/**
 * Context Watcher — real-time monitoring of SDK session context growth.
 *
 * Watches a workspace artifacts directory and prints live updates as steps
 * complete, including:
 *   1. Per-step context delta (tokens added, composition breakdown)
 *   2. Cross-step reference analysis (which artifacts are read by multiple steps)
 *   3. Content classification (reusable vs disposable vs duplicated)
 *   4. Cumulative context budget tracking
 *
 * Usage:
 *   npx tsx src/server/contextWatcher.ts <workspaceArtifactPath>
 *   npx tsx src/server/contextWatcher.ts workspaces/<task-id>/artifacts
 *
 * Or monitor the latest task:
 *   npx tsx src/server/contextWatcher.ts --latest
 */

import fs from "node:fs/promises";
import fs_cb from "node:fs";
import path from "node:path";

// ── Types ──

interface StepDelta {
  stepId: string;
  timestamp: string;
  promptTokens: number;
  assistantTokens: number;
  toolIoTokens: number;
  systemTokens: number;
  totalTokensAdded: number;
  cumulativeTokens: number;
  events: number;
  tools: Record<string, number>;
  filesRead: string[];
  filesWritten: string[];
  firstThought: string;
}

interface FileReference {
  file: string;
  steps: string[];
  totalReads: number;
  category: "artifact" | "source" | "sdk-session" | "system" | "other";
}

interface ContentClassification {
  category: string;
  tokens: number;
  reuseCount: number;
  description: string;
}

// ── Constants ──

const MODEL_CONTEXT_LIMIT = 256_000;
const CHARS_PER_TOKEN = 4;
const POLL_INTERVAL_MS = 3000;
const BAR_WIDTH = 50;

const SYSTEM_EVENT_TYPES = new Set([
  "system.message", "session.resume", "session.skills_loaded",
  "session.tools_updated", "session.idle", "user.message",
]);

const NOISE_EVENT_TYPES = new Set([
  "assistant.streaming_delta", "assistant.message_delta",
  "assistant.message_start", "assistant.intent", "assistant.reasoning",
  "permission.requested", "permission.completed",
]);

// ── State ──

const profiledSteps = new Set<string>();
const stepDeltas: StepDelta[] = [];
const fileReferences = new Map<string, FileReference>();
const artifactPattern = /artifacts\/([^\s"'`>\]]+)/g;
const filePathPattern = /["'(]?(\/[^\s"'`)\]]+\.(?:json|md|csv|yaml|yml|txt|py|js|ts))["')]?/g;

// ── Core Analysis ──

async function scanStep(stepId: string, jsonlPath: string, promptPath: string | null): Promise<StepDelta> {
  const raw = await fs.readFile(jsonlPath, "utf8");
  const lines = raw.trim().split("\n").filter(l => l.trim());
  const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  let promptChars = 0;
  if (promptPath) {
    try { promptChars = (await fs.readFile(promptPath, "utf8")).length; } catch { /* ok */ }
  }

  let assistantChars = 0;
  let toolIoChars = 0;
  let systemChars = 0;
  let eventCount = 0;
  const toolCounts: Record<string, number> = {};
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  let firstThought = "";
  let timestamp = "";

  for (const e of events) {
    if (e.kind !== "sdk_event") continue;
    eventCount++;
    const et = e.eventType ?? "unknown";
    const chars = JSON.stringify(e).length;

    if (!timestamp && e.timestamp) timestamp = e.timestamp;

    // Classify
    if (et === "assistant.message") {
      assistantChars += chars;
      const tp = e.textPreview ?? "";
      if (!firstThought && tp) firstThought = tp.slice(0, 120);

      // Detect file writes
      const writes = tp.matchAll(/(?:wrote|written|created|updated|saved)\s+(?:to\s+)?`?([^\s"`']+\.(?:json|md|csv|yaml|txt))`?/gi);
      for (const m of writes) {
        if (!filesWritten.includes(m[1])) filesWritten.push(m[1]);
      }
    } else if (et === "tool.execution_start") {
      const toolName = e.summary?.toolName ?? "?";
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      toolIoChars += chars;

      // Detect file reads from tool preview
      const tp = e.textPreview ?? "";
      extractFileReferences(tp, stepId, "read", filesRead);
    } else if (et === "tool.execution_complete") {
      toolIoChars += chars;
      // Also check completion output for file references
      const tp = e.textPreview ?? "";
      extractFileReferences(tp, stepId, "read", filesRead);
    } else if (SYSTEM_EVENT_TYPES.has(et)) {
      systemChars += chars;
    }
  }

  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const assistantTokens = Math.ceil(assistantChars / CHARS_PER_TOKEN);
  const toolIoTokens = Math.ceil(toolIoChars / CHARS_PER_TOKEN);
  const systemTokens = Math.ceil(systemChars / CHARS_PER_TOKEN);
  const totalTokensAdded = promptTokens + assistantTokens + toolIoTokens + systemTokens;

  // Calculate cumulative
  const prevCumulative = stepDeltas.length > 0
    ? stepDeltas[stepDeltas.length - 1].cumulativeTokens
    : 0;
  const cumulativeTokens = prevCumulative + totalTokensAdded;

  return {
    stepId,
    timestamp,
    promptTokens,
    assistantTokens,
    toolIoTokens,
    systemTokens,
    totalTokensAdded,
    cumulativeTokens,
    events: eventCount,
    tools: toolCounts,
    filesRead: [...new Set(filesRead)],
    filesWritten: [...new Set(filesWritten)],
    firstThought,
  };
}

function extractFileReferences(text: string, stepId: string, mode: "read" | "write", collector: string[]) {
  // Match artifact paths
  for (const m of text.matchAll(artifactPattern)) {
    const f = m[1];
    collector.push(f);
    trackFileRef(f, stepId);
  }
  // Match absolute file paths
  for (const m of text.matchAll(filePathPattern)) {
    const f = m[1];
    if (f.includes("/artifacts/") || f.includes("/source/") || f.includes("/sdk-sessions/")) {
      collector.push(f.replace(/.*\/(artifacts|source|sdk-sessions)\//, "$1/"));
      trackFileRef(f.replace(/.*\/(artifacts|source|sdk-sessions)\//, "$1/"), stepId);
    }
  }
}

function trackFileRef(file: string, stepId: string) {
  if (!fileReferences.has(file)) {
    const cat: FileReference["category"] =
      file.startsWith("artifacts/") ? "artifact" :
      file.startsWith("source/") ? "source" :
      file.startsWith("sdk-sessions/") ? "sdk-session" :
      file.includes("/comfy") || file.includes("/ComfyUI") ? "system" : "other";
    fileReferences.set(file, { file, steps: [], totalReads: 0, category: cat });
  }
  const ref = fileReferences.get(file)!;
  if (!ref.steps.includes(stepId)) ref.steps.push(stepId);
  ref.totalReads++;
}

// ── Formatting ──

function printStepUpdate(delta: StepDelta) {
  const pct = Math.round((delta.cumulativeTokens / MODEL_CONTEXT_LIMIT) * 100);
  const level = pct > 100 ? "EXCEEDED" : pct > 80 ? "CRITICAL" : pct > 50 ? "WARNING" : "OK";

  console.log("");
  console.log(`\x1b[1m━━━ Step ${delta.stepId} completed ━━━  [${level}]  ${new Date().toLocaleTimeString()}\x1b[0m`);
  console.log(`  Context added:  \x1b[33m${delta.totalTokensAdded.toLocaleString()}t\x1b[0m  (prompt=${delta.promptTokens.toLocaleString()}t + assistant=${delta.assistantTokens.toLocaleString()}t + tool_io=${delta.toolIoTokens.toLocaleString()}t + sys=${delta.systemTokens.toLocaleString()}t)`);
  console.log(`  Cumulative:     \x1b[36m${delta.cumulativeTokens.toLocaleString()}t / ${MODEL_CONTEXT_LIMIT.toLocaleString()}t (${pct}%)\x1b[0m`);
  console.log(`  Events: ${delta.events}   Tools: ${Object.entries(delta.tools).sort((a,b) => b[1]-a[1]).map(([t,c]) => `${t}×${c}`).join(", ")}`);

  if (delta.firstThought) {
    console.log(`  \x1b[2mAgent: ${delta.firstThought}...\x1b[0m`);
  }

  // Delta bar
  const deltaBar = "█".repeat(Math.min(Math.round(delta.totalTokensAdded / MODEL_CONTEXT_LIMIT * BAR_WIDTH), BAR_WIDTH));
  const cumBar = "█".repeat(Math.min(Math.round(delta.cumulativeTokens / MODEL_CONTEXT_LIMIT * BAR_WIDTH), BAR_WIDTH));
  console.log(`  Delta:  ${deltaBar} ${delta.totalTokensAdded.toLocaleString()}t`);
  console.log(`  Total:  ${cumBar} ${delta.cumulativeTokens.toLocaleString()}t / ${MODEL_CONTEXT_LIMIT.toLocaleString()}t`);

  // Files read/written
  if (delta.filesRead.length > 0) {
    console.log(`  \x1b[32mRead:\x1b[0m  ${delta.filesRead.slice(0, 5).join(", ")}${delta.filesRead.length > 5 ? ` ...+${delta.filesRead.length - 5} more` : ""}`);
  }
  if (delta.filesWritten.length > 0) {
    console.log(`  \x1b[35mWrite:\x1b[0m ${delta.filesWritten.slice(0, 5).join(", ")}${delta.filesWritten.length > 5 ? ` ...+${delta.filesWritten.length - 5} more` : ""}`);
  }
}

function printCrossReferenceSummary() {
  if (fileReferences.size === 0) return;

  console.log("");
  console.log("\x1b[1m━━━ Cross-Step File References ━━━\x1b[0m");

  // Group by reuse count
  const multiStep: FileReference[] = [];
  const singleStep: FileReference[] = [];

  for (const ref of fileReferences.values()) {
    if (ref.steps.length > 1) multiStep.push(ref);
    else singleStep.push(ref);
  }

  multiStep.sort((a, b) => b.steps.length - a.steps.length || b.totalReads - a.totalReads);
  singleStep.sort((a, b) => b.totalReads - a.totalReads);

  if (multiStep.length > 0) {
    console.log("\n  \x1b[32mMULTI-STEP (referenced across steps — hot content):\x1b[0m");
    for (const ref of multiStep.slice(0, 15)) {
      const stepsStr = ref.steps.join(",");
      console.log(`    ×${ref.totalReads} steps=[${stepsStr}] ${ref.file}`);
    }
    if (multiStep.length > 15) console.log(`    ... +${multiStep.length - 15} more`);
  }

  console.log(`\n  \x1b[33mONE-TIME (single step only — disposable after use):\x1b[0m  ${singleStep.length} files`);
  if (singleStep.length > 0) {
    for (const ref of singleStep.slice(0, 8)) {
      console.log(`    ×${ref.totalReads} step=[${ref.steps[0]}] ${ref.file}`);
    }
    if (singleStep.length > 8) console.log(`    ... +${singleStep.length - 8} more`);
  }

  // Category breakdown
  const byCategory = new Map<string, { count: number; reads: number; multiStep: number }>();
  for (const ref of fileReferences.values()) {
    const cat = ref.category;
    if (!byCategory.has(cat)) byCategory.set(cat, { count: 0, reads: 0, multiStep: 0 });
    const s = byCategory.get(cat)!;
    s.count++;
    s.reads += ref.totalReads;
    if (ref.steps.length > 1) s.multiStep++;
  }

  console.log("\n  \x1b[1mBy category:\x1b[0m");
  for (const [cat, s] of byCategory) {
    console.log(`    ${cat}: ${s.count} files, ${s.reads} reads, ${s.multiStep} multi-step`);
  }
}

function printContentClassification() {
  if (stepDeltas.length === 0) return;

  const totalPrompt = stepDeltas.reduce((s, d) => s + d.promptTokens, 0);
  const totalAssistant = stepDeltas.reduce((s, d) => s + d.assistantTokens, 0);
  const totalToolIo = stepDeltas.reduce((s, d) => s + d.toolIoTokens, 0);
  const totalSystem = stepDeltas.reduce((s, d) => s + d.systemTokens, 0);
  const totalAll = totalPrompt + totalAssistant + totalToolIo + totalSystem;

  const pct = (v: number) => Math.round((v / totalAll) * 100);

  console.log("");
  console.log("\x1b[1m━━━ Content Classification ━━━\x1b[0m");
  console.log(`  Total context generated: ${totalAll.toLocaleString()}t across ${stepDeltas.length} steps`);
  console.log("");

  const classes: ContentClassification[] = [
    {
      category: "Step Prompts",
      tokens: totalPrompt,
      reuseCount: 0,
      description: "Per-step instructions from promptSkillCompiler. Each step gets its own prompt — NEVER reused by subsequent steps (they get their own). Disposable after step completes.",
    },
    {
      category: "Tool I/O",
      tokens: totalToolIo,
      reuseCount: countMultiStepFiles(),
      description: "File reads, bash output, grep results. Mostly one-time: agent reads a file, extracts info, never needs the raw output again. Artifacts store the processed results.",
    },
    {
      category: "Assistant Thinking",
      tokens: totalAssistant,
      reuseCount: 0,
      description: "LLM reasoning chains. Mostly intermediate — the useful outputs are saved as artifacts. The raw thinking is noise for subsequent steps.",
    },
    {
      category: "System Overhead",
      tokens: totalSystem,
      reuseCount: stepDeltas.length,
      description: "SDK system message, tool definitions, skills. Identical payload repeated every step. Could be compressed to a single copy.",
    },
  ];

  for (const c of classes) {
    const bar = "█".repeat(Math.round(pct(c.tokens) * BAR_WIDTH / 100));
    console.log(`  \x1b[1m${c.category}\x1b[0m ${pct(c.tokens)}%`);
    console.log(`    ${bar} ${c.tokens.toLocaleString()}t`);
    console.log(`    ${c.description}`);
    console.log("");
  }

  // Savings estimate
  const disposablePct = pct(totalToolIo) + pct(totalAssistant);
  const systemDupPct = Math.max(0, pct(totalSystem) - 3); // 3% is the useful minimum
  const savingsPct = disposablePct + systemDupPct;
  const savingsTokens = Math.round(totalAll * savingsPct / 100);

  console.log(`  \x1b[1mPotential savings:\x1b[0m`);
  console.log(`    Tool I/O + Assistant thinking: ~${disposablePct}% disposable after each step`);
  console.log(`    System overhead dedup:        ~${systemDupPct}% redundant across steps`);
  console.log(`    \x1b[32mEstimated context reduction: ${savingsPct}% (~${savingsTokens.toLocaleString()}t)\x1b[0m`);
  console.log(`    Effective context per step:    ~${Math.round(totalAll * (100 - savingsPct) / 100 / stepDeltas.length).toLocaleString()}t (vs current ${Math.round(totalAll / stepDeltas.length).toLocaleString()}t avg)`);
}

function countMultiStepFiles(): number {
  let count = 0;
  for (const ref of fileReferences.values()) {
    if (ref.steps.length > 1) count++;
  }
  return count;
}

function printRunningSummary() {
  console.log("");
  console.log(`\x1b[2m${"─".repeat(60)}\x1b[0m`);
  console.log(`\x1b[2m  Watching: ${artifactPath}\x1b[0m`);
  console.log(`\x1b[2m  Steps: ${profiledSteps.size} profiled  |  Files tracked: ${fileReferences.size}  |  Polling: ${POLL_INTERVAL_MS / 1000}s\x1b[0m`);
  console.log(`\x1b[2m${"─".repeat(60)}\x1b[0m`);
}

// ── File Watching ──

let artifactPath = "";

async function discoverSteps(): Promise<Array<{ stepId: string; jsonl: string; prompt: string | null }>> {
  const sdkDir = path.join(artifactPath, "sdk-sessions");
  let entries: string[];
  try {
    entries = fs_cb.readdirSync(sdkDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter(e => e.endsWith(".jsonl"));

  // Group by step, take latest per step
  const groups = new Map<string, string>();
  for (const f of jsonlFiles) {
    const stepId = f.split("-")[0];
    const existing = groups.get(stepId);
    if (!existing || f > existing) groups.set(stepId, f);
  }

  const result: Array<{ stepId: string; jsonl: string; prompt: string | null }> = [];
  for (const [stepId, fileName] of [...groups.entries()].sort((a, b) => {
    const na = parseInt(a[0], 10), nb = parseInt(b[0], 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a[0].localeCompare(b[0]);
  })) {
    const jsonl = path.join(sdkDir, fileName);
    const promptName = fileName.replace(".jsonl", ".prompt.md");
    const prompt = entries.includes(promptName) ? path.join(sdkDir, promptName) : null;
    result.push({ stepId, jsonl, prompt });
  }

  return result;
}

async function watchLoop() {
  const steps = await discoverSteps();
  let newSteps = 0;

  for (const { stepId, jsonl, prompt } of steps) {
    if (profiledSteps.has(stepId)) continue;

    // Check if step is complete (jsonl file not being written to)
    // Heuristic: check if a step-job.json exists for this step with status=completed
    const stepJobPath = path.join(artifactPath, `${stepId}-step-job.json`);
    let isComplete = false;
    try {
      const job = JSON.parse(await fs.readFile(stepJobPath, "utf8"));
      isComplete = job.status === "completed" || job.status === "failed";
    } catch {
      // If no step-job.json, check if another step has started (means this one is done)
      const nextStepId = String(parseInt(stepId, 10) + 1).padStart(2, "0");
      const nextJobPath = path.join(artifactPath, `${nextStepId}-step-job.json`);
      try {
        await fs.access(nextJobPath);
        isComplete = true;
      } catch { /* not done yet */ }
    }

    if (!isComplete) {
      // Still running — show partial progress
      const stat = await fs.stat(jsonl);
      const sizeKB = Math.round(stat.size / 1024);
      process.stdout.write(`\r  Step ${stepId}: running... (${sizeKB}KB session data)\x1b[K`);
      continue;
    }

    // Profile the completed step
    profiledSteps.add(stepId);
    newSteps++;

    try {
      const delta = await scanStep(stepId, jsonl, prompt);
      stepDeltas.push(delta);
      printStepUpdate(delta);
    } catch (err) {
      console.error(`  Error profiling step ${stepId}: ${(err as Error).message}`);
    }
  }

  // If new steps were completed, refresh cross-reference and classification
  if (newSteps > 0) {
    printCrossReferenceSummary();
    printContentClassification();
    printRunningSummary();
  }
}

// ── Main ──

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx src/server/contextWatcher.ts <workspaceArtifactPath | --latest | --new>");
    process.exit(1);
  }

  if (arg === "--new") {
    // Wait for a new task to be created (watch workspaces dir for new entries)
    const wsRoot = path.resolve("workspaces");
    const existingAtStart = new Set(
      fs_cb.readdirSync(wsRoot).filter(d => {
        try { return fs_cb.statSync(path.join(wsRoot, d, "artifacts")).isDirectory(); } catch { return false; }
      })
    );
    console.log(`\x1b[1mWaiting for new task...\x1b[0m`);
    console.log(`  Existing tasks: ${existingAtStart.size}`);
    console.log(`  Polling workspaces/ every ${POLL_INTERVAL_MS / 1000}s for new task...`);
    console.log("");

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const current = fs_cb.readdirSync(wsRoot).filter(d => {
          try { return fs_cb.statSync(path.join(wsRoot, d, "artifacts")).isDirectory(); } catch { return false; }
        });
        for (const d of current) {
          if (!existingAtStart.has(d)) {
            clearInterval(check);
            artifactPath = path.join(wsRoot, d, "artifacts");
            console.log(`\x1b[32mNew task detected: ${d}\x1b[0m`);
            resolve();
            return;
          }
        }
        process.stdout.write(`\r  ${new Date().toLocaleTimeString()} — waiting... (${current.length} tasks)\x1b[K`);
      }, POLL_INTERVAL_MS);
    });
  } else if (arg === "--latest") {
    // Find the latest workspace
    const wsRoot = path.resolve("workspaces");
    const dirs = fs_cb.readdirSync(wsRoot).filter(d => {
      try { return fs_cb.statSync(path.join(wsRoot, d, "artifacts")).isDirectory(); } catch { return false; }
    });
    if (dirs.length === 0) {
      console.error("No workspaces found in workspaces/");
      process.exit(1);
    }
    // Sort by modification time, pick latest
    let latest = dirs[0];
    let latestTime = 0;
    for (const d of dirs) {
      const stat = fs_cb.statSync(path.join(wsRoot, d));
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latest = d;
      }
    }
    artifactPath = path.join(wsRoot, latest, "artifacts");
  } else {
    artifactPath = path.resolve(arg);
  }

  console.log(`\x1b[1mContext Watcher — monitoring SDK sessions in real-time\x1b[0m`);
  console.log(`  Workspace: ${artifactPath}`);
  console.log(`  Model limit: ${MODEL_CONTEXT_LIMIT.toLocaleString()} tokens`);
  console.log(`  Polling every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Press Ctrl+C to stop and print final report`);
  console.log("");

  // Initial scan (pick up any already-completed steps)
  await watchLoop();

  // Poll loop
  const interval = setInterval(async () => {
    try {
      await watchLoop();
    } catch (err) {
      console.error(`  Watch error: ${(err as Error).message}`);
    }
  }, POLL_INTERVAL_MS);

  // Graceful exit
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("");
    console.log("\x1b[1m━━━ Final Report ━━━\x1b[0m");
    printCrossReferenceSummary();
    printContentClassification();
    console.log("");
    console.log("Watcher stopped.");
    process.exit(0);
  });
}

if (process.argv[1]?.endsWith("contextWatcher.ts")) {
  main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
