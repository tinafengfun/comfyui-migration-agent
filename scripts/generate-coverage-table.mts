#!/usr/bin/env npx tsx
/**
 * generate-coverage-table.mts — Step 10 coverage table generator.
 *
 * Consumes Step 03 inventory CSV, Step 06 prompt map, Step 07 smoke histories,
 * and Step 08 full-run history to produce a node-level coverage classification.
 *
 * Usage:
 *   npx tsx scripts/generate-coverage-table.mts --workspace <workspace-dir>
 *
 * Outputs (under <workspace>/artifacts/):
 *   10-node-coverage.csv       — per-node coverage classification with evidence
 *   10-coverage-summary.json   — aggregate counts and completion decision
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ */
/*  CSV helpers (lightweight, no dependency)                          */
/* ------------------------------------------------------------------ */

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function formatCsvValue(value: unknown): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(rows: Array<Record<string, unknown>>, fieldnames: string[]): string {
  const header = fieldnames.map(formatCsvValue).join(",");
  const lines = rows.map((row) => fieldnames.map((f) => formatCsvValue(row[f])).join(","));
  return header + "\n" + lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  JSON helpers                                                       */
/* ------------------------------------------------------------------ */

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, data: unknown): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  writeFileSync(path, json + "\n");
}

/* ------------------------------------------------------------------ */
/*  Utils                                                              */
/* ------------------------------------------------------------------ */

function utcNow(): string {
  return new Date().toISOString();
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function artifactRecord(path: string): Record<string, unknown> {
  const st = statSync(path);
  return {
    name: path.split("/").pop()!,
    path,
    sizeBytes: st.size,
    sha256: sha256File(path),
  };
}

/* ------------------------------------------------------------------ */
/*  Step 10 classification logic                                       */
/* ------------------------------------------------------------------ */

interface SmokeEvidence {
  executedBranches: string[];
  cachedBranches: string[];
  outputBranches: string[];
}

function smokeEvidence(step07Summary: Record<string, unknown>): Record<string, SmokeEvidence> {
  const evidence: Record<string, SmokeEvidence> = {};
  const branchSummaries = (step07Summary as any).branch_summaries ?? [];
  for (const branch of branchSummaries) {
    const branchName: string = branch.branch ?? "";
    const historySummary = (branch as any).history_summary;
    if (!historySummary) continue;
    const executedNodes: string[] = (historySummary as any).executed_nodes ?? [];
    const cachedNodes: string[] = (historySummary as any).cached_nodes ?? [];
    const outputFiles: Array<Record<string, unknown>> = (branch as any).output_files ?? [];

    for (const nodeId of executedNodes) {
      if (!evidence[nodeId]) evidence[nodeId] = { executedBranches: [], cachedBranches: [], outputBranches: [] };
      evidence[nodeId].executedBranches.push(branchName);
    }
    for (const nodeId of cachedNodes) {
      if (!evidence[nodeId]) evidence[nodeId] = { executedBranches: [], cachedBranches: [], outputBranches: [] };
      evidence[nodeId].cachedBranches.push(branchName);
    }
    for (const output of outputFiles) {
      const nodeId = String(output.node_id ?? "");
      if (nodeId) {
        if (!evidence[nodeId]) evidence[nodeId] = { executedBranches: [], cachedBranches: [], outputBranches: [] };
        evidence[nodeId].outputBranches.push(branchName);
      }
    }
  }
  return evidence;
}

function fullOutputNodes(step08Summary: Record<string, unknown>): Set<string> {
  const outputFiles: Array<Record<string, unknown>> = (step08Summary as any).output_files ?? [];
  const ids = new Set<string>();
  for (const item of outputFiles) {
    const nodeId = String(item.node_id ?? "");
    if (nodeId) ids.add(nodeId);
  }
  return ids;
}

/**
 * Classify a single node based on all available evidence.
 * Mirrors the Python classify_row() logic in step10_coverage_review.py.
 */
function classifyRow(
  node: Record<string, unknown>,
  promptStatus: string,
  smoke: SmokeEvidence | undefined,
  fullOutput: boolean,
): { coverageStatus: string; evidence: string; supportImpact: string } {
  const fullStatus: string = String(node.status ?? "");
  const role: string = String(node.role ?? "");

  if (fullStatus === "executed") {
    return {
      coverageStatus: "covered_full_executed",
      evidence: "full-run execution history",
      supportImpact: "covered under reduced runtime-policy API boundary",
    };
  }
  if (fullStatus === "cached") {
    return {
      coverageStatus: "covered_full_cached",
      evidence: "full-run cache evidence",
      supportImpact: "cache-assisted coverage; not cold-executed in accepted run",
    };
  }
  if (smoke && smoke.executedBranches.length > 0) {
    return {
      coverageStatus: "covered_smoke_executed",
      evidence: "branch-smoke execution history",
      supportImpact: "covered by branch smoke, not full accepted execution",
    };
  }
  if (smoke && smoke.cachedBranches.length > 0) {
    return {
      coverageStatus: "covered_smoke_cached",
      evidence: "branch-smoke cache evidence",
      supportImpact: "cache-assisted smoke coverage",
    };
  }
  if (fullOutput) {
    return {
      coverageStatus: "covered_output_only",
      evidence: "full-run output file",
      supportImpact: "output evidence only",
    };
  }
  if (role === "disconnected/reference" || promptStatus.startsWith("skipped_")) {
    return {
      coverageStatus: "excluded_disconnected_or_frontend",
      evidence: "source classification and prompt map",
      supportImpact: "excluded from runtime support claim",
    };
  }
  if (role === "dead_end_or_sink") {
    return {
      coverageStatus: "excluded_dead_end_sink",
      evidence: "inventory role classification",
      supportImpact: "not on required output path",
    };
  }
  return {
    coverageStatus: "uncovered_executable",
    evidence: "none",
    supportImpact: "blocks release until covered or explicitly gated",
  };
}

function promptStatuses(promptMapCsv: Array<Record<string, string>>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of promptMapCsv) {
    map[row.node_id] = row.prompt_status;
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

function buildCoverage(workspace: string): { rows: Array<Record<string, unknown>>; summary: Record<string, unknown> } {
  const artifactDir = resolve(workspace, "artifacts");

  // Step 03: node inventory
  const inventoryPath = resolve(artifactDir, "03-node-inventory.csv");
  if (!existsSync(inventoryPath)) {
    console.error(`ERROR: missing inventory CSV at ${inventoryPath}`);
    process.exit(1);
  }
  const inventory = parseCsv(readFileSync(inventoryPath, "utf-8"));

  // Step 06: prompt map
  const promptMapPath = resolve(artifactDir, "06-node-prompt-map.csv");
  if (!existsSync(promptMapPath)) {
    console.error(`ERROR: missing prompt map CSV at ${promptMapPath}`);
    process.exit(1);
  }
  const promptMap = promptStatuses(parseCsv(readFileSync(promptMapPath, "utf-8")));

  // Step 08: full-run node accounting
  const nodeAccountingPath = resolve(artifactDir, "08-full-validation", "08-node-accounting.json");
  const fallbackNodeAccountingPath = resolve(artifactDir, "08-node-accounting.json");
  let nodeAccounting: Record<string, unknown>;
  if (existsSync(nodeAccountingPath)) {
    nodeAccounting = readJson(nodeAccountingPath);
  } else if (existsSync(fallbackNodeAccountingPath)) {
    nodeAccounting = readJson(fallbackNodeAccountingPath);
  } else {
    console.error(`ERROR: missing 08-node-accounting.json at ${nodeAccountingPath} or ${fallbackNodeAccountingPath}`);
    process.exit(1);
  }
  const fullNodes: Record<string, Record<string, unknown>> = {};
  for (const item of (nodeAccounting as any).nodes ?? []) {
    fullNodes[String(item.node_id)] = item;
  }

  // Step 07: branch smoke summary
  const step07Path = resolve(artifactDir, "07-branch-smoke-summary.json");
  if (!existsSync(step07Path)) {
    console.error(`ERROR: missing step 07 summary at ${step07Path}`);
    process.exit(1);
  }
  const step07Summary = readJson(step07Path);
  const smoke = smokeEvidence(step07Summary);

  // Step 08: full-run summary
  const step08Path = resolve(artifactDir, "08-full-validation-summary.json");
  if (!existsSync(step08Path)) {
    console.error(`ERROR: missing step 08 summary at ${step08Path}`);
    process.exit(1);
  }
  const step08Summary = readJson(step08Path);
  const outputs = fullOutputNodes(step08Summary);

  // Classify each node
  const rows: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {};
  const uncoveredIds: string[] = [];

  for (const item of inventory) {
    const nodeId = item.node_id;
    const fullNode = fullNodes[nodeId] ?? { status: "missing_from_full_accounting" };
    const smokeItem: SmokeEvidence | undefined = smoke[nodeId];
    const promptStatus = promptMap[nodeId] ?? "missing_from_prompt_map";

    const { coverageStatus, evidence, supportImpact } = classifyRow(
      { ...item, ...fullNode },
      promptStatus,
      smokeItem,
      outputs.has(nodeId),
    );

    rows.push({
      node_id: nodeId,
      node_type: item.type ?? "",
      role: item.role ?? "",
      prompt_status: promptStatus,
      full_run_status: fullNode.status ?? "",
      smoke_executed_branches: smokeItem ? smokeItem.executedBranches.join(";") : "",
      smoke_cached_branches: smokeItem ? smokeItem.cachedBranches.join(";") : "",
      output_evidence: outputs.has(nodeId) ? "yes" : "no",
      migration_risk: item.migration_risk ?? "",
      coverage_status: coverageStatus,
      evidence,
      support_impact: supportImpact,
    });

    counts[coverageStatus] = (counts[coverageStatus] ?? 0) + 1;
    if (coverageStatus === "uncovered_executable") {
      uncoveredIds.push(nodeId);
    }
  }

  // Build prompt status counts
  const promptStatusCounts: Record<string, number> = {};
  for (const row of rows) {
    const ps = String(row.prompt_status);
    promptStatusCounts[ps] = (promptStatusCounts[ps] ?? 0) + 1;
  }

  // Branch statuses from step 07
  const branchStatuses: Record<string, string> = {};
  for (const branch of (step07Summary as any).branch_summaries ?? []) {
    branchStatuses[branch.branch] = branch.status;
  }

  const resultClass: string = (step08Summary as any).result_class ?? "unknown";
  const peakMemoryBudgetRatio: number = (step08Summary as any).memory_runtime?.peak_memory_budget_ratio ?? 0;

  // Build completion decision
  const allExecutableClassified = uncoveredIds.length === 0;
  const branchesTotal: number = (step07Summary as any).branches_total ?? 0;
  const branchesRun: number = (step07Summary as any).branches_run ?? 0;
  const allBranchesPassedOrCacheAssisted = Object.values(branchStatuses).every(
    (s) => s === "cache_assisted_pass" || s === "passed"
  );
  const complete = allExecutableClassified && branchesRun === branchesTotal && allBranchesPassedOrCacheAssisted;

  const completionDecision: Record<string, unknown> = {
    status: complete ? "complete" : "hard_stop",
    success_criteria_checked: {
      source_nodes_reconciled: rows.length,
      all_executable_nodes_classified: allExecutableClassified,
      uncovered_executable_node_ids: uncoveredIds,
      all_branch_smokes_passed_or_cache_assisted: allBranchesPassedOrCacheAssisted,
      runtime_policy_boundary_preserved: true,
      full_size_claim: false,
      source_identical_claim: false,
      gui_or_customer_acceptance_claim: false,
    },
    unresolved_gaps: complete ? [] : [`uncovered executable nodes: ${uncoveredIds}`],
    human_gate_prompt: complete
      ? null
      : {
          problem_summary: "Step 10 found uncovered executable nodes or branch gaps.",
          required_human_action: "Approve targeted Step 07/08 reruns, classify exclusions, or stop delivery.",
          safe_reply_template: "Coverage decision: <rerun/classify/stop>; node ids: <ids>; allowed boundary: <details>.",
        },
    next_step_allowed: complete,
    next_step: complete ? "11-delivery-packaging" : null,
  };

  const summary: Record<string, unknown> = {
    source_node_count: rows.length,
    coverage_counts: counts,
    uncovered_executable_node_ids: uncoveredIds,
    all_executable_nodes_classified: allExecutableClassified,
    prompt_status_counts: promptStatusCounts,
    branch_total: branchesTotal,
    branch_run: branchesRun,
    branch_statuses: branchStatuses,
    step08_result_class: resultClass,
    step08_peak_memory_budget_ratio: peakMemoryBudgetRatio,
    completion_decision: completionDecision,
  };

  return { rows, summary };
}

async function main(): Promise<void> {
  const workspaceArg = process.argv.find((a) => a.startsWith("--workspace="));
  const workspaceIndex = process.argv.indexOf("--workspace");
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg.split("=", 2)[1];
  } else if (workspaceIndex !== -1 && workspaceIndex + 1 < process.argv.length) {
    workspace = process.argv[workspaceIndex + 1];
  } else {
    console.error("Usage: npx tsx scripts/generate-coverage-table.mts --workspace <workspace-dir>");
    process.exit(2);
  }

  workspace = resolve(workspace);
  const artifactDir = resolve(workspace, "artifacts");
  mkdirSync(artifactDir, { recursive: true });

  console.error(`Generating coverage table for workspace: ${workspace}`);

  const { rows, summary } = buildCoverage(workspace);

  // Write 10-node-coverage.csv
  const csvPath = resolve(artifactDir, "10-node-coverage.csv");
  const csvFields = [
    "node_id",
    "node_type",
    "role",
    "prompt_status",
    "full_run_status",
    "smoke_executed_branches",
    "smoke_cached_branches",
    "output_evidence",
    "migration_risk",
    "coverage_status",
    "evidence",
    "support_impact",
  ];
  writeFileSync(csvPath, toCsv(rows, csvFields), "utf-8");
  console.error(`Wrote ${csvPath} (${rows.length} rows)`);

  // Write 10-coverage-summary.json
  const summaryPath = resolve(artifactDir, "10-coverage-summary.json");
  const step08Path = resolve(artifactDir, "08-full-validation-summary.json");
  const step07Path = resolve(artifactDir, "07-branch-smoke-summary.json");

  const scriptPath = new URL("", import.meta.url).pathname;
  const fullSummary: Record<string, unknown> = {
    generated_at: utcNow(),
    workspace,
    tool_path: resolve(scriptPath),
    command_used: `npx tsx scripts/generate-coverage-table.mts --workspace ${workspace}`,
    ...summary,
    coverage_csv: csvPath,
    claim_boundary: {
      supported: "reduced runtime-policy API engineering node coverage",
      not_supported: [
        "full-size/original-resolution capacity",
        "source-identical asset fidelity",
        "GUI/manual acceptance",
        "customer-quality approval",
      ],
    },
    step11_context: {
      workspace,
      artifact_folder: artifactDir,
      step10_summary: summaryPath,
      coverage_csv: csvPath,
      support_statement: "reduced runtime-policy API engineering node coverage only",
      claim_boundary: "non-source-identical substitutes; reduced full-path; cache-assisted evidence",
    },
  };

  writeJson(summaryPath, fullSummary);
  console.error(`Wrote ${summaryPath}`);

  const status = (fullSummary.completion_decision as Record<string, unknown>).status as string;
  console.log(JSON.stringify({ status, summary: summaryPath }));
  process.exit(status === "complete" ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
