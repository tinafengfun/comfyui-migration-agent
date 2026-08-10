/**
 * comfyuiLifecycle.ts — the single source of truth for "is this GPU node's
 * ComfyUI reachable, and if not, how do we correctly bring it up."
 *
 * Extracted from scripts/remote-comfyui.mts (which is now a thin CLI wrapper
 * around this module) so the exact same, tested logic is importable directly
 * from orchestrator.ts -- an automatic pre-Step07/08 check calls
 * ensureComfyUiUp() before handing off to the SDK session, instead of relying
 * on the SDK agent to read a skill doc and improvise the right docker/bare-metal
 * command itself under time pressure.
 *
 * Real incident this closes: an SDK session's own ad hoc `docker run` (no
 * --entrypoint, workflow checkout bind-mounted over the image's own
 * /workspace/comfyui) ran the image's own outdated baked-in comfy_aimdo
 * instead of the correctly configured shared venv -- the environment was
 * never broken, the ad hoc relaunch command was. buildDockerStartScript()
 * below is the one place that constructs the correct command; nothing else
 * should ever hand-write a `docker run` for a runtime=docker node's ComfyUI.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { resolveNfsShareRoot, type GpuNode } from "./gpuNodes";

const execFile = promisify(execFileCb);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shellQuote(s: string): string {
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

function sshBase(node: GpuNode): string[] {
  const s = node.ssh!;
  return [
    "-p", String(s.port ?? 22), ...(s.key_path ? ["-i", s.key_path] : []),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${s.user}@${s.host}`
  ];
}

export async function objectInfoUp(apiUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/system_stats`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Run `docker <args>` on the node — locally or over ssh. Never throws. */
export async function dockerOnNode(
  node: GpuNode,
  args: string[],
  timeoutMs = 30_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    let stdout = "", stderr = "";
    if (node.kind === "ssh") {
      const r = await execFile("ssh", ["-n", ...sshBase(node), `docker ${args.map(shellQuote).join(" ")}`], { timeout: timeoutMs });
      stdout = r.stdout; stderr = r.stderr;
    } else {
      const r = await execFile("docker", args, { timeout: timeoutMs });
      stdout = r.stdout; stderr = r.stderr;
    }
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e) };
  }
}

/** For a runtime=docker node, find the running/stopped `comfyui-*` container from its image. */
export async function detectContainer(node: GpuNode): Promise<string | undefined> {
  if (node.runtime !== "docker" || !node.docker_image) return undefined;
  const r = await dockerOnNode(node, ["ps", "-a", "--filter", `ancestor=${node.docker_image}`, "--format", "{{.Names}}"]);
  if (!r.ok) return undefined;
  const names = r.stdout.split(/\s+/).filter(Boolean);
  return names.find((n) => n.startsWith("comfyui-")) ?? names[0];
}

export async function waitUp(apiUrl: string, waitSec = 150): Promise<boolean> {
  for (let i = 0; i < Math.ceil(waitSec / 5); i++) {
    await sleep(5000);
    if (await objectInfoUp(apiUrl)) return true;
  }
  return false;
}

/**
 * restart for a runtime=docker node. Tries an in-container `pkill -f main.py`
 * first (mirrors the bare-runtime stop path); if the container is still running
 * afterward — i.e. the in-container kill failed because PID 1 can't be killed
 * from inside the container (EPERM / PID 1), the real-world failure when a
 * synchronous block-swap pegs the event loop at 100% CPU — falls back to
 * `docker restart <container>`, which cleanly terminates and restarts PID 1.
 * If the kill did stop the container, `docker start` brings it back with its
 * original Step-05 launch config intact.
 */
export async function restartDocker(node: GpuNode, container: string, apiUrl: string, waitSec = 150): Promise<boolean> {
  await dockerOnNode(node, ["exec", container, "pkill", "-f", "main.py"], 30_000);
  await sleep(3000);

  const st = await dockerOnNode(node, ["inspect", "-f", "{{.State.Status}}", container]);
  if (!st.ok) return false;
  const status = st.stdout.trim();

  if (status === "running") {
    // In-container kill failed (PID 1 / EPERM) — fall back to docker restart.
    const rr = await dockerOnNode(node, ["restart", container], 90_000);
    if (!rr.ok) return false;
  } else {
    // Kill succeeded (container stopped) — start it again with its original config.
    const sr = await dockerOnNode(node, ["start", container], 90_000);
    if (!sr.ok) return false;
  }

  return await waitUp(apiUrl, waitSec);
}

export async function stopComfyUi(node: GpuNode): Promise<void> {
  // `; true` (not `|| true`) + explicit exit 0 so ssh/local always returns 0 even
  // when pkill matches nothing (exit 1) — execFile rejects on any non-zero.
  const cmd = `pkill -f 'main.py' 2>/dev/null; true`;
  try {
    if (node.kind === "ssh") await execFile("ssh", ["-n", ...sshBase(node), cmd], { timeout: 30_000 });
    else await execFile("bash", ["-c", cmd], { timeout: 30_000 });
  } catch {
    /* pkill non-zero (nothing to kill) is fine */
  }
}

/**
 * Build the docker launch script body for a runtime=docker node. Pure, so it's
 * directly unit-testable -- confirmed to match the pattern proven live on a
 * days-long-running container (docker inspect: --entrypoint venv_python,
 * comfyui_root bind-mounted at /comfyui, --net=host).
 */
/**
 * Default ComfyUI VRAM launch flags (level 0 of the escalation ladder). Kept as
 * the historical `--reserve-vram 1`.
 */
export const DEFAULT_VRAM_FLAGS: readonly string[] = ["--reserve-vram", "1"];

/**
 * Lossless VRAM-reduction escalation ladder. Each level only changes model
 * placement/scheduling (sequential offload), never the computation, so the
 * output is identical -- just slower. The orchestrator escalates a step through
 * these on a capacity OOM BEFORE asking the operator for the lossy reduced tier
 * (resolution/frames). See skills/capacity-vram-mitigation-ladder.md.
 *   L0: default (reserve-vram only)
 *   L1: --lowvram  (sequential load + offload-after-use)
 *   L2: --novram   (maximal offload; everything streamed)
 */
export const VRAM_ESCALATION_LADDER: readonly (readonly string[])[] = [
  DEFAULT_VRAM_FLAGS,
  [...DEFAULT_VRAM_FLAGS, "--lowvram"],
  [...DEFAULT_VRAM_FLAGS, "--novram"]
];

/** Resolve the launch flags to use: explicit override → node config → default. */
function resolveVramFlags(node: GpuNode, vramFlags?: readonly string[]): string[] {
  const flags = vramFlags ?? node.launch_flags ?? DEFAULT_VRAM_FLAGS;
  return [...flags];
}

export function buildDockerStartScript(
  node: GpuNode,
  port: number,
  listen: string,
  containerName: string,
  vramFlags?: readonly string[]
): string {
  if (!node.docker_image) throw new Error(`runtime=docker but node ${node.name} has no docker_image configured`);
  if (!node.venv_python) throw new Error(`runtime=docker but node ${node.name} has no venv_python configured`);
  const nfsRoot = resolveNfsShareRoot(node);
  const flags = resolveVramFlags(node, vramFlags).join(" ");
  return (
    `#!/usr/bin/env bash\n` +
    `set -e\n` +
    `[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true\n` +
    `docker rm -f '${containerName}' >/dev/null 2>&1 || true\n` +
    `RENDER_GIDS=$(stat -c '%g' /dev/dri/render* 2>/dev/null | sort -u)\n` +
    `GROUP_ADD_FLAGS=""\n` +
    `for gid in $RENDER_GIDS; do GROUP_ADD_FLAGS="$GROUP_ADD_FLAGS --group-add $gid"; done\n` +
    `docker run -d --name '${containerName}' --device=/dev/dri $GROUP_ADD_FLAGS --net=host \\\n` +
    // OMNI_FP8_KEEP_ON_MOVE=1 activates the comfy/ops.py keep-fp8-on-move patch
    // (see patches/xpu-fp8-keep-quantized-on-move.patch): fp8 QuantizedTensors move
    // between XPU/CPU without dequant-to-bf16, so the HIGH->LOW model swap on large
    // fp8 diffusion (WAN2.2 etc.) no longer doubles VRAM and OOMs. Harmless when the
    // patch is absent or the model isn't fp8 (the env is only read inside that branch).
    // Optional OMNI_ATTN_BACKEND=torch pins attention to stable PyTorch SDPA on a
    // node whose ESIMD attention kernel device-losts at full-size attention.
    (node.attn_backend ? `  -e OMNI_ATTN_BACKEND=${node.attn_backend} \\\n` : ``) +
    `  -e ZE_AFFINITY_MASK=0 -e OMNI_FP8_KEEP_ON_MOVE=1 -e NO_PROXY -e no_proxy -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy \\\n` +
    (nfsRoot ? `  -v '${nfsRoot}:${nfsRoot}' \\\n` : ``) +
    `  -v '${node.comfyui_root}:/comfyui' \\\n` +
    `  --entrypoint '${node.venv_python}' \\\n` +
    `  '${node.docker_image}' \\\n` +
    // Dynamic VRAM must stay ENABLED (do not pass --disable-dynamic-vram): the
    // sequential fp8 offload recipe relies on ComfyUI offloading a model to make
    // room for the next stage. --cpu-vae is intentionally NOT passed -- the VAE runs
    // on XPU and ComfyUI auto-falls-back to tiled decode if a full decode would OOM.
    `  /comfyui/main.py --port ${port} --listen ${listen} ${flags}\n` +
    `nohup docker logs -f '${containerName}' > /tmp/comfyui-${port}.log 2>&1 < /dev/null &\n`
  );
}

export function defaultContainerName(node: GpuNode): string {
  return `comfyui-${node.name}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function startDocker(node: GpuNode, port: number, listen: string, containerName: string, vramFlags?: readonly string[]): Promise<void> {
  const scriptPath = `/tmp/start-comfyui-docker-${port}.sh`;
  const body = buildDockerStartScript(node, port, listen, containerName, vramFlags);
  const b64 = Buffer.from(body).toString("base64");
  if (node.kind === "ssh") {
    await execFile("ssh", [...sshBase(node), `echo ${b64} | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`], { timeout: 30_000 });
    await execFile("ssh", ["-n", ...sshBase(node), `bash ${scriptPath}`], { timeout: 60_000 });
  } else {
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    await execFile("bash", [scriptPath], { timeout: 60_000 });
  }
}

async function startBareMetal(node: GpuNode, port: number, listen: string, vramFlags?: readonly string[]): Promise<void> {
  const scriptPath = `/tmp/start-comfyui-${port}.sh`;
  const flags = resolveVramFlags(node, vramFlags).join(" ");
  const body =
    `#!/usr/bin/env bash\n` +
    `[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true\n` +
    `pkill -f 'main.py' 2>/dev/null || true\n` +
    `sleep 4\n` +
    `cd '${node.comfyui_root}' || exit 3\n` +
    `export OMNI_FP8_KEEP_ON_MOVE=1\n` +
    (node.attn_backend ? `export OMNI_ATTN_BACKEND=${shellQuote(node.attn_backend)}\n` : ``) +
    `exec '${node.venv_python}' main.py --port ${port} --listen ${listen} ${flags} > /tmp/comfyui-${port}.log 2>&1 < /dev/null\n`;
  const b64 = Buffer.from(body).toString("base64");
  if (node.kind === "ssh") {
    await execFile("ssh", [...sshBase(node), `echo ${b64} | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`], { timeout: 30_000 });
    await execFile("ssh", ["-n", ...sshBase(node), `setsid bash ${scriptPath} > /tmp/start-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
  } else {
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    await execFile("bash", ["-c", `setsid bash ${scriptPath} > /tmp/start-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
  }
}

/** Launch a fresh ComfyUI (docker or bare-metal per node.runtime) -- never improvises. */
export async function startComfyUi(
  node: GpuNode,
  port: number,
  listen: string,
  containerName?: string,
  vramFlags?: readonly string[]
): Promise<void> {
  if (node.runtime === "docker") {
    await startDocker(node, port, listen, containerName ?? defaultContainerName(node), vramFlags);
    return;
  }
  await startBareMetal(node, port, listen, vramFlags);
}

export interface EnsureComfyUiUpResult {
  ok: boolean;
  detail: string;
  action: "already_up" | "restarted_existing" | "started_stopped" | "started_fresh" | "failed";
}

/**
 * High-level, single entry point: ensure this node's ComfyUI is reachable at
 * apiUrl, using the correct launch pattern deterministically. Reused by both
 * the CLI (scripts/remote-comfyui.mts) and the orchestrator's automatic
 * pre-Step07/08 check -- neither should ever hand-construct a launch command.
 *
 * Order of preference (never destroys a healthy server to "fix" it):
 *   1. Already reachable -> no-op.
 *   2. A matching container/process exists but the API isn't responding yet ->
 *      restart it (same config it was created with).
 *   3. A matching container exists but is stopped -> `docker start` it.
 *   4. Nothing exists -> launch fresh via buildDockerStartScript/startBareMetal.
 */
export async function ensureComfyUiUp(input: {
  node: GpuNode;
  apiUrl: string;
  /** e.g. `comfyui-${TASK_ID}` when invoked from a migration step. */
  container?: string;
  waitSec?: number;
  /**
   * VRAM launch flags to use if a fresh launch happens (a level of
   * VRAM_ESCALATION_LADDER). Defaults to the node/default flags.
   */
  vramFlags?: readonly string[];
  /**
   * Force a fresh relaunch with `vramFlags` even if ComfyUI is already up or a
   * container is running -- used by the orchestrator's capacity-retry ladder to
   * apply escalated flags (a plain restart/`docker start` reuses the old flags).
   */
  forceRelaunch?: boolean;
}): Promise<EnsureComfyUiUpResult> {
  const { node, apiUrl, waitSec = 150, vramFlags, forceRelaunch = false } = input;

  // Capacity-ladder escalation: tear down whatever is running and relaunch fresh
  // with the escalated VRAM flags (restart/`docker start` would reuse old flags).
  if (forceRelaunch) {
    if (node.runtime === "docker" && input.container) {
      await dockerOnNode(node, ["rm", "-f", input.container], 60_000);
    }
    const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
    await startComfyUi(node, node.api_port, listen, input.container, vramFlags);
    const up = await waitUp(apiUrl, waitSec);
    return up
      ? { ok: true, detail: `relaunched fresh with vram flags [${resolveVramFlags(node, vramFlags).join(" ")}]`, action: "started_fresh" }
      : { ok: false, detail: `forced relaunch did not bring up /system_stats within ${waitSec}s`, action: "failed" };
  }

  if (await objectInfoUp(apiUrl)) {
    return { ok: true, detail: "already reachable", action: "already_up" };
  }

  if (node.runtime === "docker") {
    const container = input.container ?? (await detectContainer(node));
    if (container) {
      const st = await dockerOnNode(node, ["inspect", "-f", "{{.State.Status}}", container]);
      if (st.ok && st.stdout.trim() === "running") {
        const up = await restartDocker(node, container, apiUrl, waitSec);
        return up
          ? { ok: true, detail: `restarted existing container ${container}`, action: "restarted_existing" }
          : { ok: false, detail: `restarted ${container} but /system_stats did not respond within ${waitSec}s`, action: "failed" };
      }
      if (st.ok) {
        const sr = await dockerOnNode(node, ["start", container], 90_000);
        if (sr.ok) {
          const up = await waitUp(apiUrl, waitSec);
          return up
            ? { ok: true, detail: `started existing stopped container ${container}`, action: "started_stopped" }
            : { ok: false, detail: `docker start ${container} did not bring up /system_stats within ${waitSec}s`, action: "failed" };
        }
      }
    }
    const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
    await startComfyUi(node, node.api_port, listen, input.container, vramFlags);
    const up = await waitUp(apiUrl, waitSec);
    return up
      ? { ok: true, detail: "launched a fresh container via buildDockerStartScript", action: "started_fresh" }
      : { ok: false, detail: `fresh container launch did not bring up /system_stats within ${waitSec}s`, action: "failed" };
  }

  const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
  await startComfyUi(node, node.api_port, listen, undefined, vramFlags);
  const up = await waitUp(apiUrl, waitSec);
  return up
    ? { ok: true, detail: "launched a fresh bare-metal process", action: "started_fresh" }
    : { ok: false, detail: `bare-metal launch did not bring up /system_stats within ${waitSec}s`, action: "failed" };
}
