/**
 * remote-comfyui.mts — start / stop / restart / status a ComfyUI instance on a
 * GPU node (local or ssh). Encapsulates the reliable detached-launch pattern that
 * took several rounds to get right:
 *   - write a launcher script on the target (base64-safe transport for ssh)
 *   - run it fully detached: `setsid bash script &` + all fds redirected + `ssh -n`
 *     (an inline `setsid … &` inheriting ssh's stdio pipes hangs the ssh call)
 *   - `pkill -f "main.py"` (plain, not --port-scoped) before relaunch
 *   - poll /object_info until it responds
 *
 * Usage:
 *   npx tsx scripts/remote-comfyui.mts --node <name> --action start|stop|restart|status
 *     [--api-url http://host:8188] [--wait 150] [--container <docker-container-name>]
 *
 * restart on a runtime=docker node: tries an in-container `pkill -f main.py` first;
 * if that fails to bring PID 1 down (PID 1 / EPERM — common when a synchronous
 * block-swap has pegged the event loop at 100% CPU), falls back to
 * `docker restart <container>` and waits for the API. `--container` is optional —
 * when omitted on a docker node the running `comfyui-*` container is auto-detected
 * via `docker ps --filter ancestor=<docker_image>`.
 *
 * start on a runtime=docker node: creates a fresh container the same way every
 * time (buildDockerStartScript) -- `--entrypoint <venv_python>` (never the
 * image's own default entrypoint/ComfyUI), comfyui_root bind-mounted at
 * /comfyui, the shared NFS root bind-mounted at an identical path, --net=host.
 * This is the ONLY correct way to launch a runtime=docker node's ComfyUI --
 * any other ad hoc `docker run` risks running the image's own outdated
 * baked-in packages instead of the properly configured environment (a real,
 * confirmed incident). `--container` names it explicitly (matching the
 * orchestrator's own `comfyui-${TASK_ID}` convention when invoked from a
 * migration step); omit it for a generic per-node container named
 * `comfyui-<node-name>`.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadGpuNodes, pickNode, nodeApiUrl, resolveNfsShareRoot, type GpuNode } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";

const execFile = promisify(execFileCb);
const nodeName = argValue("--node");
const action = (argValue("--action") ?? "status") as "start" | "stop" | "restart" | "status";
const waitSec = Number(argValue("--wait") ?? "150");
const containerFlag = argValue("--container");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shellQuote(s: string): string {
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

function sshBase(node: GpuNode): string[] {
  const s = node.ssh!;
  return ["-p", String(s.port ?? 22), ...(s.key_path ? ["-i", s.key_path] : []),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${s.user}@${s.host}`];
}

async function objectInfoUp(apiUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/system_stats`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

/** Run `docker <args>` on the node — locally or over ssh. Never throws. */
async function dockerOnNode(node: GpuNode, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

/** For a runtime=docker node, find the running `comfyui-*` container from its image. */
async function detectContainer(node: GpuNode): Promise<string | undefined> {
  if (node.runtime !== "docker" || !node.docker_image) return undefined;
  const r = await dockerOnNode(node, ["ps", "-a", "--filter", `ancestor=${node.docker_image}`, "--format", "{{.Names}}"]);
  if (!r.ok) return undefined;
  const names = r.stdout.split(/\s+/).filter(Boolean);
  return names.find((n) => n.startsWith("comfyui-")) ?? names[0];
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
async function restartDocker(node: GpuNode, container: string, apiUrl: string): Promise<boolean> {
  console.log(`attempting in-container kill: docker exec ${container} pkill -f main.py`);
  await dockerOnNode(node, ["exec", container, "pkill", "-f", "main.py"], 30_000);
  await sleep(3000);

  const st = await dockerOnNode(node, ["inspect", "-f", "{{.State.Status}}", container]);
  const status = st.stdout.trim();
  if (!st.ok) {
    console.error(`docker inspect ${container} failed: ${st.stderr || status}`);
    return false;
  }

  if (status === "running") {
    // In-container kill failed (PID 1 / EPERM) — fall back to docker restart.
    console.log(`in-container kill failed (container still running — PID 1 / EPERM); falling back to docker restart ${container}`);
    const rr = await dockerOnNode(node, ["restart", container], 90_000);
    if (!rr.ok) { console.error(`docker restart failed: ${rr.stderr}`); return false; }
  } else {
    // Kill succeeded (container stopped) — start it again with its original config.
    console.log(`container stopped after kill; docker start ${container}`);
    const sr = await dockerOnNode(node, ["start", container], 90_000);
    if (!sr.ok) { console.error(`docker start failed: ${sr.stderr}`); return false; }
  }

  console.log(`waiting up to ${waitSec}s for /system_stats…`);
  return await waitUp(apiUrl);
}

async function stop(node: GpuNode): Promise<void> {
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
 * Build the docker launch script body for a runtime=docker node. Pure/exported
 * for unit testing -- confirmed to match the pattern proven live on a
 * days-long-running container (docker inspect: --entrypoint venv_python,
 * comfyui_root bind-mounted at /comfyui, --net=host). Real incident this
 * replaces: an SDK session's own ad hoc `docker run` (no --entrypoint, workflow
 * checkout bind-mounted over the image's own /workspace/comfyui) ran the
 * image's own outdated baked-in comfy_aimdo instead of the correctly
 * configured shared venv -- the environment was never broken, the ad hoc
 * relaunch command was. This function is the single source of truth for the
 * correct command so nothing has to reconstruct it by hand again.
 */
export function buildDockerStartScript(node: GpuNode, port: number, listen: string, containerName: string): string {
  if (!node.docker_image) throw new Error(`runtime=docker but node ${node.name} has no docker_image configured`);
  if (!node.venv_python) throw new Error(`runtime=docker but node ${node.name} has no venv_python configured`);
  const nfsRoot = resolveNfsShareRoot(node);
  return (
    `#!/usr/bin/env bash\n` +
    `set -e\n` +
    `[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true\n` +
    `docker rm -f '${containerName}' >/dev/null 2>&1 || true\n` +
    `RENDER_GIDS=$(stat -c '%g' /dev/dri/render* 2>/dev/null | sort -u)\n` +
    `GROUP_ADD_FLAGS=""\n` +
    `for gid in $RENDER_GIDS; do GROUP_ADD_FLAGS="$GROUP_ADD_FLAGS --group-add $gid"; done\n` +
    `docker run -d --name '${containerName}' --device=/dev/dri $GROUP_ADD_FLAGS --net=host \\\n` +
    `  -e ZE_AFFINITY_MASK=0 -e NO_PROXY -e no_proxy -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy \\\n` +
    (nfsRoot ? `  -v '${nfsRoot}:${nfsRoot}' \\\n` : ``) +
    `  -v '${node.comfyui_root}:/comfyui' \\\n` +
    `  --entrypoint '${node.venv_python}' \\\n` +
    `  '${node.docker_image}' \\\n` +
    `  /comfyui/main.py --port ${port} --listen ${listen} --reserve-vram 1 --disable-dynamic-vram\n` +
    `nohup docker logs -f '${containerName}' > /tmp/comfyui-${port}.log 2>&1 < /dev/null &\n`
  );
}

async function startDocker(node: GpuNode, port: number, listen: string): Promise<void> {
  const containerName = (containerFlag ?? `comfyui-${node.name}`).replace(/[^a-zA-Z0-9_.-]/g, "-");
  const scriptPath = `/tmp/start-comfyui-docker-${port}.sh`;
  const body = buildDockerStartScript(node, port, listen, containerName);
  const b64 = Buffer.from(body).toString("base64");
  if (node.kind === "ssh") {
    await execFile("ssh", [...sshBase(node), `echo ${b64} | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`], { timeout: 30_000 });
    await execFile("ssh", ["-n", ...sshBase(node), `bash ${scriptPath}`], { timeout: 60_000 });
  } else {
    const fs = await import("node:fs");
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    await execFile("bash", [scriptPath], { timeout: 60_000 });
  }
}

async function start(node: GpuNode, apiUrl: string): Promise<void> {
  const port = node.api_port;
  const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
  if (node.runtime === "docker") {
    await startDocker(node, port, listen);
    return;
  }
  const scriptPath = `/tmp/start-comfyui-${port}.sh`;
  const body =
    `#!/usr/bin/env bash\n` +
    `[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true\n` +
    `pkill -f 'main.py' 2>/dev/null || true\n` +
    `sleep 4\n` +
    `cd '${node.comfyui_root}' || exit 3\n` +
    `exec '${node.venv_python}' main.py --port ${port} --listen ${listen} --reserve-vram 1 > /tmp/comfyui-${port}.log 2>&1 < /dev/null\n`;
  const b64 = Buffer.from(body).toString("base64");
  if (node.kind === "ssh") {
    await execFile("ssh", [...sshBase(node), `echo ${b64} | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`], { timeout: 30_000 });
    await execFile("ssh", ["-n", ...sshBase(node), `setsid bash ${scriptPath} > /tmp/start-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
  } else {
    const fs = await import("node:fs");
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    await execFile("bash", ["-c", `setsid bash ${scriptPath} > /tmp/start-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
  }
}

async function waitUp(apiUrl: string): Promise<boolean> {
  for (let i = 0; i < Math.ceil(waitSec / 5); i++) {
    await sleep(5000);
    if (await objectInfoUp(apiUrl)) return true;
  }
  return false;
}

async function main() {
  if (!nodeName) { console.error("usage: remote-comfyui.mts --node <name> --action start|stop|restart|status [--wait 150] [--container <name>]"); process.exit(2); }
  const config = loadConfig();
  const node = pickNode(loadGpuNodes(config), nodeName);
  const apiUrl = argValue("--api-url") ?? nodeApiUrl(node);
  console.log(`node=${node.name} (${node.kind}) comfyui=${apiUrl} action=${action}`);

  if (action === "status") {
    console.log((await objectInfoUp(apiUrl)) ? "UP" : "DOWN");
    return;
  }
  if (action === "stop") { await stop(node); console.log("stopped"); return; }
  if (action === "start" || action === "restart") {
    if (action === "restart" && node.runtime === "docker") {
      const container = containerFlag ?? (await detectContainer(node));
      if (container) {
        const up = await restartDocker(node, container, apiUrl);
        console.log(up ? "UP ✓" : "did NOT come up in time ✗");
        process.exit(up ? 0 : 1);
        return;
      }
      console.log("no --container given and could not auto-detect a comfyui-* container; falling back to bare-metal restart path");
    }
    await start(node, apiUrl);
    console.log(`launched; waiting up to ${waitSec}s for /system_stats…`);
    const up = await waitUp(apiUrl);
    console.log(up ? "UP ✓" : "did NOT come up in time ✗");
    process.exit(up ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
