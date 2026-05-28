import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactRecord } from "../shared/types";
import { safeJoin } from "./fsUtils";

export function classifyArtifact(filePath: string): ArtifactRecord["kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json" && path.basename(filePath).toLowerCase().includes("workflow")) return "workflow";
  if (ext === ".md") return "markdown";
  if (ext === ".json") return "json";
  if (ext === ".log" || ext === ".txt") return "log";
  if (ext === ".patch" || ext === ".diff") return "patch";
  if ([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".gif"].includes(ext)) return "media";
  return "other";
}

export async function listArtifactFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  await walk(root, result);
  return result;
}

export async function readArtifactText(root: string, relativePath: string): Promise<string> {
  const filePath = safeJoin(root, relativePath);
  const stat = await fs.stat(filePath);
  if (stat.size > 1024 * 1024) {
    throw new Error(`Artifact is too large for inline preview: ${relativePath}`);
  }
  return fs.readFile(filePath, "utf8");
}

async function walk(dir: string, result: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, result);
    } else {
      result.push(fullPath);
    }
  }
}
