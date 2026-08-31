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
  opts: { workflowFileName?: string; workflowJson?: unknown; fixturePath?: string; gpuNode?: string } = {}
): Promise<TaskState> {
  const fixturePath = opts.fixturePath ?? FIXTURE_PATH;
  const workflowJson = opts.workflowJson ?? JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const workflowFileName = opts.workflowFileName ?? path.basename(fixturePath);
  const r = await request.post(`${API}/api/tasks`, {
    headers: { "Content-Type": "application/json" },
    data: { workflowFileName, workflowJson, ...(opts.gpuNode ? { gpuNode: opts.gpuNode } : {}) },
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

export async function hardStop(request: APIRequestContext, taskId: string, reason = "Test cleanup: hard-stop."): Promise<number> {
  // The endpoint requires a `reason` body; without it the call 400s and the
  // task keeps running (which then holds the one-run-per-process lock).
  const r = await request.post(`${API}/api/tasks/${taskId}/hard-stop`, {
    headers: { "Content-Type": "application/json" },
    data: { reason },
  });
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

// ── Artifact content + ComfyUI direct execution (for Step-12 execute+validate) ──

/**
 * Fetch one artifact's text by filename (matched against the artifact list's
 * relativePath, e.g. "effective-run-config.json" or "reduced-runtime-policy-prompt.json").
 * Returns "" if not found. The content endpoint serves raw text.
 */
export async function getArtifactText(
  request: APIRequestContext,
  taskId: string,
  fileName: string
): Promise<string> {
  const artifacts = await listArtifacts(request, taskId);
  const hit =
    artifacts.find((a) => a.relativePath.endsWith(`/${fileName}`) || a.relativePath === fileName || a.relativePath.endsWith(fileName));
  const rel = hit?.relativePath ?? `artifacts/${fileName}`;
  const r = await request.get(`${API}/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(rel)}`);
  if (!r.ok()) return "";
  return await r.text();
}

/** JSON-parse an artifact; returns undefined on any error. */
export async function getArtifactJson<T = any>(
  request: APIRequestContext,
  taskId: string,
  fileName: string
): Promise<T | undefined> {
  const text = await getArtifactText(request, taskId, fileName);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface ComfyRunResult {
  ok: boolean;
  status: "success" | "error" | "timeout" | "submit_failed";
  promptId?: string;
  outputs: Array<{ filename: string; type: string; subfolder: string }>;
  raw: unknown;
  detail: string;
}

/**
 * Submit an API-format prompt to a ComfyUI server and wait for it to finish --
 * the automated equivalent of a human running the reduced workflow at Step 12.
 * Uses plain fetch (the Playwright host can reach the GPU node's ComfyUI directly).
 * Never throws; returns a structured result the spec asserts on.
 */
export async function comfyuiSubmitAndWait(
  comfyUrl: string,
  promptObj: unknown,
  opts: { timeoutMs?: number; pollMs?: number; clientId?: string } = {}
): Promise<ComfyRunResult> {
  const base = comfyUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 8_000;
  const clientId = opts.clientId ?? "wan22-e2e";
  const empty: ComfyRunResult = { ok: false, status: "submit_failed", outputs: [], raw: null, detail: "" };
  let promptId: string;
  try {
    const res = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptObj, client_id: clientId }),
    });
    if (!res.ok) return { ...empty, detail: `POST /prompt -> ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const body = (await res.json()) as { prompt_id?: string; node_errors?: unknown };
    if (!body.prompt_id) return { ...empty, detail: `no prompt_id (node_errors: ${JSON.stringify(body.node_errors)})` };
    promptId = body.prompt_id;
  } catch (e) {
    return { ...empty, detail: `submit threw: ${e instanceof Error ? e.message : String(e)}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    let hist: Record<string, any> = {};
    try {
      const hr = await fetch(`${base}/history/${promptId}`);
      if (hr.ok) hist = (await hr.json()) as Record<string, any>;
    } catch {
      continue; // server may be briefly unreachable (e.g. mid-relaunch)
    }
    const rec = hist[promptId];
    if (!rec) continue; // still running / queued
    const statusStr = rec?.status?.status_str;
    const outputs = collectComfyOutputs(rec?.outputs);
    const dump = JSON.stringify(rec).toLowerCase();
    const oom = /device_lost|out_of_device_memory|out of memory|ur_result_error/.test(dump);
    if (statusStr === "success" && !oom) {
      return { ok: true, status: "success", promptId, outputs, raw: rec, detail: `success, ${outputs.length} output(s)` };
    }
    return {
      ok: false,
      status: "error",
      promptId,
      outputs,
      raw: rec,
      detail: oom ? "OOM/DEVICE_LOST during render" : `status_str=${statusStr}`,
    };
  }
  return { ...empty, status: "timeout", promptId, detail: `no history within ${Math.round(timeoutMs / 60000)}min` };
}

function collectComfyOutputs(outputs: unknown): Array<{ filename: string; type: string; subfolder: string }> {
  const files: Array<{ filename: string; type: string; subfolder: string }> = [];
  if (!outputs || typeof outputs !== "object") return files;
  for (const nodeOut of Object.values(outputs as Record<string, any>)) {
    for (const key of ["images", "gifs", "videos"]) {
      const arr = (nodeOut as any)?.[key];
      if (Array.isArray(arr)) for (const f of arr) if (f?.filename) files.push({ filename: f.filename, type: key, subfolder: f.subfolder ?? "" });
    }
  }
  return files;
}
