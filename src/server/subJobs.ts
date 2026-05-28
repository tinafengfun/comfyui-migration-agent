import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SubJob, SubJobProgress, SubJobStatus } from "../shared/types";
import type { MigrationTask } from "../shared/types";
import { isAssetDownloadEnabled, sourceProviderEnv } from "./assetSourceProviders";

interface AcquisitionCandidate {
  provider: string;
  title: string;
  url: string;
  downloadCommand?: string[];
  sizeBytes?: number;
  sha256?: string;
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
  items?: AcquisitionItem[];
  customNodeItems?: CustomNodeItem[];
}

interface ActiveDownload {
  subJobId: string;
  taskId: string;
  stepId: string;
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
    const jobs: SubJob[] = [
      {
        id: "01-provider-discovery",
        taskId: task.id,
        stepId: "01",
        type: "provider_search",
        title: "Step 01 provider search",
        status: "completed",
        artifactPath: "artifacts/01-acquisition-job.json",
        candidateCount:
          (acquisition.providerCandidateCount ?? 0) + (acquisition.customNodeCandidateCount ?? 0),
        progress: { percent: 100 },
        message: "Provider discovery completed and candidates were written to the acquisition job."
      },
      {
        id: "01-custom-node-search",
        taskId: task.id,
        stepId: "01",
        type: "custom_node_search",
        title: "Step 01 custom-node source search",
        status: acquisition.customNodeCandidateCount ? "completed" : "blocked",
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
    if (!isAssetDownloadEnabled()) {
      throw new Error(
        "Download execution is disabled. Set ASSET_ACQUISITION_ENABLE_DOWNLOAD=1 or use MIGRATION_AGENT_DOWNLOAD_PROFILE=demo to start download sub-jobs."
      );
    }
    const acquisition = await readAcquisitionJob(task);
    if (!acquisition) throw new Error("No acquisition job exists for this task.");
    const item = (acquisition.items ?? []).find((entry) => subJobIdForAsset(entry.assetName) === subJobId);
    if (!item) throw new Error(`Sub-job not found: ${subJobId}`);
    const candidates = (item.candidates ?? []).filter((entry) => entry.downloadCommand?.length);
    if (!candidates.length) {
      throw new Error(`Sub-job has no executable download command: ${subJobId}`);
    }
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
    if (command !== "curl" && command !== "scp" && command !== "rsync") {
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
      await this.sampleProgress(active);
      if (code === 0) {
        const validationError = await validateDownloadedFile(active.targetPath, candidate);
        if (!validationError) {
          active.status = "completed";
          active.completedAt = new Date().toISOString();
          active.updatedAt = active.completedAt;
          active.error = undefined;
          active.process = undefined;
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
    const bytes = (await fileSize(active.targetPath)) ?? 0;
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

async function validateDownloadedFile(filePath: string, candidate: AcquisitionCandidate): Promise<string | undefined> {
  const size = await fileSize(filePath);
  if (!size) return "target file is missing or empty";
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
