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

// Mock the harness runner so no python/GPU is spawned; the orchestrator's
// runCatalogNodeValidation still runs (local node + 06b prompt present).
vi.mock("./nodeValidationRunner", () => ({ runNodeValidation: vi.fn() }));
import { runNodeValidation } from "./nodeValidationRunner";
const PASS = [{ nodeType: "FooNode", passed: true, historyResult: "success", xpuUtilizationPct: 84, passedAt: "2026-08-19T01:00:00Z" }];
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

async function makeOrchestratorTask() {
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
  // Step-06 runtime-policy prompt + Step-05 deploy ledger.
  await fs.writeFile(path.join(task.artifactPath, "06b-runtime-policy-prompt.json"), JSON.stringify({ prompt: { "1": { class_type: "FooNode", inputs: {} } } }), "utf8");
  await fs.writeFile(
    path.join(task.artifactPath, "05-catalog-deploy-ledger.json"),
    JSON.stringify({ nodes: [{ nodeType: "FooNode", repository: "https://github.com/acme/Foo", commit: "abc", dtype: "fp8_e4m3fn", xpuSupport: "patched" }] }),
    "utf8"
  );
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

describe("orchestrator.catalogValidateAndWriteBack (plan B)", () => {
  it("no-op when XPU_CATALOG_ENABLED is off", async () => {
    delete process.env.XPU_CATALOG_ENABLED;
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    expect(catalogStore.count()).toBe(0);
  });

  it("reads the deploy ledger, validates (mocked harness), and writes a candidate record", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    vi.mocked(runNodeValidation).mockResolvedValue(PASS);
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    const rec = catalogStore.getByKey("acme__foo");
    expect(rec, "record should be created from ledger + verdict").toBeTruthy();
    expect(rec!.tier).toBe("candidate");
    expect(rec!.supportedDtypes).toEqual(["fp8_e4m3fn"]);
    expect(rec!.validation?.[0]).toMatchObject({ nodeType: "FooNode", passed: true, xpuUtilizationPct: 84, taskId: task.id });
  });

  it("drives the harness against the Step-06 runtime-policy prompt (not the raw workflow)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    vi.mocked(runNodeValidation).mockResolvedValue(PASS);
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    expect(runNodeValidation).toHaveBeenCalled();
    const opts = vi.mocked(runNodeValidation).mock.calls[0][0] as { promptPath: string; nodeTypes: string[] };
    expect(opts.promptPath).toContain("06b-runtime-policy-prompt.json");
    expect(opts.nodeTypes).toContain("FooNode");
  });

  it("writes nothing when the harness yields no verdicts (no evidence → no record)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    vi.mocked(runNodeValidation).mockResolvedValue([]);
    const { orch, task } = await makeOrchestratorTask();
    await callWriteBack(orch, task);
    expect(catalogStore.count()).toBe(0);
  });

  it("is best-effort when the catalog-server is unreachable (no throw, no partial state)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    process.env.XPU_CATALOG_SERVER_URL = "http://127.0.0.1:1"; // unroutable
    vi.mocked(runNodeValidation).mockResolvedValue(PASS);
    const { orch, task } = await makeOrchestratorTask();
    await expect(callWriteBack(orch, task)).resolves.toBeUndefined(); // never throws
    expect(catalogStore.count()).toBe(0);
  });
});

function callWriteBack(orch: unknown, task: unknown): Promise<void> {
  return (orch as { catalogValidateAndWriteBack: (t: unknown) => Promise<void> }).catalogValidateAndWriteBack(task);
}
