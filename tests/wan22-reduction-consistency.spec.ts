/**
 * Layer 2 — WAN2.2 multi-step reduction-config SYNC guard (@wan22-consistency).
 *
 * This is the regression test for the "multi-step reduction-config sync" bug that
 * has been fixed several times: after Step 08 accepts the reduced tier, the SAME
 * reduced config (reduced_tier, a real reduced_prompt_path, --lowvram NOT --novram,
 * ref_max_size 1280->~640, length 81->~40, frame_load_cap 121->~60, attention
 * seq ~73000 NOT full-size ~155440) MUST be used at EVERY step 08->12 with no
 * drift back to full-size / --novram.
 *
 * It drives a FRESH WAN2.2 `Video_Edit_Multimodal_Generator` migration, auto-answers
 * the Step 02 / 04 / 08 gates, and at each newly-completed step 09/10/11 (and when
 * Step 12 reaches the human gate) RE-READS effective-run-config.json +
 * reduced-runtime-policy-prompt.json and asserts the reduced config is present AND
 * byte-for-byte identical to the Step-08 baseline (the sync check).
 *
 * IMPORTANT — this test STOPS at the Step 12 GUI-acceptance gate for a human to
 * confirm manually. It does NOT answer Step 12, does NOT hard-stop, does NOT delete
 * the task. It leaves the task parked at the gate and returns PASS.
 *
 * Any step failing / hard-stopping / terminating, any full-size read (ref_max_size
 * === 1280) or --novram, or any drift from the Step-08 baseline => throw (the sync
 * bug is NOT resolved).
 *
 * Run (hours-long, on-demand — NOT the fast CI loop):
 *   npm run playwright:wan22-consistency
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  listEvents,
  recordDecision,
  runUntilGate,
  hardStop,
  sleep,
  getArtifactJson,
  type AgentEvent,
} from "./helpers/api";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "./fixtures/video-edit-wan22.json");
const FIXTURE_NAME = "video-edit-wan22.json";
const GPU_NODE = process.env.PW_GPU_NODE ?? "remote-124-12";

const POLL_MS = 15_000;
const BUDGET_MS = 8 * 60 * 60_000; // 8h to reach the Step 12 gate

// Gate auto-answers. Step 12 is DELIBERATELY absent — the human confirms it.
const CHOICE_PREFERENCE: Record<string, string[]> = {
  "02": ["approve", "continue", "proceed"],
  "04": ["approve", "continue", "proceed"],
  // Step 08 capacity gate: "Accept reduced tier …" is what makes WAN2.2 fit a 32 GB XPU.
  "08": ["accept reduced", "reduced tier", "accept", "proceed", "lower"],
};
const FREEFORM: Record<string, string> = {
  "02": "llama_cpp VLM auto-handled on CPU; proceed",
  "04": "Approve. Source audit covers all WAN2.2 node families. Proceed.",
  "08": "Accept reduced tier. Run GUI acceptance at the recommended reduced setting.",
};

const answered = new Set<string>();

function pickBestChoice(stepId: string, choices: string[]): { answer: string; wasFreeform: boolean } {
  if (choices.length === 0) return { answer: FREEFORM[stepId] ?? "Approve and continue.", wasFreeform: true };
  const prefs = CHOICE_PREFERENCE[stepId] ?? ["continue", "proceed", "approve"];
  for (const pref of prefs) {
    const m = choices.find((c) => c.toLowerCase().includes(pref));
    if (m) return { answer: m, wasFreeform: false };
  }
  const nonStop = choices.find((c) => !c.toLowerCase().includes("stop"));
  return { answer: nonStop ?? choices[0], wasFreeform: false };
}

/** Answer every unanswered human_question for a step. NEVER call for step 12. */
async function handleGate(request: APIRequestContext, taskId: string, stepId: string): Promise<void> {
  const events = await listEvents(request, taskId);
  const unanswered = events.filter(
    (e) => e.type === "human_question" && e.stepId === stepId && !answered.has(e.id)
  );
  for (const q of unanswered) {
    const { answer, wasFreeform } = pickBestChoice(stepId, q.data?.choices ?? []);
    await recordDecision(request, taskId, q.id, answer, wasFreeform);
    answered.add(q.id);
    console.log(`  [gate] Step ${stepId} answered (${wasFreeform ? "freeform" : "choice"}): ${answer.slice(0, 80)}`);
  }
}

interface ReducedConfig {
  reduced_tier: unknown;
  reduced_prompt_path: unknown;
  vram_flags: string[];
  ref_max_size?: number;
  length?: number;
  frame_load_cap?: number;
}

/** Find the first API-format node of a given class_type in a prompt object. */
function findNode(prompt: Record<string, any>, classType: string): any | undefined {
  return Object.values(prompt).find((n: any) => n?.class_type === classType);
}

/**
 * Read the effective run config + the reduced API prompt and distil the fields the
 * sync check compares. ref_max_size/length come from the reduced prompt's
 * BerniniConditioning; frame_load_cap from its VHS_LoadVideo — the graph the run
 * actually executes.
 */
async function readReducedConfig(request: APIRequestContext, taskId: string): Promise<ReducedConfig> {
  const cfg = await getArtifactJson<any>(request, taskId, "effective-run-config.json");
  expect(cfg, "effective-run-config.json must exist").toBeTruthy();

  const reduced = await getArtifactJson<any>(request, taskId, "reduced-runtime-policy-prompt.json");
  const prompt = reduced?.prompt ?? reduced ?? {};
  const bernini = findNode(prompt, "BerniniConditioning");
  const loadVideo = findNode(prompt, "VHS_LoadVideo");

  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  return {
    reduced_tier: cfg.reduced_tier,
    reduced_prompt_path: cfg.reduced_prompt_path,
    vram_flags: Array.isArray(cfg.vram_flags) ? cfg.vram_flags : [],
    ref_max_size: num(bernini?.inputs?.ref_max_size),
    length: num(bernini?.inputs?.length),
    frame_load_cap: num(loadVideo?.inputs?.frame_load_cap),
  };
}

/**
 * Assert the reduced config is present + reduced (not full-size / not --novram) and,
 * when a baseline is supplied, IDENTICAL to it (the multi-step sync check). Throws on
 * any full-size read or drift — the sync bug is NOT resolved.
 */
function assertReduced(where: string, c: ReducedConfig, baseline: ReducedConfig | null): void {
  expect(c.reduced_tier, `[${where}] reduced_tier must be true`).toBe(true);
  expect(c.reduced_prompt_path, `[${where}] reduced_prompt_path must be truthy (not the null-summary bug)`).toBeTruthy();
  expect(
    c.vram_flags.includes("--lowvram"),
    `[${where}] vram_flags must include --lowvram (got ${JSON.stringify(c.vram_flags)})`
  ).toBe(true);
  expect(
    c.vram_flags.includes("--novram"),
    `[${where}] vram_flags must NOT include --novram (drift; got ${JSON.stringify(c.vram_flags)})`
  ).toBe(false);

  // Full-size drift guards.
  if (typeof c.ref_max_size === "number") {
    expect(c.ref_max_size, `[${where}] ref_max_size must be reduced (<=768, NOT 1280)`).toBeLessThanOrEqual(768);
    expect(c.ref_max_size, `[${where}] ref_max_size must not be full-size 1280`).not.toBe(1280);
  }
  if (typeof c.length === "number") {
    expect(c.length, `[${where}] length must be reduced (<=80, NOT 81)`).toBeLessThanOrEqual(80);
  }

  // The sync check: everything must match the Step-08 baseline exactly.
  if (baseline) {
    expect(c.vram_flags, `[${where}] vram_flags drifted from Step-08 baseline`).toEqual(baseline.vram_flags);
    expect(c.ref_max_size, `[${where}] ref_max_size drifted from Step-08 baseline`).toBe(baseline.ref_max_size);
    expect(c.length, `[${where}] length drifted from Step-08 baseline`).toBe(baseline.length);
    expect(c.frame_load_cap, `[${where}] frame_load_cap drifted from Step-08 baseline`).toBe(baseline.frame_load_cap);
    expect(c.reduced_prompt_path, `[${where}] reduced_prompt_path drifted from Step-08 baseline`).toBe(
      baseline.reduced_prompt_path
    );
  }
}

function fmt(c: ReducedConfig): string {
  return `reduced_tier=${c.reduced_tier} lowvram=${c.vram_flags.includes("--lowvram")} novram=${c.vram_flags.includes(
    "--novram"
  )} ref_max_size=${c.ref_max_size} length=${c.length} frame_load_cap=${c.frame_load_cap} reduced_prompt_path=${
    c.reduced_prompt_path ? "set" : "NULL"
  }`;
}

function stepStatus(steps: { id: string; status: string }[], id: string): string | undefined {
  return steps.find((s) => s.id === id)?.status;
}

/**
 * Best-effort assert on the canonical sidebar workflow the operator will load at
 * Step 12: fetch it via the ComfyUI userdata HTTP API and, if a BerniniConditioning
 * node is parseable, make sure the full-size ref_max_size (1280) is NOT baked into it.
 * The authoritative reduced assertion is on the reduced API prompt (below in the
 * caller); this is the extra "what the human actually opens" guard.
 */
async function assertSidebarNotFullSize(comfyOrigin: string, taskName: string): Promise<string> {
  // destName mirrors guiWorkflowSync.ts: `${sanitizeName(task.name)}-step12-gui-acceptance.json`.
  const sanitized = (taskName.split("/").pop() ?? taskName).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow";
  const destName = `${sanitized}-step12-gui-acceptance.json`;
  const url = `${comfyOrigin}/api/userdata/${encodeURIComponent(`workflows/${destName}`)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return `sidebar fetch ${res.status} (non-fatal; API-prompt assertion is authoritative)`;
    const text = await res.text();
    let gui: any;
    try {
      gui = JSON.parse(text);
    } catch {
      return "sidebar not JSON (non-fatal)";
    }
    const nodes: any[] = Array.isArray(gui?.nodes) ? gui.nodes : [];
    const bernini = nodes.find((n) => n?.type === "BerniniConditioning");
    if (!bernini) return "sidebar reachable; no BerniniConditioning node found to inspect (non-fatal)";
    const widgets: unknown[] = Array.isArray(bernini.widgets_values) ? bernini.widgets_values : [];
    // Full-size ref_max_size (1280) must not be baked into the graph the operator opens.
    if (widgets.some((w) => w === 1280)) {
      throw new Error(
        `Step 12 SIDEBAR workflow contains full-size 1280 in BerniniConditioning widgets_values ` +
          `(${JSON.stringify(widgets)}) — the operator would queue full-size and OOM. Sync bug NOT resolved.`
      );
    }
    return `sidebar reachable; BerniniConditioning widgets_values=${JSON.stringify(widgets)} (no full-size 1280)`;
  } catch (e) {
    if (e instanceof Error && e.message.includes("Sync bug NOT resolved")) throw e;
    return `sidebar fetch threw: ${e instanceof Error ? e.message : String(e)} (non-fatal)`;
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe("WAN2.2 reduction-config multi-step sync @wan22-consistency", () => {
  test.beforeAll(async ({ request }) => {
    // Clear the orchestrator's one-run-per-process lock: hard-stop + delete every task.
    for (const t of await listTasks(request)) {
      await hardStop(request, t.id, "wan22-consistency: clean slate").catch(() => {});
      await deleteTask(request, t.id).catch(() => {});
    }
  });

  test("reduced config is identical + --lowvram at every step 08->12 (stops at Step 12 gate)", async ({ request }) => {
    test.setTimeout(BUDGET_MS);

    const task = await createTask(request, {
      workflowFileName: FIXTURE_NAME,
      fixturePath: FIXTURE_PATH,
      gpuNode: GPU_NODE,
    });
    const taskId = task.id;
    console.log(`\n=== WAN2.2 reduction-consistency task ${taskId} (gpuNode=${GPU_NODE}) ===`);

    let baseline: ReducedConfig | null = null;
    const consistency: Array<{ step: string; line: string; pass: boolean }> = [];
    const checkedSteps = new Set<string>();

    // Re-read + assert the reduced config for a given "where" label. Records a
    // PASS/FAIL line and throws on any failure (fail loudly).
    const checkStep = async (where: string, captureBaseline = false): Promise<void> => {
      const c = await readReducedConfig(request, taskId);
      try {
        assertReduced(where, c, captureBaseline ? null : baseline);
        if (captureBaseline) baseline = c;
        consistency.push({ step: where, line: fmt(c), pass: true });
        console.log(`  [sync] ${where}: PASS — ${fmt(c)}`);
      } catch (e) {
        consistency.push({ step: where, line: `${fmt(c)}  <<< ${e instanceof Error ? e.message : String(e)}`, pass: false });
        console.log(`  [sync] ${where}: FAIL — ${fmt(c)}`);
        throw e;
      }
    };

    const deadline = Date.now() + BUDGET_MS;
    await runUntilGate(request, taskId);

    while (Date.now() < deadline) {
      const t = await getTask(request, taskId);
      const blocking = t.steps.find((s) =>
        ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(s.status)
      );

      // Any failure / hard-stop / termination = the sync bug is NOT resolved. Fail loudly.
      if (blocking && ["failed", "hard_stopped", "terminated"].includes(blocking.status)) {
        throw new Error(
          `Step ${blocking.id} ${blocking.status}: ${blocking.error ?? "unknown"} — sync bug NOT resolved`
        );
      }

      // Capture the Step-08 baseline the FIRST time Step 08 is completed.
      if (!baseline && stepStatus(t.steps, "08") === "completed") {
        await checkStep("08 (baseline)", true);
      }
      // Re-check the reduced config at each newly-completed 09/10/11.
      for (const id of ["09", "10", "11"]) {
        if (!checkedSteps.has(id) && stepStatus(t.steps, id) === "completed") {
          checkedSteps.add(id);
          if (!baseline) await checkStep("08 (baseline)", true); // safety: 08 must precede
          await checkStep(id);
        }
      }

      if (blocking?.status === "waiting_for_human") {
        if (blocking.id === "12") {
          // ── The Step 12 gate: assert the reduced config one last time, verify the
          // sidebar workflow, print the verification URL, then STOP (do NOT answer). ──
          if (!baseline) await checkStep("08 (baseline)", true);
          await checkStep("12 (gate)");

          const events = await listEvents(request, taskId);
          const gate = events
            .filter((e) => e.type === "human_question" && e.stepId === "12")
            .pop() as AgentEvent | undefined;
          const verifUrl = String((gate?.data as any)?.verificationUrl ?? "");
          expect(verifUrl, "Step 12 gate must carry a ComfyUI verificationUrl").toMatch(/^https?:\/\//);
          const origin = new URL(verifUrl).origin;

          // Authoritative reduced assertion on the reduced API prompt's BerniniConditioning.
          const reduced = await getArtifactJson<any>(request, taskId, "reduced-runtime-policy-prompt.json");
          const prompt = reduced?.prompt ?? reduced ?? {};
          const bernini = findNode(prompt, "BerniniConditioning");
          const apiRef = bernini?.inputs?.ref_max_size;
          if (typeof apiRef === "number") {
            expect(apiRef, "Step 12 reduced API prompt BerniniConditioning ref_max_size must be reduced (<=768)").toBeLessThanOrEqual(768);
            expect(apiRef, "Step 12 reduced API prompt ref_max_size must not be full-size 1280").not.toBe(1280);
          }
          const sidebarNote = await assertSidebarNotFullSize(origin, t.name);

          console.log(`\n=== Step 12 GATE reached — reduced config verified, task LEFT at the gate for the human ===`);
          console.log(`  verificationUrl: ${verifUrl}`);
          console.log(`  Step 12 reduced API prompt BerniniConditioning ref_max_size = ${apiRef}`);
          console.log(`  sidebar: ${sidebarNote}`);
          console.log(`\n  Per-step consistency table:`);
          for (const row of consistency) {
            console.log(`    ${row.pass ? "PASS" : "FAIL"}  ${row.step.padEnd(14)}  ${row.line}`);
          }
          console.log(
            `\n=== PASS: reduced config identical + --lowvram at every step 08->12, no full-size/--novram drift. ` +
              `Task ${taskId} PARKED at Step 12 for manual human confirmation (NOT answered, NOT deleted). ===\n`
          );
          return; // STOP here — do NOT recordDecision(12), do NOT hardStop/deleteTask.
        }
        // Non-12 gate: auto-answer and resume.
        await handleGate(request, taskId, blocking.id);
        await sleep(5_000);
        await runUntilGate(request, taskId);
      }

      await sleep(POLL_MS);
    }
    throw new Error(`Ran out of budget (${Math.round(BUDGET_MS / 3.6e6)}h) before reaching the Step 12 gate`);
  });
});
