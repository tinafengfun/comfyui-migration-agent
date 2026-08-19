/**
 * nodeValidationRunner — orchestrator-side driver for the isolated per-node XPU
 * harness (`validate_node_xpu.py`). This is the HARD/deterministic half of the
 * precise-evidence decision: the backend (not the SDK agent) drives the harness
 * against the runtime-policy prompt so the per-node "really ran on XPU" verdict
 * is trustworthy before it becomes catalog evidence.
 *
 * Split for testability: `buildHarnessArgs` (pure) + `parseHarnessReport` (pure)
 * are unit-tested directly; `runNodeValidation` shells the tool with an injectable
 * exec so tests never spawn python.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFileCb);

/** One node's verdict, mirroring an entry in validate_node_xpu's report `nodes[]`. */
export interface NodeVerdict {
  nodeType: string;
  nodeId?: string;
  passed: boolean;
  historyResult?: string;
  xpuUtilizationPct?: number | null;
  cpuFallbackSuspected?: boolean;
  capacitySuspected?: boolean;
  peakMemoryBudgetRatio?: number | null;
  passedAt?: string;
}

export interface RunNodeValidationOpts {
  pythonPath: string;
  harnessPath: string; // …/tools/validate_node_xpu.py
  apiUrl: string;
  /** Runtime-policy prompt (device cuda→xpu already applied by Step 06) — NOT the raw source. */
  promptPath: string;
  comfyRoot: string;
  nodeTypes: string[];
  expectExecution?: "xpu" | "cpu" | "hybrid";
  xpuUtilThreshold?: number;
  /** When set, the harness also merges per-node evidence into this catalog-writeback file. */
  writebackPath?: string;
  timeoutSec?: number;
  reportPath?: string;
}

/** Build the argv for validate_node_xpu.py. Pure — unit tested. */
export function buildHarnessArgs(opts: RunNodeValidationOpts): string[] {
  const args = [
    opts.harnessPath,
    "--api-url",
    opts.apiUrl,
    "--prompt",
    opts.promptPath,
    "--comfy-root",
    opts.comfyRoot,
    "--report",
    opts.reportPath ?? "node-validation.json",
    "--expect-execution",
    opts.expectExecution ?? "xpu"
  ];
  if (opts.xpuUtilThreshold !== undefined) args.push("--xpu-util-threshold", String(opts.xpuUtilThreshold));
  for (const t of opts.nodeTypes) args.push("--node-type", t);
  if (opts.writebackPath) args.push("--writeback", opts.writebackPath);
  return args;
}

/** Extract verdicts from the harness report JSON. Pure — unit tested. */
export function parseHarnessReport(report: unknown): NodeVerdict[] {
  const nodes = (report as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((n) => {
    const v = n as Record<string, unknown>;
    return {
      nodeType: String(v.nodeType ?? ""),
      nodeId: v.nodeId !== undefined ? String(v.nodeId) : undefined,
      passed: Boolean(v.passed),
      historyResult: v.historyResult as string | undefined,
      xpuUtilizationPct: (v.xpuUtilizationPct ?? null) as number | null,
      cpuFallbackSuspected: Boolean(v.cpuFallbackSuspected),
      capacitySuspected: Boolean(v.capacitySuspected),
      peakMemoryBudgetRatio: (v.peakMemoryBudgetRatio ?? null) as number | null,
      passedAt: v.passedAt as string | undefined
    };
  });
}

export interface RunDeps {
  execFile?: (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<unknown>;
  readReport?: (p: string) => unknown;
}

/**
 * Run the isolated harness for the given node types and return their verdicts.
 * Best-effort: on any failure returns [] (the caller treats missing evidence as
 * "no write-back for this node", never fatal).
 */
export async function runNodeValidation(opts: RunNodeValidationOpts, deps: RunDeps = {}): Promise<NodeVerdict[]> {
  const exec = deps.execFile ?? ((f, a, o) => execFileAsync(f, a, o));
  const reportPath = opts.reportPath ?? path.join(os.tmpdir(), `node-validation-${process.pid}-${opts.nodeTypes.join("_").slice(0, 40)}.json`);
  const args = buildHarnessArgs({ ...opts, reportPath });
  const readReport = deps.readReport ?? ((p: string) => JSON.parse(fs.readFileSync(p, "utf8")));
  try {
    await exec(opts.pythonPath, args, { timeout: (opts.timeoutSec ?? 900) * 1000, env: process.env });
  } catch {
    // Harness exits non-zero when a node fails — that is a valid verdict, not an
    // error. Fall through and read the report it still wrote.
  }
  try {
    return parseHarnessReport(readReport(reportPath));
  } catch {
    return [];
  }
}
