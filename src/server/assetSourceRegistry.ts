import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SshModelSource {
  host: string;
  user?: string;
  root: string;
}

export interface ModelSourceRegistry {
  localDirs: string[];
  sshRemotes: SshModelSource[];
  webSources: string[];
  huggingFaceEndpoint?: string;
  hasHuggingFaceToken: boolean;
  hasCivitaiToken: boolean;
  hasGitHubToken: boolean;
}

export interface ExactSourceMatch {
  provider: "local" | "ssh_remote";
  assetName: string;
  path: string;
  sizeBytes?: number;
  sha256?: string;
  host?: string;
  user?: string;
  root?: string;
}

export async function readModelSourceRegistry(filePath: string): Promise<ModelSourceRegistry> {
  const content = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return parseModelSourceRegistry(content);
}

export function parseModelSourceRegistry(content: string): ModelSourceRegistry {
  const localDirs: string[] = [];
  const sshRemotes: SshModelSource[] = [];
  const webSources: string[] = [];
  let huggingFaceEndpoint: string | undefined;
  let hasHuggingFaceToken = false;
  let hasCivitaiToken = false;
  let hasGitHubToken = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const localDir = line.match(/^local\s+dir\s+(.+)$/i)?.[1]?.trim();
    if (localDir) localDirs.push(localDir);

    const remote = line.match(/remote:\s*([A-Za-z0-9_.-]+):([~/$A-Za-z0-9_.@+-][^\s,;]*)/i);
    if (remote) {
      sshRemotes.push({
        host: remote[1],
        root: remote[2],
        user: line.match(/login\s+user:\s*([A-Za-z0-9_.-]+)/i)?.[1]
      });
    }

    const urls = line.match(/https?:\/\/[^\s`'")]+/g) ?? [];
    webSources.push(...urls.map((url) => url.replace(/[),.;，。]+$/g, "")));

    huggingFaceEndpoint = line.match(/\bHF_ENDPOINT\s*=\s*(https?:\/\/[^\s`'")]+)/)?.[1] ?? huggingFaceEndpoint;
    hasHuggingFaceToken ||= /\b(?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|HF_MIRROR_TOKEN|HF_ACCESS_TOKEN)\b|hf_[A-Za-z0-9]{12,}/.test(line);
    hasCivitaiToken ||= /\b(?:CIVITAI_TOKEN|CIVITAI_API_TOKEN)\b|\bcivitai\b.*\btoken\b|\bcivitai[_-]?token\b/i.test(line);
    hasGitHubToken ||= /\b(?:GITHUB_TOKEN|GH_TOKEN)\b|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(line);
  }

  return {
    localDirs: unique(localDirs.map((item) => path.resolve(item))),
    sshRemotes: uniqueRemotes(sshRemotes),
    webSources: unique(webSources),
    huggingFaceEndpoint,
    hasHuggingFaceToken,
    hasCivitaiToken,
    hasGitHubToken
  };
}

export async function searchLocalExact(assetName: string, roots: string[]): Promise<ExactSourceMatch[]> {
  const matches: ExactSourceMatch[] = [];
  const searchNames = assetSearchNames(assetName);
  for (const root of roots) {
    const stat = await fs.stat(root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat?.isDirectory()) continue;
    for (const searchName of searchNames) {
      const { stdout } = await execFileAsync("find", [root, "-type", "f", "-name", searchName, "-print"], {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      });
      for (const filePath of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const fileStat = await fs.stat(filePath);
        matches.push({ provider: "local", assetName, path: filePath, sizeBytes: fileStat.size });
      }
    }
  }
  return uniqueMatches(matches);
}

export async function searchSshExact(assetName: string, remotes: SshModelSource[]): Promise<ExactSourceMatch[]> {
  const matches: ExactSourceMatch[] = [];
  const searchNames = assetSearchNames(assetName);
  for (const remote of remotes) {
    const login = remote.user ? `${remote.user}@${remote.host}` : remote.host;
    for (const searchName of searchNames) {
      const command = `find ${remotePathExpression(remote.root)} -type f -name ${shellQuote(searchName)} -printf '%p\\t%s\\n' 2>/dev/null`;
      const { stdout } = await execFileAsync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", login, command],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
      );
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const [remotePath, size] = line.split("\t");
        if (!remotePath) continue;
        matches.push({
          provider: "ssh_remote",
          assetName,
          path: remotePath,
          sizeBytes: size ? Number(size) : undefined,
          host: remote.host,
          user: remote.user,
          root: remote.root
        });
      }
    }
  }
  return uniqueMatches(matches);
}

export async function sha256Local(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync("sha256sum", [filePath], { timeout: 600_000, maxBuffer: 256 * 1024 });
  return stdout.trim().split(/\s+/)[0];
}

export async function sha256Ssh(match: ExactSourceMatch): Promise<string> {
  if (match.provider !== "ssh_remote" || !match.host) throw new Error("sha256Ssh requires an ssh_remote match.");
  const login = match.user ? `${match.user}@${match.host}` : match.host;
  const { stdout } = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", login, `sha256sum ${shellQuote(match.path)}`],
    { timeout: 900_000, maxBuffer: 256 * 1024 }
  );
  return stdout.trim().split(/\s+/)[0];
}

export async function downloadSshMatch(match: ExactSourceMatch, targetPath: string): Promise<void> {
  if (match.provider !== "ssh_remote" || !match.host) throw new Error("downloadSshMatch requires an ssh_remote match.");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const login = match.user ? `${match.user}@${match.host}` : match.host;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "rsync",
      [
        "-av",
        "--partial",
        "--append-verify",
        "--info=progress2",
        "-e",
        "ssh -o BatchMode=yes -o ConnectTimeout=30",
        `${login}:${match.path}`,
        targetPath
      ],
      { stdio: "inherit" }
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rsync exited with code ${code}`));
    });
  });
}

export function targetPathForAsset(assetName: string, targetRoot: string): string {
  const lower = assetName.toLowerCase();
  const segments = assetName.split(/[\\/]+/).filter(Boolean);
  if (lower.includes("seedvr2")) return path.join(targetRoot, "SEEDVR2", ...segments);
  if (lower.includes("ultrasharp")) return path.join(targetRoot, "upscale_models", ...segments);
  if (lower.includes("lora") || lower.includes("kook_zimage")) return path.join(targetRoot, "loras", ...segments);
  if (lower.includes("vae") || lower === "ae.safetensors") return path.join(targetRoot, "vae", ...segments);
  if (lower.includes("qwen")) return path.join(targetRoot, "text_encoders", ...segments);
  return path.join(targetRoot, "diffusion_models", ...segments);
}

function remotePathExpression(remotePath: string): string {
  if (remotePath.startsWith("~/")) return `"$HOME/${remotePath.slice(2).replaceAll('"', '\\"')}"`;
  return shellQuote(remotePath);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assetSearchNames(assetName: string): string[] {
  const basename = path.basename(assetName.replaceAll("\\", "/"));
  return unique([assetName, basename]);
}

function uniqueMatches(matches: ExactSourceMatch[]): ExactSourceMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.provider}:${match.host ?? ""}:${match.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueRemotes(remotes: SshModelSource[]): SshModelSource[] {
  const seen = new Set<string>();
  return remotes.filter((remote) => {
    const key = `${remote.user ?? ""}@${remote.host}:${remote.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
