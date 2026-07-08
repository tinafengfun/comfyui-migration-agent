import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";

// ── Validation ──

const ALLOWED_EXTENSIONS = new Set([
  // Images
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif",
  // Video
  "mp4", "mov", "webm", "avi", "mkv",
  // Models
  "safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "bin",
  // Audio
  "mp3", "wav", "ogg", "flac"
]);

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const INPUT_MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif",
  "mp4", "mov", "webm", "avi", "mkv",
  "mp3", "wav", "ogg", "flac"
]);

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

function validateFile(filename: string, contentBase64: string): void {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  if (!ext) {
    throw new FileValidationError(`File has no extension: ${filename}`);
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new FileValidationError(
      `File type ".${ext}" is not allowed. Allowed types: images (png, jpg, webp, ...), video (mp4, mov, ...), models (safetensors, gguf, ...).`
    );
  }
  const sizeBytes = Math.ceil(contentBase64.length * 3 / 4);
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new FileValidationError(
      `File too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB. Maximum: 500 MB.`
    );
  }
}

// ── Placement ──

function isInputMedia(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  return INPUT_MEDIA_EXTENSIONS.has(ext);
}

async function placeFile(
  artifactMediaDir: string,
  comfyuiInputDir: string | undefined,
  taskInputDir: string | undefined,
  targetFilename: string,
  buffer: Buffer
): Promise<string[]> {
  const placedPaths: string[] = [];

  // Always write to artifacts/input-media/
  const artifactPath = path.join(artifactMediaDir, targetFilename);
  await ensureDir(artifactMediaDir);
  await fs.writeFile(artifactPath, buffer);
  placedPaths.push(artifactPath);

  // If input media, copy to both ComfyUI/input/ and task workspace inputs/
  if (isInputMedia(targetFilename)) {
    // Global ComfyUI input directory
    if (comfyuiInputDir) {
      await ensureDir(comfyuiInputDir);
      const comfyuiPath = path.join(comfyuiInputDir, targetFilename);
      await fs.writeFile(comfyuiPath, buffer);
      placedPaths.push(comfyuiPath);
    }
    // Task workspace inputs/ (used by Step 05 launched ComfyUI with --input-directory)
    if (taskInputDir) {
      await ensureDir(taskInputDir);
      const taskInputPath = path.join(taskInputDir, targetFilename);
      await fs.writeFile(taskInputPath, buffer);
      placedPaths.push(taskInputPath);
    }
  }

  return placedPaths;
}

// ── CSV Update ──

async function updateAssetCsv(
  artifactsDir: string,
  targetFilename: string,
  stagedPath: string
): Promise<void> {
  const csvPath = path.join(artifactsDir, "01-assets.csv");
  let content: string;
  try {
    content = await fs.readFile(csvPath, "utf8");
  } catch {
    return; // No CSV to update
  }

  const lines = content.split("\n");
  const targetName = path.basename(targetFilename);
  let updated = false;

  const updatedLines = lines.map((line) => {
    if (!line.trim() || line.startsWith("asset_name")) return line;
    const fields = parseCsvLine(line);
    if (fields.length === 0) return line;

    const assetName = fields[0] ?? "";
    // Match by basename: CSV may have "Qwen_Image\file.gguf" or "z-image_00006_.png"
    const csvBasename = path.basename(assetName.replace(/\\/g, "/"));
    if (csvBasename === targetName || assetName === targetName || assetName === targetFilename) {
      // Update state field (index 4) to "human_provided"
      if (fields.length > 4) {
        fields[4] = "human_provided";
      }
      // Update staged_path field (index 5) if present
      if (fields.length > 5) {
        fields[5] = stagedPath;
      }
      // Update install_status (index 10) — was "missing", now "present"
      if (fields.length > 10) {
        fields[10] = "present";
      }
      // Update acquisition_status (index 11) — was "unresolved", now "complete"
      if (fields.length > 11) {
        fields[11] = "complete";
      }
      // Clear gap message (index 14) — must be empty so assetAcquisition.ts
      // skips this row on re-run (its check is `if (!row.gap)`).
      // Audit trail is preserved in state=human_provided + staged_path.
      if (fields.length > 14) {
        fields[14] = "";
      }
      updated = true;
      return fields.map((f) => (f.includes(",") || f.includes('"')) ? `"${f.replace(/"/g, '""')}"` : f).join(",");
    }
    return line;
  });

  if (updated) {
    await fs.writeFile(csvPath, updatedLines.join("\n"), "utf8");
  }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── Gate Re-evaluation ──

async function reevaluateGate(
  artifactsDir: string,
  stepId: string
): Promise<{ resolved: boolean; remainingGaps: number }> {
  const gateSignalPath = path.join(artifactsDir, `${stepId}-gate-signal.json`);
  let signal: { items?: Array<{ name?: string; kind?: string; action?: string; asset?: string }> };
  try {
    signal = JSON.parse(await fs.readFile(gateSignalPath, "utf8"));
  } catch {
    // No gate signal file means nothing to re-evaluate
    return { resolved: true, remainingGaps: 0 };
  }

  const items = signal.items ?? [];
  if (items.length === 0) {
    // Empty items, already resolved
    await fs.unlink(gateSignalPath).catch(() => {});
    return { resolved: true, remainingGaps: 0 };
  }

  // Read CSV to check which items are now resolved
  const csvPath = path.join(artifactsDir, "01-assets.csv");
  let csvContent: string;
  try {
    csvContent = await fs.readFile(csvPath, "utf8");
  } catch {
    return { resolved: false, remainingGaps: items.length };
  }

  const csvStates = new Map<string, string>();
  for (const line of csvContent.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const assetName = fields[0] ?? "";
    const state = fields[4] ?? "";
    const csvBasename = path.basename(assetName.replace(/\\/g, "/"));
    csvStates.set(csvBasename, state);
    csvStates.set(assetName, state);
  }

  const remaining = items.filter((item) => {
    const name = item.name ?? item.asset ?? "unknown";
    const basename = path.basename(name.replace(/\\/g, "/"));
    const state = csvStates.get(basename) ?? csvStates.get(name) ?? "";
    return state === "source unknown" || state === "alias staged" || state === "";
  });

  if (remaining.length === 0) {
    // All resolved — delete gate signal
    await fs.unlink(gateSignalPath).catch(() => {});
    return { resolved: true, remainingGaps: 0 };
  }

  // Update gate signal with remaining items
  signal.items = remaining as typeof signal.items;
  await fs.writeFile(gateSignalPath, JSON.stringify(signal, null, 2), "utf8");
  return { resolved: false, remainingGaps: remaining.length };
}

// ── Main Export ──

export interface UploadReplacementResult {
  uploaded: boolean;
  path: string;
  filename: string;
  originalName: string;
  resolved: boolean;
  remainingGaps: number;
  placedPaths: string[];
}

export async function processUploadedReplacement(input: {
  task: MigrationTask;
  filename: string;
  targetFilename: string;
  contentBase64: string;
  comfyuiRoot: string;
  stepId?: string;
}): Promise<UploadReplacementResult> {
  const { task, filename, contentBase64, comfyuiRoot } = input;
  const targetFilename = path.basename(input.targetFilename || input.filename);
  const stepId = input.stepId ?? "01";

  // 1. Validate
  validateFile(targetFilename, contentBase64);

  // 2. Decode
  const buffer = Buffer.from(contentBase64, "base64");

  // 3. Place file
  const artifactMediaDir = path.join(task.artifactPath, "input-media");
  const comfyuiInputDir = path.join(comfyuiRoot, "input");
  const taskInputDir = path.join(task.workspacePath, "inputs");
  const placedPaths = await placeFile(artifactMediaDir, comfyuiInputDir, taskInputDir, targetFilename, buffer);

  // 4. Update CSV
  const primaryPath = placedPaths[0];
  await updateAssetCsv(task.artifactPath, targetFilename, primaryPath);

  // 5. Re-evaluate gate
  const gateResult = await reevaluateGate(task.artifactPath, stepId);

  // 6. Register with running ComfyUI via upload API (best-effort)
  if (isInputMedia(targetFilename)) {
    const apiUrl = await getComfyUIApiUrl(task);
    if (apiUrl) {
      try {
        await registerImageWithComfyUI(apiUrl, primaryPath, targetFilename);
        placedPaths.push(`comfyui-api:${targetFilename}`);
      } catch (err) {
        console.warn(`[upload] ComfyUI API registration failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return {
    uploaded: true,
    path: primaryPath,
    filename: targetFilename,
    originalName: path.basename(filename),
    resolved: gateResult.resolved,
    remainingGaps: gateResult.remainingGaps,
    placedPaths
  };
}

// ── ComfyUI API helpers ──

async function getComfyUIApiUrl(task: MigrationTask): Promise<string | undefined> {
  try {
    const statePath = path.join(task.workspacePath, "task-state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const apiUrl = state?.steps?.["05"]?.completion_signals?.api_url;
    if (typeof apiUrl === "string" && apiUrl.startsWith("http")) return apiUrl;
  } catch { /* ignore */ }
  return undefined;
}

async function registerImageWithComfyUI(apiUrl: string, filePath: string, _filename: string): Promise<void> {
  const url = new URL("/upload/image", apiUrl);
  const args = ["-s", "-X", "POST", "-F", `image=@${filePath}`, "-F", "overwrite=true", url.toString()];
  await new Promise<void>((resolve, reject) => {
    execFile("curl", args, { timeout: 30_000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`curl upload failed: ${err.message}`));
      } else if (!stdout.includes('"name"')) {
        reject(new Error(`ComfyUI upload unexpected response: ${stdout}`));
      } else {
        resolve();
      }
    });
  });
}
