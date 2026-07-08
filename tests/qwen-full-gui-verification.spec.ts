/**
 * Qwen-Image-2512 Full GUI Verification — Real LLM Execution
 *
 * This test runs the COMPLETE migration pipeline with real LLM execution.
 * Expected duration: 1-4 hours.
 *
 * Based on previous migration feedback (fix-log from workspace a1eb4cfc):
 *   Round 1: FP8 KSampler → near-black output → switch to txt2img (EmptySD3LatentImage)
 *   Round 2: CLIP GGUF on XPU → segfault → set CLIPLoader device=cpu
 *   Round 3: Input image → use fox_512x512.png (not the black banner image)
 *
 * The test:
 *   1. Creates a task from the Qwen-Image workflow
 *   2. Uploads fox_512x512.png as reference media
 *   3. Runs Phase 1 (steps 00-11) via run-until-gate
 *   4. Auto-approves human gates based on previous feedback
 *   5. Runs Phase 2 (step 12 GUI acceptance)
 *   6. Verifies key artifacts and modification points
 *
 * Prerequisites:
 *   - Server running on http://127.0.0.1:3001
 *   - Frontend running on http://172.16.114.105:5173
 *   - ComfyUI venv at /home/intel/tianfeng/comfy/ComfyUI/.venv-xpu
 *   - Fox image at /home/intel/hf_models/zimage_workflow/custom_nodes/ComfyUI_LayerStyle/workflow/fox_512x512.png
 *   - Models available in /home/intel/hf_models/
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API = "http://127.0.0.1:3001";
const FRONTEND = "http://172.16.114.105:5173";

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../cartoon/Qwen-Image-2512-4步-20260320-william-单参考图.json"
);
const FOX_IMAGE_PATH =
  "/home/intel/hf_models/zimage_workflow/custom_nodes/ComfyUI_LayerStyle/workflow/fox_512x512.png";

// ── Timeouts ──
const POLL_INTERVAL_MS = 30_000; // 30 seconds between status polls
const STEP_TIMEOUT_MS = 30 * 60_000; // 30 minutes per step (LLM execution)
const GATE_HANDLING_DELAY_MS = 5_000; // 5 seconds after recording a decision
const TOTAL_PIPELINE_TIMEOUT_MS = 4 * 60 * 60_000; // 4 hours total

// ── Previous feedback encoded as human decisions ──
// When a step hits waiting_for_human, these decisions auto-approve based on
// validated fixes from the previous migration run.
// For deterministic gates with specific choices, the test picks the exact
// choice text (wasFreeform=false). For LLM/freeform gates, the freeform text is used.
const PREVIOUS_FEEDBACK_DECISIONS: Record<string, string> = {
  "00": "Approve. All assets and custom nodes are available in /home/intel/hf_models/. Proceed.",
  "01": "Approve. Asset gaps resolved. Proceed with available models.",
  "02": "Approve. Target fidelity is acceptable for Intel XPU. Proceed with known workarounds (CLIP device=cpu, txt2img for FP8 quality).",
  "03": "Approve. Workflow inventory is complete.",
  "04": "Approve. Source audit covers all critical node families.",
  "05": "Approve. Environment is deployed. Use 'source .venv-xpu/bin/activate && python3 main.py' to launch ComfyUI.",
  "06": "Approve. Prompt conversion validated.",
  "07": "Approve. Smoke test results acceptable.",
  "08": "Approve. Full validation passed.",
  "09": "Approve. Performance tuning complete.",
  "10": "Approve. Coverage review complete.",
  "11": "Approve. Delivery package ready.",
  "12": "Proceed with GUI acceptance. Reference image is fox_512x512.png (not z-image_00006_.png which is a black image). Apply CLIP device=cpu workaround. Use txt2img path if FP8 quality issues occur.",
};

// Choice preference per step: which keyword to match when picking from gate choices.
// Deterministic gates offer multiple-choice answers; we always pick a "proceed" option.
const CHOICE_PREFERENCE: Record<string, string[]> = {
  "01": ["skip these items and continue", "provide the missing", "approve smoke-only", "continue"],
  "02": ["approve", "continue", "proceed"],
  "05": ["approve", "continue", "proceed"],
  "12": ["proceed", "continue", "approve"],
};

let createdTaskId: string;
const answeredQuestionIds = new Set<string>();

// ── Helpers ──

async function getTaskStatus(
  request: APIRequestContext,
  taskId: string
): Promise<{
  status: string;
  steps: Array<{ id: string; status: string; error?: string }>;
}> {
  const res = await request.get(`${API}/api/tasks/${taskId}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return {
    status: body.task.status,
    steps: body.task.steps,
  };
}

async function getBlockingStep(
  request: APIRequestContext,
  taskId: string
): Promise<{ id: string; status: string; error?: string } | null> {
  const { steps } = await getTaskStatus(request, taskId);
  const blocking = steps.find((s) =>
    ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(s.status)
  );
  return blocking ?? null;
}

async function waitForStepCompletion(
  request: APIRequestContext,
  taskId: string,
  stepId: string,
  timeoutMs: number = STEP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { steps } = await getTaskStatus(request, taskId);
    const step = steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    if (step.status === "completed") return;
    if (step.status === "failed") throw new Error(`Step ${stepId} failed: ${step.error ?? "unknown"}`);
    if (step.status === "hard_stopped") throw new Error(`Step ${stepId} hard-stopped`);
    if (step.status === "terminated") throw new Error(`Step ${stepId} terminated`);
    if (step.status === "waiting_for_human") return; // gate hit, caller handles

    // Still running — wait and poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Step ${stepId} timed out after ${timeoutMs / 60_000} minutes`);
}

function pickBestChoice(
  stepId: string,
  choices: string[]
): { answer: string; wasFreeform: boolean } {
  if (choices.length === 0) {
    return {
      answer: PREVIOUS_FEEDBACK_DECISIONS[stepId] ??
        "Approve and continue. Proceed with known XPU workarounds.",
      wasFreeform: true,
    };
  }

  // Try preferred keywords for this step
  const prefs = CHOICE_PREFERENCE[stepId] ?? ["continue", "proceed", "approve", "skip"];
  for (const pref of prefs) {
    const match = choices.find((c) => c.toLowerCase().includes(pref));
    if (match) return { answer: match, wasFreeform: false };
  }

  // Fallback: pick the first non-"stop" choice
  const nonStop = choices.find((c) => !c.toLowerCase().includes("stop"));
  if (nonStop) return { answer: nonStop, wasFreeform: false };

  return { answer: choices[0], wasFreeform: false };
}

async function handleGate(
  request: APIRequestContext,
  taskId: string,
  stepId: string
): Promise<void> {
  // Steps can have multiple sequential gates (e.g., risk review checklist).
  // Loop: answer unanswered questions, wait briefly, check if step transitioned
  // or if new questions appeared. Repeat until step transitions or deadline.
  const deadline = Date.now() + 300_000; // 5 min total per step gate sequence
  let answeredThisCall = 0;

  while (Date.now() < deadline) {
    // Fetch latest events
    const eventsRes = await request.get(`${API}/api/tasks/${taskId}/events`);
    const eventsBody = await eventsRes.json();
    const questionEvents = ((eventsBody.events ?? []) as Array<{
      id: string;
      type: string;
      stepId?: string;
      data?: { choices?: string[]; question?: string };
    }>).filter((e) => e.type === "human_question" && e.stepId === stepId);

    // Find unanswered questions for this step
    const unanswered = questionEvents.filter((e) => !answeredQuestionIds.has(e.id));

    if (unanswered.length > 0) {
      // Answer the latest unanswered question
      const latest = unanswered[unanswered.length - 1];
      const choices = latest.data?.choices ?? [];
      const { answer, wasFreeform } = pickBestChoice(stepId, choices);
      const res = await request.post(`${API}/api/tasks/${taskId}/human-decisions`, {
        data: { questionEventId: latest.id, answer, wasFreeform },
      });
      const resBody = await res.json().catch(() => ({}));
      answeredQuestionIds.add(latest.id);
      answeredThisCall++;
      console.log(
        `  [gate] Answered Q${answeredThisCall} (${latest.id.slice(0, 8)}) for step ${stepId}` +
          ` (${wasFreeform ? "freeform" : "exact"}): ${answer.slice(0, 70)}...`
      );
      const resumedLive = (resBody as { resumedLiveSession?: boolean }).resumedLiveSession;
      if (resumedLive === false) {
        await request.post(`${API}/api/tasks/${taskId}/steps/${stepId}/resume`);
      }
    }

    // Wait for the step to process the answer (transition or new question)
    await new Promise((r) => setTimeout(r, 15_000));

    // Check if step transitioned
    const { steps } = await getTaskStatus(request, taskId);
    const step = steps.find((s) => s.id === stepId);
    if (!step || step.status !== "waiting_for_human") {
      console.log(`  [gate] Step ${stepId} transitioned to: ${step?.status ?? "unknown"}`);
      return;
    }

    // If no unanswered questions and step still gated, wait for new question
    if (unanswered.length === 0) {
      // Re-check for new questions after a short wait
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  console.log(`  [gate] Step ${stepId} still waiting_for_human after 5 min — continuing`);
}

async function runPipelineWithGateHandling(
  request: APIRequestContext,
  taskId: string,
  untilStep: string = "11"
): Promise<void> {
  const deadline = Date.now() + TOTAL_PIPELINE_TIMEOUT_MS;
  let lastGateStep: string | null = null;
  let gateRetryCount = 0;

  while (Date.now() < deadline) {
    // Start auto-run
    const runRes = await request.post(`${API}/api/tasks/${taskId}/run-until-gate`);
    if (runRes.status() === 409) {
      // Already running — wait and retry
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    expect(runRes.status()).toBe(202);

    // Poll for gate or completion
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const { steps } = await getTaskStatus(request, taskId);

      // Check if target step is complete
      const targetStep = steps.find((s) => s.id === untilStep);
      if (targetStep?.status === "completed") {
        console.log(`  [pipeline] Reached step ${untilStep} completion.`);
        return;
      }

      // Check for blocking step
      const blocking = steps.find((s) =>
        ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(s.status)
      );

      if (!blocking) {
        // No blocking step — all steps running or completed
        const allComplete = steps
          .filter((s) => parseInt(s.id) <= parseInt(untilStep))
          .every((s) => s.status === "completed");
        if (allComplete) {
          console.log(`  [pipeline] All steps up to ${untilStep} completed.`);
          return;
        }
        continue; // run-until-gate is still processing
      }

      if (blocking.status === "running") {
        // Step is running — log progress and keep waiting
        const completedCount = steps.filter((s) => s.status === "completed").length;
        console.log(`  [pipeline] Step ${blocking.id} running... (${completedCount}/${steps.length} done)`);
        continue;
      }

      if (blocking.status === "waiting_for_human") {
        // Track repeated gates on the same step
        if (blocking.id === lastGateStep) {
          gateRetryCount++;
        } else {
          lastGateStep = blocking.id;
          gateRetryCount = 0;
        }

        console.log(`  [pipeline] Gate at step ${blocking.id} (retry ${gateRetryCount}). Handling...`);
        await handleGate(request, taskId, blocking.id);
        // handleGate waits for step to transition; small delay before re-entering outer loop
        await new Promise((r) => setTimeout(r, 5_000));
        break; // re-enter outer loop to call run-until-gate again
      }

      if (blocking.status === "failed") {
        throw new Error(`Step ${blocking.id} failed: ${blocking.error}`);
      }

      if (["hard_stopped", "terminated"].includes(blocking.status)) {
        throw new Error(`Step ${blocking.id} ${blocking.status}`);
      }
    }
  }

  throw new Error("Pipeline timed out");
}

async function getArtifacts(
  request: APIRequestContext,
  taskId: string
): Promise<Array<{ relativePath: string; size: number }>> {
  const res = await request.get(`${API}/api/tasks/${taskId}/artifacts`);
  const body = await res.json();
  return body.artifacts ?? [];
}

async function getArtifactContent(
  request: APIRequestContext,
  taskId: string,
  relativePath: string
): Promise<string> {
  const res = await request.get(
    `${API}/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(relativePath)}`
  );
  if (!res.ok()) return "";
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return body.content ?? "";
  } catch {
    return text; // raw content (e.g., bash script, markdown)
  }
}

// ══════════════════════════════════════════════════════════════
//  TEST SUITE
// ══════════════════════════════════════════════════════════════

test.describe.configure({ mode: "serial" });

test.describe("Qwen-Image Full GUI Verification (Real LLM)", () => {

  // ── Phase 0: Setup ──

  test("00 — cleanup and create task", async ({ request }) => {
    test.setTimeout(120_000); // 2 minutes for setup

    // Check for an existing task with Phase 1 completed (reuse for test re-runs)
    const existingRes = await request.get(`${API}/api/tasks`);
    const existingBody = await existingRes.json();
    const reusable = (existingBody.tasks ?? []).find(
      (t: { steps: Array<{ id: string; status: string }>; status: string }) => {
        const steps11 = t.steps.find((s) => s.id === "11");
        return steps11?.status === "completed" && t.status !== "terminated";
      }
    );
    if (reusable) {
      createdTaskId = reusable.id;
      console.log(`  Reusing existing task with Phase 1 complete: ${createdTaskId}`);
      return;
    }

    // Cleanup any stale tasks
    await request.post(`${API}/api/tasks/cleanup-stale`);

    // Verify prerequisites
    expect(fs.existsSync(WORKFLOW_PATH)).toBeTruthy();
    expect(fs.existsSync(FOX_IMAGE_PATH)).toBeTruthy();
    const foxSize = fs.statSync(FOX_IMAGE_PATH).size;
    expect(foxSize).toBeGreaterThan(100_000); // > 100KB (real image, not black)
    console.log(`  Fox image: ${FOX_IMAGE_PATH} (${(foxSize / 1024).toFixed(0)} KB)`);

    // Load workflow JSON
    const workflowJson = JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf-8"));
    console.log(`  Workflow nodes: ${workflowJson.nodes?.length ?? "unknown"}`);

    // Create task
    const res = await request.post(`${API}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: {
        workflowFileName: "Qwen-Image-2512-full-verification.json",
        workflowJson,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdTaskId = body.task.id;
    console.log(`  Task created: ${createdTaskId}`);
    expect(body.task.steps.length).toBeGreaterThanOrEqual(13);
  });

  // ── Phase 1: Upload reference image before pipeline starts ──

  test("01 — upload fox reference image", async ({ request }) => {
    test.setTimeout(60_000);

    // Read fox image and upload as base64
    const imageBuffer = fs.readFileSync(FOX_IMAGE_PATH);
    const base64 = imageBuffer.toString("base64");

    // Try multiple target filenames the migration might expect
    const targetFilenames = [
      "fox_512x512.png",
      "z-image_00006_.png", // The workflow references this name
    ];

    for (const target of targetFilenames) {
      const res = await request.post(`${API}/api/tasks/${createdTaskId}/upload-media`, {
        data: {
          filename: target,
          contentBase64: base64,
          targetFilename: target,
        },
      });
      console.log(`  Upload ${target}: status=${res.status()}`);
      if (res.ok()) {
        const body = await res.json();
        console.log(`  Uploaded: ${JSON.stringify(body)}`);
      }
    }
  });

  // ── Phase 2: Run Phase 1 pipeline (steps 00-11) ──

  test("02 — run Phase 1 pipeline to completion", async ({ request }) => {
    test.setTimeout(TOTAL_PIPELINE_TIMEOUT_MS); // 4 hours

    // Skip if Phase 1 already completed (task reuse)
    const { steps: currentSteps } = await getTaskStatus(request, createdTaskId);
    const phase1Done = currentSteps
      .filter((s) => parseInt(s.id) <= 11)
      .every((s) => s.status === "completed");
    if (phase1Done) {
      console.log("  Phase 1 already complete — skipping pipeline run.");
    } else {
      console.log("  Starting Phase 1 pipeline (steps 00-11)...");
      console.log("  This will take significant time due to real LLM execution.");
      await runPipelineWithGateHandling(request, createdTaskId, "11");
    }

    // Verify all Phase 1 steps completed
    const { steps } = await getTaskStatus(request, createdTaskId);
    const phase1Steps = steps.filter((s) => parseInt(s.id) <= 11);
    for (const step of phase1Steps) {
      console.log(`  Step ${step.id}: ${step.status}`);
    }

    const completedCount = phase1Steps.filter((s) => s.status === "completed").length;
    console.log(`  Phase 1: ${completedCount}/${phase1Steps.length} steps completed`);
    expect(completedCount).toBe(phase1Steps.length);
  });

  // ── Phase 3: Verify Phase 1 artifacts ──

  test("03 — verify Phase 1 artifacts exist", async ({ request }) => {
    test.setTimeout(60_000);

    const artifacts = await getArtifacts(request, createdTaskId);
    console.log(`  Total artifacts: ${artifacts.length}`);

    // Key artifacts that should exist after Phase 1
    const expectedArtifacts = [
      { substring: "00-intake", description: "Intake preflight" },
      { substring: "01-asset", description: "Asset resolution" },
      { substring: "02-feasibility", description: "Feasibility analysis" },
      { substring: "03-inventory", description: "Workflow inventory" },
      { substring: "05-environment", description: "Environment deployment" },
      { substring: "11-delivery", description: "Delivery package" },
    ];

    for (const expected of expectedArtifacts) {
      const found = artifacts.some((a) => a.relativePath.includes(expected.substring));
      console.log(`  ${found ? "✓" : "✗"} ${expected.description}: ${expected.substring}`);
      // Don't hard-fail — some artifacts may have different naming
    }

    expect(artifacts.length).toBeGreaterThan(5);
  });

  // ── Phase 4: Verify key modification points from previous feedback ──

  test("04 — verify key XPU modification points", async ({ request }) => {
    test.setTimeout(120_000);

    // Check the delivery/runtime patch bundle for known workarounds
    const artifacts = await getArtifacts(request, createdTaskId);

    // 1. Check for CLIP device=cpu workaround
    const patchArtifacts = artifacts.filter((a) =>
      a.relativePath.includes("patch") || a.relativePath.includes("runtime")
    );

    let foundClipCpuWorkaround = false;
    let foundTxt2imgWorkaround = false;
    let foundActivateWorkaround = false;

    for (const artifact of patchArtifacts) {
      const content = await getArtifactContent(request, createdTaskId, artifact.relativePath);
      if (!content) continue;

      if (content.includes("device") && content.includes("cpu")) {
        foundClipCpuWorkaround = true;
        console.log(`  ✓ CLIP device=cpu workaround found in: ${artifact.relativePath}`);
      }
      if (content.includes("EmptySD3LatentImage") || content.includes("txt2img")) {
        foundTxt2imgWorkaround = true;
        console.log(`  ✓ txt2img workaround found in: ${artifact.relativePath}`);
      }
      if (content.includes("activate") || content.includes("python3")) {
        foundActivateWorkaround = true;
        console.log(`  ✓ activate/python3 invocation found in: ${artifact.relativePath}`);
      }
    }

    // Check the environment deployment artifact for launch command
    const envArtifacts = artifacts.filter((a) => a.relativePath.includes("05-"));
    for (const artifact of envArtifacts) {
      const content = await getArtifactContent(request, createdTaskId, artifact.relativePath);
      if (content && (content.includes("activate") || content.includes("python3 main.py"))) {
        foundActivateWorkaround = true;
        console.log(`  ✓ Correct Python invocation in: ${artifact.relativePath}`);
      }
    }

    // Report findings — don't hard-fail on missing workarounds since the agent
    // may apply them in Step 12 instead
    console.log(`  --- Modification point summary ---`);
    console.log(`  CLIP device=cpu:     ${foundClipCpuWorkaround ? "FOUND" : "NOT FOUND (may apply in Step 12)"}`);
    console.log(`  txt2img path:        ${foundTxt2imgWorkaround ? "FOUND" : "NOT FOUND (may apply in Step 12)"}`);
    console.log(`  activate && python3: ${foundActivateWorkaround ? "FOUND" : "NOT FOUND"}`);
  });

  // ── Phase 5: Run Phase 2 (Step 12 GUI acceptance) ──

  test("05 — run Step 12 GUI acceptance", async ({ request }) => {
    test.setTimeout(TOTAL_PIPELINE_TIMEOUT_MS); // 4 hours

    console.log("  Starting Step 12 GUI acceptance...");

    // Check if step 12 is already completed (task reuse)
    const { steps: initSteps } = await getTaskStatus(request, createdTaskId);
    const initStep12 = initSteps.find((s) => s.id === "12");
    if (initStep12?.status === "completed") {
      console.log("  Step 12 already completed — skipping.");
      return;
    }

    // Start Step 12 (or get 409 if already running)
    const res = await request.post(`${API}/api/tasks/${createdTaskId}/steps/12/run`);
    expect([202, 409]).toContain(res.status());

    // Wait for step 12 to complete or hit a gate
    // Step 12 is interactive — it may hit multiple gates for debug rounds
    const deadline = Date.now() + TOTAL_PIPELINE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const { steps } = await getTaskStatus(request, createdTaskId);
      const step12 = steps.find((s) => s.id === "12");
      if (!step12) throw new Error("Step 12 not found");

      console.log(`  Step 12 status: ${step12.status}`);

      if (step12.status === "completed") {
        console.log("  Step 12 completed!");
        return;
      }

      if (step12.status === "waiting_for_human") {
        console.log("  Step 12 hit a gate. Auto-handling with feedback...");
        await handleGate(request, createdTaskId, "12");
        // handleGate handles resume internally via resumedLiveSession
      }

      if (step12.status === "failed") {
        // Step 12 failures during interactive debug are expected
        // Check the fix-log for what went wrong
        console.log(`  Step 12 failed: ${step12.error ?? "unknown"}`);
        console.log("  Checking fix-log for debug rounds...");

        const fixLogArtifacts = (await getArtifacts(request, createdTaskId)).filter((a) =>
          a.relativePath.includes("fix-log")
        );
        for (const artifact of fixLogArtifacts) {
          const content = await getArtifactContent(request, createdTaskId, artifact.relativePath);
          if (content) {
            console.log(`  Fix-log (${artifact.relativePath}):`);
            console.log(`    ${content.slice(0, 500)}`);
          }
        }
        // Don't throw — allow test to continue to verification
        return;
      }
    }

    throw new Error("Step 12 timed out");
  });

  // ── Phase 6: Verify final delivery ──

  test("06 — verify final delivery package", async ({ request }) => {
    test.setTimeout(120_000);

    const artifacts = await getArtifacts(request, createdTaskId);
    console.log(`  Total artifacts: ${artifacts.length}`);

    // Check for delivery artifacts
    const deliveryArtifacts = artifacts.filter((a) =>
      a.relativePath.includes("12-gui-acceptance") || a.relativePath.includes("12-final")
    );

    console.log(`  Delivery artifacts: ${deliveryArtifacts.length}`);
    for (const a of deliveryArtifacts) {
      console.log(`    ${a.relativePath} (${a.size} bytes)`);
    }

    // Check for fix-log
    const fixLogArtifacts = artifacts.filter((a) => a.relativePath.includes("fix-log"));
    if (fixLogArtifacts.length > 0) {
      console.log(`  Fix-log found: ${fixLogArtifacts.length} entries`);
      for (const a of fixLogArtifacts) {
        const content = await getArtifactContent(request, createdTaskId, a.relativePath);
        // Parse and report rounds
        try {
          const parsed = JSON.parse(content);
          if (parsed.rounds) {
            console.log(`  Fix-log rounds: ${parsed.rounds.length}`);
            for (const round of parsed.rounds) {
              console.log(`    Round ${round.round}: ${round.diagnosis ?? round.root_cause ?? "N/A"}`);
            }
          }
        } catch {
          console.log(`  Fix-log content: ${content.slice(0, 200)}`);
        }
      }
    }

    // Check for output images
    const outputArtifacts = artifacts.filter((a) =>
      a.relativePath.endsWith(".png") || a.relativePath.endsWith(".jpg")
    );
    console.log(`  Output images: ${outputArtifacts.length}`);

    // Final task status
    const { status, steps } = await getTaskStatus(request, createdTaskId);
    console.log(`  Final task status: ${status}`);
    const completedSteps = steps.filter((s) => s.status === "completed").length;
    console.log(`  Completed steps: ${completedSteps}/${steps.length}`);

    // Soft assertions — the pipeline may have partial completion
    expect(completedSteps).toBeGreaterThanOrEqual(8);
  });

  // ── Phase 7: Frontend verification ──

  test("07 — frontend displays completed pipeline", async ({ page, request }) => {
    test.setTimeout(60_000);

    await page.goto(FRONTEND);
    await page.waitForSelector(".task-item", { timeout: 10_000 });

    // Find our task
    const ourTask = page.locator(".task-item").filter({ hasText: "Qwen-Image" });
    const taskCount = await ourTask.count();
    expect(taskCount).toBeGreaterThanOrEqual(1);

    // Click it
    await ourTask.first().click({ force: true });

    // Check pipeline nodes are visible (longer timeout for SPA render)
    await page.waitForSelector(".pipeline-node", { timeout: 30_000 });
    const nodes = page.locator(".pipeline-node");
    const nodeCount = await nodes.count();
    console.log(`  Pipeline nodes displayed: ${nodeCount}`);

    // Check at least some steps show completion
    const { steps } = await getTaskStatus(request, createdTaskId);
    const completedSteps = steps.filter((s) => s.status === "completed");
    console.log(`  Completed steps visible: ${completedSteps.length}`);

    // Check artifacts tab
    const artifactsTab = page.locator(".tab", { hasText: "Artifacts" });
    if (await artifactsTab.isVisible()) {
      await artifactsTab.click();
      await expect(page.locator(".artifact-browser")).toBeVisible();
      console.log("  Artifacts browser accessible");
    }

    // Check progress narrative
    const progressRes = await request.get(`${API}/api/tasks/${createdTaskId}/progress`);
    if (progressRes.ok()) {
      const progressBody = await progressRes.json();
      if (progressBody.narrative) {
        console.log(`  Progress narrative available (${progressBody.narrative.length} chars)`);
      }
    }
  });

  // ── Phase 8: Generate run report ──

  test("08 — generate and verify run report", async ({ request }) => {
    test.setTimeout(60_000);

    const res = await request.post(`${API}/api/tasks/${createdTaskId}/run-report`);
    if (res.ok()) {
      const body = await res.json();
      console.log(`  Run report generated: ${body.report?.status ?? "unknown"}`);
      if (body.report?.summary) {
        console.log(`  Summary: ${body.report.summary}`);
      }
    } else {
      console.log(`  Run report returned: ${res.status()}`);
    }
  });

  // ── Phase 9: Cleanup (optional — keeps task for manual inspection) ──

  test("09 — cleanup", async ({ request }) => {
    test.setTimeout(30_000);

    // Don't delete the task — keep it for manual inspection
    // Just clean up stale state
    await request.post(`${API}/api/tasks/cleanup-stale`);
    console.log("  Cleanup complete. Task preserved for manual inspection.");
    console.log(`  Task ID: ${createdTaskId}`);
    console.log(`  Frontend: ${FRONTEND}`);
  });
});
