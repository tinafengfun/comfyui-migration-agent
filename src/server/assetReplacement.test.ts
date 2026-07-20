import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import {
  processUploadedReplacement,
  FileValidationError,
  MAX_FILE_SIZE_BYTES
} from "./assetReplacement";

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
