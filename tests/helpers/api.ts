/**
 * Shared migration-agent API helpers for the Playwright specs.
 *
 * Target a running agent with PW_API (default http://127.0.0.1:3001).
 * Both tiers (@ui, @migration) import from here so the API surface is defined once.
 */
import type { APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const API = process.env.PW_API ?? "http://127.0.0.1:3001";

export const FIXTURE_PATH = path.resolve(__dirname, "../fixtures/zimage-shuangcai.json");

export interface StepState {
  id: string;
  status: string;
  error?: string;
  summary?: string;
}

export interface TaskState {
  id: string;
  name: string;
  status: string;
  steps: StepState[];
}

export interface AgentEvent {
  id: string;
  type: string;
  stepId?: string;
  data?: { choices?: string[]; question?: string; [key: string]: unknown };
  message?: string;
}

export interface ArtifactEntry {
  path: string;
  relativePath: string;
  kind: string;
}

// ── Static reads ────────────────────────────────────────────────────────────

export async function health(request: APIRequestContext): Promise<{ ok: boolean; comfyuiRoot: string; [k: string]: unknown }> {
  const r = await request.get(`${API}/api/health`);
  return (await r.json()) as Promise<{ ok: boolean; comfyuiRoot: string }>;
}

export async function listStepDefs(request: APIRequestContext): Promise<Array<{ id: string; name: string }>> {
  const r = await request.get(`${API}/api/steps`);
  const body = (await r.json()) as { steps: Array<{ id: string; name: string }> };
  return body.steps;
}

export async function listTasks(request: APIRequestContext): Promise<TaskState[]> {
  const r = await request.get(`${API}/api/tasks`);
  const body = (await r.json()) as { tasks: TaskState[] };
  return body.tasks ?? [];
}

export async function getTask(request: APIRequestContext, taskId: string): Promise<TaskState> {
  const r = await request.get(`${API}/api/tasks/${taskId}`);
  if (!r.ok()) throw new Error(`getTask ${taskId} -> ${r.status()}`);
  const body = (await r.json()) as { task: TaskState };
  return body.task;
}

export async function listEvents(request: APIRequestContext, taskId: string): Promise<AgentEvent[]> {
  const r = await request.get(`${API}/api/tasks/${taskId}/events`);
  const body = (await r.json()) as { events: AgentEvent[] };
  return body.events ?? [];
}

export async function listArtifacts(request: APIRequestContext, taskId: string): Promise<ArtifactEntry[]> {
  const r = await request.get(`${API}/api/tasks/${taskId}/artifacts`);
  const body = (await r.json()) as { artifacts: ArtifactEntry[] };
  return body.artifacts ?? [];
}

export async function listGpuNodes(request: APIRequestContext) {
  const r = await request.get(`${API}/api/gpu-nodes`);
  return (await r.json()) as { default: string; nodes: Array<{ name: string; kind: string }> };
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Create a task from the bundled 双采 fixture (or an explicit path/json). */
export async function createTask(
  request: APIRequestContext,
  opts: { workflowFileName?: string; workflowJson?: unknown; fixturePath?: string } = {}
): Promise<TaskState> {
  const fixturePath = opts.fixturePath ?? FIXTURE_PATH;
  const workflowJson = opts.workflowJson ?? JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const workflowFileName = opts.workflowFileName ?? path.basename(fixturePath);
  const r = await request.post(`${API}/api/tasks`, {
    headers: { "Content-Type": "application/json" },
    data: { workflowFileName, workflowJson },
  });
  if (r.status() !== 201) {
    throw new Error(`createTask -> ${r.status()}: ${await r.text()}`);
  }
  const body = (await r.json()) as { task: TaskState };
  return body.task;
}

export async function deleteTask(request: APIRequestContext, taskId: string): Promise<void> {
  await request.delete(`${API}/api/tasks/${taskId}`);
}

/** Returns the HTTP status (202 accepted, 409 already running). */
export async function runUntilGate(request: APIRequestContext, taskId: string): Promise<number> {
  const r = await request.post(`${API}/api/tasks/${taskId}/run-until-gate`);
  return r.status();
}

export async function resumeStep(request: APIRequestContext, taskId: string, stepId: string): Promise<number> {
  const r = await request.post(`${API}/api/tasks/${taskId}/steps/${stepId}/resume`);
  return r.status();
}

export async function recordDecision(
  request: APIRequestContext,
  taskId: string,
  questionEventId: string,
  answer: string,
  wasFreeform = false
): Promise<{ resumedLiveSession?: boolean }> {
  const r = await request.post(`${API}/api/tasks/${taskId}/human-decisions`, {
    headers: { "Content-Type": "application/json" },
    data: { questionEventId, answer, wasFreeform },
  });
  if (r.status() !== 201) {
    throw new Error(`recordDecision -> ${r.status()}: ${await r.text()}`);
  }
  return (await r.json().catch(() => ({}))) as { resumedLiveSession?: boolean };
}

export async function hardStop(request: APIRequestContext, taskId: string): Promise<number> {
  const r = await request.post(`${API}/api/tasks/${taskId}/hard-stop`);
  return r.status();
}

// ── Polling helpers ─────────────────────────────────────────────────────────

export const BLOCKING_STATUSES = ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"];

export function blockingStep(steps: StepState[]): StepState | null {
  return steps.find((s) => BLOCKING_STATUSES.includes(s.status)) ?? null;
}

export async function waitFor(
  fn: () => Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 2_000, message = "condition" } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${message}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
