#!/usr/bin/env node
/**
 * acceptance-synthesized-ledger.mts — proves the catalog self-learning loop turns
 * END-TO-END on REAL migration artifacts THROUGH THE SYNTHESIS FALLBACK (no
 * agent-emitted 05-catalog-deploy-ledger.json), against a REAL in-process
 * catalog-server. This is the acceptance for the hard-layer synthesis fix
 * (commit ba4a881): object_info + registry + container-git provenance →
 * deploy ledger → branch-harvest fresh gate → write-back → records.
 *
 * Inputs (env):
 *   ACCEPT_ARTIFACTS   dir with the REAL task artifacts:
 *                      05-object_info_workflow_nodes.json,
 *                      06b-runtime-policy-prompt.json, 07-branch-smoke-summary.json
 *   ACCEPT_PROVENANCE  (optional) JSON file: { "<dir>": { repository, commit } }
 *                      harvested from the deployed container (git remotes).
 *
 * Run: ACCEPT_ARTIFACTS=/path npx tsx scripts/acceptance-synthesized-ledger.mts
 * Exit 0 = the loop turned (>=1 provenance-known, fresh-tested node recorded).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { CatalogStore } from "../src/catalog/store";
import { GitRepo } from "../src/catalog/gitRepo";
import { CatalogWriter } from "../src/catalog/writer";
import { createCatalogApp } from "../src/catalog/server";
import { branchValidatedNodeTypes } from "../src/server/catalogBranchHarvest";
import { parseWorkflowNodeTypes, synthesizeLedgerNodes, type ProvenanceMap } from "../src/server/deployLedgerSynthesis";
import { applyCatalogWriteBackFromLedger } from "../src/server/xpuCatalogWriteBack";
import type { NodeVerdict } from "../src/server/nodeValidationRunner";

const ART = process.env.ACCEPT_ARTIFACTS;
if (!ART) throw new Error("set ACCEPT_ARTIFACTS to the real task artifacts dir");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(ART, p), "utf8"));

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

async function main(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accept-synth-"));
  const clone = path.join(root, "clone");
  fs.mkdirSync(path.join(clone, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  process.env.XPU_CATALOG_DB = path.join(clone, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = clone;
  process.env.XPU_CATALOG_ENABLED = "1";

  const store = new CatalogStore(clone);
  const writer = new CatalogWriter({ store, git: new GitRepo(clone, { branch: "main" }), promoteThreshold: 2 });
  const server = createCatalogApp(store, writer).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 1) SYNTHESIZE the ledger from real object_info + registry + container-git provenance
  //    (exactly what orchestrator.synthesizeDeployLedger does — no agent ledger file).
  const objectInfo = readJson("05-object_info_workflow_nodes.json");
  const provenance: ProvenanceMap = process.env.ACCEPT_PROVENANCE
    ? JSON.parse(fs.readFileSync(process.env.ACCEPT_PROVENANCE, "utf8"))
    : {};
  const types = parseWorkflowNodeTypes(objectInfo);
  const { nodes, unattributed } = synthesizeLedgerNodes(types, provenance);
  check("synthesis produced >=1 provenance-known custom node", nodes.length > 0, `${nodes.length} synthesized: ${nodes.map((n) => n.nodeType).join(", ")}`);
  console.log(`  (unattributed, not recorded: ${unattributed.length ? unattributed.join(", ") : "none"})`);

  // 2) real branch-harvest fresh-tested gate
  const doc = readJson("06b-runtime-policy-prompt.json");
  const graph = doc.prompt ?? doc;
  const fresh = branchValidatedNodeTypes(readJson("07-branch-smoke-summary.json"), graph);
  check("branch harvest produced a fresh-validated set", fresh.size > 0, `${fresh.size} fresh types`);

  // 3) compose verdicts for synthesized nodes that are fresh-validated, and write back
  const now = new Date().toISOString();
  const verdicts: NodeVerdict[] = nodes
    .filter((n) => fresh.has(n.nodeType))
    .map((n) => ({ nodeType: n.nodeType, passed: true, historyResult: "success", passedAt: now }));
  check("at least one synthesized node is fresh-tested (loop can turn)", verdicts.length > 0, `${verdicts.length} to record: ${verdicts.map((v) => v.nodeType).join(", ")}`);

  const summary = await applyCatalogWriteBackFromLedger({ nodes }, verdicts, { taskId: "accept-synth", workflowName: "wan22-real" });
  check("write-back created/validated records", summary.created.length + summary.validated.length > 0, `created=[${summary.created.join(",")}] validated=[${summary.validated.join(",")}]`);
  check("catalog is no longer empty (loop turned)", store.count() > 0, `${store.count()} record(s)`);

  // 4) each recorded node is a candidate with real validation evidence
  for (const k of summary.created) {
    const rec = store.getByKey(k);
    check(`record ${k} is a candidate with evidence`, rec?.tier === "candidate" && (rec?.validation?.length ?? 0) > 0, `tier=${rec?.tier} evidence=${rec?.validation?.length ?? 0}`);
  }

  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.ok);
  console.log("\n==== ACCEPTANCE: synthesized-ledger loop (REAL artifacts, real server) ====");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASSED" : `❌ ${failed.length} FAILED`}  (${checks.length - failed.length}/${checks.length})`);
  return failed.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
