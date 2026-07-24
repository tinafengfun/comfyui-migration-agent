import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";

/**
 * Verifies the new post-Step-13 human-approval gate end to end: Step 13's
 * SDK session completes, produces a real 13-agent-improvement.json with
 * pending items, and the orchestrator must pause for approval instead of
 * completing the step outright -- then, once a human answers, apply the
 * approval decisions and only then let the step complete. Part of the fix
 * for "Step 13 proposals never actually go anywhere" (see plan Part B).
 */
async function setupTask(): Promise<{
  orchestrator: MigrationOrchestrator;
  store: StateStore;
  taskId: string;
  artifactPath: string;
}> {
  const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step13-gate-${Date.now()}`);
  const config: AppConfig = {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: path.join(root, "ComfyUI"),
    modelRoots: [path.join(root, "models")],
    gpuNodesPath: path.join(root, "gpu-nodes.json"),
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    autoApproveAgentPermissions: false
  };
  await ensureDir(config.workspaceRoot);
  await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
  const store = new StateStore(config);
  await store.initialize();

  const orchestrator = new MigrationOrchestrator(
    config,
    store,
    [
      {
        id: "13",
        name: "Agent improvement and playbook hardening",
        requiredOutput: "13-agent-improvement.* / 13-playbook-patch-plan.md / 13-phase3-readiness.json / 13-reflection.*",
        humanIntervention: "Approve medium/high-risk changes."
      }
    ],
    {
      async runStep(job, emit) {
        // Simulate Step 13's SDK session writing its real output files, then
        // returning a summary -- mirroring what the real Copilot session does.
        const artifactPath = job.artifactPath;
        await fs.writeFile(path.join(artifactPath, "13-agent-improvement.md"), "# improvements\n", "utf8");
        await fs.writeFile(
          path.join(artifactPath, "13-agent-improvement.json"),
          JSON.stringify({
            step_id: "13",
            improvements: [
              { id: "I01", risk_tier: "low_risk_doc_only", root_cause: "r1", proposed_change: "p1", apply_status: "patch_plan_only" },
              { id: "I02", risk_tier: "medium_prompt_skill_contract", root_cause: "r2", proposed_change: "p2", apply_status: "patch_plan_only" }
            ]
          }),
          "utf8"
        );
        await fs.writeFile(path.join(artifactPath, "13-playbook-patch-plan.md"), "# patch plan\n", "utf8");
        await fs.writeFile(path.join(artifactPath, "13-phase3-readiness.json"), "{}\n", "utf8");
        await fs.writeFile(path.join(artifactPath, "13-reflection.md"), "# reflection\n", "utf8");
        await fs.writeFile(path.join(artifactPath, "13-reflection.json"), "{}\n", "utf8");
        await emit({ taskId: job.taskId, stepId: job.stepId, type: "progress", message: "Step 13 SDK session ran." });
        return { sessionId: "fake-session", summary: "Step 13 completed with 2 proposed improvements." };
      }
    }
  );

  const task = await orchestrator.createTask({
    name: "Step13 gate test",
    workflowFileName: "workflow.json",
    workflowJson: { nodes: [], links: [] }
  });
  return { orchestrator, store, taskId: task.id, artifactPath: task.artifactPath };
}

describe("Step 13 improvement approval gate", () => {
  it("pauses for human approval instead of completing when items are patch_plan_only", async () => {
    const { orchestrator, store, taskId, artifactPath } = await setupTask();

    await orchestrator.runStep(taskId, "13");

    const task = await store.getTask(taskId);
    expect(task?.steps.find((s) => s.id === "13")?.status).toBe("waiting_for_human");

    const question = (await store.listEvents(taskId)).find((event) => event.type === "human_question");
    expect(question).toBeDefined();
    expect(question?.message).toContain("2 improvement(s)");
    expect(JSON.stringify(question?.data)).toContain("I01");
    expect(JSON.stringify(question?.data)).toContain("I02");

    const state = JSON.parse(await fs.readFile(path.join(artifactPath, "13-agent-improvement.json"), "utf8"));
    expect(state.improvements.every((i: { apply_status: string }) => i.apply_status === "waiting_for_human_approval")).toBe(true);
  });

  it("applies the human's approval decision and only then completes the step", async () => {
    const { orchestrator, store, taskId, artifactPath } = await setupTask();
    await orchestrator.runStep(taskId, "13");
    const question = (await store.listEvents(taskId)).find((event) => event.type === "human_question");

    await orchestrator.recordHumanDecision({
      taskId,
      stepId: "13",
      questionEventId: question?.id ?? "",
      answer: "approve: I02",
      wasFreeform: true
    });

    const task = await store.getTask(taskId);
    expect(task?.steps.find((s) => s.id === "13")?.status).toBe("completed");

    const state = JSON.parse(await fs.readFile(path.join(artifactPath, "13-agent-improvement.json"), "utf8"));
    const byId = Object.fromEntries(state.improvements.map((i: { id: string; apply_status: string }) => [i.id, i.apply_status]));
    expect(byId.I01).toBe("do_not_apply");
    expect(byId.I02).toBe("approved_to_apply");
  });

  it("completes normally without a gate when Step 13 proposes zero improvements", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step13-nogate-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        {
          id: "13",
          name: "Agent improvement and playbook hardening",
          requiredOutput: "13-agent-improvement.* / 13-playbook-patch-plan.md / 13-phase3-readiness.json / 13-reflection.*",
          humanIntervention: ""
        }
      ],
      {
        async runStep(job) {
          const artifactPath = job.artifactPath;
          await fs.writeFile(path.join(artifactPath, "13-agent-improvement.md"), "# improvements\n", "utf8");
          await fs.writeFile(
            path.join(artifactPath, "13-agent-improvement.json"),
            JSON.stringify({ step_id: "13", improvements: [] }),
            "utf8"
          );
          await fs.writeFile(path.join(artifactPath, "13-playbook-patch-plan.md"), "# patch plan\n", "utf8");
          await fs.writeFile(path.join(artifactPath, "13-phase3-readiness.json"), "{}\n", "utf8");
          await fs.writeFile(path.join(artifactPath, "13-reflection.md"), "# reflection\n", "utf8");
          await fs.writeFile(path.join(artifactPath, "13-reflection.json"), "{}\n", "utf8");
          return { sessionId: "fake-session", summary: "Step 13 completed with zero proposed improvements." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Step13 no-gate test",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runStep(task.id, "13");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "13")?.status).toBe("completed");
    expect((await store.listEvents(task.id)).some((event) => event.type === "human_question")).toBe(false);
  });
});
