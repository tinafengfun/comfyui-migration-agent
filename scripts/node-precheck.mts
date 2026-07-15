/**
 * node-precheck.mts — scan a GPU node's ComfyUI readiness (ssh/xpu/object_info/
 * custom_nodes baseline/model roots/known sampler packages) and report gaps.
 * With --prepare, auto-installs the missing custom-node baseline + sampler packages
 * so a new node is prepared ONCE instead of tripping the same pit-falls repeatedly.
 *
 * Usage:
 *   npx tsx scripts/node-precheck.mts --node <name> [--prepare] [--json]
 *
 * Reads the curated baseline from data/node-baseline.json and sampler packages
 * from recipes with providesEnumValues.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGpuNodes, pickNode, nodeApiUrl, type GpuNode } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";
import { loadAllRecipes } from "../src/server/recipeLibrary";
import { runNodePrecheck, reposToPrepare, type BaselineNode, type SamplerPackageCheck } from "../src/server/nodePrecheck";
import type { ObjectInfo } from "../src/server/enumPackageInstall";

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeName = argValue("--node");
const prepare = process.argv.includes("--prepare");
const asJson = process.argv.includes("--json");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sshBase(node: GpuNode): string[] {
  const s = node.ssh!;
  return ["-p", String(s.port ?? 22), ...(s.key_path ? ["-i", s.key_path] : []),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${s.user}@${s.host}`];
}
async function runOnNode(node: GpuNode, cmd: string, timeout = 60_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = node.kind === "ssh"
      ? await execFile("ssh", [...sshBase(node), cmd], { timeout })
      : await execFile("bash", ["-c", cmd], { timeout });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, out: (e as Error).message.slice(0, 200) };
  }
}
async function fetchObjectInfo(apiUrl: string): Promise<ObjectInfo | undefined> {
  try {
    const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/object_info`, { signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as ObjectInfo) : undefined;
  } catch { return undefined; }
}

function loadBaseline(): BaselineNode[] {
  const p = path.resolve(__dirname, "../data/node-baseline.json");
  try {
    return (JSON.parse(fs.readFileSync(p, "utf8")).custom_nodes ?? []) as BaselineNode[];
  } catch { return []; }
}
function loadSamplerPackages(): SamplerPackageCheck[] {
  const { recipes } = loadAllRecipes();
  const out: SamplerPackageCheck[] = [];
  for (const r of recipes) {
    if (!r.providesEnumValues?.length || !r.packageRepo) continue;
    const slots = r.enumSlots?.length ? r.enumSlots : ["sampler_name"];
    // pick one representative value per recipe to verify (first value)
    out.push({ repo: r.packageRepo, hostNodeType: r.nodeType, slot: slots[0], value: r.providesEnumValues[0] });
  }
  return out;
}

async function main() {
  if (!nodeName) { console.error("usage: node-precheck.mts --node <name> [--prepare] [--json]"); process.exit(2); }
  const config = loadConfig();
  const node = pickNode(loadGpuNodes(config), nodeName);
  const apiUrl = nodeApiUrl(node);

  const report = await runNodePrecheck({
    nodeName: node.name,
    nodeKind: node.kind,
    baseline: loadBaseline(),
    samplerPackages: loadSamplerPackages(),
    probes: {
      sshReachable: node.kind === "ssh" ? async () => {
        const r = await runOnNode(node, `test -f '${node.comfyui_root}/main.py' && echo ok || echo missing`);
        return { ok: r.ok && r.out.includes("ok"), detail: r.ok ? r.out : r.out };
      } : undefined,
      xpuAvailable: async () => {
        const r = await runOnNode(node, `'${node.venv_python}' -c "import torch;print(torch.xpu.is_available())"`);
        return { ok: r.ok && r.out.trim().endsWith("True"), detail: r.out.slice(-80) };
      },
      fetchObjectInfo: () => fetchObjectInfo(apiUrl),
      listCustomNodes: async () => {
        const r = await runOnNode(node, `ls '${node.comfyui_root}/custom_nodes' 2>/dev/null`);
        return r.ok ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      },
      checkModelRoots: async () => {
        const roots = node.model_roots ?? [];
        if (!roots.length) return { ok: true, detail: "no model_roots configured" };
        const r = await runOnNode(node, roots.map((m) => `test -d '${m}' && echo "${m}:ok" || echo "${m}:MISSING"`).join("; "));
        return { ok: r.ok && !r.out.includes("MISSING"), detail: r.out.replace(/\n/g, " ") };
      }
    }
  });

  if (asJson) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`\n=== node-precheck: ${report.node} (${report.ok ? "ALL OK" : report.gaps.length + " gap(s)"}) ===`);
    for (const c of report.checks) console.log(`  [${c.status === "ok" ? "✓" : c.status === "skip" ? "–" : "✗"}] ${c.name}: ${c.detail}`);
  }
  const reportPath = path.resolve(`node-precheck-${node.name}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, apiUrl, generatedAt: new Date().toISOString() }, null, 2) + "\n");

  if (prepare && report.fixable.length) {
    console.log(`\n=== --prepare: installing ${reposToPrepare(report).length} package(s) ===`);
    for (const repo of reposToPrepare(report)) {
      const dir = repo.replace(/\.git$/, "").split("/").pop();
      const cn = `${node.comfyui_root}/custom_nodes`;
      const cmd = [
        node.kind === "ssh" ? "[ -f ~/.proxyrc ] && . ~/.proxyrc 2>/dev/null || true" : "true",
        `cd '${cn}'`,
        `if [ -d '${dir}' ]; then echo already; else git clone --depth 1 '${repo}' '${dir}'; fi`,
        `if [ -f '${dir}/requirements.txt' ]; then '${node.venv_python}' -m pip install -r '${dir}/requirements.txt'; fi`
      ].join(" && ");
      const r = await runOnNode(node, cmd, 300_000);
      console.log(`  ${dir}: ${r.ok ? "installed" : "FAILED — " + r.out}`);
    }
    console.log("Note: restart ComfyUI (remote-comfyui.mts --action restart) then re-run precheck to verify sampler values appear.");
  }

  console.log(`\nreport → ${reportPath}`);
  process.exit(report.ok ? 0 : prepare ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
