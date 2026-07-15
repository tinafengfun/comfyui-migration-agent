/**
 * install-enum-package.mts — deterministic "install a custom package + verify the
 * enum value it injects appears in the target's /object_info" tool.
 *
 * This is the apple-to-apple resolver for implicit package dependencies: when a
 * workflow uses an enum widget value (sampler_name/scheduler/…) that a source-side
 * package injected into a core node's dropdown (e.g. RES4LYF adds res_2s /
 * bong_tangent to KSampler), install that package on the target so the value works
 * unchanged — never substitute. Works on local and ssh GPU nodes. Idempotent.
 *
 * Usage:
 *   npx tsx scripts/install-enum-package.mts \
 *     --node remote-124-12 \
 *     --repo https://github.com/ClownsharkBatwing/RES4LYF \
 *     --host-node-type KSampler \
 *     --verify sampler_name=res_2s --verify scheduler=bong_tangent \
 *     [--api-url http://127.0.0.1:8188]   # default: node's http://api_host:api_port
 *     [--report <path>]                    # default: ./05-enum-package-install.json
 *     [--dry-run]
 *
 * Exit 0 = already_satisfied or installed_verified. Non-zero = install/verify
 * failed or ComfyUI unreachable (caller surfaces a human gate; substitution is a
 * human-approved last resort).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGpuNodes, pickNode, nodeApiUrl, type GpuNode } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";
import {
  installAndVerifyEnumPackage,
  type EnumRequirement,
  type ObjectInfo,
  type EnumPackageInstallReport
} from "../src/server/enumPackageInstall";

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const out: {
    node?: string; repo?: string; hostNodeType: string; apiUrl?: string;
    report: string; dryRun: boolean; verify: EnumRequirement[];
  } = { hostNodeType: "KSampler", report: path.resolve("05-enum-package-install.json"), dryRun: false, verify: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--node") out.node = next();
    else if (a === "--repo") out.repo = next();
    else if (a === "--host-node-type") out.hostNodeType = next();
    else if (a === "--api-url") out.apiUrl = next();
    else if (a === "--report") out.report = path.resolve(next());
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verify") {
      const [slot, value] = (next() ?? "").split("=");
      if (slot && value) out.verify.push({ hostNodeType: out.hostNodeType, slot, value });
    }
  }
  return out;
}

function sshBase(node: GpuNode): string[] {
  const s = node.ssh!;
  return [
    "-p", String(s.port ?? 22),
    ...(s.key_path ? ["-i", s.key_path] : []),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    `${s.user}@${s.host}`
  ];
}

/** Repo dir name inside custom_nodes/ (basename of the git url, sans .git). */
function repoDirName(repo: string): string {
  return repo.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop() || "custom-node";
}

async function fetchObjectInfo(apiUrl: string): Promise<ObjectInfo | undefined> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/object_info`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    return (await res.json()) as ObjectInfo;
  } catch {
    return undefined;
  }
}

/** Build the shell snippet that clones + pip-installs a package on the target. */
function installScript(node: GpuNode, repo: string): string {
  const dir = repoDirName(repo);
  const cn = `${node.comfyui_root}/custom_nodes`;
  const py = node.venv_python;
  // Idempotent: skip clone if dir exists; install reqs if present. Proxy-aware.
  return [
    node.kind === "ssh" ? "[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true" : "true",
    `cd '${cn}'`,
    `if [ -d '${dir}' ]; then echo 'ALREADY_CLONED'; else git clone --depth 1 '${repo}' '${dir}'; fi`,
    `if [ -f '${dir}/requirements.txt' ]; then '${py}' -m pip install -r '${dir}/requirements.txt'; fi`,
    `cd '${cn}/${dir}' && git rev-parse --short HEAD 2>/dev/null || echo nocommit`
  ].join(" && ");
}

async function runInstall(node: GpuNode, repo: string, dryRun: boolean): Promise<{ ok: boolean; detail: string; commit?: string }> {
  const script = installScript(node, repo);
  if (dryRun) return { ok: true, detail: `[dry-run] ${node.kind}: ${script}` };
  try {
    if (node.kind === "ssh") {
      const { stdout } = await execFile("ssh", [...sshBase(node), script], { timeout: 300_000 });
      const commit = stdout.trim().split("\n").pop();
      return { ok: true, detail: stdout.trim().slice(-200), commit };
    } else {
      const { stdout } = await execFile("bash", ["-c", script], { timeout: 300_000 });
      const commit = stdout.trim().split("\n").pop();
      return { ok: true, detail: stdout.trim().slice(-200), commit };
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

/**
 * Restart ComfyUI on the target and wait for /object_info. We reuse the node's
 * kill pattern + a background relaunch, then poll. The launch flags mirror the
 * agent's Step-05 conservative defaults.
 */
async function reloadComfyui(node: GpuNode, apiUrl: string, dryRun: boolean): Promise<{ ok: boolean; detail: string }> {
  if (dryRun) return { ok: true, detail: "[dry-run] skip reload" };
  const port = node.api_port;
  const listen = node.kind === "ssh" ? "0.0.0.0" : "127.0.0.1";
  // Write a launcher script on the target, then invoke it — a background `&`
  // process inheriting ssh's stdio pipes keeps the ssh call from returning, so we
  // fully detach with setsid + all fds redirected, and run the SCRIPT (not an
  // inline command whose exit code / open pipes trip up execFile).
  const scriptPath = `/tmp/reload-comfyui-${port}.sh`;
  // Kill any existing ComfyUI FIRST and wait for it to actually exit, THEN launch
  // detached. Match plain `main.py` (the `--port`-scoped pattern proved fragile);
  // the launch happens strictly after the kill+sleep so the fresh process is safe.
  const scriptBody =
    `#!/usr/bin/env bash\n` +
    `[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true\n` +
    `pkill -f 'main.py' 2>/dev/null || true\n` +
    `sleep 4\n` +
    `cd '${node.comfyui_root}' || exit 3\n` +
    `exec '${node.venv_python}' main.py --port ${port} --listen ${listen} --reserve-vram 1 > /tmp/comfyui-enumpkg-${port}.log 2>&1 < /dev/null\n`;
  try {
    const b64 = Buffer.from(scriptBody).toString("base64");
    if (node.kind === "ssh") {
      // 1) materialize the launcher script on the target (base64-safe transport)
      await execFile("ssh", [...sshBase(node), `echo ${b64} | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`], { timeout: 30_000 });
      // 2) run it fully detached; -n + redirected fds so ssh returns immediately
      await execFile("ssh", ["-n", ...sshBase(node), `setsid bash ${scriptPath} > /tmp/reload-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
    } else {
      fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
      await execFile("bash", ["-c", `setsid bash ${scriptPath} > /tmp/reload-comfyui-${port}.out 2>&1 < /dev/null & echo started`], { timeout: 30_000 });
    }
  } catch (e) {
    return { ok: false, detail: `relaunch failed: ${(e as Error).message.slice(0, 200)}` };
  }
  // Poll /object_info (RES4LYF adds ~290 nodes → allow up to ~150s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const oi = await fetchObjectInfo(apiUrl);
    if (oi) return { ok: true, detail: `ComfyUI back up after ~${(i + 1) * 5}s` };
  }
  return { ok: false, detail: "ComfyUI did not come back within ~150s after relaunch" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || args.verify.length === 0) {
    console.error("usage: install-enum-package.mts --repo <git-url> --verify slot=value [--verify …] [--node <name>] [--host-node-type KSampler] [--api-url …] [--dry-run]");
    process.exit(2);
  }
  const config = loadConfig();
  const registry = loadGpuNodes(config);
  const node = pickNode(registry, args.node);
  const apiUrl = args.apiUrl ?? nodeApiUrl(node);
  console.log(`Target node: ${node.name} (${node.kind}) | ComfyUI: ${apiUrl} | repo: ${args.repo}`);
  console.log(`Verify: ${args.verify.map((v) => `${v.hostNodeType}.${v.slot}="${v.value}"`).join(", ")}`);

  const report: EnumPackageInstallReport = await installAndVerifyEnumPackage({
    repo: args.repo,
    requirements: args.verify,
    fetchObjectInfo: () => fetchObjectInfo(apiUrl),
    runInstall: (repo) => runInstall(node, repo, args.dryRun),
    reloadComfyui: () => reloadComfyui(node, apiUrl, args.dryRun)
  });

  const full = { ...report, node: node.name, nodeKind: node.kind, apiUrl, generatedAt: new Date().toISOString() };
  fs.writeFileSync(args.report, JSON.stringify(full, null, 2) + "\n", "utf8");
  console.log(`\n=== outcome: ${report.outcome} ===`);
  console.log(report.detail);
  report.requirements.forEach((r) =>
    console.log(`  ${r.hostNodeType}.${r.slot}="${r.value}": before=${r.presentBefore} after=${r.presentAfter}`)
  );
  console.log(`report → ${args.report}`);
  process.exit(report.outcome === "already_satisfied" || report.outcome === "installed_verified" ? 0 : 1);
}

main().catch((e) => {
  console.error("install-enum-package failed:", e);
  process.exit(1);
});
