import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureIntakePreflight } from "./intakePreflight";
import { resetBuiltinNodeCache } from "./builtinNodes";
import { ensureDir } from "./fsUtils";

async function writeComfyuiFixture(comfyuiRoot: string, extraExtrasFile?: { name: string; content: string }): Promise<void> {
  await ensureDir(comfyuiRoot);
  await ensureDir(path.join(comfyuiRoot, "comfy_extras"));
  await fs.writeFile(
    path.join(comfyuiRoot, "nodes.py"),
    'NODE_CLASS_MAPPINGS = {\n  "KSampler": KSampler,\n  "CLIPTextEncode": CLIPTextEncode,\n}\n',
    "utf8"
  );
  if (extraExtrasFile) {
    await fs.writeFile(path.join(comfyuiRoot, "comfy_extras", extraExtrasFile.name), extraExtrasFile.content, "utf8");
  }
}

function boogNode(): unknown {
  return {
    id: 63,
    type: "TextEncodeBooguEdit",
    properties: { cnr_id: "comfy-core" },
    inputs: [{ link: 116 }],
    outputs: [{ links: [124] }],
    widgets_values: []
  };
}

describe("intake preflight custom-node detection", () => {
  it("flags a node tagged cnr_id=comfy-core as a critical gap when it isn't actually registered in the local ComfyUI build (real bug)", async () => {
    // Regression test for a real incident: a workflow node genuinely IS
    // native ComfyUI core upstream (added after this build's ComfyUI
    // checkout), so its `cnr_id: "comfy-core"` tag is truthful -- but the
    // old code trusted that tag unconditionally and skipped the node
    // entirely, so Step 00/01 never surfaced it. The gap only surfaced deep
    // in Step 02's own SDK-driven code inspection. Cross-checking against
    // the local build's real registered node types (parsed from its own
    // nodes.py/comfy_extras) catches this at intake instead.
    resetBuiltinNodeCache();
    const root = path.join(process.cwd(), ".demo-state", "tests", `intake-preflight-core-gap-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await writeComfyuiFixture(comfyuiRoot);
    const workflowPath = path.join(root, "workflow.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({ nodes: [boogNode()], links: [] }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-intake-core-gap",
      name: "Intake core gap",
      status: "pending",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "00", status: "pending" }]
    };

    const result = await ensureIntakePreflight({ task, modelRoots: [path.join(root, "models")], comfyuiRoot });

    const row = result.customNodeRows.find((r) => r.nodeType === "TextEncodeBooguEdit");
    expect(row).toMatchObject({
      criticalPath: "yes",
      state: "source unknown",
      sourcePackage: "comfy-core (missing locally)"
    });
    expect(row?.evidence).toContain("upstream version gap");
    expect(result.canContinueToFeasibility).toBe("no");
    expect(result.hardStops.some((s) => s.includes("TextEncodeBooguEdit"))).toBe(true);
  });

  it("does not flag a cnr_id=comfy-core node that IS actually registered in the local ComfyUI build", async () => {
    resetBuiltinNodeCache();
    const root = path.join(process.cwd(), ".demo-state", "tests", `intake-preflight-core-known-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await writeComfyuiFixture(comfyuiRoot, {
      name: "nodes_boogu.py",
      content: 'NODE_CLASS_MAPPINGS = {\n  "TextEncodeBooguEdit": TextEncodeBooguEdit,\n}\n'
    });
    const workflowPath = path.join(root, "workflow.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({ nodes: [boogNode()], links: [] }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-intake-core-known",
      name: "Intake core known",
      status: "pending",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "00", status: "pending" }]
    };

    const result = await ensureIntakePreflight({ task, modelRoots: [path.join(root, "models")], comfyuiRoot });

    expect(result.customNodeRows.find((r) => r.nodeType === "TextEncodeBooguEdit")).toBeUndefined();
    expect(result.hardStops.some((s) => s.includes("TextEncodeBooguEdit"))).toBe(false);
  });

  it("recognizes a custom node whose custom_nodes/<name> is a SYMLINK (the /nfs_share shared-tree convention), not a real directory (real bug: fs.readdir's Dirent.isDirectory() does not follow symlinks, so a migrated shared node was silently treated as absent)", async () => {
    resetBuiltinNodeCache();
    const root = path.join(process.cwd(), ".demo-state", "tests", `intake-preflight-symlink-node-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await writeComfyuiFixture(comfyuiRoot);

    // Simulate the /nfs_share/custom_nodes/<name> shared tree: a real package
    // directory living OUTSIDE comfyui_root, symlinked in from custom_nodes/.
    const sharedTreeDir = path.join(root, "nfs-share-custom-nodes", "ComfyUI-KJNodes");
    await ensureDir(sharedTreeDir);
    await fs.writeFile(path.join(sharedTreeDir, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n", "utf8");
    await ensureDir(path.join(comfyuiRoot, "custom_nodes"));
    await fs.symlink(sharedTreeDir, path.join(comfyuiRoot, "custom_nodes", "ComfyUI-KJNodes"), "dir");

    const workflowPath = path.join(root, "workflow.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            type: "SomeKJNode",
            properties: { cnr_id: "comfyui-kjnodes" },
            inputs: [],
            outputs: [],
            widgets_values: []
          }
        ],
        links: []
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-intake-symlink-node",
      name: "Intake symlink node",
      status: "pending",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "00", status: "pending" }]
    };

    const result = await ensureIntakePreflight({ task, modelRoots: [path.join(root, "models")], comfyuiRoot });

    const row = result.customNodeRows.find((r) => r.nodeType === "SomeKJNode");
    expect(row?.state).toBe("source known");
    expect(row?.evidence).toContain("custom_nodes/ComfyUI-KJNodes");
  });

  it("marks a known-registry custom node (llama_cpp_* / ComfyUI-llama-cpp_vlm) as 'source known' with NO local install, so Step 02 does not ask the human to provide the source", async () => {
    resetBuiltinNodeCache();
    const root = path.join(process.cwd(), ".demo-state", "tests", `intake-preflight-known-llama-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await writeComfyuiFixture(comfyuiRoot);
    // Deliberately NO custom_nodes/ComfyUI-llama-cpp_vlm dir: source-known must come
    // from the known-custom-node registry (inferPackageHint), not local evidence.

    const workflowPath = path.join(root, "workflow.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          { id: 1, type: "llama_cpp_model_loader", properties: {}, inputs: [], outputs: [], widgets_values: [] }
        ],
        links: []
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-intake-known-llama",
      name: "Intake known llama node",
      status: "pending",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "00", status: "pending" }]
    };

    const result = await ensureIntakePreflight({ task, modelRoots: [path.join(root, "models")], comfyuiRoot });

    const row = result.customNodeRows.find((r) => r.nodeType === "llama_cpp_model_loader");
    expect(row?.state).toBe("source known");
    expect(row?.sourcePackage).toBe("ComfyUI-llama-cpp_vlm");
    expect(row?.humanAction).toBe("none");
  });
});

describe("intake preflight catalog boundary pre-triage", () => {
  // A critical custom node linked into the graph (criticalPath === "yes").
  function cudaKernelNode(): unknown {
    return {
      id: 7,
      type: "CudaKernelNode",
      properties: {},
      inputs: [{ link: 1 }],
      outputs: [{ links: [2] }],
      widgets_values: []
    };
  }

  async function writeCatalogRecord(dataDir: string, rec: Record<string, unknown>): Promise<void> {
    await ensureDir(path.join(dataDir, "nodes"));
    await fs.writeFile(path.join(dataDir, "nodes", `${rec.nodeKey}.json`), JSON.stringify(rec), "utf8");
  }

  function boundaryRecord(tier: "trusted" | "unsupported" | "candidate"): Record<string, unknown> {
    return {
      schemaVersion: 1,
      nodeKey: "acme__cudakernel",
      packageName: "CudaKernel",
      repository: "https://github.com/acme/CudaKernel",
      nodeTypePrefixes: ["CudaKernelNode"],
      execution: "cpu",
      xpuSupport: "unsupported",
      migrationRoute: "unsupported_cuda_kernel",
      knownIssues: ["compiled CUDA kernel, no XPU path"],
      retireCondition: "re-evaluate if upstream ships a SYCL build",
      tier,
      version: 1,
      createdAt: "2026-08-27T00:00:00Z",
      updatedAt: "2026-08-27T00:00:00Z"
    };
  }

  async function runWithCatalog(tier: "trusted" | "unsupported" | "candidate") {
    resetBuiltinNodeCache();
    const root = path.join(process.cwd(), ".demo-state", "tests", `intake-boundary-${tier}-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    const dataDir = path.join(root, "catalog");
    await ensureDir(artifactPath);
    await writeComfyuiFixture(comfyuiRoot);
    await writeCatalogRecord(dataDir, boundaryRecord(tier));
    const workflowPath = path.join(root, "workflow.json");
    await fs.writeFile(workflowPath, JSON.stringify({ nodes: [cudaKernelNode()], links: [] }), "utf8");
    const task: MigrationTask = {
      id: `task-intake-boundary-${tier}`,
      name: "Intake boundary",
      status: "pending",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "00", status: "pending" }]
    };
    // Catalog enabled, but point the server at a dead port so resolve uses the
    // offline JSON fallback against our fixture dataDir (hermetic).
    process.env.XPU_CATALOG_ENABLED = "1";
    process.env.XPU_CATALOG_DATA_DIR = dataDir;
    process.env.XPU_CATALOG_SERVER_URL = "http://127.0.0.1:59997";
    try {
      return await ensureIntakePreflight({ task, modelRoots: [path.join(root, "models")], comfyuiRoot });
    } finally {
      for (const k of ["XPU_CATALOG_ENABLED", "XPU_CATALOG_DATA_DIR", "XPU_CATALOG_SERVER_URL"]) delete process.env[k];
    }
  }

  it("hard-stops early on a critical node the catalog knows is an unsupported_cuda_kernel (proven tier)", async () => {
    const result = await runWithCatalog("unsupported");
    expect(result.canContinueToFeasibility).toBe("no");
    expect(result.hardStops.some((s) => s.includes("Known XPU boundary") && s.includes("CudaKernelNode"))).toBe(true);
  });

  it("does NOT hard-stop on a candidate-tier boundary (a guess, left for Step 02)", async () => {
    const result = await runWithCatalog("candidate");
    expect(result.hardStops.some((s) => s.includes("Known XPU boundary"))).toBe(false);
  });
});
