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
      detail: `ComfyUI responded at ${url}${hasXpu ? " (XPU device info present)" : ""}`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `Could not reach ${url} — ${msg}`
    };
  }
}

async function verifySsh(node: GpuNode, timeoutMs: number): Promise<GpuNodeVerifyResult> {
  if (!node.ssh) {
    return { ok: false, detail: "kind=ssh but ssh block is missing" };
  }
  const port = node.ssh.port ?? 22;
  const args = [
    "-p", String(port),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...(node.ssh.key_path ? ["-i", node.ssh.key_path] : []),
    `${node.ssh.user}@${node.ssh.host}`,
    `echo OK; uname -n; test -f ${shellQuote(node.comfyui_root + "/main.py")} && echo main_py_found || echo main_py_missing`
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, { timeout: timeoutMs + 5_000 });
    const lines = stdout.trim().split("\n");
    const host = lines[1] ?? "(unknown host)";
    const mainPy = lines[2] === "main_py_found" ? "main.py present" : "main.py MISSING";
    return {
      ok: true,
      detail: `SSH OK to ${node.ssh.user}@${node.ssh.host} (${host}); ${mainPy}`
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
    ssh
  };
}
