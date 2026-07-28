import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SubJob, SubJobProgress, SubJobStatus } from "../shared/types";
import type { MigrationTask } from "../shared/types";
import { buildSourceProviderConfig, isAssetDownloadEnabled, sourceProviderEnv, withDownloadCommand, type SourceProvider } from "./assetSourceProviders";
import { markAssetResolvedAndReevaluateGate } from "./assetReplacement";

interface AcquisitionCandidate {
  provider: string;
  title: string;
  url: string;
  downloadCommand?: string[];
  sizeBytes?: number;
  sha256?: string;
  /** See AssetSourceCandidate's fields of the same name in assetSourceProviders.ts. */
  postDownloadMoveFrom?: string;
  hfCliScratchDir?: string;
}

interface AcquisitionItem {
  assetName: string;
  status: string;
  targetPath?: string;
  resolvedPath?: string;
  candidates?: AcquisitionCandidate[];
  searchIssues?: Array<{ provider: string; message: string }>;
}

interface CustomNodeItem {
  packageHint: string;
  status: string;
  candidates?: AcquisitionCandidate[];
}

interface AcquisitionJob {
  status: string;
  providerCandidateCount?: number;
  customNodeCandidateCount?: number;
  unresolvedCount?: number;
  items?: AcquisitionItem[];
  customNodeItems?: CustomNodeItem[];
}

interface ActiveDownload {
  subJobId: string;
  taskId: string;
  stepId: string;
  artifactPath: string;
  title: string;
  assetName: string;
  provider: string;
  candidateIndex: number;
  candidateCount: number;
  candidates: AcquisitionCandidate[];
  targetPath: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: SubJobStatus;
  process?: ChildProcess;
  totalBytes?: number;
  downloadedBytes: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  error?: string;
  stderr: string;
  attemptErrors: string[];
  env: NodeJS.ProcessEnv;
  lastSampleAt: number;
  lastSampleBytes: number;
}

export class SubJobManager {
  private readonly active = new Map<string, ActiveDownload>();

  async listTaskSubJobs(task: MigrationTask): Promise<SubJob[]> {
    const acquisition = await readAcquisitionJob(task);
    if (!acquisition) return [];
    // Same staleness root cause as the Missing-Assets-panel bug this session
    // fixed elsewhere (see emitStep01AcquisitionGateIfNeeded): these two
    // summary rows derive "blocked" purely from 01-acquisition-job.json's own
    // unresolvedCount, which nothing clears when Step 01 resolves through a
    // DIFFERENT path (the general gate-signal mechanism). Once the step
    // itself has actually reached a terminal state, showing "blocked" here
    // is misleading historical info, not a current blocker -- report
    // "completed" instead (the step moved on regardless of how).
    const step01Terminal = ["completed", "failed", "terminated", "hard_stopped"].includes(
      task.steps.find((s) => s.id === "01")?.status ?? ""
    );
    const jobs: SubJob[] = [
      {
        id: "01-provider-discovery",
        taskId: task.id,
        stepId: "01",
        type: "provider_search",
        title: "Step 01 provider search",
        // Ran to completion either way -- but only report "completed" (all
        // gaps resolved) when unresolvedCount is actually zero, instead of
        // always claiming success regardless of whether anything was found
        // -- UNLESS the step itself has since moved past the gate anyway.
        status: (acquisition.unresolvedCount ?? 0) === 0 || step01Terminal ? "completed" : "blocked",
        artifactPath: "artifacts/01-acquisition-job.json",
        candidateCount:
          (acquisition.providerCandidateCount ?? 0) + (acquisition.customNodeCandidateCount ?? 0),
        progress: { percent: 100 },
        message: (acquisition.unresolvedCount ?? 0) === 0
          ? "Provider discovery completed and all gaps were resolved."
          : step01Terminal
            ? `Provider discovery ran with ${acquisition.unresolvedCount} item(s) unresolved at the time, but Step 01 has since moved on.`
            : `Provider discovery ran, but ${acquisition.unresolvedCount} item(s) remain unresolved -- see candidates/fuzzy-match judgment in the acquisition job.`
      },
      {
        id: "01-custom-node-search",
        taskId: task.id,
        stepId: "01",
        type: "custom_node_search",
        title: "Step 01 custom-node source search",
        status: acquisition.customNodeCandidateCount || step01Terminal ? "completed" : "blocked",
        artifactPath: "artifacts/01-acquisition-job.json",
        candidateCount: acquisition.customNodeCandidateCount ?? 0,
        progress: { percent: 100 },
        message: `${acquisition.customNodeCandidateCount ?? 0} custom-node candidate source(s) recorded.`
      }
    ];

    for (const item of acquisition.items ?? []) {
      jobs.push(await this.subJobFromAcquisitionItem(task, item));
    }
    return jobs;
  }

  async startSubJob(task: MigrationTask, subJobId: string): Promise<SubJob> {
    this.assertDownloadEnabled();
    const acquisition = await readAcquisitionJob(task);
    if (!acquisition) throw new Error("No acquisition job exists for this task.");
    const item = (acquisition.items ?? []).find((entry) => subJobIdForAsset(entry.assetName) === subJobId);
    if (!item) throw new Error(`Sub-job not found: ${subJobId}`);
    const candidates = (item.candidates ?? []).filter((entry) => entry.downloadCommand?.length);
    if (!candidates.length) {
      throw new Error(`Sub-job has no executable download command: ${subJobId}`);
    }
    return this.startDownload(task, subJobId, item, candidates);
  }

  /**
   * Downloads a human-approved URL that didn't come from the structured
   * provider search — specifically, Step 01's own LLM fuzzy-match judgment
   * (fuzzyJudgment.suggestedUrl in 01-acquisition-job.json), surfaced in the
   * web UI's missing-asset panel and confirmed by a person clicking "Use
   * this source". Builds one synthetic candidate through withDownloadCommand
   * (assetSourceProviders.ts) so it runs through the exact same
   * execution/progress/validation logic AND the same hf-cli-vs-curl
   * selection as the structured provider-search path — no duplicated
   * download machinery, only the URL->candidate wrapping is new.
   *
   * Real incident this closes: a 29.5GB suggested-url download died at 42%
   * with "HTTP/2 stream 1 was not closed cleanly: CANCEL" after ~20 minutes
   * on a single long-lived curl connection through this project's corporate
   * proxy. This path previously always used the bespoke, curl-only
   * buildSuggestedUrlDownloadCommand regardless of whether the URL was a
   * HuggingFace file (where `hf download`'s chunked/resumable transfer is
   * both faster and far less likely to drop a single multi-hour stream).
   */
  async startSubJobForSuggestedUrl(task: MigrationTask, assetName: string, url: string): Promise<SubJob> {
    this.assertDownloadEnabled();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not an http(s) URL: ${url}`);
    const acquisition = await readAcquisitionJob(task);
    if (!acquisition) throw new Error("No acquisition job exists for this task.");
    const item = (acquisition.items ?? []).find((entry) => entry.assetName === assetName);
    if (!item) throw new Error(`No acquisition item found for asset: ${assetName}`);
    if (!item.targetPath) throw new Error(`No target path recorded for asset: ${assetName}`);
    const provider: SourceProvider = /(^|\.)huggingface\.co$|(^|\.)hf-mirror\.com$/i.test(new URL(url).hostname)
      ? "huggingface"
      : /(^|\.)civitai\.com$/i.test(new URL(url).hostname)
        ? "civitai"
        : "github";
    const withCommand = withDownloadCommand(
      {
        provider,
        title: `Human-approved suggested source for ${assetName}`,
        url,
        downloadUrl: url,
        score: 0,
        requiresToken: false,
        notes: ""
      },
      { query: assetName, kind: "model", targetPath: item.targetPath },
      buildSourceProviderConfig()
    );
    const candidate: AcquisitionCandidate = {
      provider: "suggested-url",
      title: `Human-approved suggested source for ${assetName}`,
      url,
      downloadCommand: withCommand.downloadCommand,
      postDownloadMoveFrom: withCommand.postDownloadMoveFrom,
      hfCliScratchDir: withCommand.hfCliScratchDir
    };
    return this.startDownload(task, subJobIdForAsset(assetName), item, [candidate]);
  }

  private assertDownloadEnabled(): void {
    if (!isAssetDownloadEnabled()) {
      throw new Error(
        "Download execution is disabled. Set ASSET_ACQUISITION_ENABLE_DOWNLOAD=1 or use MIGRATION_AGENT_DOWNLOAD_PROFILE=demo to start download sub-jobs."
      );
    }
  }

  private async startDownload(
    task: MigrationTask,
    subJobId: string,
    item: AcquisitionItem,
    candidates: AcquisitionCandidate[]
  ): Promise<SubJob> {
    if (!item.targetPath) throw new Error(`Sub-job has no target path: ${subJobId}`);
    if (this.active.get(subJobId)?.status === "running") {
      return this.subJobFromActive(this.active.get(subJobId)!);
    }

    const env = await readRuntimeDownloadEnv(task);
    await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
    const startedAt = new Date().toISOString();
    const active: ActiveDownload = {
      subJobId,
      taskId: task.id,
      stepId: "01",
      artifactPath: task.artifactPath,
      title: `Download ${item.assetName}`,
      assetName: item.assetName,
      provider: candidates[0].provider,
      candidateIndex: 0,
      candidateCount: candidates.length,
      candidates,
      targetPath: item.targetPath,
      startedAt,
      updatedAt: startedAt,
      status: "running",
      downloadedBytes: 0,
      stderr: "",
      attemptErrors: [],
      env,
      lastSampleAt: Date.now(),
      lastSampleBytes: 0
    };
    this.active.set(subJobId, active);
    await this.startCandidate(active, 0);
    await this.sampleProgress(active);
    return this.subJobFromActive(active);
  }

  private async startCandidate(active: ActiveDownload, index: number): Promise<void> {
    const candidate = active.candidates[index];
    if (!candidate?.downloadCommand?.length) {
      active.status = "waiting_for_human";
      active.completedAt = new Date().toISOString();
      active.updatedAt = active.completedAt;
      active.error = `All ${active.candidateCount} download candidate(s) failed. ${active.attemptErrors.join(" | ")}`;
      active.stderr = "";
      return;
    }
    active.candidateIndex = index;
    active.provider = candidate.provider;
    active.stderr = "";
    active.error = undefined;
    active.status = "running";
    active.updatedAt = new Date().toISOString();
    const [command, ...args] = candidate.downloadCommand.map((value) => substituteEnvPlaceholders(value, active.env));
    if (command !== "curl" && command !== "scp" && command !== "rsync" && command !== "hf") {
      active.attemptErrors.push(`${candidate.provider}:${candidate.title} uses unsupported command ${command}`);
      await this.startCandidate(active, index + 1);
      return;
    }
    active.totalBytes =
      candidate.sizeBytes ?? (command === "curl" ? await contentLengthFromCurl(args, active.env).catch(() => undefined) : undefined);
    const child = spawn(command, args, {
      env: active.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    active.process = child;
    child.stderr.on("data", (chunk: Buffer) => {
      active.stderr = `${active.stderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.on("close", async (code) => {
      // `hf download` (see withDownloadCommand's hf-cli fast path in
      // assetSourceProviders.ts) can never write directly to active.targetPath
      // -- it always places the file under --local-dir/<path-in-repo>. Move it
      // into place before validating/completing, same contract curl already
      // satisfies by writing straight to --output targetPath.
      if (code === 0 && candidate.postDownloadMoveFrom) {
        try {
          await fs.rename(candidate.postDownloadMoveFrom, active.targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EXDEV") {
            await fs.copyFile(candidate.postDownloadMoveFrom, active.targetPath);
            await fs.rm(candidate.postDownloadMoveFrom, { force: true }).catch(() => undefined);
          } else {
            active.attemptErrors.push(
              `${candidate.provider}:${candidate.title} downloaded but could not be moved into place: ${error instanceof Error ? error.message : error}`
            );
            code = 1;
          }
        }
      }
      if (candidate.hfCliScratchDir) {
        await fs.rm(candidate.hfCliScratchDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await this.sampleProgress(active);
      if (code === 0) {
        const validationError = await validateDownloadedFile(active.targetPath, candidate);
        if (!validationError) {
          active.status = "completed";
          active.completedAt = new Date().toISOString();
          active.updatedAt = active.completedAt;
          active.error = undefined;
          active.process = undefined;
          // Real bug fixed here: a completed download used to just sit on
          // disk without ever updating 01-assets.csv/the gate-signal file,
          // so Step 01's own gate kept treating it as an open gap even
          // though the file was already there. Best-effort: a failure here
          // must not un-complete a download that genuinely succeeded.
          await markAssetResolvedAndReevaluateGate({
            artifactPath: active.artifactPath,
            assetName: active.assetName,
            stagedPath: active.targetPath,
            stepId: active.stepId
          }).catch((error) => {
            console.warn(`[subJobs] failed to update ledger/gate-signal after download completion: ${error instanceof Error ? error.message : error}`);
          });
          return;
        }
        active.attemptErrors.push(`${candidate.provider}:${candidate.title} failed validation: ${validationError}`);
      } else {
        active.attemptErrors.push(`${candidate.provider}:${candidate.title} exited with code ${code}. ${active.stderr.trim()}`);
      }
      active.process = undefined;
      await fs.rm(active.targetPath, { force: true }).catch(() => undefined);
      await this.startCandidate(active, index + 1);
    });
  }

  private async subJobFromAcquisitionItem(task: MigrationTask, item: AcquisitionItem): Promise<SubJob> {
    const subJobId = subJobIdForAsset(item.assetName);
    const active = this.active.get(subJobId);
    if (active) {
      await this.sampleProgress(active);
      return this.subJobFromActive(active);
    }
    const downloadable = (item.candidates ?? []).find((candidate) => candidate.downloadCommand?.length);
    const targetPath = item.targetPath ?? item.resolvedPath;
    const existingBytes = targetPath ? await fileSize(targetPath) : undefined;
    const completed = item.status === "already_staged" || item.status === "resolved_local_exact";
    return {
      id: subJobId,
      taskId: task.id,
      stepId: "01",
      type: "download",
      title: completed ? `Asset staged: ${item.assetName}` : `Download/provision ${item.assetName}`,
      status: completed ? "completed" : downloadable ? "pending" : "blocked",
      provider: downloadable?.provider,
      assetName: item.assetName,
      targetPath,
      artifactPath: "artifacts/01-acquisition-report.md",
      candidateCount: item.candidates?.length ?? 0,
      canStart: Boolean(downloadable && isAssetDownloadEnabled()),
      progress: completed
        ? { percent: 100, downloadedBytes: existingBytes }
        : { downloadedBytes: existingBytes ?? 0 },
      message: completed
        ? "Asset is already staged."
        : downloadable
          ? "Download plan is ready. Start is gated by ASSET_ACQUISITION_ENABLE_DOWNLOAD or the demo download profile."
          : "No executable download command is available; provide an exact local file or a source-identical provider candidate."
    };
  }

  private async sampleProgress(active: ActiveDownload): Promise<void> {
    const now = Date.now();
    // hf-cli's own `--local-dir` scratch file (see withHfCliDownloadCommand)
    // is the file actually growing mid-download -- active.targetPath doesn't
    // exist until the post-close move happens. Prefer whichever exists so
    // progress isn't stuck at 0% for the whole download.
    const scratchPath = active.candidates[active.candidateIndex]?.postDownloadMoveFrom;
    const bytes = (await fileSize(active.targetPath)) ?? (scratchPath ? await fileSize(scratchPath) : undefined) ?? 0;
    const elapsedSeconds = Math.max((now - active.lastSampleAt) / 1000, 0.001);
    const deltaBytes = Math.max(bytes - active.lastSampleBytes, 0);
    active.downloadedBytes = bytes;
    active.speedBytesPerSecond = deltaBytes / elapsedSeconds;
    active.etaSeconds =
      active.totalBytes && active.speedBytesPerSecond > 0
        ? Math.max((active.totalBytes - bytes) / active.speedBytesPerSecond, 0)
        : undefined;
    active.updatedAt = new Date(now).toISOString();
    active.lastSampleAt = now;
    active.lastSampleBytes = bytes;
  }

  private subJobFromActive(active: ActiveDownload): SubJob {
    const progress: SubJobProgress = {
      downloadedBytes: active.downloadedBytes,
      totalBytes: active.totalBytes,
      percent:
        active.totalBytes && active.totalBytes > 0
          ? Math.min(100, (active.downloadedBytes / active.totalBytes) * 100)
          : undefined,
      speedBytesPerSecond: active.speedBytesPerSecond,
      etaSeconds: active.etaSeconds
    };
    return {
      id: active.subJobId,
      taskId: active.taskId,
      stepId: active.stepId,
      type: "download",
      title: active.title,
      status: active.status,
      provider: active.provider,
      assetName: active.assetName,
      targetPath: active.targetPath,
      canStart: active.status !== "running" && isAssetDownloadEnabled(),
      startedAt: active.startedAt,
      updatedAt: active.updatedAt,
      completedAt: active.completedAt,
      error: active.error,
      progress,
      message:
        active.status === "running"
          ? `Download is running (candidate ${active.candidateIndex + 1}/${active.candidateCount}: ${active.provider}).`
          : active.error
    };
  }
}

async function readAcquisitionJob(task: MigrationTask): Promise<AcquisitionJob | undefined> {
  const filePath = path.join(task.artifactPath, "01-acquisition-job.json");
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as AcquisitionJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function subJobIdForAsset(assetName: string): string {
  return `01-download-${Buffer.from(assetName).toString("base64url")}`;
}

async function fileSize(filePath: string): Promise<number | undefined> {
  const stat = await fs.stat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return stat?.isFile() ? stat.size : undefined;
}

async function contentLengthFromCurl(args: string[], env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const url = args.at(-1);
  if (!url?.startsWith("http")) return undefined;
  return new Promise((resolve) => {
    const head = spawn("curl", ["-I", "-L", "--silent", "--max-time", "15", url], {
      env,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    head.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    head.on("close", () => {
      const matches = [...output.matchAll(/^content-length:\s*(\d+)/gim)];
      const last = matches.at(-1)?.[1];
      resolve(last ? Number(last) : undefined);
    });
  });
}

function substituteEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => env[name] ?? "");
}

// Extensions a real model/media download should never actually be plain
// text/HTML -- used to catch a "soft 404" (proxy/CDN/mirror returns HTTP 200
// with an HTML error/landing page body instead of a real 404 status).
// Real incident this closes: a suggested-source URL from Step 01's own LLM
// fuzzy-match judgment pointed at a dead HuggingFace repo; curl -L --fail
// followed the redirect to HuggingFace's own generic HTML page, which still
// returns 200, so the download "succeeded" and got marked resolved with an
// HTML document sitting where a 10GB safetensors file was expected -- caught
// only later, by chance, when Step 02's feasibility analysis opened the file.
const BINARY_ASSET_EXTENSIONS = new Set([
  "safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "bin",
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif",
  "mp4", "mov", "webm", "avi", "mkv",
  "mp3", "wav", "ogg", "flac"
]);
const TEXT_MASQUERADE_MARKERS = [/^\s*<!doctype html/i, /^\s*<html/i, /^\s*<\?xml/i];

async function sniffTextMasqueradingAsBinary(filePath: string): Promise<string | undefined> {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (!BINARY_ASSET_EXTENSIONS.has(ext)) return undefined;
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    if (TEXT_MASQUERADE_MARKERS.some((re) => re.test(head))) {
      return `downloaded content looks like an HTML page, not a .${ext} file (starts with: ${head.slice(0, 80).replace(/\s+/g, " ").trim()}...)`;
    }
  } catch {
    // Binary content that isn't valid UTF-8 will throw or produce replacement
    // characters, not match the HTML markers above -- either way, not text.
  } finally {
    await handle.close();
  }
  return undefined;
}

async function validateDownloadedFile(filePath: string, candidate: AcquisitionCandidate): Promise<string | undefined> {
  const size = await fileSize(filePath);
  if (!size) return "target file is missing or empty";
  const textMasqueradeIssue = await sniffTextMasqueradingAsBinary(filePath);
  if (textMasqueradeIssue) return textMasqueradeIssue;
  if (candidate.sizeBytes !== undefined && candidate.sizeBytes !== size) {
    return `size mismatch: expected ${candidate.sizeBytes}, got ${size}`;
  }
  if (candidate.sha256) {
    const actualSha = await sha256File(filePath);
    if (actualSha !== candidate.sha256) return `sha256 mismatch: expected ${candidate.sha256}, got ${actualSha}`;
  }
  return undefined;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readRuntimeDownloadEnv(task: MigrationTask): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const comfyRoot = path.resolve(task.workspacePath, "../../..");
  const contextPaths = [
    path.join(comfyRoot, "model_repo"),
    path.join(comfyRoot, "huggingface_mode.md")
  ];
  for (const filePath of contextPaths) {
    const content = await fs.readFile(filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|HF_MIRROR_TOKEN|HF_ACCESS_TOKEN|CIVITAI_TOKEN|CIVITAI_API_TOKEN|GITHUB_TOKEN|GH_TOKEN|ASSET_DOWNLOAD_PROXY|MIGRATION_AGENT_DOWNLOAD_PROXY|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy)\s*=\s*['"]?([^'"\s]+)['"]?/);
      if (!match) continue;
      const [, key, value] = match;
      if (!env[key]) env[key] = value;
    }
  }
  return sourceProviderEnv(env);
}
