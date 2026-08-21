#!/usr/bin/env node
/**
 * acceptance-catalog-loop.mts — end-to-end acceptance of the catalog self-learning
 * loop against REAL archived Step-07/06b data + a REAL in-process catalog-server
 * (no mocks). Proves: harvest (branch-path gate) → write-back → candidate → promote
 * to trusted → resolve → git persistence, and that FAILED-branch nodes are excluded.
 *
 * Run: npx tsx scripts/acceptance-catalog-loop.mts
 * Exit 0 = all acceptance checks passed.
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
import { applyCatalogWriteBackFromLedger, type CatalogDeployLedger } from "../src/server/xpuCatalogWriteBack";
import type { NodeVerdict } from "../src/server/nodeValidationRunner";

// A MIXED archived task: some branches passed, some failed → proves inclusion + exclusion.
const ARCHIVE = "/nfs_share/migration-tasks/Video_Edit_Multimodal_Generator_workflow_intel_20260816T024048Z/artifacts";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

async function main(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accept-catalog-"));
  const clone = path.join(root, "clone");
  fs.mkdirSync(path.join(clone, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  process.env.XPU_CATALOG_DB = path.join(clone, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = clone;
  process.env.XPU_CATALOG_ENABLED = "1";

  const store = new CatalogStore(clone);
  const git = new GitRepo(clone, { branch: "main" });
  const writer = new CatalogWriter({ store, git, promoteThreshold: 2 });
  const server = createCatalogApp(store, writer).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 1) harvest from REAL Step-07 + 06b
  const s07 = JSON.parse(fs.readFileSync(path.join(ARCHIVE, "07-branch-smoke-summary.json"), "utf8"));
  const doc = JSON.parse(fs.readFileSync(path.join(ARCHIVE, "06b-runtime-policy-prompt.json"), "utf8"));
  const graph = doc.prompt ?? doc;
  const validated = branchValidatedNodeTypes(s07, graph);
  check("harvest produced a non-empty validated set from real data", validated.size > 0, `${validated.size} types`);
  check("llama_cpp_model_loader IS validated (on a passed branch)", validated.has("llama_cpp_model_loader"));
  check("SamplerCustom is NOT validated (only under failed video branches)", !validated.has("SamplerCustom"));

  // 2) deploy ledger: 2 validated custom nodes + 1 excluded (SamplerCustom, on a failed branch)
  const ledger: CatalogDeployLedger = {
    nodes: [
      { nodeType: "llama_cpp_model_loader", repository: "https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm", commit: "abc", execution: "cpu", xpuSupport: "cpu_offload" },
      { nodeType: "VHS_LoadVideo", repository: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", commit: "def", xpuSupport: "native" },
      { nodeType: "SamplerCustom", repository: "https://github.com/comfyanonymous/ComfyUI", commit: "ghi", xpuSupport: "patched" }
    ]
  };
  const verdicts = (types: Set<string>): NodeVerdict[] =>
    ledger.nodes.filter((n) => types.has(n.nodeType)).map((n) => ({ nodeType: n.nodeType, passed: true, historyResult: "success", passedAt: new Date(1_000_000).toISOString() }));

  // 3) first migration → candidates for validated nodes only
  const s1 = await applyCatalogWriteBackFromLedger(ledger, verdicts(validated), { taskId: "task-1", workflowName: "wfA" });
  check("write-back created records", s1.created.length >= 2, `created ${s1.created.join(",")}`);
  const llama = store.getByKey("lihaoyun6__comfyui-llama-cpp_vlm");
  check("llama_cpp recorded as candidate", llama?.tier === "candidate");
  check("SamplerCustom (excluded) NOT recorded", store.getByKey("comfyanonymous__comfyui") === undefined);

  // 4) second DISTINCT workflow validates the same nodes → promote to trusted
  await applyCatalogWriteBackFromLedger(ledger, verdicts(validated), { taskId: "task-2", workflowName: "wfB" });
  const llama2 = store.getByKey("lihaoyun6__comfyui-llama-cpp_vlm");
  check("llama_cpp promoted to trusted after 2 distinct workflows", llama2?.tier === "trusted", `tier=${llama2?.tier}`);

  // 5) resolve via HTTP (agent client path)
  const res = await fetch(`${process.env.XPU_CATALOG_SERVER_URL}/api/xpu-catalog/resolve?nodeType=llama_cpp_model_loader`);
  const body = (await res.json()) as { found: boolean; record?: { tier?: string } };
  check("resolve returns the trusted record over HTTP", body.found === true && body.record?.tier === "trusted");

  // 6) git persistence
  const log = execFileSync("git", ["-C", clone, "log", "--oneline"], { encoding: "utf8" });
  check("writes were committed to git (durable)", log.includes("catalog:"), `${log.trim().split("\n").length} commits`);

  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.ok);
  console.log("\n==== ACCEPTANCE: catalog self-learning loop (real data, real server) ====");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASSED" : `❌ ${failed.length} FAILED`}  (${checks.length - failed.length}/${checks.length})`);
  return failed.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
