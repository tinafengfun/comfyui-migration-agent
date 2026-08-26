import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog/store";
import { createCatalogApp } from "../catalog/server";
import { injectRecipesForWorkflow } from "./recipeInjector";
import type { XpuNodeRecord } from "../catalog/schema";

let root: string;
let recipesRoot: string;
let workflowPath: string;
let store: CatalogStore;
let server: Server;

function trustedRecord(): XpuNodeRecord {
  return {
    schemaVersion: 1,
    nodeKey: "acme__foo",
    packageName: "Foo",
    repository: "https://github.com/acme/Foo",
    // Exact class_type: bare prefixes now match exactly; only `_`-terminated
    // prefixes are startsWith families (see store.resolveByNodeType). The workflow
    // node below is "FooNode", so the record must advertise that exact type.
    nodeTypePrefixes: ["FooNode"],
    execution: "xpu",
    xpuSupport: "patched",
    patchClass: "functional_runtime_support",
    patches: [{ file: "patches/foo-xpu.patch", target: "foo/ops.py" }],
    knownIssues: ["Foo OOMs on XPU without the keep-on-move patch"],
    tier: "trusted",
    version: 3,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z"
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-bridge-"));
  recipesRoot = path.join(root, "recipes"); // empty → recipe library matches nothing
  fs.mkdirSync(recipesRoot, { recursive: true });
  fs.mkdirSync(path.join(root, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(root, "nodes", "acme__foo.json"), JSON.stringify(trustedRecord()), "utf8");
  workflowPath = path.join(root, "wf.json");
  fs.writeFileSync(workflowPath, JSON.stringify({ nodes: [{ type: "FooNode" }] }), "utf8");

  process.env.XPU_CATALOG_DB = path.join(root, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = root;
  store = new CatalogStore(root);
  store.rebuildFromJson();
  await new Promise<void>((resolve) => {
    server = createCatalogApp(store).listen(0, "127.0.0.1", () => {
      process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  for (const k of ["XPU_CATALOG_DB", "XPU_CATALOG_DATA_DIR", "XPU_CATALOG_SERVER_URL", "XPU_CATALOG_ENABLED"]) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recipeInjector catalog bridge", () => {
  it("injects a TRUSTED catalog record as a recipe section when enabled", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    const out = await injectRecipesForWorkflow({ workflowPath, stepId: "05", recipesRoot });
    expect(out).toContain("Matched catalog records");
    expect(out).toContain("catalog-acme__foo");
    expect(out).toContain("FooNode");
    expect(out).toContain("patches/foo-xpu.patch");
  });

  it("injects nothing catalog-related when the flag is off", async () => {
    delete process.env.XPU_CATALOG_ENABLED;
    const out = await injectRecipesForWorkflow({ workflowPath, stepId: "05", recipesRoot });
    expect(out).not.toContain("Matched catalog records");
  });

  it("does not inject a CANDIDATE record (trusted-only bridge)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    const rec = { ...trustedRecord(), tier: "candidate" as const };
    fs.writeFileSync(path.join(root, "nodes", "acme__foo.json"), JSON.stringify(rec), "utf8");
    store.rebuildFromJson();
    const out = await injectRecipesForWorkflow({ workflowPath, stepId: "05", recipesRoot });
    expect(out).not.toContain("catalog-acme__foo");
  });
});
