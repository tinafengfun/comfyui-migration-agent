import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { demoModelRoot } from "./config";
import { ensureDir } from "./fsUtils";
import {
  checkHiddenAssetPrestageStatus,
  readHiddenRuntimeAssets,
  startHiddenAssetPrestage
} from "./hiddenAssetPrestage";

function makeTask(root: string, artifactPath: string): MigrationTask {
  return {
    id: "task-hidden-asset-prestage",
    name: "Hidden asset prestage",
    status: "waiting_for_human",
    workflowPath: path.join(root, "workflow.json"),
    workspacePath: root,
    artifactPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [{ id: "02", status: "completed" }]
  };
}

async function waitForStatusCount(task: MigrationTask, expected: number, timeoutMs = 8000): Promise<ReturnType<typeof checkHiddenAssetPrestageStatus> extends Promise<infer T> ? T : never> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summaries = await checkHiddenAssetPrestageStatus(task);
    const settled = summaries.filter((s) => s.status === "complete" || s.status === "failed");
    if (settled.length >= expected || Date.now() > deadline) return summaries;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("hidden asset prestage", () => {
  const originalDownloadFlag = process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
  const originalHfEndpoint = process.env.HF_ENDPOINT;

  afterEach(() => {
    if (originalDownloadFlag === undefined) delete process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
    else process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = originalDownloadFlag;
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
  });

  describe("readHiddenRuntimeAssets", () => {
    it("returns undefined when 02-hidden-runtime-assets.json is absent", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-read-absent-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      await ensureDir(artifactPath);
      const task = makeTask(root, artifactPath);
      expect(await readHiddenRuntimeAssets(task)).toBeUndefined();
    });

    it("returns undefined when the file is malformed JSON (SDK agent output is never trusted blindly)", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-read-malformed-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      await ensureDir(artifactPath);
      await fs.writeFile(path.join(artifactPath, "02-hidden-runtime-assets.json"), "{ not valid json", "utf8");
      const task = makeTask(root, artifactPath);
      expect(await readHiddenRuntimeAssets(task)).toBeUndefined();
    });

    it("filters out items the human has not approved for auto-download", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-read-filter-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      await ensureDir(artifactPath);
      await fs.writeFile(
        path.join(artifactPath, "02-hidden-runtime-assets.json"),
        JSON.stringify({
          items: [
            { name: "approved-item", kind: "file_url", url: "http://example.test/f", targetRelativePath: "TTS/x", humanApproved: true },
            { name: "unapproved-item", kind: "file_url", url: "http://example.test/g", targetRelativePath: "TTS/y", humanApproved: false }
          ]
        }),
        "utf8"
      );
      const task = makeTask(root, artifactPath);
      const items = await readHiddenRuntimeAssets(task);
      expect(items?.map((i) => i.name)).toEqual(["approved-item"]);
    });
  });

  describe("startHiddenAssetPrestage + checkHiddenAssetPrestageStatus", () => {
    it("downloads to the task's node-specific model root, not demoModelRoot, when both are configured (real bug confirmed live: a real prestage download landed at /home/intel/hf_models/... invisible to the task's actual target node)", async () => {
      process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "9" });
        res.end("modelbyte");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Unexpected test server address");
        process.env.HF_ENDPOINT = `http://127.0.0.1:${address.port}`;

        const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-node-root-${Date.now()}`);
        const artifactPath = path.join(root, "artifacts");
        await ensureDir(artifactPath);
        const nodeSpecificRoot = path.join(root, "nfs-share");
        await ensureDir(nodeSpecificRoot);
        await fs.writeFile(
          path.join(artifactPath, "02-hidden-runtime-assets.json"),
          JSON.stringify({
            items: [
              {
                name: "IndexTTS-2 model suite",
                kind: "huggingface_repo",
                repo: "IndexTeam/IndexTTS-2-mock",
                files: ["ok.pth"],
                targetRelativePath: "TTS/IndexTTS-2",
                humanApproved: true
              }
            ]
          }),
          "utf8"
        );
        const task = makeTask(root, artifactPath);

        // demoModelRoot listed first, exactly like resolveModelRoots' merge order.
        startHiddenAssetPrestage(task, [demoModelRoot, nodeSpecificRoot], path.join(root, "ComfyUI"));

        const summaries = await waitForStatusCount(task, 1);
        expect(summaries.find((s) => s.file === "ok.pth")?.status).toBe("complete");
        const downloaded = await fs.readFile(path.join(nodeSpecificRoot, "TTS", "IndexTTS-2", "ok.pth"), "utf8");
        expect(downloaded).toBe("modelbyte");
      } finally {
        server.close();
      }
    });

    it("is a no-op when downloads are not enabled (safety gate, same as subJobs.ts)", async () => {
      delete process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
      const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-gated-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      await ensureDir(artifactPath);
      await fs.writeFile(
        path.join(artifactPath, "02-hidden-runtime-assets.json"),
        JSON.stringify({
          items: [{ name: "x", kind: "file_url", url: "http://example.test/f", targetRelativePath: "TTS/x", humanApproved: true }]
        }),
        "utf8"
      );
      const task = makeTask(root, artifactPath);
      const modelRoot = path.join(root, "models");
      await ensureDir(modelRoot);
      startHiddenAssetPrestage(task, [modelRoot], root);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await checkHiddenAssetPrestageStatus(task)).toEqual([]);
    });

    it("downloads each file in the background and reaches complete/failed without blocking the caller", async () => {
      process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
      const server = http.createServer((req, res) => {
        if (req.url === "/IndexTeam/IndexTTS-2-mock/resolve/main/ok.pth") {
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "9" });
          res.end("modelbyte");
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("missing");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Unexpected test server address");
        process.env.HF_ENDPOINT = `http://127.0.0.1:${address.port}`;

        const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-download-${Date.now()}`);
        const artifactPath = path.join(root, "artifacts");
        await ensureDir(artifactPath);
        const modelRoot = path.join(root, "models");
        await ensureDir(modelRoot);
        await fs.writeFile(
          path.join(artifactPath, "02-hidden-runtime-assets.json"),
          JSON.stringify({
            items: [
              {
                name: "IndexTTS-2 model suite",
                kind: "huggingface_repo",
                repo: "IndexTeam/IndexTTS-2-mock",
                files: ["ok.pth", "missing.pth"],
                targetRelativePath: "TTS/IndexTTS-2",
                humanApproved: true
              }
            ]
          }),
          "utf8"
        );
        const task = makeTask(root, artifactPath);

        // Fire-and-forget: does not return a promise the caller awaits.
        startHiddenAssetPrestage(task, [modelRoot], root);

        const summaries = await waitForStatusCount(task, 2);
        const ok = summaries.find((s) => s.file === "ok.pth");
        const missing = summaries.find((s) => s.file === "missing.pth");
        expect(ok?.status).toBe("complete");
        expect(missing?.status).toBe("failed");

        const downloaded = await fs.readFile(path.join(modelRoot, "TTS", "IndexTTS-2", "ok.pth"), "utf8");
        expect(downloaded).toBe("modelbyte");
      } finally {
        server.close();
      }
    });

    it("skips a file that is already staged on disk (no duplicate download)", async () => {
      process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
      let requestCount = 0;
      const server = http.createServer((req, res) => {
        requestCount += 1;
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "2" });
        res.end("no");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Unexpected test server address");
        process.env.HF_ENDPOINT = `http://127.0.0.1:${address.port}`;

        const root = path.join(process.cwd(), ".demo-state", "tests", `hidden-asset-already-staged-${Date.now()}`);
        const artifactPath = path.join(root, "artifacts");
        await ensureDir(artifactPath);
        const modelRoot = path.join(root, "models");
        const stagedDir = path.join(modelRoot, "TTS", "IndexTTS-2");
        await ensureDir(stagedDir);
        await fs.writeFile(path.join(stagedDir, "already-here.pth"), "already staged bytes", "utf8");
        await fs.writeFile(
          path.join(artifactPath, "02-hidden-runtime-assets.json"),
          JSON.stringify({
            items: [
              {
                name: "already staged item",
                kind: "huggingface_repo",
                repo: "IndexTeam/IndexTTS-2-mock",
                files: ["already-here.pth"],
                targetRelativePath: "TTS/IndexTTS-2",
                humanApproved: true
              }
            ]
          }),
          "utf8"
        );
        const task = makeTask(root, artifactPath);

        startHiddenAssetPrestage(task, [modelRoot], root);
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(requestCount).toBe(0);
        expect(await checkHiddenAssetPrestageStatus(task)).toEqual([]);
        const untouched = await fs.readFile(path.join(stagedDir, "already-here.pth"), "utf8");
        expect(untouched).toBe("already staged bytes");
      } finally {
        server.close();
      }
    });
  });
});
