/**
 * E2E Migration Driver — interactive CLI client for the migration agent API.
 *
 * Drives a workflow through all 14 migration steps via the REST API server.
 * When the agent hits a human gate, the question is printed and the user
 * types an answer directly in the terminal.
 *
 * Usage:
 *   npx tsx scripts/e2e-migration.mts <workflow.json>
 *   npx tsx scripts/e2e-migration.mts --auto-approve <workflow.json>
 *   npx tsx scripts/e2e-migration.mts --help
 *
 * Prerequisites:
 *   1. API server running:  cd agent-demo && source env && bash scripts/restart.sh
 *   2. LLM provider configured via the `env` file
 *   3. COMFYUI_ROOT / MODEL_ROOTS / DEMO_WORKSPACE_ROOT set (server-side)
 *
 * Options:
 *   --auto-approve   Pick the first choice at each human gate (non-interactive)
 *   --port <n>       API server port (default: 3001, or PORT env var)
 *   --timeout <min>  Overall migration timeout in minutes (default: 60)
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";

// ── Types (mirror src/shared/types.ts — kept local to avoid build-time deps) ─
type TaskStatus =
  | "pending" | "running" | "waiting_for_human" | "paused"
  | "hard_stopped" | "completed" | "failed" | "terminated";

interface MigrationStepState {
  id: string;
  status: TaskStatus;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface MigrationTask {
  id: string;
  name: string;
  status: TaskStatus;
  workflowPath: string;
  workspacePath: string;
  artifactPath: string;
  createdAt: string;
  updatedAt: string;
  steps: MigrationStepState[];
}

interface AgentEvent {
  id: string;
  taskId: string;
  stepId?: string;
  type: string;
  message: string;
  createdAt: string;
  data?: any;
}

interface HumanQuestionData {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  blockingReason?: string;
}

// ── Step display names ────────────────────────────────────────────────────────
const STEP_NAMES: Record<string, string> = {
  "00": "Intake & Preflight",
  "01": "Asset & Custom-Node Resolution",
  "02": "Feasibility Analysis",
  "03": "Workflow Inventory",
  "04": "Source Audit",
  "05": "Environment Deployment",
  "06": "Prompt Conversion Validation",
  "07": "Branch Smoke Validation",
  "08": "Full Validation & Capacity",
  "09": "Performance Tuning",
  "10": "Coverage Review",
  "11": "Delivery Packaging",
  "12": "GUI Acceptance Demo",
  "13": "Agent Improvement",
};

const TERMINAL_STATUSES: TaskStatus[] = [
  "completed", "failed", "hard_stopped", "terminated",
];

// ── CLI arg parsing ───────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  let autoApprove = false;
  let port = Number(process.env.PORT ?? "3001");
  let timeoutMin = 60;
  let workflowPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--auto-approve") {
      autoApprove = true;
    } else if (a === "--port") {
      port = Number(argv[++i]);
    } else if (a === "--timeout") {
      timeoutMin = Number(argv[++i]);
    } else if (!a.startsWith("--")) {
      workflowPath = a;
    }
  }

  if (!workflowPath) {
    printHelp();
    process.exit(1);
  }

  return { workflowPath: path.resolve(workflowPath), autoApprove, port, timeoutMin };
}

function printHelp() {
  console.log(`
Usage: npx tsx scripts/e2e-migration.mts [options] <workflow.json>

Options:
  --auto-approve   Pick the first choice at each human gate (non-interactive)
  --port <n>       API server port (default: 3001, or PORT env var)
  --timeout <min>  Overall migration timeout in minutes (default: 60)
  --help, -h       Show this help

Prerequisites:
  1. Start the API server:  cd agent-demo && source env && bash scripts/restart.sh
  2. LLM provider configured via the 'env' file
`);
}

// ── API helpers ───────────────────────────────────────────────────────────────
class ApiClient {
  constructor(
    private base: string,
    private log: (msg: string) => void,
  ) {}

  async health(): Promise<any> {
    const res = await fetch(`${this.base}/api/health`);
    if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
    return res.json();
  }

  async createTask(input: { name: string; workflowFileName: string; workflowJson: unknown }): Promise<MigrationTask> {
    const res = await fetch(`${this.base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`createTask failed: HTTP ${res.status} ${text}`);
    }
    const body = await res.json() as { task: MigrationTask };
    return body.task;
  }

  async runUntilGate(taskId: string): Promise<void> {
    const res = await fetch(`${this.base}/api/tasks/${taskId}/run-until-gate`, {
      method: "POST",
    });
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new Error(`runUntilGate failed: HTTP ${res.status} ${text}`);
    }
  }

  async getTask(taskId: string): Promise<MigrationTask> {
    const res = await fetch(`${this.base}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error(`getTask failed: HTTP ${res.status}`);
    const body = await res.json() as { task: MigrationTask };
    return body.task;
  }

  async getEvents(taskId: string): Promise<AgentEvent[]> {
    const res = await fetch(`${this.base}/api/tasks/${taskId}/events`);
    if (!res.ok) throw new Error(`getEvents failed: HTTP ${res.status}`);
    const body = await res.json() as { events: AgentEvent[] };
    return body.events;
  }

  async getArtifacts(taskId: string): Promise<Array<{ path: string; relativePath: string; kind: string }>> {
    const res = await fetch(`${this.base}/api/tasks/${taskId}/artifacts`);
    if (!res.ok) throw new Error(`getArtifacts failed: HTTP ${res.status}`);
    const body = await res.json() as { artifacts: any[] };
    return body.artifacts;
  }

  async submitDecision(
    taskId: string,
    input: { questionEventId: string; answer: string; wasFreeform?: boolean; stepId?: string },
  ): Promise<void> {
    const res = await fetch(`${this.base}/api/tasks/${taskId}/human-decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`submitDecision failed: HTTP ${res.status} ${text}`);
    }
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function bar(c: string, n = 80): string { return c.repeat(n); }

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function stepLabel(stepId?: string): string {
  if (!stepId) return "?";
  return `Step ${stepId}: ${STEP_NAMES[stepId] ?? "?"}`;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "✅";
    case "failed": return "❌";
    case "hard_stopped": return "🛑";
    case "terminated": return "⏹️";
    case "waiting_for_human": return "⏸️";
    case "running": return "▶️";
    case "paused": return "⏸️";
    default: return "⬜";
  }
}

// ── Event printing ────────────────────────────────────────────────────────────
function printEvent(ev: AgentEvent, startMs: number): void {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const ts = `[${mm}:${ss}]`;

  switch (ev.type) {
    case "step_started":
      console.log(`${ts} ▶ ${stepLabel(ev.stepId)}`);
      break;
    case "step_completed":
    case "step_summary":
      console.log(`${ts} ${statusIcon("completed")} ${stepLabel(ev.stepId)} — ${ev.message}`);
      break;
    case "step_failed":
      console.log(`${ts} ${statusIcon("failed")} ${stepLabel(ev.stepId)} FAILED — ${ev.message}`);
      break;
    case "artifact_created": {
      const p = ev.data?.relativePath ?? ev.data?.path ?? ev.message;
      console.log(`${ts} 📦 Artifact: ${p}`);
      break;
    }
    case "progress":
      // Only print non-empty progress messages
      if (ev.message) console.log(`${ts}   ${ev.message}`);
      break;
    case "human_question":
      console.log(`${ts} ${statusIcon("waiting_for_human")} ${stepLabel(ev.stepId)} waiting for human decision`);
      break;
    case "hard_stop":
      console.log(`${ts} ${statusIcon("hard_stopped")} HARD STOP — ${ev.message}`);
      break;
    case "file_changed":
      // Skip noisy file_changed events unless it's a significant file
      break;
    case "retry_scheduled":
      console.log(`${ts} 🔄 Retry scheduled — ${ev.message}`);
      break;
    case "reflection_proposed":
      console.log(`${ts} 💡 Reflection proposed — ${ev.message}`);
      break;
    default:
      // Unknown event type — print only if message is non-trivial
      if (ev.message && ev.message.length > 5) {
        console.log(`${ts}   [${ev.type}] ${ev.message}`);
      }
  }
}

// ── Human gate handling ──────────────────────────────────────────────────────
function extractQuestion(ev: AgentEvent): HumanQuestionData {
  if (ev.data && typeof ev.data === "object" && "question" in ev.data) {
    return ev.data as HumanQuestionData;
  }
  return { question: ev.message };
}

async function promptUser(
  ev: AgentEvent,
  rl: ReturnType<typeof createInterface>,
  autoApprove: boolean,
): Promise<{ answer: string; wasFreeform: boolean }> {
  const q = extractQuestion(ev);
  const stepName = stepLabel(ev.stepId);

  console.log();
  console.log(bar("═"));
  console.log(`  HUMAN DECISION REQUIRED — ${stepName}`);
  console.log(bar("═"));
  console.log();
  console.log(`  Q: ${wrapText(q.question, 75, "     ")}`);

  const choices = q.choices?.filter((c) => c?.trim()) ?? [];
  if (choices.length > 0) {
    console.log();
    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${i + 1}. ${choices[i]}`);
    }
  }

  const allowFreeform = q.allowFreeform !== false;

  if (autoApprove) {
    if (choices.length > 0) {
      console.log(`\n  ⚡ Auto-approved: choice 1 — ${choices[0]}`);
      return { answer: choices[0], wasFreeform: false };
    }
    if (allowFreeform) {
      console.log(`\n  ⚡ Auto-approved: "yes"`);
      return { answer: "yes", wasFreeform: true };
    }
    // No choices and no freeform — shouldn't happen, but handle it
    console.log(`\n  ⚡ Auto-approved: "continue"`);
    return { answer: "continue", wasFreeform: true };
  }

  console.log();
  let hint: string;
  if (choices.length > 0 && allowFreeform) {
    hint = `Enter choice (1-${choices.length}) or type your answer`;
  } else if (choices.length > 0) {
    hint = `Enter choice (1-${choices.length})`;
  } else {
    hint = `Type your answer`;
  }

  const answer = (await rl.question(`  ${hint}: `)).trim();
  if (!answer) return promptUser(ev, rl, autoApprove);

  // Numeric choice?
  if (choices.length > 0) {
    const n = Number(answer);
    if (!isNaN(n) && n >= 1 && n <= choices.length) {
      return { answer: choices[n - 1], wasFreeform: false };
    }
    // Non-numeric that exactly matches a choice
    const match = choices.find((c) => c.toLowerCase() === answer.toLowerCase());
    if (match) return { answer: match, wasFreeform: false };
  }

  return { answer, wasFreeform: true };
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

// ── Polling loop ──────────────────────────────────────────────────────────────
async function pollUntilSettled(
  api: ApiClient,
  taskId: string,
  startMs: number,
  seenEventIds: Set<string>,
  opts: { intervalMs?: number; timeoutMs?: number },
): Promise<MigrationTask> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;

  while (true) {
    // Fetch + print new events
    const events = await api.getEvents(taskId);
    for (const ev of events) {
      if (!seenEventIds.has(ev.id)) {
        seenEventIds.add(ev.id);
        printEvent(ev, startMs);
      }
    }

    const task = await api.getTask(taskId);

    if (task.status === "waiting_for_human") return task;
    if (TERMINAL_STATUSES.includes(task.status)) return task;

    // Check timeout
    if (Date.now() - startMs > timeoutMs) {
      throw new Error(`Migration timed out after ${fmtDuration(timeoutMs)}`);
    }

    // Wait before next poll
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Final report ──────────────────────────────────────────────────────────────
async function printFinalReport(
  api: ApiClient,
  task: MigrationTask,
  startMs: number,
  humanDecisions: Array<{ stepId?: string; question: string; answer: string }>,
): Promise<void> {
  const duration = Date.now() - startMs;
  const artifacts = await api.getArtifacts(task.id);

  console.log();
  console.log(bar("═", 60));
  console.log(`  MIGRATION ${task.status.toUpperCase()} — ${task.name}`);
  console.log(`  Duration: ${fmtDuration(duration)}`);
  console.log(bar("═", 60));

  // Step table
  console.log();
  console.log("  Step  Status             Duration");
  console.log("  ────  ─────────────────  ────────");
  for (const s of task.steps) {
    const icon = statusIcon(s.status);
    const dur = s.startedAt && s.completedAt
      ? fmtDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())
      : s.startedAt
        ? "running…"
        : "—";
    const decCount = humanDecisions.filter((d) => d.stepId === s.id).length;
    const decSuffix = decCount > 0 ? ` (${decCount} decision${decCount > 1 ? "s" : ""})` : "";
    const statusStr = `${icon} ${s.status}`;
    console.log(`  ${s.id}    ${statusStr.padEnd(18)} ${dur}${decSuffix}`);
    if (s.error) {
      console.log(`        ⚠️  ${s.error}`);
    }
  }

  // Artifacts
  if (artifacts.length > 0) {
    console.log();
    console.log(`  Artifacts (${artifacts.length}):`);
    for (const a of artifacts) {
      const name = a.relativePath ?? path.basename(a.path);
      console.log(`  - ${name}`);
    }
  }

  // Human decisions
  if (humanDecisions.length > 0) {
    console.log();
    console.log(`  Human decisions (${humanDecisions.length}):`);
    for (const d of humanDecisions) {
      const shortQ = d.question.length > 60 ? d.question.slice(0, 57) + "…" : d.question;
      const shortA = d.answer.length > 50 ? d.answer.slice(0, 47) + "…" : d.answer;
      console.log(`  - Step ${d.stepId ?? "?"}: "${shortA}"`);
      console.log(`    Q: ${shortQ}`);
    }
  }

  console.log();
  console.log(bar("═", 60));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { workflowPath, autoApprove, port, timeoutMin } = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${port}`;
  const api = new ApiClient(base, console.log);
  const startMs = Date.now();

  // ── Health check ──────────────────────────────────────────────────────────
  console.log(bar("═"));
  console.log("  E2E Migration Driver");
  console.log(`  Workflow: ${path.basename(workflowPath)}`);
  console.log(`  Mode: ${autoApprove ? "auto-approve" : "interactive"}`);
  console.log(bar("═"));
  console.log();

  let health: any;
  try {
    health = await api.health();
  } catch {
    console.error(`\n❌ Cannot reach API server at ${base}`);
    console.error(`\n  Start it first:`);
    console.error(`    cd agent-demo && source env && bash scripts/restart.sh`);
    process.exit(1);
  }
  console.log(`  ✓ Server healthy — comfyui: ${health.comfyuiRoot ?? "?"}`);
  console.log();

  // ── Load workflow ─────────────────────────────────────────────────────────
  let workflowJson: unknown;
  try {
    workflowJson = JSON.parse(readFileSync(workflowPath, "utf8"));
  } catch (e) {
    console.error(`\n❌ Cannot read workflow JSON: ${workflowPath}`);
    console.error(`  ${e}`);
    process.exit(1);
  }

  // ── Create task ───────────────────────────────────────────────────────────
  const taskName = path.basename(workflowPath).replace(/\.json$/, "");
  console.log(`  ▶ Creating task…`);
  const task = await api.createTask({
    name: taskName,
    workflowFileName: path.basename(workflowPath),
    workflowJson,
  });
  console.log(`  ✓ Task created: ${task.id}`);
  console.log(`  ✓ Workspace: ${task.workspacePath}`);
  console.log();

  // ── Drive migration ───────────────────────────────────────────────────────
  const rl = autoApprove ? null : createInterface({ input: process.stdin, output: process.stdout });
  const seenEventIds = new Set<string>();
  const humanDecisions: Array<{ stepId?: string; question: string; answer: string }> = [];
  const timeoutMs = timeoutMin * 60 * 1000;
  let currentTask = task;

  try {
    while (!TERMINAL_STATUSES.includes(currentTask.status)) {
      // Kick off the next run-until-gate
      await api.runUntilGate(task.id);

      // Poll until settled (human gate, terminal, or timeout)
      currentTask = await pollUntilSettled(
        api, task.id, startMs, seenEventIds,
        { intervalMs: 2000, timeoutMs },
      );

      // Handle human gate
      if (currentTask.status === "waiting_for_human") {
        // Find the latest unanswered human_question event
        const events = await api.getEvents(task.id);
        const pendingQ = [...events]
          .reverse()
          .find((e) => e.type === "human_question" && !humanDecisions.some((d) => d.question === (e.data?.question ?? e.message)));

        if (!pendingQ) {
          // Status says waiting but no pending question — wait and re-check
          console.log("  ⚠️  Status is waiting_for_human but no pending question found. Waiting…");
          await sleep(3000);
          currentTask = await api.getTask(task.id);
          continue;
        }

        const qData = extractQuestion(pendingQ);
        const { answer, wasFreeform } = await promptUser(
          pendingQ,
          rl ?? createInterface({ input: process.stdin, output: process.stdout }),
          autoApprove,
        );

        console.log(`\n  → Submitting: ${answer.length > 60 ? answer.slice(0, 57) + "…" : answer}`);
        await api.submitDecision(task.id, {
          questionEventId: pendingQ.id,
          answer,
          wasFreeform,
          stepId: pendingQ.stepId,
        });
        humanDecisions.push({
          stepId: pendingQ.stepId,
          question: qData.question,
          answer,
        });

        // The loop will call runUntilGate again on next iteration
        // Update task status before looping
        await sleep(1000);
        currentTask = await api.getTask(task.id);
      }
    }
  } finally {
    rl?.close();
  }

  // ── Final report ──────────────────────────────────────────────────────────
  // Fetch final events before report
  const finalEvents = await api.getEvents(task.id);
  for (const ev of finalEvents) {
    if (!seenEventIds.has(ev.id)) {
      seenEventIds.add(ev.id);
      printEvent(ev, startMs);
    }
  }

  await printFinalReport(api, currentTask, startMs, humanDecisions);

  // Exit code
  const failed = currentTask.status === "failed" || currentTask.status === "terminated";
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n❌ Fatal error: ${e?.stack ?? e}`);
  process.exit(1);
});
