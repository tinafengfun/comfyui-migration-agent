/**
 * xpu-run-monitor.mts — out-of-band monitor for a ComfyUI run that has blocked
 * the event loop with synchronous sampling (100% CPU), where the HTTP API no
 * longer responds so the usual /system_stats / /history polling times out.
 *
 * It confirms, from *outside* the container, that:
 *   - the compute is still active (per-thread utime/stime from
 *     /proc/<hostPid>/task/<tid>/stat is increasing between samples), and
 *   - the VRAM budget is still respected (xpu-smi GPU Memory Used / Util %).
 *
 * It is strictly read-only and non-invasive: it never ptrace-attaches, never
 * sends signals, never writes into the container, and never touches the XPU
 * device — it only reads `xpu-smi dump` and `/proc/<pid>/task/<tid>/stat`. Running
 * it cannot perturb the computation it is observing (this is exactly why Steps
 * 08/09 had to abandon py-spy, which needed SYS_PTRACE).
 *
 * Resolution of the host PID:
 *   - `--container <name>` → `docker inspect --format '{{.State.Pid}}' <name>`
 *     (run locally, or over ssh when `--node` is an ssh node). The returned PID
 *     is the host PID of the container's init process; its threads are visible
 *     on the host at `/proc/<hostPid>/task/<tid>/stat`.
 *   - `--pid <n>` → use a host PID directly (skip docker inspect; works for a
 *     bare-metal run with no container).
 *
 * Usage:
 *   npx tsx scripts/xpu-run-monitor.mts --container <name> [--node <gpu-node>]
 *     [--prompt-id <id>] [--pid <n>] [--device 0] [--interval 5] [--samples 12]
 *     [--vram-budget-mib 30720] [--json]
 *
 * `--node <name>` resolves the node from gpu-nodes.json (override path with
 * `GPU_NODES_PATH=`). If omitted, commands run locally on this host.
 * `--prompt-id` is only echoed in the report header for correlation with the
 *   ComfyUI prompt queue — the API is assumed unresponsive, so it is NOT used
 *   to query the server.
 * `--vram-budget-mib` turns the VRAM reading into a budget check; the monitor
 *   flags (but does not act on) a breach.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config";
import { loadGpuNodes, pickNode, type GpuNode } from "../src/server/gpuNodes";

const execFile = promisify(execFileCb);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nodeName = argValue("--node");
const container = argValue("--container");
const promptId = argValue("--prompt-id");
const pidArg = argValue("--pid");
const device = argValue("--device") ?? "0";
const intervalSec = Number(argValue("--interval") ?? "5");
const samples = Number(argValue("--samples") ?? "12");
const vramBudgetMib = argValue("--vram-budget-mib") ? Number(argValue("--vram-budget-mib")) : undefined;
const jsonOut = has("--json");

interface NodeCmd {
  kind: "local" | "ssh";
  sshArgs?: string[];
}
function nodeCmd(node: GpuNode | null): NodeCmd {
  if (node && node.kind === "ssh" && node.ssh) {
    const s = node.ssh;
    const base = ["-p", String(s.port ?? 22), ...(s.key_path ? ["-i", s.key_path] : []),
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${s.user}@${s.host}`];
    return { kind: "ssh", sshArgs: base };
  }
  return { kind: "local" };
}

async function run(cmd: string, nc: NodeCmd, timeoutMs = 30_000): Promise<string> {
  if (nc.kind === "ssh") {
    const { stdout } = await execFile("ssh", ["-n", ...nc.sshArgs!, cmd], { timeout: timeoutMs });
    return stdout;
  }
  const { stdout } = await execFile("bash", ["-c", cmd], { timeout: timeoutMs });
  return stdout;
}

/** Read utime+stime (fields 14+15, in clock ticks) summed over all threads. */
async function readCpuJiffies(hostPid: number, nc: NodeCmd): Promise<{ total: number; threads: number } | null> {
  // ls /proc/<pid>/task then sum field 14 (utime) + 15 (stime) of each /proc/<pid>/task/<tid>/stat.
  // Field 14/15 are within the comm field (field 2, parens) safety: split on the last ')' first.
  const cmd = `awk '{u=\$14; s=\$15; t+=u+s; n++} END {print t" "n}' /proc/${hostPid}/task/*/stat 2>/dev/null`;
  try {
    const out = (await run(cmd, nc, 10_000)).trim();
    if (!out) return null;
    const [total, threads] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(total) || !Number.isFinite(threads)) return null;
    return { total, threads };
  } catch {
    return null;
  }
}

interface XpuSample { memUsedMib: number | null; memUtilPct: number | null; raw: string }

async function readXpu(nc: NodeCmd): Promise<XpuSample> {
  // -m 18 = GPU Memory Used (MiB), -m 5 = GPU Memory Utilization (%). One dump each (-n 1).
  const memUsed = await runQuiet(`xpu-smi dump -d ${device} -m 18 -n 1`, nc);
  const memUtil = await runQuiet(`xpu-smi dump -d ${device} -m 5 -n 1`, nc);
  const memUsedMib = parseFirstNumber(memUsed);
  const memUtilPct = parseFirstNumber(memUtil);
  return { memUsedMib, memUtilPct, raw: `${memUsed.trim()} | ${memUtil.trim()}` };
}

async function runQuiet(cmd: string, nc: NodeCmd, timeoutMs = 30_000): Promise<string> {
  try {
    return await run(cmd, nc, timeoutMs);
  } catch {
    return "";
  }
}

function parseFirstNumber(s: string): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function resolveHostPid(nc: NodeCmd): Promise<number | null> {
  if (pidArg) {
    const n = Number(pidArg);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (!container) return null;
  const out = await runQuiet(`docker inspect --format '{{.State.Pid}}' ${shellQuote(container)}`, nc, 15_000);
  const n = parseFirstNumber(out);
  return n && n > 0 ? n : null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface PollRow {
  sample: number;
  ts: string;
  hostPid: number | null;
  threads: number | null;
  cpuJiffies: number | null;
  cpuDelta: number | null;
  memUsedMib: number | null;
  memUtilPct: number | null;
  activeCompute: boolean | null;
  vramBudgetOk: boolean | null;
}

async function main(): Promise<void> {
  if (!container && !pidArg) {
    console.error("error: pass --container <name> or --pid <n>");
    process.exit(2);
  }

  let node: GpuNode | null = null;
  if (nodeName) {
    try {
      node = pickNode(loadGpuNodes(loadConfig()), nodeName);
    } catch (e) {
      console.error(`error: could not load gpu-nodes.json: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const nc = nodeCmd(node);

  const hostPid = await resolveHostPid(nc);
  if (!hostPid) {
    console.error("error: could not resolve host PID (container not running? wrong node?)");
    process.exit(3);
  }

  const header = {
    container: container ?? null,
    pid: hostPid,
    node: node?.name ?? "local",
    promptId: promptId ?? null,
    device,
    intervalSec,
    samples,
    vramBudgetMib: vramBudgetMib ?? null,
    note: "read-only: xpu-smi dump + /proc/<pid>/task/*/stat; no ptrace, no signals, no device writes",
  };

  if (jsonOut) process.stdout.write(JSON.stringify({ header, rows: [] as PollRow[] }) + "\n");
  else {
    console.log(JSON.stringify(header, null, 2));
    console.log("sample | ts                  | threads | cpuJiffies | cpuDelta | memUsedMiB | memUtil% | active | budget");
    console.log("-------+---------------------+---------+------------+----------+------------+----------+--------+-------");
  }

  let prevCpu: number | null = null;
  const rows: PollRow[] = [];
  for (let i = 1; i <= samples; i++) {
    const cpu = await readCpuJiffies(hostPid, nc);
    const xpu = await readXpu(nc);
    const cpuDelta = cpu && prevCpu !== null ? cpu.total - prevCpu : null;
    // activeCompute = CPU time strictly increasing across >=1 thread. A delta of 0
    // over an interval means the process is frozen (deadlocked / finished).
    const activeCompute = cpuDelta !== null ? cpuDelta > 0 : null;
    const vramBudgetOk = vramBudgetMib && xpu.memUsedMib !== null ? xpu.memUsedMib <= vramBudgetMib : null;
    if (cpu) prevCpu = cpu.total;

    const row: PollRow = {
      sample: i,
      ts: new Date().toISOString(),
      hostPid,
      threads: cpu?.threads ?? null,
      cpuJiffies: cpu?.total ?? null,
      cpuDelta,
      memUsedMib: xpu.memUsedMib,
      memUtilPct: xpu.memUtilPct,
      activeCompute,
      vramBudgetOk,
    };
    rows.push(row);

    if (jsonOut) {
      // In JSON mode, stream one row per line (NDJSON after the header).
      process.stdout.write(JSON.stringify(row) + "\n");
    } else {
      console.log(
        `${String(i).padStart(6)} | ${row.ts} | ${String(row.threads ?? "?").padStart(7)} | ` +
        `${String(row.cpuJiffies ?? "?").padStart(10)} | ${String(row.cpuDelta ?? "?").padStart(8)} | ` +
        `${String(row.memUsedMib ?? "?").padStart(10)} | ${String(row.memUtilPct ?? "?").padStart(8)} | ` +
        `${row.activeCompute === null ? "?" : row.activeCompute ? "yes" : "NO"} | ` +
        `${row.vramBudgetOk === null ? "n/a" : row.vramBudgetOk ? "ok" : "BREACH"}`,
      );
    }
    if (i < samples) await sleep(intervalSec * 1000);
  }

  if (!jsonOut) {
    const activeCount = rows.filter((r) => r.activeCompute).length;
    console.log(`\nsummary: ${activeCount}/${rows.length} samples showed increasing CPU time (active compute).`);
    if (vramBudgetMib) {
      const breaches = rows.filter((r) => r.vramBudgetOk === false).length;
      console.log(`vram budget (${vramBudgetMib} MiB): ${breaches} breach(es).`);
    }
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
