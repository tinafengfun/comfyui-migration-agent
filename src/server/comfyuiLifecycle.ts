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
import { resolveNfsShareRoot, runShellOnNode, type GpuNode } from "./gpuNodes";

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

/**
 * Reset the XPU via `xpu-smi config -d <device> --reset` to recover the `xe`
 * driver after a capacity OOM / DEVICE_LOST wedges it (VM worker -12 / engine
 * resets) — a container relaunch frees VRAM but not the driver state, so without
 * this the next run can DEVICE_LOST again on a config that fit minutes earlier
 * (real incident 2026-08-12). Best-effort: never throws; needs passwordless sudo
 * and the device to be free (call AFTER `docker rm -f`). Returns a short detail.
 */
export async function resetXpuDevice(node: GpuNode, timeoutMs = 120_000): Promise<{ ok: boolean; detail: string }> {
  const device = String(node.xpu_device ?? "0");
  // `sudo -n` (non-interactive): if sudo isn't passwordless this fails cleanly
  // rather than hanging on a password prompt. The reset itself takes ~1 min.
  const cmd = `sudo -n xpu-smi config -d ${shellQuote(device)} --reset 2>&1 || true`;
  try {
    const out = (await runShellOnNode(node, cmd, timeoutMs)) ?? "";
    const ok = /succeed to reset/i.test(out);
    return { ok, detail: ok ? `xpu-smi reset GPU ${device} ✓` : `xpu-smi reset GPU ${device} not confirmed: ${out.trim().slice(0, 160) || "no output"}` };
  } catch (e) {
    return { ok: false, detail: `xpu-smi reset GPU ${device} threw: ${e instanceof Error ? e.message : String(e)}` };
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

/** VRAM-policy flags that take a value (flag + next arg). */
const VRAM_VALUE_FLAGS = new Set(["--reserve-vram"]);
/** Boolean VRAM/placement-policy flags (no value). */
const VRAM_BOOL_FLAGS = new Set([
  "--lowvram",
  "--novram",
  "--highvram",
  "--normalvram",
  "--cpu",
  "--gpu-only",
  "--disable-smart-memory"
]);

/**
 * From a container's raw entrypoint args (docker inspect `.Args`, e.g.
 * `["/comfyui/main.py","--port","8188","--listen","0.0.0.0","--extra-model-paths-config",
 *   "/comfyui/05-extra-model-paths.yaml","--output-directory","/comfyui/outputs","--reserve-vram","1"]`),
 * extract ONLY the VRAM-policy flags so the live container can be compared against
 * `resolveVramFlags` for drift.
 *
 * Whitelist, not blacklist: a launch may legitimately carry incidental flags the
 * deterministic launcher doesn't (an SDK Step-05 launch adds `--extra-model-paths-config`
 * and `--output-directory`). The OLD "everything except main.py/--port/--listen" logic
 * counted those as VRAM drift → it tore down a perfectly healthy ComfyUI before Step 07
 * and the relaunch failed (real incident: WAN2.2 on remote-124-12, 2026-08-28). Only
 * genuine VRAM-placement flags constitute drift.
 */
export function extractVramFlagTail(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VRAM_VALUE_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < args.length) out.push(args[++i]);
    } else if (VRAM_BOOL_FLAGS.has(a)) {
      out.push(a);
    }
    // everything else (main.py, --port/--listen, --extra-model-paths-config,
    // --output-directory, and any other incidental launch flag) is NOT VRAM policy → ignore
  }
  return out;
}

/**
 * The VRAM launch flags the RUNNING docker container was actually started with,
 * read from `docker inspect -f '{{json .Args}}'`. Best-effort: returns undefined
 * on a non-docker node, an unreachable/absent container, or unparseable output.
 * Used to detect drift between the live container and the persisted VRAM policy.
 */
async function runningContainerVramFlags(node: GpuNode, container: string): Promise<string[] | undefined> {
  if (node.runtime !== "docker") return undefined;
  const r = await dockerOnNode(node, ["inspect", "-f", "{{json .Args}}", container]);
  if (!r.ok) return undefined;
  try {
    const args = JSON.parse(r.stdout.trim());
    if (!Array.isArray(args)) return undefined;
    return extractVramFlagTail(args.map((x: unknown) => String(x)));
  } catch {
    return undefined;
  }
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
 * Tear down the container (docker only) and relaunch ComfyUI fresh with `vramFlags`.
 * Shared by the `forceRelaunch` path and the flag-drift reconciliation path so both
 * apply the escalated/persisted flags identically (a plain restart/`docker start`
 * would reuse the old flags). Optionally resets the XPU between teardown and
 * relaunch (a container relaunch frees VRAM but not a wedged `xe` driver).
 */
async function teardownAndRelaunch(input: {
  node: GpuNode;
  apiUrl: string;
  container?: string;
  vramFlags?: readonly string[];
  resetXpu: boolean;
  waitSec: number;
}): Promise<{ up: boolean; resetDetail: string }> {
  const { node, apiUrl, container, vramFlags, resetXpu, waitSec } = input;
  let resetDetail = "";
  if (node.runtime === "docker" && container) {
    await dockerOnNode(node, ["rm", "-f", container], 60_000);
    // Reset the wedged XPU AFTER the container is gone (device is now free) and
    // BEFORE relaunch, so the fresh ComfyUI starts on a clean driver.
    if (resetXpu) {
      const r = await resetXpuDevice(node);
      resetDetail = `; ${r.detail}`;
    }
  }
  const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
  await startComfyUi(node, node.api_port, listen, container, vramFlags);
  const up = await waitUp(apiUrl, waitSec);
  return { up, resetDetail };
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
  /**
   * Reset the XPU (`xpu-smi config -d <device> --reset`) between teardown and
   * relaunch. Set by the capacity-retry ladder when the previous run hit an OOM /
   * DEVICE_LOST that can wedge the `xe` driver -- a plain relaunch frees VRAM but
   * not the driver, so the next run can DEVICE_LOST again. Only honored together
   * with forceRelaunch on a docker node. Best-effort (never blocks the relaunch).
   */
  resetXpu?: boolean;
}): Promise<EnsureComfyUiUpResult> {
  const { node, apiUrl, waitSec = 150, vramFlags, forceRelaunch = false, resetXpu = false } = input;

  // Capacity-ladder escalation: tear down whatever is running and relaunch fresh
  // with the escalated VRAM flags (restart/`docker start` would reuse old flags).
  if (forceRelaunch) {
    const { up, resetDetail } = await teardownAndRelaunch({ node, apiUrl, container: input.container, vramFlags, resetXpu, waitSec });
    return up
      ? { ok: true, detail: `relaunched fresh with vram flags [${resolveVramFlags(node, vramFlags).join(" ")}]${resetDetail}`, action: "started_fresh" }
      : { ok: false, detail: `forced relaunch did not bring up /system_stats within ${waitSec}s${resetDetail}`, action: "failed" };
  }

  if (await objectInfoUp(apiUrl)) {
    // Flag-drift reconciliation: the server is healthy, but if the live container
    // was launched with different VRAM flags than the persisted policy wants,
    // relaunch it to match. This closes a real drift: Step 08 escalates the live
    // container to --novram while probing full size, then the accepted reduced tier
    // pins --lowvram to disk -- but writing the file is not a relaunch, so steps
    // that merely reuse a healthy server (09/10/11) inherited the stale --novram
    // container (2026-08-16). Only checked when caller passed the intended flags.
    if (vramFlags && node.runtime === "docker" && input.container) {
      const desired = resolveVramFlags(node, vramFlags);
      const running = await runningContainerVramFlags(node, input.container);
      if (running && running.join(" ") !== desired.join(" ")) {
        const { up, resetDetail } = await teardownAndRelaunch({ node, apiUrl, container: input.container, vramFlags, resetXpu, waitSec });
        return up
          ? { ok: true, detail: `reconciled drifted vram flags [${running.join(" ")}] -> [${desired.join(" ")}]${resetDetail}`, action: "started_fresh" }
          : { ok: false, detail: `flag-drift relaunch did not bring up /system_stats within ${waitSec}s${resetDetail}`, action: "failed" };
      }
    }
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
