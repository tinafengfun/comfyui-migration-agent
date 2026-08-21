import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";
import { CatalogStore } from "../catalog/store";
import { GitRepo } from "../catalog/gitRepo";
import { CatalogWriter } from "../catalog/writer";
import { createCatalogApp } from "../catalog/server";

vi.mock("./comfyuiLifecycle", () => ({
  ensureComfyUiUp: vi.fn().mockResolvedValue({ ok: true, action: "already_up", detail: "mock" }),
  VRAM_ESCALATION_LADDER: [["--reserve-vram", "1"]]
}));

const STEPS = [{ id: "07", name: "Branch smoke", requiredOutput: "07-branch-smoke-summary.json", humanIntervention: "" }];

function makeConfig(root: string, gpuNodesPath: string): AppConfig {
  return {
    port: 0, projectRoot: root, workspaceRoot: path.join(root, "workspaces"), stateRoot: path.join(root, "state"),
    draftDocRoot: root, comfyuiRoot: "/tmp/comfy", modelRoots: ["/nfs_share"], gpuNodesPath,
    workflowArchiveRoot: path.join(root, "wf"), taskArchiveRoot: path.join(root, "ta"),
    assetResolutionLedgerPath: path.join(root, "a.jsonl"), answerLogPath: path.join(root, "b.jsonl"),
    answerDefaultsPath: path.join(root, "c.jsonl"), answerDefaultsEnabled: false, autoApproveAgentPermissions: false
  };
}

let root: string;
let catalogStore: CatalogStore;
let server: Server;

// FooNode (id 7) is on the path of a PASSED output branch (node-16) → validated.
// BarNode (id 8) is only under a FAILED branch (node-99) → must NOT be recorded.
const STEP07_SUMMARY = {
  branch_summaries: [
    { branch: "node-16", status: "passed" },
    { branch: "node-99", status: "failed_runtime" }
  ]
};
const PROMPT_06B = {
  prompt: {
    "7": { class_type: "FooNode", inputs: {} },
    "8": { class_type: "BarNode", inputs: {} },
    "16": { class_type: "SaveImage", inputs: { images: ["7", 0] } },
    "99": { class_type: "PreviewAny", inputs: { x: ["8", 0] } }
  }
};
const LEDGER = {
  nodes: [
    { nodeType: "FooNode", repository: "https://github.com/acme/Foo", commit: "abc", dtype: "fp8_e4m3fn", xpuSupport: "patched" },
    { nodeType: "BarNode", repository: "https://github.com/acme/Bar", commit: "def", xpuSupport: "patched" }
  ]
};

async function makeOrchestratorTask(opts: { withStep07?: boolean } = { withStep07: true }) {
  const { MigrationOrchestrator } = await import("./orchestrator");
  const gpuNodesPath = path.join(root, "gpu-nodes.json");
  await ensureDir(root);
  await fs.writeFile(gpuNodesPath, JSON.stringify({ default_node: "local-xpu", nodes: [{ name: "local-xpu", kind: "local", comfyui_root: "/nfs_share/comfyui-core", venv_python: "/x/py", model_roots: ["/nfs_share"], api_host: "127.0.0.1", api_port: 8188, runtime: "docker", docker_image: "img" }] }), "utf8");
  const config = makeConfig(root, gpuNodesPath);
  await ensureDir(config.workspaceRoot);
  const store = new StateStore(config);
  await store.initialize();
  const orch = new MigrationOrchestrator(config, store, STEPS, { runStep: async () => ({ sessionId: "s", summary: "x" }) });
  const task = await orch.createTask({ name: "wf", workflowFileName: "wf.json", workflowJson: { nodes: [], links: [] } });
  await ensureDir(task.artifactPath);
  await fs.writeFile(path.join(task.artifactPath, "06b-runtime-policy-prompt.json"), JSON.stringify(PROMPT_06B), "utf8");
  await fs.writeFile(path.join(task.artifactPath, "05-catalog-deploy-ledger.json"), JSON.stringify(LEDGER), "utf8");
  if (opts.withStep07 !== false) {
    await fs.writeFile(path.join(task.artifactPath, "07-branch-smoke-summary.json"), JSON.stringify(STEP07_SUMMARY), "utf8");
  }
  return { orch, task };
}

beforeEach(async () => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "orch-catalog-wb-"));
  const clone = path.join(root, "catalog-clone");
  fsSync.mkdirSync(path.join(clone, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  process.env.XPU_CATALOG_DB = path.join(clone, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = clone;
  catalogStore = new CatalogStore(clone);
  const writer = new CatalogWriter({ store: catalogStore, git: new GitRepo(clone, { branch: "main" }), promoteThreshold: 2 });
  await new Promise<void>((r) => {
    server = createCatalogApp(catalogStore, writer).listen(0, "127.0.0.1", () => {
      process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  catalogStore.close();
  for (const k of ["XPU_CATALOG_DB", "XPU_CATALOG_DATA_DIR", "XPU_CATALOG_SERVER_URL", "XPU_CATALOG_ENABLED"]) delete process.env[k];
  fsSync.rmSync(root, { recursive: true, force: true });
});

const callWriteBack = (orch: unknown, task: unknown): Promise<void> =>
  (orch as { catalogValidateAndWriteBack: (t: unknown) => Promise<void> }).catalogValidateAndWriteBack(task);

describe("orchestrator.catalogValidateAndWriteBack — option B (branch harvest + fresh gate)", () => {
  it("no-op when XPU_CATALOG_ENABLED is off", async () => {
    delete process.env.XPU_CATALOG_ENABLED;
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    expect(catalogStore.count()).toBe(0);
  });

  it("records ONLY nodes executed fresh on a successful branch (the DB-entry gate)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    // FooNode (id 7) ran fresh on a PASSED branch → recorded candidate...
    const foo = catalogStore.getByKey("acme__foo");
    expect(foo, "FooNode should be recorded").toBeTruthy();
    expect(foo!.tier).toBe("candidate");
    expect(foo!.validation?.[0]).toMatchObject({ nodeType: "FooNode", passed: true, taskId: task.id });
    // ...BarNode (id 8) only ran on a FAILED branch → NOT recorded (not truly tested).
    expect(catalogStore.getByKey("acme__bar")).toBeUndefined();
  });

  it("records nothing when Step 07 has not run (can't confirm → don't enter DB)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    const { orch, task } = await makeOrchestratorTask({ withStep07: false });
    await callWriteBack(orch, task);
    expect(catalogStore.count()).toBe(0);
  });

  it("best-effort when the catalog-server is unreachable (no throw, no partial state)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    process.env.XPU_CATALOG_SERVER_URL = "http://127.0.0.1:1";
    const { orch, task } = await makeOrchestratorTask();
    await expect(callWriteBack(orch, task)).resolves.toBeUndefined();
    expect(catalogStore.count()).toBe(0);
  });
});
