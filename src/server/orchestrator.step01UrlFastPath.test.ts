import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator, type SuggestedUrlDownloader } from "./orchestrator";
import { StateStore } from "./state";

// Fix 2/3: a Step-01 human answer that pastes exact source URLs must route each
// URL (matched by basename) to an async download sub-job and return to the gate
// promptly -- no more "only 1 URL + 1 item", no subfolder-prefix mismatch, no
// minutes-long synchronous re-search wedge. Confirmed field incident.

function makeConfig(root: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: "/tmp/comfy",
    modelRoots: ["/home/intel/hf_models"],
    gpuNodesPath: path.join(root, "gpu-nodes.json"),
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    taskArchiveRoot: path.join(root, "task-archive"),
    assetResolutionLedgerPath: path.join(root, "asset-resolutions.jsonl"),
    answerLogPath: path.join(root, "answer-log.jsonl"),
    answerDefaultsPath: path.join(root, "answer-defaults.jsonl"),
    answerDefaultsEnabled: false,
    autoApproveAgentPermissions: false
  };
}

async function seedGatedStep01(
  store: StateStore,
  task: MigrationTask,
  unresolvedItems: Array<{ assetName: string; requestedName: string; targetPath: string }>
): Promise<void> {
  await store.updateStep(task.id, "01", "waiting_for_human", { summary: "waiting for sources" });
  await fs.writeFile(
    path.join(task.artifactPath, "01-gate-signal.json"),
    JSON.stringify({ stepId: "01", gated: true, category: "missing_asset", reason: "missing assets" }),
    "utf8"
  );
  await fs.writeFile(
    path.join(task.artifactPath, "01-acquisition-job.json"),
    JSON.stringify({
      status: "waiting_for_secure_download",
      unresolvedItems: unresolvedItems.map((it) => ({
        ...it,
        kind: "model asset",
        sourceContext: "",
        candidateCount: 3,
        searchIssueCount: 0,
        nextAction: "provide source"
      }))
    }),
    "utf8"
  );
}

function orchestratorWith(config: AppConfig, store: StateStore, calls: Array<{ assetName: string; url: string }>): MigrationOrchestrator {
  const downloader: SuggestedUrlDownloader = {
    async startSubJobForSuggestedUrl(_task, assetName, url) {
      calls.push({ assetName, url });
      return {};
    }
  };
  return new MigrationOrchestrator(
    config,
    store,
    [{ id: "01", name: "Asset and custom-node resolution", requiredOutput: "01-assets.csv", humanIntervention: "Provide sources" }],
    { runStep: async () => ({ sessionId: "x", summary: "x" }) },
    downloader
  );
}

describe("Step 01 human-URL fast path", () => {
  it("starts one async download per unambiguously basename-matched URL, incl. a subfolder-prefixed asset, and returns to the gate", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-step01-url-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const calls: Array<{ assetName: string; url: string }> = [];
    const orchestrator = orchestratorWith(config, store, calls);
    const task = await orchestrator.createTask({ name: "UrlFastPath", workflowFileName: "wf.json", workflowJson: { nodes: [], links: [] } });
    await seedGatedStep01(store, task, [
      { assetName: "SD1.5/vaeFtMse840000Ema_v10.safetensors", requestedName: "SD1.5/vaeFtMse840000Ema_v10.safetensors", targetPath: "/nfs/vae/SD1.5/vaeFtMse840000Ema_v10.safetensors" },
      { assetName: "majicmixRealistic_v7.safetensors", requestedName: "majicmixRealistic_v7.safetensors", targetPath: "/nfs/diffusion_models/majicmixRealistic_v7.safetensors" }
    ]);

    const q = await store.appendEvent({ taskId: task.id, stepId: "01", type: "human_question", message: "need sources", data: { question: "?", allowFreeform: true, blockingReason: "missing_asset" } });
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: q.id,
      answer: [
        "https://huggingface.co/Server9/VAE/resolve/main/vaeFtMse840000Ema_v10.safetensors",
        "https://civitai.com/api/download/models/xyz/majicmixRealistic_v7.safetensors"
      ].join("\n"),
      wasFreeform: true
    });

    // One download started per matched asset (the subfolder-prefixed VAE included).
    expect(calls.map((c) => c.assetName).sort()).toEqual([
      "SD1.5/vaeFtMse840000Ema_v10.safetensors",
      "majicmixRealistic_v7.safetensors"
    ]);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "01")?.status).toBe("waiting_for_human");
    expect(updated?.steps.find((s) => s.id === "01")?.summary).toContain("background download");
  });

  it("does not auto-route a URL whose basename matches more than one unresolved asset (ambiguous), but still routes the unambiguous one", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-step01-ambig-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const calls: Array<{ assetName: string; url: string }> = [];
    const orchestrator = orchestratorWith(config, store, calls);
    const task = await orchestrator.createTask({ name: "UrlAmbig", workflowFileName: "wf.json", workflowJson: { nodes: [], links: [] } });
    await seedGatedStep01(store, task, [
      { assetName: "SD1.5/dup.safetensors", requestedName: "SD1.5/dup.safetensors", targetPath: "/nfs/a/dup.safetensors" },
      { assetName: "SDXL/dup.safetensors", requestedName: "SDXL/dup.safetensors", targetPath: "/nfs/b/dup.safetensors" },
      { assetName: "unique.safetensors", requestedName: "unique.safetensors", targetPath: "/nfs/c/unique.safetensors" }
    ]);

    const q = await store.appendEvent({ taskId: task.id, stepId: "01", type: "human_question", message: "need sources", data: { question: "?", allowFreeform: true, blockingReason: "missing_asset" } });
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: q.id,
      answer: [
        "https://huggingface.co/x/y/resolve/main/dup.safetensors",       // ambiguous -> not routed
        "https://huggingface.co/x/y/resolve/main/unique.safetensors"      // routed
      ].join(" "),
      wasFreeform: true
    });

    expect(calls).toEqual([{ assetName: "unique.safetensors", url: "https://huggingface.co/x/y/resolve/main/unique.safetensors" }]);
  });
});
