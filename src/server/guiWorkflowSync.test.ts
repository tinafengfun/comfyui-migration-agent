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
      comfyui_root: "/irrelevant",
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
      comfyui_root: "/irrelevant",
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
      comfyui_root: "/irrelevant",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: "127.0.0.1",
      api_port: 54219
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/no gui_workflow_json/);
  });

  it("returns synced:false without throwing when the server is unreachable", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gui-sync-unreachable-${Date.now()}`);
    const task = await makeTask(root);
    await seedGuiWorkflow(task.artifactPath);

    const node: GpuNode = {
      name: "n",
      kind: "local",
      comfyui_root: "/irrelevant",
      venv_python: "/usr/bin/python3",
      model_roots: [],
      api_host: "127.0.0.1",
      api_port: 54220 // nothing bound here
    };

    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/sync failed/);
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
      comfyui_root: "/irrelevant",
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
