import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import {
  loadGpuNodes,
  pickNode,
  nodeApiUrl,
  renderGpuNodeBlock,
  maskNodeForPublic,
  upsertNode,
  removeNode,
  saveGpuNodes,
  verifyNode,
  type GpuNode
} from "./gpuNodes";

function makeConfig(root: string, gpuNodesPath?: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: "/tmp/comfy",
    modelRoots: ["/home/intel/hf_models"],
    gpuNodesPath: gpuNodesPath ?? path.join(root, "gpu-nodes.json"),
    autoApproveAgentPermissions: false
  };
}

describe("gpuNodes", () => {
  it("synthesizes a single local node when gpu-nodes.json is missing", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-missing-${Date.now()}`);
    const cfg = makeConfig(root);  // path doesn't exist on disk
    const reg = loadGpuNodes(cfg);
    expect(reg.nodes).toHaveLength(1);
    expect(reg.nodes[0].kind).toBe("local");
    expect(reg.nodes[0].comfyui_root).toBe(cfg.comfyuiRoot);
    expect(reg.nodes[0].model_roots).toEqual(cfg.modelRoots);
    expect(reg.default_node).toBe(reg.nodes[0].name);
  });

  it("loads a registry with local + ssh nodes and masks key_path in public view", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-load-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const cfg = makeConfig(root);
    await fs.writeFile(
      cfg.gpuNodesPath,
      JSON.stringify({
        default_node: "remote",
        nodes: [
          {
            name: "local",
            kind: "local",
            comfyui_root: "/tmp/comfy",
            venv_python: "/tmp/comfy/.venv/bin/python3",
            model_roots: ["/models"],
            api_host: "127.0.0.1",
            api_port: 8188
          },
          {
            name: "remote",
            kind: "ssh",
            comfyui_root: "/home/intel/ComfyUI",
            venv_python: "/home/intel/ComfyUI/.venv-xpu/bin/python3",
            model_roots: ["/home/intel/hf_models"],
            api_host: "172.16.114.200",
            api_port: 8188,
            ssh: {
              host: "172.16.114.200",
              user: "intel",
              port: 22,
              key_path: "/home/intel/.ssh/id_ed25519"
            },
            model_share: "nfs_same_path"
          }
        ]
      }),
      "utf8"
    );

    const reg = loadGpuNodes(cfg);
    expect(reg.nodes.map((n) => n.name).sort()).toEqual(["local", "remote"]);

    const remote = pickNode(reg, "remote");
    expect(remote.kind).toBe("ssh");
    expect(remote.ssh?.key_path).toBe("/home/intel/.ssh/id_ed25519");

    const masked = maskNodeForPublic(remote);
    expect(masked.ssh?.key_configured).toBe(true);
    expect((masked.ssh as { key_path?: string }).key_path).toBeUndefined();

    expect(nodeApiUrl(remote)).toBe("http://172.16.114.200:8188");
  });

  it("pickNode falls back to default then nodes[0]", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-pick-${Date.now()}`);
    const cfg = makeConfig(root);
    const reg = loadGpuNodes(cfg);  // synthesized single node
    expect(pickNode(reg, "nonexistent").name).toBe(reg.nodes[0].name);
    expect(pickNode(reg).name).toBe(reg.nodes[0].name);
  });

  it("renderGpuNodeBlock surfaces ssh details for the Step 05 skill to branch on", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-render-${Date.now()}`);
    const cfg = makeConfig(root);
    const reg = loadGpuNodes(cfg);
    const block = renderGpuNodeBlock(reg.nodes[0], "task-123");
    expect(block).toContain("kind: local");
    expect(block).toContain("task_id: task-123");
    expect(block).toContain(`comfyui_root: ${cfg.comfyuiRoot}`);
  });

  it("rejects a registry with default_node that doesn't match any node name", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-bad-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const cfg = makeConfig(root);
    await fs.writeFile(
      cfg.gpuNodesPath,
      JSON.stringify({
        default_node: "missing",
        nodes: [
          {
            name: "local",
            kind: "local",
            comfyui_root: "/tmp/comfy",
            venv_python: "/tmp/comfy/.venv/bin/python3",
            model_roots: ["/models"],
            api_host: "127.0.0.1",
            api_port: 8188
          }
        ]
      }),
      "utf8"
    );
    expect(() => loadGpuNodes(cfg)).toThrow(/default_node "missing"/);
  });

  it("upsertNode adds and replaces by name", () => {
    const local: GpuNode = {
      name: "a", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };
    const remote: GpuNode = {
      name: "a", kind: "ssh", comfyui_root: "/y", venv_python: "/y/.venv/bin/python3",
      model_roots: ["/m"], api_host: "10.0.0.1", api_port: 8188,
      ssh: { host: "10.0.0.1", user: "u" }
    };
    const reg = { default_node: "a", nodes: [local] };
    const upserted = upsertNode(reg, remote);
    expect(upserted.nodes).toHaveLength(1);
    expect(upserted.nodes[0]).toBe(remote);
  });

  it("removeNode returns input untouched if name not present", () => {
    const local: GpuNode = {
      name: "a", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };
    const reg = { default_node: "a", nodes: [local] };
    expect(removeNode(reg, "nonexistent")).toBe(reg);
  });

  it("removeNode reassigns default if removed node was the default", () => {
    const a: GpuNode = {
      name: "a", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };
    const b: GpuNode = {
      name: "b", kind: "ssh", comfyui_root: "/y", venv_python: "/y/.venv/bin/python3",
      model_roots: ["/m"], api_host: "10.0.0.1", api_port: 8188,
      ssh: { host: "10.0.0.1", user: "u" }
    };
    const reg = { default_node: "a", nodes: [a, b] };
    const after = removeNode(reg, "a");
    expect(after.nodes.map((n) => n.name)).toEqual(["b"]);
    expect(after.default_node).toBe("b");
  });

  it("saveGpuNodes round-trips through loadGpuNodes", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-save-${Date.now()}`);
    const cfg = makeConfig(root);
    const local: GpuNode = {
      name: "saved-local", kind: "local", comfyui_root: "/tmp/comfy",
      venv_python: "/tmp/comfy/.venv/bin/python3",
      model_roots: ["/home/intel/hf_models"], api_host: "127.0.0.1", api_port: 8188
    };
    await saveGpuNodes(cfg, { default_node: "saved-local", nodes: [local] });
    const loaded = loadGpuNodes(cfg);
    expect(loaded.nodes.map((n) => n.name)).toEqual(["saved-local"]);
    expect(loaded.default_node).toBe("saved-local");
  });

  it("saveGpuNodes rejects a registry with an invalid node", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-save-bad-${Date.now()}`);
    const cfg = makeConfig(root);
    const bad = {
      name: "x", kind: "local" as const, comfyui_root: "",  // missing comfyui_root
      venv_python: "/x", model_roots: [], api_host: "127.0.0.1", api_port: 8188
    };
    await expect(saveGpuNodes(cfg, { default_node: "x", nodes: [bad as unknown as GpuNode] }))
      .rejects.toThrow(/comfyui_root/);
  });

  it("verifyNode returns ok:false (never throws) on unreachable local port", async () => {
    const node: GpuNode = {
      name: "dead", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 1,  // nothing listens on :1
    };
    const result = await verifyNode(node, 2_000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("127.0.0.1:1");
  });
});
