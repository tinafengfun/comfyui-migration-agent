/**
 * remote-comfyui.mts — CLI wrapper for start / stop / restart / status of a
 * ComfyUI instance on a GPU node (local or ssh). All the actual logic
 * (correct docker/bare-metal launch pattern, restart-vs-relaunch decisions,
 * reachability polling) lives in src/server/comfyuiLifecycle.ts, which is
 * also imported directly by orchestrator.ts's automatic pre-Step07/08 check
 * -- this file is just an argv-parsing shell around it.
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
import { loadGpuNodes, pickNode, nodeApiUrl, resolveListenHost } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";
import {
  objectInfoUp,
  detectContainer,
  restartDocker,
  stopComfyUi,
  startComfyUi,
  waitUp
} from "../src/server/comfyuiLifecycle";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const nodeName = argValue("--node");
const action = (argValue("--action") ?? "status") as "start" | "stop" | "restart" | "status";
const waitSec = Number(argValue("--wait") ?? "150");
const containerFlag = argValue("--container");

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
  if (action === "stop") { await stopComfyUi(node); console.log("stopped"); return; }
  if (action === "start" || action === "restart") {
    if (action === "restart" && node.runtime === "docker") {
      const container = containerFlag ?? (await detectContainer(node));
      if (container) {
        const up = await restartDocker(node, container, apiUrl, waitSec);
        console.log(up ? "UP ✓" : "did NOT come up in time ✗");
        process.exit(up ? 0 : 1);
        return;
      }
      console.log("no --container given and could not auto-detect a comfyui-* container; falling back to bare-metal restart path");
    }
    await startComfyUi(node, node.api_port, resolveListenHost(node), containerFlag);
    console.log(`launched; waiting up to ${waitSec}s for /system_stats…`);
    const up = await waitUp(apiUrl, waitSec);
    console.log(up ? "UP ✓" : "did NOT come up in time ✗");
    process.exit(up ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
