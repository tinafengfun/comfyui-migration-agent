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
});
