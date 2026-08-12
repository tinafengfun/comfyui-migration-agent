import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir, writeJson } from "./fsUtils";
import fs from "node:fs/promises";
import type { GpuNode } from "./gpuNodes";
import { syncGuiWorkflowToComfyUIServer } from "./guiWorkflowSync";

async function makeTask(root: string): Promise<MigrationTask> {
  const artifactPath = path.join(root, "artifacts");
  await ensureDir(artifactPath);
  return {
    id: "task",
    name: "My Zimage Workflow!!",
    status: "waiting_for_human",
    workflowPath: path.join(root, "workflow.json"),
    workspacePath: root,
    artifactPath,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    steps: [{ id: "12", status: "waiting_for_human" }]
  };
}

async function seedGuiWorkflow(artifactPath: string): Promise<void> {
  await ensureDir(path.join(artifactPath, "12-gui-acceptance"));
  await fs.writeFile(
    path.join(artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
    '{"nodes":[],"links":[]}\n',
    "utf8"
  );
  await writeJson(path.join(artifactPath, "12-gui-acceptance-summary.json"), {
    gui_workflow_json: { path: "12-gui-acceptance/12-runtime-policy-gui-workflow.json" }
  });
}

/** Real HTTP server mimicking ComfyUI's `POST /api/userdata/<path>` endpoint. */
function startFakeComfyUIServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  receivedRequests: Array<{ url: string; body: string }>;
}> {
  const receivedRequests: Array<{ url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedRequests.push({ url: req.url ?? "", body });
      if (req.url?.startsWith("/api/userdata/") && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(decodeURIComponent(req.url.replace("/api/userdata/", ""))));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind fake server"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(() => res())),
        receivedRequests
      });
    });
  });
}

describe("syncGuiWorkflowToComfyUIServer", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("POSTs the prepared GUI workflow to the live server's userdata API under workflows/", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-ok-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);

    const fake = await startFakeComfyUIServer();
    cleanup = fake.close;
    const [host, port] = fake.url.replace("http://", "").split(":");
    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: host,
      api_port: Number(port)
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });

    expect(result.synced).toBe(true);
    expect(result.destination).toMatch(/^workflows\/.*\.json$/);
    expect(fake.receivedRequests).toHaveLength(1);
    expect(decodeURIComponent(fake.receivedRequests[0].url)).toBe(`/api/userdata/${result.destination}`);
    expect(JSON.parse(fake.receivedRequests[0].body)).toEqual({ nodes: [], links: [] });
  });

  it("sanitizes the task name into a safe destination filename", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-sanitize-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);

    const fake = await startFakeComfyUIServer();
    cleanup = fake.close;
    const [host, port] = fake.url.replace("http://", "").split(":");
    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: host,
      api_port: Number(port)
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.destination).toMatch(/^workflows\/[a-zA-Z0-9._-]+\.json$/);
  });

  it("returns synced:false without throwing when the summary file is missing", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-missing-${Date.now()}`);
    const task = await makeTask(root);
    // No seedGuiWorkflow() call -- no 12-gui-acceptance-summary.json exists.

    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: "127.0.0.1",
      api_port: 54219
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/no usable gui_workflow_json pointer/);
  });

  it("resolves gui_workflow_json when written as a plain string at the top level (real incident: SDK wrote it this way instead of {path})", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-string-toplevel-${Date.now()}`);
    const task = await makeTask(root);
    await ensureDir(path.join(task.artifactPath, "12-gui-acceptance"));
    await fs.writeFile(
      path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
      '{"nodes":[],"links":[]}\n',
      "utf8"
    );
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), {
      gui_workflow_json: "12-gui-acceptance/12-runtime-policy-gui-workflow.json"
    });

    const fake = await startFakeComfyUIServer();
    cleanup = fake.close;
    const [host, port] = fake.url.replace("http://", "").split(":");
    const node: GpuNode = {
      name: "n", kind: "local", comfyui_root: "", venv_python: "/usr/bin/python3",
      model_roots: [], api_host: host, api_port: Number(port)
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(true);
  });

  it("resolves gui_workflow_json when nested under artifacts as a plain string (real incident, confirmed live in a real task run)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-string-nested-${Date.now()}`);
    const task = await makeTask(root);
    await ensureDir(path.join(task.artifactPath, "12-gui-acceptance"));
    await fs.writeFile(
      path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
      '{"nodes":[],"links":[]}\n',
      "utf8"
    );
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), {
      artifacts: { gui_workflow_json: "12-gui-acceptance/12-runtime-policy-gui-workflow.json" }
    });

    const fake = await startFakeComfyUIServer();
    cleanup = fake.close;
    const [host, port] = fake.url.replace("http://", "").split(":");
    const node: GpuNode = {
      name: "n", kind: "local", comfyui_root: "", venv_python: "/usr/bin/python3",
      model_roots: [], api_host: host, api_port: Number(port)
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(true);
  });

  it("falls back to the documented default filename when the summary JSON has no usable pointer at all", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-fallback-default-${Date.now()}`);
    const task = await makeTask(root);
    await ensureDir(path.join(task.artifactPath, "12-gui-acceptance"));
    await fs.writeFile(
      path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
      '{"nodes":[],"links":[]}\n',
      "utf8"
    );
    // No gui_workflow_json pointer anywhere in the summary.
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { status: "prepared_for_gui_acceptance" });

    const fake = await startFakeComfyUIServer();
    cleanup = fake.close;
    const [host, port] = fake.url.replace("http://", "").split(":");
    const node: GpuNode = {
      name: "n", kind: "local", comfyui_root: "", venv_python: "/usr/bin/python3",
      model_roots: [], api_host: host, api_port: Number(port)
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(true);
  });

  it("returns synced:false without throwing when the server is unreachable", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-unreachable-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);

    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: "127.0.0.1",
      api_port: 54220 // nothing bound here
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/http fallback/);
  });

  it("returns synced:false without throwing when the server responds with an error status", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-error-status-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);

    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanup = () => new Promise((res) => server.close(() => res()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind");

    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: "127.0.0.1",
      api_port: addr.port
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/500/);
  });
});

import { describe as describe2, it as it2, expect as expect2 } from "vitest";
import { reduceGuiWorkflow } from "./guiWorkflowSync";

describe2("reduceGuiWorkflow — deterministic reduced-tier edits to GUI widgets_values", () => {
  const objectInfo = {
    BerniniConditioning: { input: { required: {
      positive: ["CONDITIONING"], negative: ["CONDITIONING"], vae: ["VAE"],
      width: ["INT"], height: ["INT"], length: ["INT"], batch_size: ["INT"],
      source_video: ["IMAGE"], ref_max_size: ["INT"]
    } } }
  };
  it2("maps list widgets_values by object_info widget order (ref_max_size is the real driver)", () => {
    const wf = { nodes: [
      { id: 34, type: "BerniniConditioning", widgets_values: [720, 1280, 81, 1, 1280] },
      { id: 90, type: "VHS_LoadVideo", widgets_values: { frame_load_cap: 121, videopreview: { params: { frame_load_cap: 121 } } } }
    ] };
    const changes = [
      { node_id: "34", input: "ref_max_size", new: 640 },
      { node_id: "34", input: "length", new: 40 },
      { node_id: "90", input: "frame_load_cap", new: 60 }
    ];
    const applied = reduceGuiWorkflow(wf, changes, objectInfo);
    expect2(applied).toBe(3);
    // ref_max_size is widget index 4 (width,height,length,batch_size,ref_max_size):
    expect2((wf.nodes[0].widgets_values as any)[4]).toBe(640);
    expect2((wf.nodes[0].widgets_values as any)[2]).toBe(40); // length
    // dict widgets set by key, incl. the videopreview display:
    expect2((wf.nodes[1].widgets_values as any).frame_load_cap).toBe(60);
    expect2((wf.nodes[1].widgets_values as any).videopreview.params.frame_load_cap).toBe(60);
  });
});

describe("syncGuiWorkflowToComfyUIServer — filesystem write (primary, hardened)", () => {
  it("writes + read-back-verifies the GUI workflow into the node's workflows dir without needing HTTP", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-fs-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);
    const comfyuiRoot = path.join(root, "comfyui-root");
    const node: GpuNode = {
      name: "n", kind: "local", comfyui_root: comfyuiRoot, venv_python: "/usr/bin/python3",
      model_roots: [], api_host: "127.0.0.1", api_port: 1 // nothing listening -> proves HTTP not needed
    };
    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(true);
    expect(result.destination).toContain("user/default/workflows/");
    const written = await fs.readFile(path.join(comfyuiRoot, result.destination!), "utf8");
    expect(JSON.parse(written)).toEqual({ nodes: [], links: [] });
  });

  it("writes the SINGLE canonical acceptance name and OVERWRITES a stale full-size file squatting it", async () => {
    // Regression for the 2026-08-12 OOM: a stale full-size workflow at the canonical
    // `<name>-step12-gui-acceptance.json` path was opened by the operator (seq=155440)
    // because the sync wrote its reduced graph under a "-REDUCED" twin instead. The
    // canonical name must always hold the freshly-synced graph.
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-overwrite-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);
    const comfyuiRoot = path.join(root, "comfyui-root");
    const wfDir = path.join(comfyuiRoot, "user", "default", "workflows");
    await ensureDir(wfDir);
    // canonical name for this task (matches sanitizeName("My Zimage Workflow!!"))
    const canonical = "My_Zimage_Workflow__-step12-gui-acceptance.json";
    // a stale full-size file (and a legacy -REDUCED twin) already squatting the sidebar
    await fs.writeFile(path.join(wfDir, canonical), '{"STALE":"full-size"}', "utf8");
    await fs.writeFile(
      path.join(wfDir, "My_Zimage_Workflow__-REDUCED-step12-gui-acceptance.json"),
      '{"STALE":"reduced-twin"}',
      "utf8"
    );
    const node: GpuNode = {
      name: "n", kind: "local", comfyui_root: comfyuiRoot, venv_python: "/usr/bin/python3",
      model_roots: [], api_host: "127.0.0.1", api_port: 1
    };
    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(true);
    // exactly one canonical acceptance file, holding the fresh graph (not the stale one)
    expect(result.destination).toContain(canonical);
    const written = await fs.readFile(path.join(wfDir, canonical), "utf8");
    expect(JSON.parse(written)).toEqual({ nodes: [], links: [] });
    // the legacy -REDUCED twin is purged so it can't be mis-picked
    await expect(
      fs.access(path.join(wfDir, "My_Zimage_Workflow__-REDUCED-step12-gui-acceptance.json"))
    ).rejects.toThrow();
  });
});
