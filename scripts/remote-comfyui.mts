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
 *     [--api-url http://host:8188] [--wait 150]
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadGpuNodes, pickNode, nodeApiUrl, type GpuNode } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";

const execFile = promisify(execFileCb);
const nodeName = argValue("--node");
const action = (argValue("--action") ?? "status") as "start" | "stop" | "restart" | "status";
const waitSec = Number(argValue("--wait") ?? "150");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function start(node: GpuNode, apiUrl: string): Promise<void> {
  const port = node.api_port;
  const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
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
  if (!nodeName) { console.error("usage: remote-comfyui.mts --node <name> --action start|stop|restart|status [--wait 150]"); process.exit(2); }
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
    await start(node, apiUrl);
    console.log(`launched; waiting up to ${waitSec}s for /system_stats…`);
    const up = await waitUp(apiUrl);
    console.log(up ? "UP ✓" : "did NOT come up in time ✗");
    process.exit(up ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
