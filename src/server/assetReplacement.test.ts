import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import {
  processUploadedReplacement,
  markAssetResolvedAndReevaluateGate,
  FileValidationError,
  MAX_FILE_SIZE_BYTES
} from "./assetReplacement";

const CSV_HEADER =
  "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap";

function csvRow(assetName: string, gap = "not staged"): string {
  return `"${assetName}","${assetName}","","","source unknown","","","","","","missing","unresolved","none","false","${gap}"`;
}

let root: string;
let uploadSourceDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "asset-replace-"));
  uploadSourceDir = path.join(root, "tmp-uploads");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeTask(): MigrationTask {
  const workspacePath = path.join(root, "workspace");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "test task",
    status: "running",
    workflowPath: path.join(workspacePath, "source", "workflow.json"),
    workspacePath,
    artifactPath: path.join(workspacePath, "artifacts"),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    steps: []
  };
}

async function writeTempUpload(name: string, content: string): Promise<{ filePath: string; sizeBytes: number }> {
  await import("node:fs/promises").then((fs) => fs.mkdir(uploadSourceDir, { recursive: true }));
  const filePath = path.join(uploadSourceDir, name);
  await writeFile(filePath, content);
  const info = await stat(filePath);
  return { filePath, sizeBytes: info.size };
}

describe("processUploadedReplacement", () => {
  it("copies the temp upload to the artifact input-media dir and cleans up the temp file", async () => {
    const task = makeTask();
    const { filePath, sizeBytes } = await writeTempUpload("model.safetensors", "fake-weights");

    const result = await processUploadedReplacement({
      task,
      filename: "model.safetensors",
      targetFilename: "model.safetensors",
      filePath,
      fileSizeBytes: sizeBytes,
      comfyuiRoot: path.join(root, "comfyui")
    });

    expect(result.uploaded).toBe(true);
    const placedContent = await readFile(result.path, "utf8");
    expect(placedContent).toBe("fake-weights");

    // Temp upload must be cleaned up, not left behind.
    await expect(stat(filePath)).rejects.toThrow();
  });

  it("also stages input-media files (images/video) into the ComfyUI input dir and task workspace inputs dir", async () => {
    const task = makeTask();
    const { filePath, sizeBytes } = await writeTempUpload("ref.png", "fake-png-bytes");
    const comfyuiRoot = path.join(root, "comfyui");

    const result = await processUploadedReplacement({
      task,
      filename: "ref.png",
      targetFilename: "ref.png",
      filePath,
      fileSizeBytes: sizeBytes,
      comfyuiRoot
    });

    expect(result.placedPaths.some((p) => p.startsWith(path.join(comfyuiRoot, "input")))).toBe(true);
    expect(result.placedPaths.some((p) => p.startsWith(path.join(task.workspacePath, "inputs")))).toBe(true);
  });

  it("rejects a disallowed extension before touching the filesystem", async () => {
    const task = makeTask();
    const { filePath, sizeBytes } = await writeTempUpload("script.exe", "x");

    await expect(
      processUploadedReplacement({
        task,
        filename: "script.exe",
        targetFilename: "script.exe",
        filePath,
        fileSizeBytes: sizeBytes,
        comfyuiRoot: path.join(root, "comfyui")
      })
    ).rejects.toThrow(FileValidationError);

    // Temp file is still cleaned up even when validation fails.
    await expect(stat(filePath)).rejects.toThrow();
  });

  it("rejects a file whose real (non-base64-derived) size exceeds the byte limit", async () => {
    const task = makeTask();
    const { filePath } = await writeTempUpload("huge.safetensors", "small-on-disk-but-claims-huge");

    await expect(
      processUploadedReplacement({
        task,
        filename: "huge.safetensors",
        targetFilename: "huge.safetensors",
        filePath,
        fileSizeBytes: MAX_FILE_SIZE_BYTES + 1,
        comfyuiRoot: path.join(root, "comfyui")
      })
    ).rejects.toThrow(/File too large/);
  });

  it("accepts a file just under the 4GB limit boundary (size check only, no real 4GB file written)", async () => {
    const task = makeTask();
    const { filePath } = await writeTempUpload("big-lora.safetensors", "small-file-content");

    const result = await processUploadedReplacement({
      task,
      filename: "big-lora.safetensors",
      targetFilename: "big-lora.safetensors",
      filePath,
      fileSizeBytes: MAX_FILE_SIZE_BYTES - 1,
      comfyuiRoot: path.join(root, "comfyui")
    });

    expect(result.uploaded).toBe(true);
  });
});

describe("markAssetResolvedAndReevaluateGate", () => {
  // Regression coverage for a real bug: a sub-job download that lands a file
  // on disk (via curl, not the browser-upload path) never touched
  // 01-assets.csv/the gate-signal file, so Step 01's own gate kept treating
  // an already-downloaded asset as an open gap. This function is what
  // subJobs.ts now calls on download completion to close that gap the same
  // way a manual upload always has.
  it("updates the CSV row and deletes the gate-signal file when it was the only remaining item", async () => {
    const artifactPath = path.join(root, "artifacts");
    await mkdir(artifactPath, { recursive: true });
    await writeFile(
      path.join(artifactPath, "01-assets.csv"),
      `${CSV_HEADER}\n${csvRow("model.safetensors")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(artifactPath, "01-gate-signal.json"),
      JSON.stringify({ items: [{ name: "model.safetensors", kind: "model asset", action: "provide" }] }, null, 2),
      "utf8"
    );

    const result = await markAssetResolvedAndReevaluateGate({
      artifactPath,
      assetName: "model.safetensors",
      stagedPath: "/nfs_share/diffusion_models/model.safetensors"
    });

    expect(result).toEqual({ resolved: true, remainingGaps: 0 });
    const csv = await readFile(path.join(artifactPath, "01-assets.csv"), "utf8");
    expect(csv).toContain("human_provided");
    expect(csv).toContain("/nfs_share/diffusion_models/model.safetensors");
    expect(csv).toContain(",present,complete,");
    await expect(readFile(path.join(artifactPath, "01-gate-signal.json"), "utf8")).rejects.toThrow();
  });

  it("keeps the gate-signal file listing only the still-unresolved items when others remain", async () => {
    const artifactPath = path.join(root, "artifacts");
    await mkdir(artifactPath, { recursive: true });
    await writeFile(
      path.join(artifactPath, "01-assets.csv"),
      `${CSV_HEADER}\n${csvRow("model-a.safetensors")}\n${csvRow("model-b.safetensors")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(artifactPath, "01-gate-signal.json"),
      JSON.stringify({
        items: [
          { name: "model-a.safetensors", kind: "model asset", action: "provide" },
          { name: "model-b.safetensors", kind: "model asset", action: "provide" }
        ]
      }, null, 2),
      "utf8"
    );

    const result = await markAssetResolvedAndReevaluateGate({
      artifactPath,
      assetName: "model-a.safetensors",
      stagedPath: "/nfs_share/diffusion_models/model-a.safetensors"
    });

    expect(result).toEqual({ resolved: false, remainingGaps: 1 });
    const gateSignal = JSON.parse(await readFile(path.join(artifactPath, "01-gate-signal.json"), "utf8"));
    expect(gateSignal.items).toHaveLength(1);
    expect(gateSignal.items[0].name).toBe("model-b.safetensors");
  });
});
