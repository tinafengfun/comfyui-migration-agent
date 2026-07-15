/**
 * Node precheck — scan a target GPU node's ComfyUI readiness and report gaps, so
 * a new node is prepared ONCE instead of tripping the same pit-falls run after run
 * (missing custom nodes, missing sampler packages, XPU not available, unreachable
 * models/object_info). Optionally auto-prepares missing pieces.
 *
 * Core is pure/injectable (probes passed in) so the orchestrator/CLI drive real
 * local/ssh execution and tests mock it.
 */
import type { ObjectInfo } from "./enumPackageInstall";
import { enumValuePresent } from "./enumPackageInstall";

export interface BaselineNode { dir: string; repo: string; provides?: string }
export interface SamplerPackageCheck { repo: string; hostNodeType: string; slot: string; value: string }

export type CheckStatus = "ok" | "gap" | "skip";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fixable?: boolean; // a --prepare run could resolve this gap
  repo?: string; // for a fixable custom-node / sampler-package gap
}

export interface NodePrecheckProbes {
  /** ssh reachable + main.py present (undefined for local → treated ok). */
  sshReachable?: () => Promise<{ ok: boolean; detail: string }>;
  /** torch.xpu.is_available() via the node's venv. */
  xpuAvailable: () => Promise<{ ok: boolean; detail: string }>;
  /** GET /object_info (undefined if ComfyUI down). */
  fetchObjectInfo: () => Promise<ObjectInfo | undefined>;
  /** dir names present under custom_nodes/. */
  listCustomNodes: () => Promise<string[]>;
  /** each model root exists + readable. */
  checkModelRoots: () => Promise<{ ok: boolean; detail: string }>;
}

export interface NodePrecheckInput {
  nodeName: string;
  nodeKind: "local" | "ssh";
  baseline: BaselineNode[];
  samplerPackages: SamplerPackageCheck[]; // from recipes with providesEnumValues
  probes: NodePrecheckProbes;
}

export interface NodePrecheckReport {
  node: string;
  ok: boolean; // no gaps
  checks: CheckResult[];
  gaps: CheckResult[];
  fixable: CheckResult[]; // subset of gaps a --prepare could install
}

export async function runNodePrecheck(input: NodePrecheckInput): Promise<NodePrecheckReport> {
  const checks: CheckResult[] = [];

  // 1. ssh reachability (ssh nodes only)
  if (input.nodeKind === "ssh" && input.probes.sshReachable) {
    const r = await input.probes.sshReachable();
    checks.push({ name: "ssh_reachable", status: r.ok ? "ok" : "gap", detail: r.detail });
  } else {
    checks.push({ name: "ssh_reachable", status: "skip", detail: "local node" });
  }

  // 2. torch.xpu
  const xpu = await input.probes.xpuAvailable();
  checks.push({ name: "torch_xpu", status: xpu.ok ? "ok" : "gap", detail: xpu.detail });

  // 3. model roots
  const mr = await input.probes.checkModelRoots();
  checks.push({ name: "model_roots", status: mr.ok ? "ok" : "gap", detail: mr.detail });

  // 4. custom_nodes baseline
  let installed: string[] = [];
  try {
    installed = await input.probes.listCustomNodes();
  } catch {
    installed = [];
  }
  const installedSet = new Set(installed);
  for (const b of input.baseline) {
    const present = installedSet.has(b.dir);
    checks.push({
      name: `custom_node:${b.dir}`,
      status: present ? "ok" : "gap",
      detail: present ? "present" : `missing (${b.provides ?? "custom node"})`,
      fixable: !present,
      repo: present ? undefined : b.repo
    });
  }

  // 5. object_info + known sampler packages (needs ComfyUI up)
  const oi = await input.probes.fetchObjectInfo();
  if (!oi) {
    checks.push({ name: "object_info", status: "gap", detail: "ComfyUI /object_info not reachable — start it to verify sampler packages" });
  } else {
    checks.push({ name: "object_info", status: "ok", detail: `${Object.keys(oi).length} node types registered` });
    for (const sp of input.samplerPackages) {
      const present = enumValuePresent(oi, { hostNodeType: sp.hostNodeType, slot: sp.slot, value: sp.value });
      checks.push({
        name: `sampler_pkg:${sp.hostNodeType}.${sp.slot}=${sp.value}`,
        status: present ? "ok" : "gap",
        detail: present ? "value present" : `value missing → needs ${sp.repo}`,
        fixable: !present,
        repo: present ? undefined : sp.repo
      });
    }
  }

  const gaps = checks.filter((c) => c.status === "gap");
  const fixable = gaps.filter((c) => c.fixable && c.repo);
  return { node: input.nodeName, ok: gaps.length === 0, checks, gaps, fixable };
}

/** Distinct repos to install to resolve the fixable gaps (dedup). */
export function reposToPrepare(report: NodePrecheckReport): string[] {
  return [...new Set(report.fixable.map((c) => c.repo!).filter(Boolean))];
}
