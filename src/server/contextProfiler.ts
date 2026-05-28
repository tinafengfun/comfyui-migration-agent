/**
 * Context Profiler — analyzes SDK session data to track context growth and reuse.
 *
 * No LLM involved. Pure data analysis:
 *   1. Scans sdk-sessions/*.jsonl + *.prompt.md for each step
 *   2. Classifies content into: system_overhead, step_prompt, assistant_output, tool_io, resume_history
 *   3. Tracks cumulative context sent to model on resume
 *   4. Identifies which artifacts each step reads vs writes
 *   5. Reports context budget warnings
 *
 * Usage (from agent-demo root):
 *   npx tsx src/server/contextProfiler.ts <workspaceArtifactPath>
 *   npx tsx src/server/contextProfiler.ts workspaces/<task-id>/artifacts
 */

import fs from "node:fs/promises";
import path from "node:path";
import fs_callback from "node:fs";

// ── Types ──

interface StepProfile {
  stepId: string;
  sessionFiles: SessionFileSummary[];
  /** Characters in the serialized prompt (from promptSkillCompiler) */
  promptChars: number;
  /** Estimated tokens for the prompt */
  promptTokens: number;
  /** SDK event breakdown by type */
  eventTypeBreakdown: Map<string, EventTypeInfo>;
  /** Total events in this step */
  totalEvents: number;
  /** Assistant output chars (the LLM's thinking text) */
  assistantOutputChars: number;
  /** Tool I/O chars (execution_start + execution_complete) */
  toolIoChars: number;
  /** System overhead (system.message, session.*, skills_loaded, etc.) */
  systemOverheadChars: number;
  /** What tools were called and how many times */
  toolUsage: Map<string, number>;
  /** First assistant message (agent's initial thought) */
  firstThought: string;
  /** Does this step resume a prior session? */
  isResume: boolean;
  /** Artifacts this step READ (from tool call analysis) */
  artifactsRead: string[];
  /** Artifacts this step WROTE (from tool call analysis) */
  artifactsWritten: string[];
}

interface SessionFileSummary {
  fileName: string;
  type: "jsonl" | "prompt" | "transcript";
  chars: number;
  tokens: number;
}

interface EventTypeInfo {
  count: number;
  totalChars: number;
  sampleText: string;
}

interface CumulativeContextSnapshot {
  stepId: string;
  /** Estimated total tokens sent to model (system + prompt + all prior history) */
  estimatedInputTokens: number;
  /** Breakdown of where those tokens come from */
  breakdown: {
    systemOverhead: number;
    stepPrompt: number;
    priorAssistantOutput: number;
    priorToolIo: number;
  };
  /** Which budget level this hits */
  budgetLevel: "ok" | "warning" | "critical" | "exceeded";
  /** Model context limit being compared against */
  modelLimit: number;
}

interface ContextProfileReport {
  workspacePath: string;
  modelLimit: number;
  steps: StepProfile[];
  cumulativeSnapshots: CumulativeContextSnapshot[];
  summary: {
    totalJsonlChars: number;
    totalPromptChars: number;
    totalEvents: number;
    estimatedFinalContextTokens: number;
    mostExpensiveStep: string;
    stepsOverBudget: string[];
    reusableContext: string[];
    disposableContext: string[];
  };
}

// ── Constants ──

// deepseek-v4-flash: 256K native context window
const MODEL_CONTEXT_LIMIT = 256_000;
const CHARS_PER_TOKEN = 4;

// Event types classified as system overhead (carried on every step, not content)
const SYSTEM_EVENT_TYPES = new Set([
  "system.message",
  "session.resume",
  "session.skills_loaded",
  "session.tools_updated",
  "session.idle",
  "user.message",
]);

// Event types that are pure noise (not counted toward context)
const NOISE_EVENT_TYPES = new Set([
  "assistant.streaming_delta",
  "assistant.message_delta",
  "assistant.message_start",
  "assistant.intent",
  "assistant.reasoning",
  "permission.requested",
  "permission.completed",
]);

// ── Main Profiler ──

export async function profileContext(artifactPath: string): Promise<ContextProfileReport> {
  const sdkSessionsDir = path.join(artifactPath, "sdk-sessions");

  // Check directory exists
  try {
    await fs.access(sdkSessionsDir);
  } catch {
    throw new Error(`No sdk-sessions directory found at ${sdkSessionsDir}`);
  }

  // Find all JSONL files, group by step
  const dirEntries = fs_callback.readdirSync(sdkSessionsDir);
  const jsonlFiles = dirEntries
    .filter(e => e.endsWith(".jsonl"))
    .map(e => path.join(sdkSessionsDir, e));
  const stepGroups = new Map<string, string[]>();

  for (const file of jsonlFiles) {
    const base = path.basename(file);
    const stepId = base.split("-")[0];
    if (!stepGroups.has(stepId)) stepGroups.set(stepId, []);
    stepGroups.get(stepId)!.push(file);
  }

  // Profile each step (use the latest JSONL if multiple runs for same step)
  const steps: StepProfile[] = [];
  for (const [stepId, files] of [...stepGroups.entries()].sort((a, b) => sortStepIds(a[0], b[0]))) {
    // Use the latest file for this step (sorted by timestamp in filename)
    const latestFile = files.sort().pop()!;
    const profile = await profileStep(stepId, latestFile, sdkSessionsDir);
    steps.push(profile);
  }

  // Build cumulative context snapshots
  const cumulativeSnapshots = buildCumulativeSnapshots(steps);

  // Build summary
  const totalJsonlChars = steps.reduce((s, p) => s + p.sessionFiles.find(f => f.type === "jsonl")?.chars ?? 0, 0);
  const totalPromptChars = steps.reduce((s, p) => s + p.promptChars, 0);
  const totalEvents = steps.reduce((s, p) => s + p.totalEvents, 0);
  const lastSnapshot = cumulativeSnapshots[cumulativeSnapshots.length - 1];
  const estimatedFinalTokens = lastSnapshot?.estimatedInputTokens ?? 0;

  const stepsOverBudget = cumulativeSnapshots
    .filter(s => s.budgetLevel === "exceeded" || s.budgetLevel === "critical")
    .map(s => s.stepId);

  const mostExpensiveStep = steps.reduce((max, p) =>
    (p.assistantOutputChars + p.toolIoChars) > (max.assistantOutputChars + max.toolIoChars) ? p : max
  , steps[0]);

  // Analyze which context is reusable vs disposable
  const { reusable, disposable } = classifyContext(steps);

  return {
    workspacePath: artifactPath,
    modelLimit: MODEL_CONTEXT_LIMIT,
    steps,
    cumulativeSnapshots,
    summary: {
      totalJsonlChars,
      totalPromptChars,
      totalEvents,
      estimatedFinalContextTokens: estimatedFinalTokens,
      mostExpensiveStep: mostExpensiveStep?.stepId ?? "none",
      stepsOverBudget,
      reusableContext: reusable,
      disposableContext: disposable,
    },
  };
}

async function profileStep(stepId: string, jsonlFile: string, sdkSessionsDir: string): Promise<StepProfile> {
  // Read JSONL events
  const rawLines = (await fs.readFile(jsonlFile, "utf8")).trim().split("\n");
  const events = rawLines.map(line => JSON.parse(line));

  // Read prompt file
  const promptFileName = path.basename(jsonlFile).replace(".jsonl", ".prompt.md");
  const promptPath = path.join(sdkSessionsDir, promptFileName);
  let promptChars = 0;
  try {
    promptChars = (await fs.readFile(promptPath, "utf8")).length;
  } catch { /* no prompt file */ }

  // Read transcript file for artifact read/write detection
  const transcriptFileName = path.basename(jsonlFile).replace(".jsonl", ".md");
  const transcriptPath = path.join(sdkSessionsDir, transcriptFileName);

  // Analyze events
  const typeBreakdown = new Map<string, EventTypeInfo>();
  let totalEvents = 0;
  let assistantOutputChars = 0;
  let toolIoChars = 0;
  let systemOverheadChars = 0;
  const toolUsage = new Map<string, number>();
  let firstThought = "";
  let isResume = false;
  const artifactsRead: string[] = [];
  const artifactsWritten: string[] = [];

  for (const event of events) {
    if (event.kind !== "sdk_event") continue;
    totalEvents++;

    const eventType = event.eventType ?? "unknown";
    const eventChars = JSON.stringify(event).length;
    const textPreview = event.textPreview ?? "";
    const semanticProgress = event.summary?.semanticProgress ?? "";

    // Track type breakdown
    if (!typeBreakdown.has(eventType)) {
      typeBreakdown.set(eventType, { count: 0, totalChars: 0, sampleText: "" });
    }
    const info = typeBreakdown.get(eventType)!;
    info.count++;
    info.totalChars += eventChars;
    if (!info.sampleText && (textPreview || semanticProgress)) {
      info.sampleText = (semanticProgress || textPreview).slice(0, 120);
    }

    // Classify content size
    if (eventType === "assistant.message") {
      assistantOutputChars += eventChars;
      if (!firstThought && textPreview) {
        firstThought = textPreview.slice(0, 100);
      }
    } else if (eventType === "tool.execution_start") {
      const toolName = event.summary?.toolName ?? "unknown";
      toolUsage.set(toolName, (toolUsage.get(toolName) ?? 0) + 1);
      toolIoChars += eventChars;

      // Detect artifact reads from view tool calls
      if (toolName === "view" || toolName === "grep" || toolName === "glob") {
        const match = textPreview.match(/artifacts\/[^\s"']+/);
        if (match) artifactsRead.push(match[0]);
      }
    } else if (eventType === "tool.execution_complete") {
      toolIoChars += eventChars;
    } else if (SYSTEM_EVENT_TYPES.has(eventType)) {
      systemOverheadChars += eventChars;
    }

    // Detect resume
    if (eventType === "session.resume") {
      isResume = true;
    }

    // Detect artifact writes from assistant messages
    if (eventType === "assistant.message" && textPreview) {
      const writeMatches = textPreview.matchAll(/(?:wrote|written|created|updated|saved)\s+(?:to\s+)?`?(artifacts\/[^\s"`']+)/gi);
      for (const m of writeMatches) {
        if (!artifactsWritten.includes(m[1])) artifactsWritten.push(m[1]);
      }
    }
  }

  // Session file summaries
  const sessionFiles: SessionFileSummary[] = [];
  sessionFiles.push({
    fileName: path.basename(jsonlFile),
    type: "jsonl",
    chars: rawLines.join("").length,
    tokens: Math.ceil(rawLines.join("").length / CHARS_PER_TOKEN),
  });
  if (promptChars > 0) {
    sessionFiles.push({
      fileName: promptFileName,
      type: "prompt",
      chars: promptChars,
      tokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
    });
  }

  return {
    stepId,
    sessionFiles,
    promptChars,
    promptTokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
    eventTypeBreakdown: typeBreakdown,
    totalEvents,
    assistantOutputChars,
    toolIoChars,
    systemOverheadChars,
    toolUsage,
    firstThought,
    isResume,
    artifactsRead,
    artifactsWritten,
  };
}

function buildCumulativeSnapshots(steps: StepProfile[]): CumulativeContextSnapshot[] {
  const snapshots: CumulativeContextSnapshot[] = [];
  let cumulativeAssistant = 0;
  let cumulativeToolIo = 0;

  // System overhead is roughly constant per step (~3K chars = ~750 tokens)
  const systemOverheadPerStep = 750;

  for (const step of steps) {
    cumulativeAssistant += Math.ceil(step.assistantOutputChars / CHARS_PER_TOKEN);
    cumulativeToolIo += Math.ceil(step.toolIoChars / CHARS_PER_TOKEN);

    const estimatedInputTokens =
      systemOverheadPerStep +
      step.promptTokens +
      cumulativeAssistant +
      cumulativeToolIo;

    // Note: on resume, SDK carries ALL prior history, so input = system + prompt + ALL prior output
    // But SDK may truncate internally — this is the worst case
    const budgetLevel: CumulativeContextSnapshot["budgetLevel"] =
      estimatedInputTokens > MODEL_CONTEXT_LIMIT ? "exceeded" :
      estimatedInputTokens > MODEL_CONTEXT_LIMIT * 0.8 ? "critical" :
      estimatedInputTokens > MODEL_CONTEXT_LIMIT * 0.5 ? "warning" :
      "ok";

    snapshots.push({
      stepId: step.stepId,
      estimatedInputTokens,
      breakdown: {
        systemOverhead: systemOverheadPerStep,
        stepPrompt: step.promptTokens,
        priorAssistantOutput: cumulativeAssistant,
        priorToolIo: cumulativeToolIo,
      },
      budgetLevel,
      modelLimit: MODEL_CONTEXT_LIMIT,
    });
  }

  return snapshots;
}

function classifyContext(steps: StepProfile[]): { reusable: string[]; disposable: string[] } {
  // Reusable: context that should persist because it informs future steps
  // Disposable: context that was only needed for one step

  const reusable: string[] = [];
  const disposable: string[] = [];

  // System overhead is always reusable (SDK needs it)
  reusable.push(`System overhead: ~750 tokens/step (SDK system message, tools, skills)`);

  // Step prompt is reusable for the current step only
  for (const step of steps) {
    const avgPromptTokens = steps.reduce((s, p) => s + p.promptTokens, 0) / steps.length;
    reusable.push(`Step ${step.stepId} prompt: ${step.promptTokens} tokens (avg: ${Math.round(avgPromptTokens)})`);
  }

  // Tool I/O is the biggest waste — most tool results are not needed by next step
  const totalToolIo = steps.reduce((s, p) => s + p.toolIoChars / CHARS_PER_TOKEN, 0);
  disposable.push(`Tool I/O across all steps: ~${Math.round(totalToolIo)} tokens (file reads, bash output, grep results)`);
  disposable.push(`Most tool I/O is read-once: bash output, file content viewed, grep matches`);

  // Assistant thinking is partially disposable
  const totalAssistant = steps.reduce((s, p) => s + p.assistantOutputChars / CHARS_PER_TOKEN, 0);
  reusable.push(`Agent final summaries: should persist (decisions, status, artifacts written)`);
  disposable.push(`Agent thinking/progress: ~${Math.round(totalAssistant)} tokens (mostly intermediate reasoning, disposable)`);

  // Key insight: artifacts replace chat history
  reusable.push(`Artifact files: durable, file-based — this is the REAL context transfer mechanism`);

  return { reusable, disposable };
}

// ── Formatting ──

export function formatProfileReport(report: ContextProfileReport): string {
  const lines: string[] = [];

  lines.push("═".repeat(90));
  lines.push("CONTEXT PROFILE REPORT");
  lines.push("═".repeat(90));
  lines.push(`Workspace: ${report.workspacePath}`);
  lines.push(`Model limit: ${report.modelLimit.toLocaleString()} tokens`);
  lines.push(`Steps profiled: ${report.steps.length}`);
  lines.push(`Total events: ${report.summary.totalEvents.toLocaleString()}`);
  lines.push("");

  // Step-by-step breakdown
  lines.push("─".repeat(90));
  lines.push("STEP-BY-STEP CONTEXT BREAKDOWN");
  lines.push("─".repeat(90));
  lines.push("");

  for (const step of report.steps) {
    const snapshot = report.cumulativeSnapshots.find(s => s.stepId === step.stepId);
    const budgetIcon =
      snapshot?.budgetLevel === "exceeded" ? "OVER" :
      snapshot?.budgetLevel === "critical" ? "CRIT" :
      snapshot?.budgetLevel === "warning" ? "WARN" : " OK ";

    lines.push(`  Step ${step.stepId}  [${budgetIcon}]  resume=${step.isResume ? "YES" : "no"}`);
    lines.push(`    Prompt: ${step.promptTokens.toLocaleString()}t   Events: ${step.totalEvents}   Tools: ${formatToolUsage(step.toolUsage)}`);

    if (step.firstThought) {
      lines.push(`    Thought: ${step.firstThought}...`);
    }

    if (snapshot) {
      const pct = Math.round((snapshot.estimatedInputTokens / report.modelLimit) * 100);
      lines.push(`    Cumulative context: ${snapshot.estimatedInputTokens.toLocaleString()}t / ${report.modelLimit.toLocaleString()}t (${pct}%)`);
      lines.push(`      system=${snapshot.breakdown.systemOverhead.toLocaleString()}t  prompt=${snapshot.breakdown.stepPrompt.toLocaleString()}t  prior_assistant=${snapshot.breakdown.priorAssistantOutput.toLocaleString()}t  prior_tool_io=${snapshot.breakdown.priorToolIo.toLocaleString()}t`);
    }
    lines.push("");
  }

  // Cumulative context chart
  lines.push("─".repeat(90));
  lines.push("CUMULATIVE CONTEXT GROWTH");
  lines.push("─".repeat(90));
  lines.push("");

  const maxBarWidth = 60;
  for (const snapshot of report.cumulativeSnapshots) {
    const pct = snapshot.estimatedInputTokens / report.modelLimit;
    const barWidth = Math.min(Math.round(pct * maxBarWidth), maxBarWidth + 10);
    const bar = "█".repeat(Math.min(barWidth, maxBarWidth)) + (barWidth > maxBarWidth ? "→" : "");
    const color =
      snapshot.budgetLevel === "exceeded" ? "!" :
      snapshot.budgetLevel === "critical" ? "!" :
      snapshot.budgetLevel === "warning" ? "~" : " ";
    lines.push(`  ${color} ${snapshot.stepId}: ${bar} ${snapshot.estimatedInputTokens.toLocaleString()}t (${Math.round(pct * 100)}%)`);
  }

  const limitLine = "  " + "─".repeat(maxBarWidth) + ` ${report.modelLimit.toLocaleString()}t limit`;
  lines.push(limitLine);
  lines.push("");

  // Event type analysis
  lines.push("─".repeat(90));
  lines.push("CONTEXT COMPOSITION (what's in the accumulated context)");
  lines.push("─".repeat(90));
  lines.push("");

  let totalAssistantOutput = 0;
  let totalToolIoOutput = 0;
  let totalSystemOverhead = 0;

  for (const step of report.steps) {
    totalAssistantOutput += step.assistantOutputChars;
    totalToolIoOutput += step.toolIoChars;
    totalSystemOverhead += step.systemOverheadChars;
  }

  const totalChars = totalAssistantOutput + totalToolIoOutput + totalSystemOverhead;
  const assistantPct = Math.round((totalAssistantOutput / totalChars) * 100);
  const toolPct = Math.round((totalToolIoOutput / totalChars) * 100);
  const systemPct = Math.round((totalSystemOverhead / totalChars) * 100);

  lines.push(`  Assistant output (thinking/reasoning): ${formatSize(totalAssistantOutput)} (~${assistantPct}%)`);
  lines.push(`  Tool I/O (file reads, bash, grep):     ${formatSize(totalToolIoOutput)} (~${toolPct}%)`);
  lines.push(`  System overhead (SDK messages):         ${formatSize(totalSystemOverhead)} (~${systemPct}%)`);
  lines.push(`  TOTAL:                                  ${formatSize(totalChars)}`);
  lines.push("");

  // Budget warnings
  if (report.summary.stepsOverBudget.length > 0) {
    lines.push("─".repeat(90));
    lines.push("BUDGET EXCEEDED");
    lines.push("─".repeat(90));
    lines.push("");
    lines.push(`  Steps exceeding model context limit: ${report.summary.stepsOverBudget.join(", ")}`);
    lines.push(`  This means the SDK is likely truncating context from Step ${report.summary.stepsOverBudget[0]} onward.`);
    lines.push(`  Agent may be operating with partial/missing prior context.`);
    lines.push("");
  }

  // Recommendations
  lines.push("─".repeat(90));
  lines.push("CONTEXT CLASSIFICATION");
  lines.push("─".repeat(90));
  lines.push("");

  lines.push("  REUSABLE (should persist across steps):");
  for (const item of report.summary.reusableContext) {
    lines.push(`    + ${item}`);
  }
  lines.push("");

  lines.push("  DISPOSABLE (used once, safe to drop after step completes):");
  for (const item of report.summary.disposableContext) {
    lines.push(`    - ${item}`);
  }
  lines.push("");

  lines.push("═".repeat(90));
  lines.push("END OF REPORT");
  lines.push("═".repeat(90));

  return lines.join("\n");
}

// ── Helpers ──

function sortStepIds(a: string, b: string): number {
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  return a.localeCompare(b);
}

function formatToolUsage(usage: Map<string, number>): string {
  if (usage.size === 0) return "none";
  return [...usage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `${tool}×${count}`)
    .join(", ");
}

function formatSize(chars: number): string {
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  if (chars > 1_000_000) return `${(chars / 1_000_000).toFixed(1)}MB (${tokens.toLocaleString()}t)`;
  if (chars > 1_000) return `${(chars / 1_000).toFixed(0)}KB (${tokens.toLocaleString()}t)`;
  return `${chars}c (${tokens}t)`;
}

// ── CLI Entry Point ──

async function main(): Promise<void> {
  const artifactPath = process.argv[2];
  if (!artifactPath) {
    console.error("Usage: npx tsx src/server/contextProfiler.ts <workspaceArtifactPath>");
    console.error("Example: npx tsx src/server/contextProfiler.ts workspaces/<task-id>/artifacts");
    process.exit(1);
  }

  const resolved = path.resolve(artifactPath);
  console.error(`Profiling context for: ${resolved}`);

  const report = await profileContext(resolved);
  console.log(formatProfileReport(report));
}

// Run if invoked directly
if (process.argv[1]?.endsWith("contextProfiler.ts")) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
