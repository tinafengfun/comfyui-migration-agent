import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { primaryModelRoot } from "./assetAcquisition";
import {
  buildSourceProviderConfig,
  executeCandidateDownload,
  isAssetDownloadEnabled,
  withDownloadCommand,
  type AssetSourceCandidate
} from "./assetSourceProviders";

// Real incident this closes: IndexTTS2Run (and custom nodes like it) loads its
// entire model suite dynamically from Python code, invisible to Step00/01's
// static workflow-JSON scan. Step02's SDK agent DOES discover this (by reading
// the custom node's source) and gets human sign-off to defer acquisition, but
// until now nothing downloaded anything until Step05's own SDK session did the
// full multi-GB fetch live, inline, counted against Step05's own session time
// budget -- which is exactly what made Step05 slow enough to risk timing out.
// This module lets Step02 kick off those downloads in the background (a plain
// detached-in-spirit child process via executeCandidateDownload, not awaited
// by the caller) the moment they're known, so by the time Step05 runs, the
// files are already there (or Step05 can see they're still in progress and
// avoid re-downloading). Status is persisted to disk (not just in-memory, see
// subJobs.ts's ActiveDownload for the contrast) specifically so Step05 can
// check it even if it runs in a later backend process lifetime than Step02 --
// a long HF download can easily span a restart.

export interface HiddenRuntimeAssetItem {
  name: string;
  kind: "huggingface_repo" | "file_url";
  humanApproved: boolean;
  targetRelativePath: string;
  // huggingface_repo
  repo?: string;
  files?: string[];
  // file_url
  url?: string;
}

interface HiddenRuntimeAssetsFile {
  items: HiddenRuntimeAssetItem[];
}

export type PrestageFileStatus = "downloading" | "complete" | "failed";

export interface PrestageStatusRecord {
  itemName: string;
  file: string;
  targetPath: string;
  status: PrestageFileStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const HIDDEN_ASSETS_FILENAME = "02-hidden-runtime-assets.json";
const STATUS_DIR = "hidden-asset-downloads";

function sanitizeForFilename(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (cleaned || "unnamed").slice(0, 80);
}

function statusDir(task: MigrationTask): string {
  return path.join(task.artifactPath, STATUS_DIR);
}

function statusPath(task: MigrationTask, itemName: string, file: string): string {
  return path.join(statusDir(task), `${sanitizeForFilename(itemName)}__${sanitizeForFilename(file)}.status.json`);
}

async function writeStatus(task: MigrationTask, record: PrestageStatusRecord): Promise<void> {
  await fs.mkdir(statusDir(task), { recursive: true });
  await fs.writeFile(statusPath(task, record.itemName, record.file), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Never throws -- returns undefined if the file is absent or malformed (Step02's SDK agent may not always emit it). */
export async function readHiddenRuntimeAssets(task: MigrationTask): Promise<HiddenRuntimeAssetItem[] | undefined> {
  try {
    const raw = await fs.readFile(path.join(task.artifactPath, HIDDEN_ASSETS_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as HiddenRuntimeAssetsFile;
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed.items.filter((item) => item && item.humanApproved === true);
  } catch {
    return undefined;
  }
}

function filesForItem(item: HiddenRuntimeAssetItem): string[] {
  if (item.kind === "huggingface_repo") return item.files ?? [];
  if (item.kind === "file_url" && item.url) return [path.basename(item.url)];
  return [];
}

function downloadUrlForFile(item: HiddenRuntimeAssetItem, file: string, huggingFaceEndpoint: string): string | undefined {
  if (item.kind === "huggingface_repo" && item.repo) {
    return `${huggingFaceEndpoint}/${item.repo}/resolve/main/${file}`;
  }
  if (item.kind === "file_url") return item.url;
  return undefined;
}

/**
 * Fire-and-forget: reads 02-hidden-runtime-assets.json (if present) and kicks
 * off one background download per file. Never awaited by the caller -- the
 * orchestrator calls this and moves on immediately; Step02 completes without
 * waiting for any of these downloads. Safe to call with an empty/missing file
 * (no-op) and safe to call more than once for the same task (re-download of an
 * already-complete file is skipped).
 */
export function startHiddenAssetPrestage(task: MigrationTask, modelRoots: string[], comfyuiRoot: string): void {
  // Same safety gate as subJobs.ts's human-triggered downloads (isAssetDownloadEnabled) --
  // this is an automatic download path, so it must never fire in an environment
  // where downloads haven't been explicitly enabled (ASSET_ACQUISITION_ENABLE_DOWNLOAD=1
  // or MIGRATION_AGENT_DOWNLOAD_PROFILE=demo).
  if (!isAssetDownloadEnabled()) return;
  readHiddenRuntimeAssets(task)
    .then(async (items) => {
      if (!items || items.length === 0) return;
      // Real bug this closes: modelRoots[0] is ALWAYS demoModelRoot (a
      // local-disk-only path) -- resolveModelRoots() unconditionally merges
      // it in first, the exact same trap primaryModelRoot() in
      // assetAcquisition.ts was already fixed for. Confirmed live: a real
      // prestage download landed at /home/intel/hf_models/... on the agent
      // host, invisible to the task's actual target node (remote-124-12),
      // completely defeating the point of pre-staging. Reuse the same fix.
      const primaryRoot = primaryModelRoot(modelRoots, comfyuiRoot);
      if (!primaryRoot) return;
      const config = buildSourceProviderConfig();
      for (const item of items) {
        const files = filesForItem(item);
        for (const file of files) {
          const targetPath = path.join(primaryRoot, item.targetRelativePath, file);
          const existing = await fs.stat(targetPath).catch(() => undefined);
          if (existing && existing.size > 0) continue; // already staged -- nothing to do
          const downloadUrl = downloadUrlForFile(item, file, config.huggingFaceEndpoint);
          if (!downloadUrl) continue;
          const candidate: AssetSourceCandidate = {
            provider: item.kind === "huggingface_repo" ? "huggingface" : "ssh_remote",
            title: `${item.name}: ${file}`,
            url: downloadUrl,
            downloadUrl,
            score: 100,
            requiresToken: false,
            notes: "hidden-runtime-asset background prestage (kicked off during Step02, not Step05)"
          };
          const withCommand = withDownloadCommand(candidate, { query: file, kind: "model", targetPath }, config);
          if (!withCommand.downloadCommand) continue;
          await writeStatus(task, {
            itemName: item.name,
            file,
            targetPath,
            status: "downloading",
            startedAt: new Date().toISOString()
          });
          // Deliberately not awaited here -- this whole startHiddenAssetPrestage
          // call is itself fire-and-forget from the orchestrator's Step02 code.
          // executeCandidateDownload awaits its own child `curl` process, but
          // nothing in this module or the orchestrator blocks on that.
          executeCandidateDownload(withCommand)
            .then(() =>
              writeStatus(task, {
                itemName: item.name,
                file,
                targetPath,
                status: "complete",
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString()
              })
            )
            .catch((error) =>
              writeStatus(task, {
                itemName: item.name,
                file,
                targetPath,
                status: "failed",
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error)
              })
            );
        }
      }
    })
    .catch(() => {
      // Best-effort only -- a prestage failure must never affect Step02's own
      // completion. Step05's fallback (do the download itself, as before) is
      // the real safety net.
    });
}

export interface PrestageStatusSummary {
  itemName: string;
  file: string;
  targetPath: string;
  status: PrestageFileStatus | "not_started";
}

/**
 * Detection-only: reads persisted status records and cross-checks real file
 * existence (ground truth -- a status file can be stale if the backend
 * restarted mid-download). Never throws; returns an empty array if nothing
 * was ever pre-staged for this task.
 */
export async function checkHiddenAssetPrestageStatus(task: MigrationTask): Promise<PrestageStatusSummary[]> {
  const dir = statusDir(task);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const summaries: PrestageStatusSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".status.json")) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as PrestageStatusRecord;
      const staged = await fs.stat(record.targetPath).catch(() => undefined);
      const status: PrestageStatusSummary["status"] =
        staged && staged.size > 0 ? "complete" : record.status;
      summaries.push({ itemName: record.itemName, file: record.file, targetPath: record.targetPath, status });
    } catch {
      // Malformed status file -- skip it, don't fail the whole check.
    }
  }
  return summaries;
}
