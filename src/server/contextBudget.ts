import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../shared/types";

export type ContextBudgetLevel = "ok" | "warning" | "critical";

export interface ContextBudgetLimits {
  warningEstimatedTokens: number;
  criticalEstimatedTokens: number;
  warningSdkEvents: number;
  criticalSdkEvents: number;
  snapshotIntervalMs: number;
}

export interface ContextBudgetSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  reason: string;
  level: ContextBudgetLevel;
  limits: ContextBudgetLimits;
  estimatedContextChars: number;
  estimatedContextTokens: number;
  sdkEventCount: number;
  sdkEventChars: number;
  trackedArtifactChars: number;
  trackedArtifacts: Array<{ path: string; chars: number; kind: "file" | "directory" | "missing" }>;
  recommendation: string;
}

export class ContextBudgetExceededError extends Error {
  constructor(readonly snapshot: ContextBudgetSnapshot) {
    super(
      `Phase 1 context budget reached ${snapshot.level}: ` +
        `${snapshot.estimatedContextTokens}/${snapshot.limits.criticalEstimatedTokens} estimated tokens, ` +
        `${snapshot.sdkEventCount}/${snapshot.limits.criticalSdkEvents} SDK events.`
    );
    this.name = "ContextBudgetExceededError";
  }
}

export class ContextBudgetTracker {
  private sdkEventCount = 0;
  private sdkEventChars = 0;
  private lastSnapshotAt = 0;
  private lastAlertLevel: ContextBudgetLevel = "ok";

  constructor(
    private readonly input: {
      budgetPath: string;
      trackedPaths: string[];
      limits?: Partial<ContextBudgetLimits>;
    }
  ) {}

  get limits(): ContextBudgetLimits {
    return {
      ...defaultContextBudgetLimits(),
      ...this.input.limits
    };
  }

  async recordSdkEvent(event: Omit<AgentEvent, "id" | "createdAt">): Promise<ContextBudgetSnapshot | undefined> {
    this.sdkEventCount += 1;
    this.sdkEventChars += event.message.length + boundedJsonLength(event.data, 8_000);
    const now = Date.now();
    const due = now - this.lastSnapshotAt >= this.limits.snapshotIntervalMs;
    if (!due) return undefined;
    return this.writeSnapshot("periodic_sdk_event");
  }

  async writeSnapshot(reason: string): Promise<ContextBudgetSnapshot> {
    this.lastSnapshotAt = Date.now();
    const trackedArtifacts = await Promise.all(
      this.input.trackedPaths.map(async (trackedPath) => ({
        path: trackedPath,
        ...(await pathSize(trackedPath))
      }))
    );
    const trackedArtifactChars = trackedArtifacts.reduce((sum, item) => sum + item.chars, 0);
    const estimatedContextChars = trackedArtifactChars + this.sdkEventChars;
    const estimatedContextTokens = estimateTokens(estimatedContextChars);
    const limits = this.limits;
    const level = classifyContextBudget({
      estimatedContextTokens,
      sdkEventCount: this.sdkEventCount,
      limits
    });
    const snapshot: ContextBudgetSnapshot = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      reason,
      level,
      limits,
      estimatedContextChars,
      estimatedContextTokens,
      sdkEventCount: this.sdkEventCount,
      sdkEventChars: this.sdkEventChars,
      trackedArtifactChars,
      trackedArtifacts,
      recommendation: recommendationForLevel(level)
    };
    await fs.mkdir(path.dirname(this.input.budgetPath), { recursive: true });
    await fs.writeFile(this.input.budgetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return snapshot;
  }

  shouldAlert(snapshot: ContextBudgetSnapshot): boolean {
    if (snapshot.level === "ok") return false;
    if (this.lastAlertLevel === snapshot.level) return false;
    this.lastAlertLevel = snapshot.level;
    return true;
  }
}

export function defaultContextBudgetLimits(env: NodeJS.ProcessEnv = process.env): ContextBudgetLimits {
  return {
    warningEstimatedTokens: positiveInt(env.MIGRATION_AGENT_CONTEXT_WARNING_TOKENS, 180_000),
    criticalEstimatedTokens: positiveInt(env.MIGRATION_AGENT_CONTEXT_CRITICAL_TOKENS, 300_000),
    warningSdkEvents: positiveInt(env.MIGRATION_AGENT_CONTEXT_WARNING_EVENTS, 30_000),
    criticalSdkEvents: positiveInt(env.MIGRATION_AGENT_CONTEXT_CRITICAL_EVENTS, 60_000),
    snapshotIntervalMs: positiveInt(env.MIGRATION_AGENT_CONTEXT_SNAPSHOT_MS, 10_000)
  };
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function classifyContextBudget(input: {
  estimatedContextTokens: number;
  sdkEventCount: number;
  limits: ContextBudgetLimits;
}): ContextBudgetLevel {
  if (
    input.estimatedContextTokens >= input.limits.criticalEstimatedTokens ||
    input.sdkEventCount >= input.limits.criticalSdkEvents
  ) {
    return "critical";
  }
  if (
    input.estimatedContextTokens >= input.limits.warningEstimatedTokens ||
    input.sdkEventCount >= input.limits.warningSdkEvents
  ) {
    return "warning";
  }
  return "ok";
}

function recommendationForLevel(level: ContextBudgetLevel): string {
  if (level === "critical") {
    return "Stop at the next safe step boundary, write a compact checkpoint, and resume Phase 1 in a fresh SDK session.";
  }
  if (level === "warning") {
    return "Write a compact checkpoint, avoid reading non-required large artifacts, and prepare to restart after the current step.";
  }
  return "Continue normally while keeping step handoffs and running summary current.";
}

async function pathSize(trackedPath: string): Promise<{ chars: number; kind: "file" | "directory" | "missing" }> {
  try {
    const stat = await fs.stat(trackedPath);
    if (stat.isFile()) return { chars: stat.size, kind: "file" };
    if (stat.isDirectory()) return { chars: await directorySize(trackedPath), kind: "directory" };
    return { chars: 0, kind: "missing" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { chars: 0, kind: "missing" };
    throw error;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}

function boundedJsonLength(value: unknown, max: number): number {
  if (value === undefined) return 0;
  try {
    return Math.min(JSON.stringify(value).length, max);
  } catch {
    return max;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
