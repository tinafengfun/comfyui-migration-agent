/**
 * GPU node registry.
 *
 * Single source of truth for where ComfyUI can run. Each task picks one node at
 * creation time; the chosen node drives Step 05 launch (local shell vs SSH),
 * Step 07/08 endpoint resolution, and process cleanup routing.
 *
 * Config file: see `gpu-nodes.json` at the project root (override path via the
 * `GPU_NODES_PATH` env var). Missing file → single local node synthesized from
 * `AppConfig.comfyuiRoot` + `AppConfig.modelRoots` so the app keeps working
 * without forcing users to write a config.
 */
import fs from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AppConfig } from "./config";
import type { GpuNodeVerifyResult } from "../shared/types";
import type { Recipe } from "./recipeLibrary";
import { localCoreCommit } from "./coreNodeRecipeDiscovery";

const execFileAsync = promisify(execFileCb);

export interface GpuNodeSsh {
  host: string;
  user: string;
  port?: number;
  key_path?: string;
  /** Scratch dir on the remote for logs (we don't sync the whole workspace). */
  remote_workspace_root?: string;
}

export type GpuNodeKind = "local" | "ssh";
export type ModelShare = "nfs_same_path" | "none";
/**
 * "bare": existing behaviour — `venv_python main.py` as a plain subprocess.
 * "docker": Step 05 launches ComfyUI inside a container derived from
 * `docker_image` (e.g. Intel's `intel/llm-scaler-vllm:1.4`, used only for its
 * oneAPI/PyTorch-XPU stack — never that image's own ComfyUI/vLLM components).
 * The task's comfyui_root is `docker cp`'d into the container per-run (not
 * bind-mounted), so concurrent tasks don't share a mutable mount; model_roots
 * are bind-mounted since they're large/shared and read-mostly.
 */
export type GpuNodeRuntime = "bare" | "docker";

export interface GpuNode {
  name: string;
  kind: GpuNodeKind;
  vram_gb?: number;
  comfyui_root: string;
  venv_python: string;
  model_roots: string[];
  api_host: string;
  api_port: number;
  launch_flags?: string[];
  ssh?: GpuNodeSsh;
  model_share?: ModelShare;
  runtime?: GpuNodeRuntime;
  docker_image?: string;
  /**
   * Root of the shared multi-person NFS tree (custom_nodes/, docker-images/,
   * venv-container-xpu/, workflows/ — a superset of model_roots). Defaults to
   * "/nfs_share" when runtime="docker" and this is unset. See
   * docs/gpu-node-setup.md "Multi-person shared environment".
   */
  nfs_share_root?: string;
  /**
   * OmniXPU attention backend override, passed as -e OMNI_ATTN_BACKEND at launch:
   * "auto"|"cute"|"esimd" (fused, fastest) or "torch" (stable PyTorch SDPA).
   * Unset = the image default (auto/esimd). Set to "torch" on a node whose ESIMD
   * attention kernel intermittently faults the XPU (UR_RESULT_ERROR_DEVICE_LOST at
   * full-size attention). See docs — ESIMD is faster but can device-lost at very
   * large sequence lengths; torch is slower but stable (may still need the
   * reduced-size tier for full-size video). Confirmed live 2026-08-09.
   */
  attn_backend?: string;
  /**
   * XPU device index for `xpu-smi config -d <n> --reset`, used to recover the GPU
   * after a capacity OOM / DEVICE_LOST wedges the `xe` driver (VM worker -12 /
   * engine resets) — a container relaunch frees memory but NOT the driver state.
   * Defaults to "0" (matches the container's ZE_AFFINITY_MASK=0). Reset needs
   * passwordless sudo on the node and is run while the container is torn down.
   */
  xpu_device?: number | string;
}

export interface GpuNodeRegistry {
  default_node: string;
  nodes: GpuNode[];
}

/** What we return to the frontend — never contains ssh.key_path. */
export type GpuNodePublic = Omit<GpuNode, "ssh"> & {
  ssh?: Omit<GpuNodeSsh, "key_path"> & { key_configured: boolean };
};

export function maskNodeForPublic(node: GpuNode): GpuNodePublic {
  const { ssh, ...rest } = node;
  if (!ssh) return rest;
  const { key_path: _key_path, ...sshRest } = ssh;
  return { ...rest, ssh: { ...sshRest, key_configured: Boolean(ssh.key_path) } };
}

/**
 * Load the registry. Missing file is NOT an error — we synthesize a single
 * local node from the app config so existing deployments keep working.
 */
export function loadGpuNodes(config: AppConfig): GpuNodeRegistry {
  const filePath = config.gpuNodesPath;
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return synthesizeDefaultRegistry(config);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gpu-nodes.json at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  return normalizeRegistry(parsed, config, filePath);
}

/**
 * Union of the global default model roots and a specific node's own roots,
 * deduped, global-first. A node's `model_roots` list is meant to be
 * additional/override roots for that node, not a replacement for the global
 * default -- a node whose list omits a root that's actually still valid
 * there (e.g. hf_models genuinely NFS-mounted at the same path on both the
 * orchestrator host and a remote node, just never added to that node's own
 * list) shouldn't make callers blind to it.
 */
export function mergeModelRoots(globalRoots: string[], nodeRoots: string[]): string[] {
  return [...new Set([...globalRoots, ...nodeRoots])];
}

/** Pick a node by name, falling back to the registry default, then to nodes[0]. */
export function pickNode(registry: GpuNodeRegistry, name?: string): GpuNode {
  if (name) {
    const hit = registry.nodes.find((n) => n.name === name);
    if (hit) return hit;
  }
  const byDefault = registry.nodes.find((n) => n.name === registry.default_node);
  return byDefault ?? registry.nodes[0];
}

/** Build the HTTP API URL (no trailing slash) from a node. */
export function nodeApiUrl(node: GpuNode): string {
  return `http://${node.api_host}:${node.api_port}`;
}

/**
 * Render a compact "## GPU node" block for prompt injection.
 * The Step 05 skill branches on `kind` after reading this.
 */
export function renderGpuNodeBlock(node: GpuNode, taskId: string): string {
  const lines: string[] = ["## GPU node", ""];
  lines.push(`- name: ${node.name}`);
  lines.push(`- kind: ${node.kind}`);
  if (node.vram_gb !== undefined) lines.push(`- vram_gb: ${node.vram_gb}`);
  lines.push(`- api_url: ${nodeApiUrl(node)}`);
  lines.push(`- comfyui_root: ${node.comfyui_root}`);
  lines.push(`- venv_python: ${node.venv_python}`);
  lines.push(`- model_roots: ${node.model_roots.join(":") || "(none)"}`);
  if (node.model_share) lines.push(`- model_share: ${node.model_share}`);
  lines.push(`- runtime: ${node.runtime ?? "bare"}`);
  if (node.docker_image) lines.push(`- docker_image: ${node.docker_image}`);
  if (node.nfs_share_root) lines.push(`- nfs_share_root: ${node.nfs_share_root}`);
  if (node.launch_flags?.length) lines.push(`- launch_flags: ${node.launch_flags.join(" ")}`);
  if (node.kind === "ssh" && node.ssh) {
    const port = node.ssh.port ?? 22;
    lines.push(`- ssh: ${node.ssh.user}@${node.ssh.host}:${port}`);
    if (node.ssh.key_path) lines.push(`- ssh_key_path: ${node.ssh.key_path}`);
    if (node.ssh.remote_workspace_root) {
      lines.push(`- remote_workspace_root: ${node.ssh.remote_workspace_root}`);
    }
  }
  lines.push(`- task_id: ${taskId}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation + persistence (CRUD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomic registry write: tmp file + rename. Pretty-printed JSON + trailing
 * newline so manual edits and git diffs stay clean.
 */
export async function saveGpuNodes(config: AppConfig, registry: GpuNodeRegistry): Promise<void> {
  // Re-validate every node on save so a bad programmatic edit can't corrupt
  // the file. Throws on validation error before touching disk.
  const revalidated = normalizeRegistry(
    { default_node: registry.default_node, nodes: registry.nodes },
    config,
    config.gpuNodesPath
  );
  const dir = path.dirname(config.gpuNodesPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${config.gpuNodesPath}.tmp`;
  const body = JSON.stringify(revalidated, null, 2) + "\n";
  await fs.promises.writeFile(tmp, body, "utf8");
  await fs.promises.rename(tmp, config.gpuNodesPath);
}

/** Returns a NEW registry with the node added or replaced by name. */
export function upsertNode(registry: GpuNodeRegistry, node: GpuNode): GpuNodeRegistry {
  const without = registry.nodes.filter((n) => n.name !== node.name);
  return {
    default_node: registry.default_node,
    nodes: [...without, node]
  };
}

/** Returns a NEW registry without the named node. No-op (returns input) if absent. */
export function removeNode(registry: GpuNodeRegistry, name: string): GpuNodeRegistry {
  if (!registry.nodes.some((n) => n.name === name)) return registry;
  return {
    // If we just removed the default, point default at whichever node is first.
    default_node:
      registry.default_node === name
        ? (registry.nodes.find((n) => n.name !== name)?.name ?? "")
        : registry.default_node,
    nodes: registry.nodes.filter((n) => n.name !== name)
  };
}

/** Construct a GpuNode from a write request, validating required fields. */
export function buildNodeFromRequest(input: unknown, sourcePath: string): GpuNode {
  // Reuse the existing normalizeNode helper so write-side validation matches
  // load-side validation exactly.
  return normalizeNode(input, 0, sourcePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify (test connection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test that a node is reachable. Never throws — caller can render `detail`
 * verbatim. Local: curl /system_stats. SSH: echo + check main.py exists.
 *
 * For SSH nodes that haven't been persisted yet (no key configured), this
 * still tries the system's default ssh agent/keys.
 */
export async function verifyNode(node: GpuNode, timeoutMs = 10_000): Promise<GpuNodeVerifyResult> {
  if (node.kind === "local") {
    return verifyLocal(node, timeoutMs);
  }
  return verifySsh(node, timeoutMs);
}

async function verifyLocal(node: GpuNode, timeoutMs: number): Promise<GpuNodeVerifyResult> {
  const url = `${nodeApiUrl(node)}/system_stats`;
  const dockerSuffix = node.runtime === "docker" ? await checkLocalDockerImage(node) : "";
  const nfsRoot = resolveNfsShareRoot(node);
  const nfsSuffix = nfsRoot ? await checkLocalNfsShare(nfsRoot) : "";
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-fsS", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
      { timeout: timeoutMs + 2_000 }
    );
    const parsed = JSON.parse(stdout) as { system?: { xpu?: unknown; devices?: unknown[] } };
    const hasXpu = Boolean(parsed.system?.xpu ?? parsed.system?.devices?.length);
    return {
      ok: true,
      detail: `ComfyUI responded at ${url}${hasXpu ? " (XPU device info present)" : ""}${dockerSuffix}${nfsSuffix}`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `Could not reach ${url} — ${msg}${dockerSuffix}${nfsSuffix}`
    };
  }
}

/**
 * Root of the shared multi-person NFS tree for this node. Explicit
 * nfs_share_root wins; runtime="docker" nodes default to "/nfs_share" since
 * they fundamentally depend on it (custom_nodes/, docker-images/,
 * venv-container-xpu/). Bare nodes with no explicit setting have none.
 */
export function resolveNfsShareRoot(node: GpuNode): string | undefined {
  return node.nfs_share_root ?? (node.runtime === "docker" ? "/nfs_share" : undefined);
}

/** For runtime=docker nodes, confirm the pinned image is already loaded locally (avoids a surprise pull mid-task). */
async function checkLocalDockerImage(node: GpuNode): Promise<string> {
  if (!node.docker_image) return "; runtime=docker but docker_image is unset";
  try {
    await execFileAsync("docker", ["image", "inspect", node.docker_image], { timeout: 10_000 });
    return `; docker image ${node.docker_image} present`;
  } catch {
    return `; docker image ${node.docker_image} NOT found locally — POST /api/gpu-nodes/${encodeURIComponent(node.name)}/sync-docker-image or run scripts/load-docker-image-from-nfs.sh`;
  }
}

async function checkLocalNfsShare(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("bash", ["-c", nfsHealthShellCmd(root)], { timeout: 10_000 });
    return formatNfsHealthSuffix(root, stdout.split("\n"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `; NFS share ${root} check failed — ${msg}`;
  }
}

/**
 * Shell snippet (used both locally and over ssh) that reports mount health +
 * the three subdirs a docker-runtime node depends on, each as a distinct
 * PREFIX:value line so the caller can parse by scanning rather than by fixed
 * line position (robust to whichever other checks get concatenated before it).
 */
function nfsHealthShellCmd(root: string): string {
  const q = shellQuote(root);
  const mountCheck =
    `if command -v mountpoint >/dev/null 2>&1; then ` +
    `mountpoint -q ${q} && echo NFS_MOUNT:mounted || echo NFS_MOUNT:not_mounted; ` +
    `else ` +
    `[ -d ${q} ] && [ -n "$(ls -A ${q} 2>/dev/null)" ] && echo NFS_MOUNT:nonempty || echo NFS_MOUNT:empty_or_missing; ` +
    `fi`;
  const subdirChecks = ["custom_nodes", "docker-images", "venv-container-xpu"]
    .map((d) => `test -d ${shellQuote(`${root}/${d}`)} && echo NFS_SUBDIR:${d}:ok || echo NFS_SUBDIR:${d}:missing`)
    .join("; ");
  return `${mountCheck}; ${subdirChecks}`;
}

/** Exported for direct unit testing — parses the PREFIX:value lines produced by nfsHealthShellCmd(). */
export function formatNfsHealthSuffix(root: string, lines: string[]): string {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);
  const mountLine = trimmed.find((l) => l.startsWith("NFS_MOUNT:"));
  const mounted = mountLine === "NFS_MOUNT:mounted" || mountLine === "NFS_MOUNT:nonempty";
  if (!mounted) {
    return `; NFS share ${root} NOT mounted/populated`;
  }
  const missingSubdirs = trimmed
    .filter((l) => l.startsWith("NFS_SUBDIR:") && l.endsWith(":missing"))
    .map((l) => l.split(":")[1]);
  if (missingSubdirs.length > 0) {
    return `; NFS share ${root} mounted but missing: ${missingSubdirs.join(", ")}`;
  }
  return `; NFS share ${root} healthy`;
}

async function verifySsh(node: GpuNode, timeoutMs: number): Promise<GpuNodeVerifyResult> {
  if (!node.ssh) {
    return { ok: false, detail: "kind=ssh but ssh block is missing" };
  }
  const port = node.ssh.port ?? 22;
  const nfsRoot = resolveNfsShareRoot(node);
  const checks = [
    "echo OK",
    "uname -n",
    `test -f ${shellQuote(node.comfyui_root + "/main.py")} && echo MAIN_PY:found || echo MAIN_PY:missing`
  ];
  if (node.runtime === "docker" && node.docker_image) {
    checks.push(
      `docker image inspect ${shellQuote(node.docker_image)} >/dev/null 2>&1 && echo DOCKER_IMAGE:found || echo DOCKER_IMAGE:missing`
    );
  }
  if (nfsRoot) {
    checks.push(nfsHealthShellCmd(nfsRoot));
  }
  const args = [
    "-p", String(port),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...(node.ssh.key_path ? ["-i", node.ssh.key_path] : []),
    `${node.ssh.user}@${node.ssh.host}`,
    checks.join("; ")
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, { timeout: timeoutMs + 5_000 });
    const lines = stdout.trim().split("\n").map((l) => l.trim());
    const host = lines[1] ?? "(unknown host)";
    const mainPyLine = lines.find((l) => l.startsWith("MAIN_PY:"));
    const mainPy = mainPyLine === "MAIN_PY:found" ? "main.py present" : "main.py MISSING";
    let dockerSuffix = "";
    if (node.runtime === "docker") {
      const dockerLine = lines.find((l) => l.startsWith("DOCKER_IMAGE:"));
      dockerSuffix =
        dockerLine === "DOCKER_IMAGE:found"
          ? `; docker image ${node.docker_image} present`
          : `; docker image ${node.docker_image} NOT found — POST /api/gpu-nodes/${encodeURIComponent(node.name)}/sync-docker-image or run scripts/load-docker-image-from-nfs.sh on ${node.ssh.host}`;
    }
    const nfsSuffix = nfsRoot ? formatNfsHealthSuffix(nfsRoot, lines) : "";
    return {
      ok: true,
      detail: `SSH OK to ${node.ssh.user}@${node.ssh.host} (${host}); ${mainPy}${dockerSuffix}${nfsSuffix}`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `SSH to ${node.ssh.user}@${node.ssh.host}:${port} failed — ${msg}`
    };
  }
}

function shellQuote(s: string): string {
  // Single-quote + escape embedded single quotes. Good enough for the limited
  // character set we expect in comfyui_root paths.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Docker image from the shared NFS store (see scripts/save-docker-image-to-nfs.sh)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load (or refresh) this node's Docker image from the shared NFS store,
 * transporting and running the SAME canonical script used for standalone ops
 * (scripts/load-docker-image-from-nfs.sh) rather than reimplementing its
 * digest-verification logic in TypeScript. Local nodes run it directly;
 * ssh nodes get it scp'd to a per-user cache path first.
 */
export async function syncDockerImageFromNfs(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<{ ok: boolean; detail: string }> {
  const localScriptPath = path.join(config.projectRoot, "scripts", "load-docker-image-from-nfs.sh");
  if (!fs.existsSync(localScriptPath)) {
    return { ok: false, detail: `sync script not found at ${localScriptPath}` };
  }
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  return runScriptOnNode(node, localScriptPath, {
    remoteScriptName: "load-docker-image-from-nfs.sh",
    scriptArgs: [],
    env: { NFS_DOCKER_IMAGES_ROOT: `${nfsRoot}/docker-images` },
    timeoutMs: 30 * 60_000,
    actionLabel: "image sync"
  });
}

/**
 * Cheap pre-flight check for a docker-runtime node's image, meant to run
 * automatically before every Step 05 (not just the manual "Sync Docker
 * Image" button): compares the node's locally-loaded image_id against the
 * NFS manifest's recorded image_id -- a fast `docker image inspect`, no
 * data transfer -- and only invokes the full syncDockerImageFromNfs (a real
 * ~14GB `docker load`) when they differ or the image isn't present locally
 * at all. The manifest itself is read directly off the orchestrator's own
 * `/nfs_share` mount (no SSH needed for that part); only the "what's
 * actually loaded on the target node" half needs to run on the node.
 * No-ops for non-docker-runtime nodes or when the manifest can't be read
 * (best-effort -- a missing/unreadable manifest should never block Step 05).
 */
export async function ensureDockerImageSynced(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<{ synced: boolean; detail: string }> {
  if (node.runtime !== "docker" || !node.docker_image) {
    return { synced: false, detail: "not a docker-runtime node; nothing to sync" };
  }

  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  const safeName = node.docker_image.replace(/[/:]/g, "-");
  const manifestPath = path.join(nfsRoot, "docker-images", `${safeName}.manifest.json`);
  let expectedId: string | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { image_id?: string };
    expectedId = manifest.image_id;
  } catch (err) {
    return {
      synced: false,
      detail: `could not read NFS manifest at ${manifestPath}: ${(err as Error).message} -- skipping drift check`
    };
  }
  if (!expectedId) {
    return { synced: false, detail: `manifest at ${manifestPath} has no image_id -- skipping drift check` };
  }

  const actualId = await inspectRemoteImageId(node);
  if (actualId === expectedId) {
    return {
      synced: false,
      detail: `docker image ${node.docker_image} already matches NFS manifest (${expectedId.slice(0, 19)}...)`
    };
  }

  const reason = actualId
    ? `local image_id ${actualId.slice(0, 19)}... does not match NFS manifest image_id ${expectedId.slice(0, 19)}...`
    : `docker image ${node.docker_image} not present locally`;
  const result = await syncDockerImageFromNfs(node, config);
  return {
    synced: result.ok,
    detail: `${reason} -- ${result.ok ? "synced from NFS" : "sync attempt failed"}: ${result.detail}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ComfyUI-core NFS drift detection + sync
// ─────────────────────────────────────────────────────────────────────────────

export interface ComfyUiCoreDriftResult {
  inSync: boolean;
  localCommit?: string;
  canonicalCommit?: string;
  detail: string;
}

/**
 * Compares this node's comfyui_root git commit against the canonical
 * /nfs_share/comfyui-core repo's HEAD. Detection only -- deliberately does
 * NOT auto-sync on drift, unlike ensureDockerImageSynced above. A docker
 * image tag only ever changes via a deliberate republish, so auto-loading a
 * matching one is safe; ComfyUI core is a live, actively-run codebase, and
 * silently rewriting it between task runs would make a regression hard to
 * bisect (which task run first saw the changed code?). Surfacing drift as
 * durable evidence and leaving the actual sync to a human (the "Sync from
 * NFS" button, or scripts/sync-comfyui-core-from-nfs.sh) is the deliberate
 * choice here -- see docs/gpu-node-setup.md's "Shared ComfyUI core
 * convention" section.
 *
 * Missing canonical repo, or comfyui_root not a git checkout, is reported as
 * in-sync (nothing to compare against) rather than drifted -- a node that
 * was never meant to track the canonical repo shouldn't get flagged.
 */
export async function checkComfyUiCoreDrift(node: GpuNode): Promise<ComfyUiCoreDriftResult> {
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  const canonicalPath = path.join(nfsRoot, "comfyui-core");
  if (!fs.existsSync(path.join(canonicalPath, ".git"))) {
    return { inSync: true, detail: `no canonical repo at ${canonicalPath} -- nothing to compare` };
  }
  const canonicalCommit = await localCoreCommit(canonicalPath);
  if (!canonicalCommit) {
    return { inSync: true, detail: `could not read canonical repo HEAD at ${canonicalPath}` };
  }
  const localCommit = await localCoreCommit(node.comfyui_root);
  if (!localCommit) {
    return {
      inSync: true,
      canonicalCommit,
      detail: `${node.comfyui_root} is not a git checkout (or git is unavailable) -- nothing to compare`
    };
  }
  if (localCommit === canonicalCommit) {
    return { inSync: true, localCommit, canonicalCommit, detail: `comfyui_root already matches canonical (${canonicalCommit})` };
  }
  return {
    inSync: false,
    localCommit,
    canonicalCommit,
    detail: `comfyui_root is at ${localCommit}, canonical /nfs_share/comfyui-core is at ${canonicalCommit} -- run scripts/sync-comfyui-core-from-nfs.sh (or the GPU Nodes Manager "Sync ComfyUI Core" button) to update, or scripts/publish-comfyui-core-patch.sh if this node has a local core fix to preserve`
  };
}

/**
 * Sync this node's comfyui_root to the canonical /nfs_share/comfyui-core
 * repo -- a real `git merge` (via scripts/sync-comfyui-core-from-nfs.sh),
 * refuses if the node has uncommitted core changes. Manual/human-triggered
 * only (the GPU Nodes Manager button, or run directly) -- see
 * checkComfyUiCoreDrift's doc comment for why this is never auto-invoked.
 */
export async function syncComfyUiCoreFromNfs(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<{ ok: boolean; detail: string }> {
  const localScriptPath = path.join(config.projectRoot, "scripts", "sync-comfyui-core-from-nfs.sh");
  if (!fs.existsSync(localScriptPath)) {
    return { ok: false, detail: `sync script not found at ${localScriptPath}` };
  }
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  return runScriptOnNode(node, localScriptPath, {
    remoteScriptName: "sync-comfyui-core-from-nfs.sh",
    scriptArgs: [node.comfyui_root],
    env: { NFS_COMFYUI_CORE_ROOT: `${nfsRoot}/comfyui-core` },
    timeoutMs: 5 * 60_000,
    actionLabel: "ComfyUI core sync"
  });
}

/**
 * Publish this node's local comfyui_root core commits back into the canonical
 * /nfs_share/comfyui-core repo (a real `git merge` via
 * scripts/publish-comfyui-core-patch.sh, serialized by an flock in the script).
 * This is the "sync new patches back to the NFS master" half of the
 * clone-from-NFS -> patch-local -> publish-back loop. Best-effort: the script
 * refuses (non-zero) if the local root has uncommitted tracked changes or a
 * merge conflict, which the caller treats as a soft failure (durable evidence),
 * never a migration-breaking error.
 */
export async function publishComfyUiCoreToNfs(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<{ ok: boolean; detail: string }> {
  const localScriptPath = path.join(config.projectRoot, "scripts", "publish-comfyui-core-patch.sh");
  if (!fs.existsSync(localScriptPath)) {
    return { ok: false, detail: `publish script not found at ${localScriptPath}` };
  }
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  return runScriptOnNode(node, localScriptPath, {
    remoteScriptName: "publish-comfyui-core-patch.sh",
    scriptArgs: [node.comfyui_root],
    env: { NFS_COMFYUI_CORE_ROOT: `${nfsRoot}/comfyui-core` },
    timeoutMs: 5 * 60_000,
    actionLabel: "ComfyUI core publish"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Live XPU memory telemetry (device-level, via xpu-smi on the node)
// ─────────────────────────────────────────────────────────────────────────────

export interface XpuMemoryDevice {
  device_id: number;
  ok: boolean;
  device_name?: string | null;
  mem_used_mib?: number | null;
  mem_total_mib?: number | null;
  mem_used_pct?: number | null;
  mem_util_pct?: number | null;
  gpu_util_pct?: number | null;
  power_w?: number | null;
  temp_c?: number | null;
}
export interface XpuMemorySample {
  ok: boolean;
  timestamp?: number;
  tool?: string;
  devices: XpuMemoryDevice[];
  error?: string;
}

/**
 * Sample RAW device-level XPU memory on a node via `scripts/xpu-mem-sample.py`
 * (xpu-smi under the hood) — the accurate source, unlike ComfyUI's /system_stats
 * self-accounting. The script is piped over the wire (base64 → python3 -) so it
 * needs no prior deployment and stays stateless for frequent polling. Degrades
 * to ok:false (never throws) on a non-XPU node / missing xpu-smi / unreachable
 * host, so the web UI can show "unavailable" cleanly. Backend GET
 * /api/gpu-nodes/:name/xpu-memory wraps this; the frontend polls it live.
 */
export async function sampleXpuMemory(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<XpuMemorySample> {
  const scriptPath = path.join(config.projectRoot, "scripts", "xpu-mem-sample.py");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, devices: [], error: `xpu-mem sampler not found at ${scriptPath}` };
  }
  const b64 = Buffer.from(fs.readFileSync(scriptPath, "utf8")).toString("base64");
  const out = await runShellOnNode(node, `echo ${b64} | base64 -d | python3 -`, 12_000);
  if (!out) {
    return { ok: false, devices: [], error: "xpu-smi sampler produced no output (not an XPU node, xpu-smi unavailable, or node unreachable)" };
  }
  try {
    const parsed = JSON.parse(out) as XpuMemorySample;
    if (!Array.isArray(parsed.devices)) parsed.devices = [];
    return parsed;
  } catch {
    return { ok: false, devices: [], error: `unparseable xpu-smi sampler output: ${out.slice(0, 200)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipe environment-drift detection
// ─────────────────────────────────────────────────────────────────────────────

export interface RecipeVersionCheck {
  recipeId: string;
  packageName: string;
  expectedRef: string;
  actualVersion?: string;
  drifted: boolean;
}

export interface RecipeEnvironmentDriftResult {
  checked: number;
  drifted: RecipeVersionCheck[];
}

/**
 * The gap this closes: the patch-adaptation-protocol already has the
 * *concept* of version drift (baseVersion vs. installed version -> escalate
 * through Layers 1/2/3), but nothing automatically checks whether a matched
 * recipe's assumed environment still holds before the SDK agent starts
 * trusting its patch. Confirmed live: comfy_kitchen drifted from what
 * CLIPLoader-qwen-fp8's baseVersion assumed, and finding that out cost ~10+
 * minutes of manual bash archaeology in Step 05, not an automatic signal.
 *
 * Deliberately scoped to PIP-installable packages only (checked via
 * `importlib.metadata.version()`, resolved for real inside the node's own
 * environment -- docker-runtime nodes get wrapped in a throwaway container
 * since the persisted venv only resolves correctly from inside one, per
 * ensureDockerImageSynced's own docstring). A recipe whose baseVersion names
 * a git-cloned custom-node repo (e.g. "numz/ComfyUI-SeedVR2_VideoUpscaler@…")
 * naturally fails to resolve as a pip distribution name and is silently
 * skipped -- that case is already handled by the existing protocol's own
 * commit-based version check (01-acquisition-job.json), not duplicated here.
 *
 * Detection only: never blocks Step 05, never applies/adapts anything
 * itself -- just surfaces a clear, visible flag so re-verification (today,
 * still a human/agent judgment call) happens on purpose instead of by
 * accident.
 */
export async function checkRecipeEnvironmentDrift(
  recipes: Recipe[],
  node: GpuNode
): Promise<RecipeEnvironmentDriftResult> {
  const checks: RecipeVersionCheck[] = [];
  for (const recipe of recipes) {
    if (!recipe.baseVersion) continue;
    const at = recipe.baseVersion.lastIndexOf("@");
    if (at <= 0) continue;
    const packageName = recipe.baseVersion.slice(0, at);
    const expectedRef = recipe.baseVersion.slice(at + 1);
    // Only meaningful for a plain package name (no "/" or path separators --
    // a git-repo-style reference like "owner/Repo" is never a pip
    // distribution name, so resolveInstalledPackageVersion would just fail
    // to find it anyway, but skip the round-trip).
    if (packageName.includes("/")) continue;

    const actualVersion = await resolveInstalledPackageVersion(node, packageName);
    if (!actualVersion) continue;
    checks.push({
      recipeId: recipe.recipeId,
      packageName,
      expectedRef,
      actualVersion,
      drifted: actualVersion !== expectedRef
    });
  }
  return { checked: checks.length, drifted: checks.filter((c) => c.drifted) };
}

/**
 * Runs a shell command directly on the node's HOST (local or ssh) --
 * deliberately NEVER docker-wrapped. Use for checks that need the host's own
 * OS-level state (port bindings, process listings) rather than a
 * container's isolated view -- a throwaway `docker run --rm` (without
 * `--network host`) has its own network namespace and wouldn't see the
 * host's actual bound ports at all. Best-effort: returns undefined on any
 * failure (unreachable node, command not found, etc.), never throws.
 */
export async function runShellOnNode(node: GpuNode, cmd: string, timeoutMs = 15_000): Promise<string | undefined> {
  try {
    if (node.kind === "local") {
      const { stdout } = await execFileAsync("bash", ["-c", cmd], { timeout: timeoutMs });
      return stdout.trim() || undefined;
    }
    if (!node.ssh) return undefined;
    const port = node.ssh.port ?? 22;
    const sshKeyArgs = node.ssh.key_path ? ["-i", node.ssh.key_path] : [];
    const { stdout } = await execFileAsync(
      "ssh",
      ["-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshKeyArgs, `${node.ssh.user}@${node.ssh.host}`, cmd],
      { timeout: timeoutMs + 5_000 }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs a shell command inside the node's own Python environment --
 * docker-wrapped (throwaway `docker run --rm`) for runtime=docker nodes,
 * since the persisted venv only resolves its packages correctly from inside
 * a container with the matching system libs (confirmed live: running it
 * bare on the host fails to even find comfy_kitchen). Otherwise identical
 * to runShellOnNode. Best-effort, never throws.
 */
async function runInNodeEnv(node: GpuNode, cmd: string, timeoutMs = 60_000): Promise<string | undefined> {
  if (node.runtime !== "docker" || !node.docker_image) {
    return runShellOnNode(node, cmd, timeoutMs);
  }
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  const wrapped = `docker run --rm -v ${shellQuote(`${nfsRoot}:${nfsRoot}`)} ${shellQuote(node.docker_image)} bash -c ${shellQuote(cmd)}`;
  return runShellOnNode(node, wrapped, timeoutMs);
}

/**
 * `importlib.metadata.version(packageName)` resolved inside the node's own
 * environment. Returns undefined on any failure (package not installed,
 * node unreachable, etc.) -- never throws.
 */
async function resolveInstalledPackageVersion(node: GpuNode, packageName: string): Promise<string | undefined> {
  const pyCode = `import importlib.metadata as m; print(m.version(${JSON.stringify(packageName)}))`;
  const pyCmd = `${shellQuote(node.venv_python)} -c ${shellQuote(pyCode)} 2>/dev/null || true`;
  return runInNodeEnv(node, pyCmd);
}

export interface PortOccupant {
  occupied: boolean;
  pid?: string;
  commandLine?: string;
}

/**
 * Checks whether `port` is bound on the node's host and, if so, identifies
 * the occupying process's PID + full command line (callers use this to
 * extract e.g. the ComfyUI workspace path a stale process was launched
 * from). Best-effort: `occupied: false` covers both "genuinely free" and
 * "couldn't determine" -- a failed check should never trigger a kill
 * attempt, and a normal docker/bare-metal launch attempt is a safe fallback
 * either way (it will itself fail loudly if the port really is taken).
 */
export async function checkPortOccupant(node: GpuNode, port: number): Promise<PortOccupant> {
  const findPidCmd = `ss -ltnp 2>/dev/null | grep -E ":${port}\\s" | grep -oP 'pid=\\K[0-9]+' | head -1`;
  const pid = await runShellOnNode(node, findPidCmd, 15_000);
  if (!pid) return { occupied: false };
  const commandLine = await runShellOnNode(node, `ps -o cmd= -p ${shellQuote(pid)} 2>/dev/null || true`, 15_000);
  return { occupied: true, pid, commandLine };
}

/**
 * Seconds since `pid` started (`ps -o etimes=`), on the node's host.
 * Elapsed-time rather than an absolute start timestamp specifically to
 * avoid parsing `ps -o lstart=`'s locale-dependent date format across local
 * and remote hosts. Returns undefined if the process doesn't exist or the
 * node is unreachable -- never throws.
 */
export async function getProcessElapsedSeconds(node: GpuNode, pid: string): Promise<number | undefined> {
  const result = await runShellOnNode(node, `ps -o etimes= -p ${shellQuote(pid)} 2>/dev/null || true`, 15_000);
  if (!result) return undefined;
  const seconds = Number(result.trim());
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * SIGTERMs `pid` on the node's host. Only meant for a PID already confirmed
 * (via checkPortOccupant) to be a specific, known-stale process -- not a
 * general-purpose kill. Returns true on a clean `kill` exit, false
 * otherwise (already gone, permission denied, node unreachable) -- never
 * throws.
 */
export async function killProcessOnNode(node: GpuNode, pid: string): Promise<boolean> {
  const result = await runShellOnNode(node, `kill -TERM ${shellQuote(pid)} 2>/dev/null && echo killed || echo failed`, 15_000);
  return result === "killed";
}

export interface OmniXpuAccelerationCapability {
  /** Whether ComfyUI-OmniXPU's custom-node directory is present under this node's comfyui_root/custom_nodes. */
  omniXpuNodePresent: boolean;
  /** Whether omni_xpu_kernel (the compiled cute/esimd attention backend) actually imports in this node's environment. */
  kernelImportable: boolean;
}

/**
 * Checks whether real XPU-native attention acceleration (ComfyUI-OmniXPU's
 * cute/esimd backends via omni_xpu_kernel) is actually available in this
 * node's resolved environment -- not just "is the custom node symlinked",
 * since the compiled kernel is a separate, environment-specific dependency
 * (ships in the docker image's system dist-packages; a bare-metal venv
 * typically won't have it). Best-effort, never throws.
 */
export async function checkOmniXpuAcceleration(node: GpuNode): Promise<OmniXpuAccelerationCapability> {
  const dirCheckCmd = `test -d ${shellQuote(path.join(node.comfyui_root, "custom_nodes", "ComfyUI-OmniXPU"))} && echo present || echo absent`;
  const dirResult = await runShellOnNode(node, dirCheckCmd, 15_000);
  if (dirResult !== "present") return { omniXpuNodePresent: false, kernelImportable: false };

  const importCmd = `${shellQuote(node.venv_python)} -c "import omni_xpu_kernel" >/dev/null 2>&1 && echo importable || echo not_importable`;
  const importResult = await runInNodeEnv(node, importCmd, 30_000);
  return { omniXpuNodePresent: true, kernelImportable: importResult === "importable" };
}

/** `docker image inspect --format '{{.Id}}'` on the node, local or over ssh. Returns undefined on any failure (image missing, node unreachable, etc.) -- never throws. */
async function inspectRemoteImageId(node: GpuNode): Promise<string | undefined> {
  const cmd = `docker image inspect ${shellQuote(node.docker_image!)} --format '{{.Id}}' 2>/dev/null || true`;
  try {
    if (node.kind === "local") {
      const { stdout } = await execFileAsync("bash", ["-c", cmd], { timeout: 10_000 });
      return stdout.trim() || undefined;
    }
    if (!node.ssh) return undefined;
    const port = node.ssh.port ?? 22;
    const sshKeyArgs = node.ssh.key_path ? ["-i", node.ssh.key_path] : [];
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshKeyArgs,
        `${node.ssh.user}@${node.ssh.host}`,
        cmd
      ],
      { timeout: 15_000 }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bulk-symlink /nfs_share/custom_nodes/* into a node's comfyui_root/custom_nodes,
 * transporting and running scripts/sync-custom-nodes-from-nfs.sh — same
 * canonical-script-not-reimplemented approach as syncDockerImageFromNfs.
 */
export async function syncCustomNodesFromNfs(
  node: GpuNode,
  config: Pick<AppConfig, "projectRoot">
): Promise<{ ok: boolean; detail: string }> {
  const localScriptPath = path.join(config.projectRoot, "scripts", "sync-custom-nodes-from-nfs.sh");
  if (!fs.existsSync(localScriptPath)) {
    return { ok: false, detail: `sync script not found at ${localScriptPath}` };
  }
  const nfsRoot = resolveNfsShareRoot(node) ?? "/nfs_share";
  return runScriptOnNode(node, localScriptPath, {
    remoteScriptName: "sync-custom-nodes-from-nfs.sh",
    scriptArgs: [node.comfyui_root, `${nfsRoot}/custom_nodes`],
    env: {},
    timeoutMs: 60_000,
    actionLabel: "custom_nodes sync"
  });
}

/**
 * Shared transport for "run this canonical ops script against a node":
 * local nodes run it directly; ssh nodes get it scp'd to a per-user cache
 * path first, then executed there. One transport, reused by every
 * NFS-sync helper so the scp/ssh dance isn't duplicated per script.
 */
async function runScriptOnNode(
  node: GpuNode,
  localScriptPath: string,
  opts: { remoteScriptName: string; scriptArgs: string[]; env: Record<string, string>; timeoutMs: number; actionLabel: string }
): Promise<{ ok: boolean; detail: string }> {
  const argsSuffix = opts.scriptArgs.length ? ` ${opts.scriptArgs.map(shellQuote).join(" ")}` : "";

  if (node.kind === "local") {
    try {
      const { stdout } = await execFileAsync("bash", [localScriptPath, ...opts.scriptArgs], {
        timeout: opts.timeoutMs,
        env: { ...process.env, ...opts.env }
      });
      return { ok: true, detail: summarizeSyncOutput(stdout) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `local ${opts.actionLabel} failed: ${msg}` };
    }
  }

  if (!node.ssh) {
    return { ok: false, detail: "kind=ssh but ssh block is missing" };
  }
  const port = node.ssh.port ?? 22;
  const sshKeyArgs = node.ssh.key_path ? ["-i", node.ssh.key_path] : [];
  const remoteScriptPath = `~/.cache/migration-agent/${opts.remoteScriptName}`;
  const envPrefix = Object.entries(opts.env)
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join("");
  try {
    await execFileAsync(
      "ssh",
      [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshKeyArgs,
        `${node.ssh.user}@${node.ssh.host}`,
        "mkdir -p ~/.cache/migration-agent"
      ],
      { timeout: 15_000 }
    );
    await execFileAsync(
      "scp",
      ["-P", String(port), ...sshKeyArgs, localScriptPath, `${node.ssh.user}@${node.ssh.host}:${remoteScriptPath}`],
      { timeout: 30_000 }
    );
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshKeyArgs,
        `${node.ssh.user}@${node.ssh.host}`,
        `${envPrefix}bash ${remoteScriptPath}${argsSuffix}`
      ],
      { timeout: opts.timeoutMs }
    );
    return { ok: true, detail: summarizeSyncOutput(stdout) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `remote ${opts.actionLabel} via ${node.ssh.user}@${node.ssh.host} failed: ${msg}` };
  }
}

function summarizeSyncOutput(stdout: string): string {
  return stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function synthesizeDefaultRegistry(config: AppConfig): GpuNodeRegistry {
  const node: GpuNode = {
    name: "local-xpu",
    kind: "local",
    comfyui_root: config.comfyuiRoot,
    // The default ComfyUI venv python path matches what step 05 skill expects.
    venv_python: path.join(config.comfyuiRoot, ".venv", "bin", "python3"),
    model_roots: config.modelRoots.slice(),
    api_host: "127.0.0.1",
    api_port: Number(process.env.COMFYUI_PORT ?? "8188"),
    launch_flags: ["--reserve-vram", "1"]
  };
  return { default_node: node.name, nodes: [node] };
}

function normalizeRegistry(
  parsed: unknown,
  config: AppConfig,
  sourcePath: string
): GpuNodeRegistry {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`gpu-nodes.json at ${sourcePath} must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const nodesRaw = obj.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new Error(`gpu-nodes.json at ${sourcePath} must have a non-empty "nodes" array`);
  }
  const nodes: GpuNode[] = nodesRaw.map((raw, i) => normalizeNode(raw, i, sourcePath));
  const defaultName = typeof obj.default_node === "string" ? obj.default_node : nodes[0].name;
  if (!nodes.some((n) => n.name === defaultName)) {
    throw new Error(
      `gpu-nodes.json default_node "${defaultName}" does not match any node name at ${sourcePath}`
    );
  }
  // Touch config so the parameter is used (suppresses unused-arg lint in TS strict);
  // the synthesized fallback is the only place config drives defaults, and that
  // path doesn't reach here. Kept for future per-field env overrides.
  void config;
  return { default_node: defaultName, nodes };
}

function normalizeNode(raw: unknown, index: number, sourcePath: string): GpuNode {
  if (!raw || typeof raw !== "object") {
    throw new Error(`gpu-nodes.json node[${index}] at ${sourcePath} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  if (!name) throw new Error(`gpu-nodes.json node[${index}] is missing "name"`);
  const kind: GpuNodeKind = o.kind === "ssh" ? "ssh" : "local";
  const comfyui_root = typeof o.comfyui_root === "string" ? o.comfyui_root : "";
  if (!comfyui_root) {
    throw new Error(`gpu-nodes.json node "${name}" is missing "comfyui_root"`);
  }
  const venv_python = typeof o.venv_python === "string" ? o.venv_python : "";
  if (!venv_python) {
    throw new Error(`gpu-nodes.json node "${name}" is missing "venv_python"`);
  }
  const model_roots =
    Array.isArray(o.model_roots) && o.model_roots.every((v) => typeof v === "string")
      ? (o.model_roots as string[])
      : [];
  const api_host = typeof o.api_host === "string" ? o.api_host : "127.0.0.1";
  const api_port = typeof o.api_port === "number" ? o.api_port : 8188;
  const launch_flags =
    Array.isArray(o.launch_flags) && o.launch_flags.every((v) => typeof v === "string")
      ? (o.launch_flags as string[])
      : undefined;
  const vram_gb = typeof o.vram_gb === "number" ? o.vram_gb : undefined;
  const model_share: ModelShare | undefined =
    o.model_share === "nfs_same_path" || o.model_share === "none" ? o.model_share : undefined;
  const runtime: GpuNodeRuntime | undefined =
    o.runtime === "docker" || o.runtime === "bare" ? o.runtime : undefined;
  const docker_image = typeof o.docker_image === "string" ? o.docker_image : undefined;
  if (runtime === "docker" && !docker_image) {
    throw new Error(
      `gpu-nodes.json node "${name}" has runtime="docker" but is missing "docker_image"`
    );
  }
  const nfs_share_root = typeof o.nfs_share_root === "string" ? o.nfs_share_root : undefined;
  const attn_backend = typeof o.attn_backend === "string" ? o.attn_backend : undefined;

  let ssh: GpuNodeSsh | undefined;
  if (kind === "ssh") {
    const s = (o.ssh ?? {}) as Record<string, unknown>;
    const sshHost = typeof s.host === "string" ? s.host : "";
    const sshUser = typeof s.user === "string" ? s.user : "";
    if (!sshHost || !sshUser) {
      throw new Error(
        `gpu-nodes.json node "${name}" has kind=ssh but is missing ssh.host or ssh.user`
      );
    }
    ssh = {
      host: sshHost,
      user: sshUser,
      port: typeof s.port === "number" ? s.port : undefined,
      key_path: typeof s.key_path === "string" ? s.key_path : undefined,
      remote_workspace_root:
        typeof s.remote_workspace_root === "string" ? s.remote_workspace_root : undefined
    };
  }

  return {
    name,
    kind,
    comfyui_root,
    venv_python,
    model_roots,
    api_host,
    api_port,
    launch_flags,
    vram_gb,
    model_share,
    runtime,
    docker_image,
    nfs_share_root,
    attn_backend,
    ssh
  };
}
