/**
 * Layer 2 — Complete WAN2.2 video-edit migration, replaces the manual test (@migration @wan22).
 *
 * Drives the REAL WAN2.2 `Video_Edit_Multimodal_Generator` migration through the full
 * pipeline 00 → 12b, auto-answering EVERY human gate (Step 02 feasibility, Step 04
 * source-audit rounds, Step 08 capacity "accept reduced tier", Step 12 GUI acceptance),
 * and — at Step 12 — it ACTUALLY runs the reduced workflow on ComfyUI and asserts no
 * OOM/DEVICE_LOST + real output files before answering "Pass". So it does what the human
 * used to do by hand. Step 13 (self-evolution) is intentionally NOT covered.
 *
 * It also regression-guards the capacity fixes: after Step 08 it asserts the effective
 * run config carries a reduced tier with a real reduced-prompt path (not the null-summary
 * bug), --lowvram flags, and frame counts clamped to WAN2.2's <=5 s limit.
 *
 * Long + GPU/model-dependent. Run on-demand (NOT the fast CI loop):
 *   MIGRATION_DEPTH=capacity npm run playwright:wan22   # ~to Step 08 gate + capacity asserts (faster smoke)
 *   MIGRATION_DEPTH=full     npm run playwright:wan22   # hours, whole pipeline to 12b incl. Step-12 render
 *
 * Prereqs:
 *   - Backend (PW_API :3001) + frontend (PW_BASE_URL :5173) up; LLM (DeepSeek) configured.
 *   - The target GPU node (PW_GPU_NODE, default "remote-124-12" = 172.16.124.12) reachable
 *     with the WAN2.2 docker container + models (dual fp8 Bernini HIGH/LOW, UMT5-XXL, the
 *     llama_cpp VLM) and its ComfyUI reachable from the test host.
 *   - FRESH backend (no held run-lock): if POST /api/tasks 500s "another step is running",
 *     restart the backend (this spec's beforeAll also clears stale tasks).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  API,
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
  comfyuiSubmitAndWait,
  type AgentEvent,
} from "./helpers/api";
import { stageValidInputs } from "./helpers/media";
import { assessOutput } from "./helpers/quality";

// Feed valid generated inputs + assess output quality by default; opt out with
// PW_SKIP_INPUT_STAGING=1 / PW_SKIP_QUALITY=1 for a bare existence-only run.
const STAGE_INPUTS = process.env.PW_SKIP_INPUT_STAGING !== "1";
const CHECK_QUALITY = process.env.PW_SKIP_QUALITY !== "1";
// Frozen Step-12 render target: 768 "SD" long-edge + ~3s (72 frames @ 24fps), so
// the render is deterministic content we can quality-assert, independent of the
// capacity probe's chosen reduction. Overridable via env.
const TARGET_MAX_SIZE = Number(process.env.PW_TARGET_MAX_SIZE ?? 768);
const TARGET_LENGTH = Number(process.env.PW_TARGET_LENGTH ?? 72); // frames (~3s @ 24fps)
const TARGET_FRAME_CAP = TARGET_LENGTH + 4; // source frames the video loader must supply

// "full" (default): drive to Step 12b. "capacity": stop after answering the Step 08 gate.
const DEPTH = (process.env.MIGRATION_DEPTH ?? "full") as "full" | "capacity";
const GPU_NODE = process.env.PW_GPU_NODE ?? "remote-124-12";
const FIXTURE_NAME = "video-edit-wan22.json";
// Optional: point the run at an external workflow file (absolute path) instead of
// the bundled fixture — e.g. PW_WORKFLOW_FILE=/home/intel/.../Dasiwa-图生视频流.json
const WORKFLOW_FILE = process.env.PW_WORKFLOW_FILE ?? "";
const TASK_ITEM_TEXT = "video-edit-wan22"; // .task-item name substring

const POLL_MS = 15_000;
// WAN2.2 is heavy: CPU VLM (~5 min), full-size capacity probe that DEVICE_LOSTs +
// reduced-validation + XPU reset, Step 09 multi-run tuning, the Step 12 render.
const PER_STEP_MS = 120 * 60_000; // 120 min / step (Step 08 alone ran ~78 min)
const CAPACITY_BUDGET_MS = 3 * 60 * 60_000; // 3 h to reach + answer Step 08
const FULL_BUDGET_MS = 8 * 60 * 60_000; // 8 h to 12b (incl. the Step-12 render)
const RENDER_TIMEOUT_MS = 40 * 60_000; // Step-12 reduced render (VLM + 2 WAN passes)

const CHOICE_PREFERENCE: Record<string, string[]> = {
  "01": ["skip these items and continue", "provide the missing", "approve", "continue"],
  "02": ["approve", "continue", "proceed"],
  "04": ["approve", "continue", "proceed"],
  // Step 08 capacity gate: choices are "Accept reduced tier …" / "Hardware escalation …" /
  // "Hard stop …" — the reduced-tier answer is what makes WAN2.2 fit on a 32 GB XPU.
  "08": ["accept reduced", "reduced tier", "accept", "proceed", "480", "lower"],
  "05": ["approve", "continue", "proceed"],
  "12b": ["approve", "continue", "proceed"]
};
const FREEFORM: Record<string, string> = {
  "02": "Approve. llama_cpp VLM is auto-handled on CPU (host RAM, not XPU), XPU workarounds documented. Proceed.",
  "04": "Approve. Source audit covers all WAN2.2 node families. Proceed.",
  "08": "Accept reduced tier. Run GUI acceptance at the recommended reduced setting.",
};

const answered = new Set<string>();

function pickBestChoice(stepId: string, choices: string[]): { answer: string; wasFreeform: boolean } {
  if (choices.length === 0) return { answer: FREEFORM[stepId] ?? "Approve and continue.", wasFreeform: true };
  const prefs = CHOICE_PREFERENCE[stepId] ?? ["continue", "proceed", "approve", "skip"];
  for (const pref of prefs) {
    const m = choices.find((c) => c.toLowerCase().includes(pref));
    if (m) return { answer: m, wasFreeform: false };
  }
  const nonStop = choices.find((c) => !c.toLowerCase().includes("stop"));
  return { answer: nonStop ?? choices[0], wasFreeform: false };
}

/** Answer every unanswered human_question for a step (generic gates: 02/04/08/12b). */
async function handleGate(request: APIRequestContext, taskId: string, stepId: string): Promise<boolean> {
  const events = await listEvents(request, taskId);
  const unanswered = events.filter((e) => e.type === "human_question" && e.stepId === stepId && !answered.has(e.id));
  for (const q of unanswered) {
    const { answer, wasFreeform } = pickBestChoice(stepId, q.data?.choices ?? []);
    await recordDecision(request, taskId, q.id, answer, wasFreeform);
    answered.add(q.id);
    console.log(`  [gate] Step ${stepId} answered (${wasFreeform ? "freeform" : "choice"}): ${answer.slice(0, 80)}`);
  }
  return unanswered.length > 0;
}

/**
 * Step 12 replaces the manual GUI acceptance: read the reduced prompt + the ComfyUI URL,
 * ACTUALLY run the reduced workflow, assert no OOM + real outputs, THEN answer "Pass".
 * Throws (fails the test) if the render OOMs or produces nothing — exactly the manual
 * failure this test exists to catch.
 */
async function executeAndValidateStep12(request: APIRequestContext, taskId: string): Promise<void> {
  const events = await listEvents(request, taskId);
  const gate = events.filter((e) => e.type === "human_question" && e.stepId === "12" && !answered.has(e.id)).pop();
  expect(gate, "Step 12 must have an open GUI-acceptance gate").toBeTruthy();
  const q = gate as AgentEvent;

  const verifUrl = String((q.data as any)?.verificationUrl ?? process.env.PW_COMFY_URL ?? "");
  expect(verifUrl, "Step 12 gate must carry a ComfyUI verificationUrl (or set PW_COMFY_URL)").toMatch(/^https?:\/\//);
  const comfyUrl = new URL(verifUrl).origin;

  // The reduced API prompt generated at Step-08 acceptance (regression guard: it must exist).
  const reduced = await getArtifactJson<any>(request, taskId, "reduced-runtime-policy-prompt.json");
  expect(reduced, "reduced-runtime-policy-prompt.json must exist (never ship full-size to Step 12)").toBeTruthy();
  const prompt = reduced.prompt ?? reduced;

  // Sanity: it must be the REDUCED graph, not full-size.
  const bernini = Object.values(prompt).find((n: any) => n?.class_type === "BerniniConditioning") as any;
  if (bernini?.inputs) {
    const ref = bernini.inputs.ref_max_size;
    const len = bernini.inputs.length;
    if (typeof ref === "number") expect(ref, "reduced ref_max_size").toBeLessThanOrEqual(768);
    if (typeof len === "number") expect(len, "reduced length (<=5s)").toBeLessThanOrEqual(120);
  }

  // Freeze the render target to 768 long-edge + ~3s (72 frames): the Bernini
  // resolution driver (ref_max_size) and length, plus the video loader's
  // frame_load_cap. Only these WAN2.2 drivers are touched — NOT llama_cpp's
  // max_size (that is the VLM token cap, unrelated to picture size).
  for (const n of Object.values(prompt) as any[]) {
    if (!n?.inputs) continue;
    if (n.class_type === "BerniniConditioning") {
      if (typeof n.inputs.ref_max_size === "number") n.inputs.ref_max_size = TARGET_MAX_SIZE;
      if (typeof n.inputs.length === "number") n.inputs.length = TARGET_LENGTH;
    }
    if (/VHS_LoadVideo|LoadVideo/.test(String(n.class_type)) && typeof n.inputs.frame_load_cap === "number")
      n.inputs.frame_load_cap = TARGET_FRAME_CAP;
  }
  console.log(`  [step12] render target frozen: ref_max_size=${TARGET_MAX_SIZE}, length=${TARGET_LENGTH} (~3s), frame_load_cap=${TARGET_FRAME_CAP}`);

  // Feed VALID inputs: generate an image + video (enough source frames), upload
  // them into this ComfyUI's input dir, and rewire the LoadImage / VHS_LoadVideo
  // nodes to them — so the render runs on decodable inputs we control.
  if (STAGE_INPUTS) {
    const { wired } = await stageValidInputs(comfyUrl, prompt, { frames: TARGET_FRAME_CAP + 4, size: "768x512" });
    console.log(`  [step12] staged valid inputs → image nodes ${JSON.stringify(wired.imageNodes)}, video nodes ${JSON.stringify(wired.videoNodes)}`);
  }

  console.log(`  [step12] executing reduced workflow on ${comfyUrl} …`);
  const result = await comfyuiSubmitAndWait(comfyUrl, prompt, { timeoutMs: RENDER_TIMEOUT_MS });
  console.log(`  [step12] render result: ${result.status} — ${result.detail}`);
  expect(result.ok, `Step 12 reduced render must succeed without OOM: ${result.detail}`).toBe(true);
  expect(result.outputs.length, "Step 12 render must produce output file(s)").toBeGreaterThan(0);

  // Judge OUTPUT QUALITY, not just existence. A WAN2.2 graph emits several video
  // outputs (the generated result plus preview / side-by-side / input-echo
  // branches), so requiring EVERY output to be pristine is too strict — a preview
  // branch can be legitimately blank. Instead: assess all, require the PRIMARY
  // generated video (best content score = contrast × frames) to pass, and just log
  // the rest. If ALL outputs are blank/black, the best still fails → the test fails
  // (the real "ran but produced garbage" regression is still caught).
  if (CHECK_QUALITY) {
    const videoOuts = result.outputs.filter((o) => o.type === "videos" || o.type === "gifs" || /\.(mp4|webm|gif|webp)$/i.test(o.filename));
    const targets = videoOuts.length ? videoOuts : result.outputs;
    const verdicts = [] as Array<{ out: (typeof targets)[number]; v: Awaited<ReturnType<typeof assessOutput>>; score: number }>;
    for (const out of targets) {
      const v = await assessOutput(comfyUrl, out);
      const p = v.probe;
      const dims = p ? `${p.width}x${p.height}, ${p.nbFrames}f, ${p.durationSec.toFixed(1)}s, ${Math.round((p.sizeBytes ?? 0) / 1024)}KB` : "no-probe";
      console.log(`  [step12] quality ${out.filename}: ${v.ok ? "OK" : "FAIL"} (${dims}; black=${v.blackRatio ?? "-"}; contrast=${v.spatialContrast ?? "-"})${v.failures.length ? " — " + v.failures.join("; ") : ""}`);
      verdicts.push({ out, v, score: (v.spatialContrast ?? 0) * (p?.nbFrames ?? 0) });
    }
    expect(verdicts.length, "at least one output must be quality-assessed").toBeGreaterThan(0);
    const best = verdicts.sort((a, b) => b.score - a.score)[0];
    expect(
      best.v.ok,
      `Step 12: the primary generated video (${best.out.filename}) failed quality: ${best.v.failures.join("; ")}`
    ).toBe(true);
    // The frozen target is ~3s: the primary output should carry roughly TARGET_LENGTH
    // frames (allow generous slack for the graph's fps / trimming).
    const p = best.v.probe!;
    if (p.nbFrames > 0) expect(p.nbFrames, `primary ~${TARGET_LENGTH}f (3s)`).toBeGreaterThanOrEqual(Math.floor(TARGET_LENGTH * 0.6));
    if (p.durationSec > 0) expect(p.durationSec, "primary ~3s of content").toBeGreaterThanOrEqual(2.0);
    console.log(`  [step12] primary ${best.out.filename} OK: ${p.width}x${p.height}, ${p.nbFrames}f, ${p.durationSec.toFixed(2)}s (${verdicts.filter((x) => x.v.ok).length}/${verdicts.length} outputs pass)`);
  }

  // Validated → answer Pass.
  const passChoice =
    (q.data?.choices ?? []).find((c) => /^pass\b/i.test(c)) ?? "Pass — outputs verified correct";
  await recordDecision(request, taskId, q.id, passChoice, false);
  answered.add(q.id);
  console.log(`  [step12] validated (${result.outputs.length} outputs) → answered "${passChoice}"`);
}

/** Regression-guard the capacity fixes after Step 08 completes. */
async function assertStep08CapacityConfig(request: APIRequestContext, taskId: string): Promise<void> {
  const cfg = await getArtifactJson<any>(request, taskId, "effective-run-config.json");
  expect(cfg, "effective-run-config.json must exist after Step 08").toBeTruthy();
  expect(cfg.reduced_tier, "reduced tier accepted").toBe(true);
  // The exact bug we fixed: a null reduced_prompt_path meant Step 12 shipped full-size.
  expect(cfg.reduced_prompt_path, "reduced workflow must be generated (not null)").toBeTruthy();
  expect(Array.isArray(cfg.vram_flags) && cfg.vram_flags.includes("--lowvram"), "reduced tier runs --lowvram").toBe(true);
  const changes = cfg.recommended_reduced_setting?.changes;
  expect(Array.isArray(changes) && changes.length > 0, "structured reduced changes present").toBe(true);
  // WAN2.2 <=5 s frame cap: every frame change lands within the 5 s budget (<=120 @ 24fps).
  for (const ch of changes) {
    if (typeof ch?.kind === "string" && ch.kind.includes("frames") && typeof ch.new === "number") {
      expect(ch.new, `frame input ${ch.input} clamped to <=5s`).toBeLessThanOrEqual(120);
    }
  }
  console.log(`  [step08] capacity config OK: reduced_tier, reduced_prompt_path, --lowvram, <=5s frames`);
}

async function assertGuiForStep(page: Page, stepId: string, label: string): Promise<void> {
  await page.goto("/");
  await page.locator(".task-item", { hasText: TASK_ITEM_TEXT }).first().click({ force: true }).catch(() => {});
  await expect(page.locator(".pipeline-node").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".step-progress-label")).toBeVisible();
  console.log(`  [gui] Step ${stepId} (${label}): GUI ok`);
}

function stepStatus(steps: { id: string; status: string }[], id: string): string | undefined {
  return steps.find((s) => s.id === id)?.status;
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe("WAN2.2 video-edit migration @migration @wan22", () => {
  test.beforeAll(async ({ request }) => {
    // Clear the orchestrator's one-run-per-process lock: hard-stop + delete every task.
    for (const t of await listTasks(request)) {
      await hardStop(request, t.id, "wan22 e2e: clean slate").catch(() => {});
      await deleteTask(request, t.id).catch(() => {});
    }
  });

  test("drives WAN2.2 00→12b, auto-answers gates, executes+validates the Step-12 render", async ({ page, request }) => {
    const budget = DEPTH === "full" ? FULL_BUDGET_MS : CAPACITY_BUDGET_MS;
    test.setTimeout(budget);

    const task = await createTask(
      request,
      WORKFLOW_FILE
        ? { workflowFileName: WORKFLOW_FILE.split("/").pop()!, fixturePath: WORKFLOW_FILE, gpuNode: GPU_NODE }
        : { workflowFileName: FIXTURE_NAME, gpuNode: GPU_NODE }
    );
    const taskId = task.id;
    console.log(`\n=== WAN2.2 migration task ${taskId} (depth=${DEPTH}, gpuNode=${GPU_NODE}) ===`);
    const seenCompleted = new Set<string>();
    let step08Asserted = false;

    try {
      const deadline = Date.now() + budget;
      await runUntilGate(request, taskId);

      while (Date.now() < deadline) {
        const t = await getTask(request, taskId);
        const blocking = t.steps.find((s) =>
          ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(s.status)
        );

        // Any failure / hard-stop is a real regression for WAN2.2 (it should reach the
        // reduced tier and finish) — surface it loudly.
        if (blocking && ["failed", "hard_stopped", "terminated"].includes(blocking.status)) {
          await assertGuiForStep(page, blocking.id, blocking.status);
          throw new Error(`Step ${blocking.id} ${blocking.status}: ${blocking.error ?? "unknown"}`);
        }

        if (blocking?.status === "waiting_for_human") {
          if (blocking.id === "12") {
            await executeAndValidateStep12(request, taskId);
          } else {
            await handleGate(request, taskId, blocking.id);
          }
          await sleep(5_000);
          await runUntilGate(request, taskId); // resume
        }

        // GUI assertion at each newly-completed step + capacity assertion after Step 08.
        for (const s of t.steps) {
          if (s.status === "completed" && !seenCompleted.has(s.id)) {
            seenCompleted.add(s.id);
            await assertGuiForStep(page, s.id, "completed");
          }
        }
        if (!step08Asserted && stepStatus(t.steps, "08") === "completed") {
          step08Asserted = true;
          await assertStep08CapacityConfig(request, taskId);
          if (DEPTH === "capacity") {
            console.log(`\n=== PASS (capacity depth): Step 08 reduced tier accepted + config validated ===`);
            return;
          }
        }

        // Full-depth success: final delivery (12b) completed. Never trigger Step 13.
        if (stepStatus(t.steps, "12b") === "completed") {
          expect(stepStatus(t.steps, "12"), "Step 12 GUI acceptance completed").toBe("completed");
          console.log(`\n=== PASS (full depth): WAN2.2 pipeline completed through 12b (Step 13 not run) ===`);
          return;
        }

        await sleep(POLL_MS);
      }
      throw new Error(`Ran out of budget (${Math.round(budget / 3.6e6)}h); last completed: ${[...seenCompleted].join(",")}`);
    } finally {
      await hardStop(request, taskId, "wan22 e2e: cleanup").catch(() => {});
      await deleteTask(request, taskId).catch(() => {});
    }
  });
});
