import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { loadBuiltinNodeTypes, resetBuiltinNodeCache } from "./builtinNodes";
import { ensureDir } from "./fsUtils";

async function makeComfyuiRoot(dirName: string, nodesPyBody: string, extrasFiles: Record<string, string> = {}): Promise<string> {
  const root = path.join(process.cwd(), ".demo-state", "tests", dirName);
  await ensureDir(root);
  await ensureDir(path.join(root, "comfy_extras"));
  await fs.writeFile(path.join(root, "nodes.py"), nodesPyBody, "utf8");
  for (const [name, content] of Object.entries(extrasFiles)) {
    await fs.writeFile(path.join(root, "comfy_extras", name), content, "utf8");
  }
  return root;
}

beforeEach(() => {
  resetBuiltinNodeCache();
});

describe("loadBuiltinNodeTypes", () => {
  it("parses legacy NODE_CLASS_MAPPINGS dict entries from nodes.py", async () => {
    const root = await makeComfyuiRoot(
      `builtin-nodes-legacy-${Date.now()}`,
      'NODE_CLASS_MAPPINGS = {\n  "KSampler": KSampler,\n  "CustomThing": CustomThing,\n}\n'
    );
    const types = loadBuiltinNodeTypes(root);
    expect(types.has("CustomThing")).toBe(true);
  });

  it("parses legacy NODE_CLASS_MAPPINGS entries from comfy_extras/*.py", async () => {
    const root = await makeComfyuiRoot(`builtin-nodes-extras-${Date.now()}`, "NODE_CLASS_MAPPINGS = {}\n", {
      "nodes_boogu.py": 'NODE_CLASS_MAPPINGS = {\n  "TextEncodeBooguEdit": TextEncodeBooguEdit,\n}\n'
    });
    const types = loadBuiltinNodeTypes(root);
    expect(types.has("TextEncodeBooguEdit")).toBe(true);
  });

  it("parses modern node_id registrations", async () => {
    const root = await makeComfyuiRoot(`builtin-nodes-modern-${Date.now()}`, "", {
      "nodes_modern.py": 'class Foo(io.ComfyNode):\n    node_id = "ModernNodeType"\n'
    });
    const types = loadBuiltinNodeTypes(root);
    expect(types.has("ModernNodeType")).toBe(true);
  });

  it("always includes the fallback core types even for an empty checkout", async () => {
    const root = await makeComfyuiRoot(`builtin-nodes-empty-${Date.now()}`, "");
    const types = loadBuiltinNodeTypes(root);
    expect(types.has("KSampler")).toBe(true);
    expect(types.has("CLIPTextEncode")).toBe(true);
  });

  it("caches per comfyuiRoot -- querying a second, different root does not return the first root's parse (real bug this fixes)", async () => {
    // Regression test: a single unkeyed cache would make a caller checking a
    // scratch verification worktree (a different root than the live
    // checkout) incorrectly see the live root's already-cached result.
    const rootA = await makeComfyuiRoot(`builtin-nodes-root-a-${Date.now()}`, "", {
      "nodes_a.py": 'NODE_CLASS_MAPPINGS = {\n  "OnlyInRootA": OnlyInRootA,\n}\n'
    });
    const rootB = await makeComfyuiRoot(`builtin-nodes-root-b-${Date.now()}`, "", {
      "nodes_b.py": 'NODE_CLASS_MAPPINGS = {\n  "OnlyInRootB": OnlyInRootB,\n}\n'
    });

    const typesA = loadBuiltinNodeTypes(rootA);
    const typesB = loadBuiltinNodeTypes(rootB);

    expect(typesA.has("OnlyInRootA")).toBe(true);
    expect(typesA.has("OnlyInRootB")).toBe(false);
    expect(typesB.has("OnlyInRootB")).toBe(true);
    expect(typesB.has("OnlyInRootA")).toBe(false);
  });

  it("returns a stable cached result for the same root across repeated calls", async () => {
    const root = await makeComfyuiRoot(`builtin-nodes-stable-${Date.now()}`, "", {
      "nodes.py": 'NODE_CLASS_MAPPINGS = {\n  "StableType": StableType,\n}\n'
    });
    const first = loadBuiltinNodeTypes(root);
    const second = loadBuiltinNodeTypes(root);
    expect(second).toBe(first);
  });

  it("resetBuiltinNodeCache clears all cached roots, forcing a fresh parse", async () => {
    const root = await makeComfyuiRoot(`builtin-nodes-reset-${Date.now()}`, "", {
      "nodes.py": 'NODE_CLASS_MAPPINGS = {\n  "OriginalType": OriginalType,\n}\n'
    });
    loadBuiltinNodeTypes(root);
    await fs.writeFile(
      path.join(root, "comfy_extras", "nodes.py"),
      'NODE_CLASS_MAPPINGS = {\n  "UpdatedType": UpdatedType,\n}\n',
      "utf8"
    );
    resetBuiltinNodeCache();
    const types = loadBuiltinNodeTypes(root);
    expect(types.has("UpdatedType")).toBe(true);
  });
});
