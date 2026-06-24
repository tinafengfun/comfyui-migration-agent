#!/usr/bin/env npx tsx
/**
 * CLI wrapper for the workspace purity linter (§C).
 *
 * Usage:
 *   npx tsx scripts/lint-workspace-purity.mts \
 *     --comfyui-root /path/to/ComfyUI \
 *     [--agent-root /path/to/agent-demo]
 *
 * Exit codes:
 *   0 = clean (no error-severity findings)
 *   1 = pollution detected (review the report)
 *   2 = bad CLI args
 *
 * Hook this into cron (e.g. daily) or pre-commit by running before pushes.
 * The linter is read-only — it never deletes or moves anything.
 */
import { lintWorkspacePurity, formatPurityReport } from "../src/server/lintWorkspacePurity";
import { loadConfig } from "../src/server/config";

interface ParsedArgs {
  comfyuiRoot?: string;
  agentRoot?: string;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--comfyui-root") out.comfyuiRoot = argv[++i];
    else if (a === "--agent-root") out.agentRoot = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: lint-workspace-purity.mts --comfyui-root <path> [--agent-root <path>] [--json]
  --comfyui-root  ComfyUI checkout to scan (required unless config has COMFYUI_ROOT)
  --agent-root    Agent demo dir to treat as allowed (default: auto-detect)
  --json          Emit machine-readable JSON instead of human-readable text
`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Fall back to loadConfig() for comfyuiRoot — same source the server uses.
const config = loadConfig();
const comfyuiRoot = args.comfyuiRoot ?? config.comfyuiRoot;
if (!comfyuiRoot) {
  console.error("error: --comfyui-root required (or set COMFYUI_ROOT)");
  process.exit(2);
}

// agentRoot default: the dir this script lives in's parent (scripts/ -> agent-demo/).
const defaultAgentRoot = new URL("..", import.meta.url).pathname;
const agentRoot = args.agentRoot ?? defaultAgentRoot;

const report = lintWorkspacePurity({
  comfyuiRoot,
  // The agent's own dir and global patches/ and debug-archives/ are always allowed.
  // Add the agentRoot explicitly in case it's named differently from "agent-demo".
  allowedRoots: [agentRoot]
});

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatPurityReport(report));
  if (report.errors.length > 0) {
    console.log(`${report.errors.length} error(s) require cleanup before push.`);
  } else {
    console.log("No errors. Warnings/infos do not block.");
  }
}

process.exit(report.clean ? 0 : 1);
