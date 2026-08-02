import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { Recipe } from "./recipeLibrary";
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
  resolveNfsShareRoot,
  syncDockerImageFromNfs,
  ensureDockerImageSynced,
  checkComfyUiCoreDrift,
  syncComfyUiCoreFromNfs,
  checkRecipeEnvironmentDrift,
  checkPortOccupant,
  checkOmniXpuAcceleration,
  getProcessElapsedSeconds,
  killProcessOnNode,
  syncCustomNodesFromNfs,
  formatNfsHealthSuffix,
  mergeModelRoots,
  type GpuNode
} from "./gpuNodes";

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial", "--allow-empty"], { cwd: root });
}

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
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    taskArchiveRoot: path.join(root, "task-archive"),
    assetResolutionLedgerPath: path.join(root, "asset-resolutions.jsonl"),
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

  it("rejects runtime=docker without docker_image", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-docker-bad-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const cfg = makeConfig(root);
    await fs.writeFile(
      cfg.gpuNodesPath,
      JSON.stringify({
        default_node: "d",
        nodes: [
          {
            name: "d", kind: "local", comfyui_root: "/tmp/comfy",
            venv_python: "/venv/bin/python3", model_roots: ["/m"],
            api_host: "127.0.0.1", api_port: 8188, runtime: "docker"
          }
        ]
      }),
      "utf8"
    );
    expect(() => loadGpuNodes(cfg)).toThrow(/runtime="docker".*docker_image/);
  });

  it("loads runtime=docker + docker_image from JSON and renders them for the Step 05 skill", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-docker-ok-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const cfg = makeConfig(root);
    await fs.writeFile(
      cfg.gpuNodesPath,
      JSON.stringify({
        default_node: "d",
        nodes: [
          {
            name: "d", kind: "local", comfyui_root: "/tmp/comfy",
            venv_python: "/shared/venv/bin/python3", model_roots: ["/m"],
            api_host: "127.0.0.1", api_port: 8188,
            runtime: "docker", docker_image: "intel/llm-scaler-vllm:1.4"
          }
        ]
      }),
      "utf8"
    );
    const reg = loadGpuNodes(cfg);
    expect(reg.nodes[0].runtime).toBe("docker");
    expect(reg.nodes[0].docker_image).toBe("intel/llm-scaler-vllm:1.4");
    const block = renderGpuNodeBlock(reg.nodes[0], "task-docker");
    expect(block).toContain("runtime: docker");
    expect(block).toContain("docker_image: intel/llm-scaler-vllm:1.4");
  });

  it("renderGpuNodeBlock defaults to 'runtime: bare' when unset", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `gn-bare-${Date.now()}`);
    const cfg = makeConfig(root);
    const reg = loadGpuNodes(cfg);
    const block = renderGpuNodeBlock(reg.nodes[0], "task-bare");
    expect(block).toContain("runtime: bare");
    expect(block).not.toContain("docker_image:");
  });

  describe("resolveNfsShareRoot", () => {
    it("defaults to /nfs_share for runtime=docker with no explicit setting", () => {
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag"
      };
      expect(resolveNfsShareRoot(node)).toBe("/nfs_share");
    });

    it("prefers an explicit nfs_share_root over the docker default", () => {
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag", nfs_share_root: "/custom-share"
      };
      expect(resolveNfsShareRoot(node)).toBe("/custom-share");
    });

    it("is undefined for a bare node with no explicit setting", () => {
      const node: GpuNode = {
        name: "b", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
      };
      expect(resolveNfsShareRoot(node)).toBeUndefined();
    });
  });

  describe("formatNfsHealthSuffix (parses the PREFIX:value protocol nfsHealthShellCmd produces)", () => {
    // Real `mountpoint -q` correctly refuses to call a plain mkdir'd test directory
    // "mounted" (it isn't a genuine kernel-level mount) — that strictness is the
    // whole point (catches a silently-unmounted/empty directory masquerading as
    // the real share), but it also means "simulate a healthy mount" can't be done
    // with a bare directory in a unit test. Test the pure parsing logic directly
    // instead of depending on real mount state; the "doesn't exist at all" case
    // below is still exercised end-to-end since that's genuinely verifiable.
    it("reports healthy when mounted and all subdirs are present", () => {
      const detail = formatNfsHealthSuffix("/nfs_share", [
        "NFS_MOUNT:mounted",
        "NFS_SUBDIR:custom_nodes:ok",
        "NFS_SUBDIR:docker-images:ok",
        "NFS_SUBDIR:venv-container-xpu:ok"
      ]);
      expect(detail).toBe("; NFS share /nfs_share healthy");
    });

    it("reports missing subdirs when mounted but incomplete", () => {
      const detail = formatNfsHealthSuffix("/nfs_share", [
        "NFS_MOUNT:mounted",
        "NFS_SUBDIR:custom_nodes:ok",
        "NFS_SUBDIR:docker-images:missing",
        "NFS_SUBDIR:venv-container-xpu:missing"
      ]);
      expect(detail).toContain("mounted but missing:");
      expect(detail).toContain("docker-images");
      expect(detail).toContain("venv-container-xpu");
      expect(detail).not.toContain("custom_nodes");
    });

    it("also accepts the mountpoint-less fallback signal (nonempty)", () => {
      const detail = formatNfsHealthSuffix("/nfs_share", [
        "NFS_MOUNT:nonempty",
        "NFS_SUBDIR:custom_nodes:ok",
        "NFS_SUBDIR:docker-images:ok",
        "NFS_SUBDIR:venv-container-xpu:ok"
      ]);
      expect(detail).toBe("; NFS share /nfs_share healthy");
    });

    it("reports not mounted/populated when the mount signal is negative", () => {
      const detail = formatNfsHealthSuffix("/nfs_share", ["NFS_MOUNT:not_mounted"]);
      expect(detail).toContain("NOT mounted/populated");
    });
  });

  describe("verifyNode NFS share health check", () => {
    it("reports not mounted/populated when the share root doesn't exist at all", async () => {
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 1,
        runtime: "docker", docker_image: "img:tag", nfs_share_root: "/this/path/does/not/exist-ever"
      };
      const result = await verifyNode(node, 2_000);
      expect(result.detail).toContain("NOT mounted/populated");
    });
  });

  describe("syncDockerImageFromNfs", () => {
    it("runs the local canonical script and returns its trailing output", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-sync-ok-${Date.now()}`);
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.writeFile(
        path.join(root, "scripts", "load-docker-image-from-nfs.sh"),
        "#!/usr/bin/env bash\necho \"NFS_DOCKER_IMAGES_ROOT=$NFS_DOCKER_IMAGES_ROOT\"\necho done\n",
        { mode: 0o755 }
      );
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag", nfs_share_root: "/custom-share"
      };
      const result = await syncDockerImageFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("NFS_DOCKER_IMAGES_ROOT=/custom-share/docker-images");
      expect(result.detail).toContain("done");
    });

    it("returns ok:false when the canonical script isn't present", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-sync-missing-${Date.now()}`);
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag"
      };
      const result = await syncDockerImageFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("sync script not found");
    });

    it("returns ok:false for an ssh-kind node missing its ssh block", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-sync-nossh-${Date.now()}`);
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.writeFile(path.join(root, "scripts", "load-docker-image-from-nfs.sh"), "#!/usr/bin/env bash\necho ok\n", {
        mode: 0o755
      });
      const node: GpuNode = {
        name: "d", kind: "ssh", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "10.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag"
      };
      const result = await syncDockerImageFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("ssh block is missing");
    });
  });

  describe("ensureDockerImageSynced", () => {
    it("no-ops for a non-docker-runtime node", async () => {
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
      };
      const result = await ensureDockerImageSynced(node, { projectRoot: "/does-not-matter" });
      expect(result.synced).toBe(false);
      expect(result.detail).toContain("not a docker-runtime node");
    });

    it("no-ops when docker_image is unset", async () => {
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188, runtime: "docker"
      };
      const result = await ensureDockerImageSynced(node, { projectRoot: "/does-not-matter" });
      expect(result.synced).toBe(false);
      expect(result.detail).toContain("not a docker-runtime node");
    });

    it("skips the drift check (never blocks Step 05) when the NFS manifest can't be read", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-ensure-nomanifest-${Date.now()}`);
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "does-not-exist:tag", nfs_share_root: path.join(root, "no-such-nfs-root")
      };
      const result = await ensureDockerImageSynced(node, { projectRoot: root });
      expect(result.synced).toBe(false);
      expect(result.detail).toContain("could not read NFS manifest");
    });

    it("skips the drift check when the manifest has no image_id", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-ensure-noid-${Date.now()}`);
      const nfsRoot = path.join(root, "nfs-share");
      await fs.mkdir(path.join(nfsRoot, "docker-images"), { recursive: true });
      await fs.writeFile(
        path.join(nfsRoot, "docker-images", "test-image-tag.manifest.json"),
        JSON.stringify({ image: "test/image:tag" }),
        "utf8"
      );
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "test/image:tag", nfs_share_root: nfsRoot
      };
      const result = await ensureDockerImageSynced(node, { projectRoot: root });
      expect(result.synced).toBe(false);
      expect(result.detail).toContain("no image_id");
    });

    it("triggers a sync from NFS when the image isn't present locally (real case: never loaded, or a different image_id)", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-ensure-mismatch-${Date.now()}`);
      const nfsRoot = path.join(root, "nfs-share");
      await fs.mkdir(path.join(nfsRoot, "docker-images"), { recursive: true });
      await fs.writeFile(
        path.join(nfsRoot, "docker-images", "test-image-tag.manifest.json"),
        JSON.stringify({ image: "test/image:tag", image_id: "sha256:deadbeef" }),
        "utf8"
      );
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.writeFile(
        path.join(root, "scripts", "load-docker-image-from-nfs.sh"),
        "#!/usr/bin/env bash\necho synced-ok\n",
        { mode: 0o755 }
      );
      const node: GpuNode = {
        // "test/image:tag" is never actually loaded in this test sandbox --
        // docker image inspect naturally returns nothing for it, exercising
        // the real "not present locally" path without mocking docker itself.
        name: "d", kind: "local", comfyui_root: "/x", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "test/image:tag", nfs_share_root: nfsRoot
      };
      const result = await ensureDockerImageSynced(node, { projectRoot: root });
      expect(result.synced).toBe(true);
      expect(result.detail).toContain("not present locally");
      expect(result.detail).toContain("synced-ok");
    });
  });

  describe("checkComfyUiCoreDrift", () => {
    it("reports in-sync when no canonical repo exists at <nfs_share_root>/comfyui-core (nothing to compare)", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-drift-no-canonical-${Date.now()}`);
      await fs.mkdir(root, { recursive: true });
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: path.join(root, "comfyui"), venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", nfs_share_root: path.join(root, "nfs-share")
      };
      const result = await checkComfyUiCoreDrift(node);
      expect(result.inSync).toBe(true);
      expect(result.detail).toContain("nothing to compare");
    });

    it("reports in-sync when comfyui_root is not a git checkout (nothing to compare)", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-drift-not-git-${Date.now()}`);
      const nfsRoot = path.join(root, "nfs-share");
      const canonicalPath = path.join(nfsRoot, "comfyui-core");
      await fs.mkdir(canonicalPath, { recursive: true });
      initGitRepo(canonicalPath);
      // Deliberately OUTSIDE this project's own git repo (unlike `root` above,
      // nested under /tmp/cma-staging) -- otherwise `git -C comfyuiRoot` walks
      // up and finds THIS repo's own .git, returning ITS HEAD instead of
      // correctly failing (confirmed live: git does exactly this).
      const comfyuiRoot = path.join(os.tmpdir(), `gn-core-drift-not-git-comfyui-${Date.now()}`);
      await fs.mkdir(comfyuiRoot, { recursive: true });
      try {
        const node: GpuNode = {
          name: "d", kind: "local", comfyui_root: comfyuiRoot, venv_python: "/x/.venv/bin/python3",
          model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
          runtime: "docker", nfs_share_root: nfsRoot
        };
        const result = await checkComfyUiCoreDrift(node);
        expect(result.inSync).toBe(true);
        expect(result.canonicalCommit).toBeDefined();
        expect(result.detail).toContain("not a git checkout");
      } finally {
        await fs.rm(comfyuiRoot, { recursive: true, force: true });
      }
    });

    it("reports in-sync when comfyui_root's commit matches the canonical repo's HEAD", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-drift-match-${Date.now()}`);
      const nfsRoot = path.join(root, "nfs-share");
      const canonicalPath = path.join(nfsRoot, "comfyui-core");
      await fs.mkdir(canonicalPath, { recursive: true });
      initGitRepo(canonicalPath);
      const comfyuiRoot = path.join(root, "comfyui");
      execFileSync("git", ["clone", "-q", canonicalPath, comfyuiRoot]);
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: comfyuiRoot, venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", nfs_share_root: nfsRoot
      };
      const result = await checkComfyUiCoreDrift(node);
      expect(result.inSync).toBe(true);
      expect(result.localCommit).toBe(result.canonicalCommit);
      expect(result.detail).toContain("already matches canonical");
    });

    it("reports drift when comfyui_root's commit is behind the canonical repo's HEAD", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-drift-behind-${Date.now()}`);
      const nfsRoot = path.join(root, "nfs-share");
      const canonicalPath = path.join(nfsRoot, "comfyui-core");
      await fs.mkdir(canonicalPath, { recursive: true });
      initGitRepo(canonicalPath);
      const comfyuiRoot = path.join(root, "comfyui");
      execFileSync("git", ["clone", "-q", canonicalPath, comfyuiRoot]);
      // Advance canonical past the node's cloned commit -- a real XPU patch commit.
      await fs.mkdir(path.join(canonicalPath, "comfy"), { recursive: true });
      await fs.writeFile(path.join(canonicalPath, "comfy", "ops.py"), "# xpu patch\n");
      execFileSync("git", ["add", "-A"], { cwd: canonicalPath });
      execFileSync("git", ["commit", "-q", "-m", "xpu: patch ops.py"], { cwd: canonicalPath });
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: comfyuiRoot, venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", nfs_share_root: nfsRoot
      };
      const result = await checkComfyUiCoreDrift(node);
      expect(result.inSync).toBe(false);
      expect(result.localCommit).not.toBe(result.canonicalCommit);
      expect(result.detail).toContain("sync-comfyui-core-from-nfs.sh");
    });
  });

  describe("syncComfyUiCoreFromNfs", () => {
    it("runs the local canonical script and returns its trailing output", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-sync-ok-${Date.now()}`);
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.writeFile(
        path.join(root, "scripts", "sync-comfyui-core-from-nfs.sh"),
        "#!/usr/bin/env bash\necho \"NFS_COMFYUI_CORE_ROOT=$NFS_COMFYUI_CORE_ROOT\"\necho \"arg1=$1\"\necho done\n",
        { mode: 0o755 }
      );
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x/comfyui", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", nfs_share_root: "/custom-share"
      };
      const result = await syncComfyUiCoreFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("NFS_COMFYUI_CORE_ROOT=/custom-share/comfyui-core");
      expect(result.detail).toContain("arg1=/x/comfyui");
      expect(result.detail).toContain("done");
    });

    it("returns ok:false when the canonical script isn't present", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-core-sync-missing-${Date.now()}`);
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/x/comfyui", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
      };
      const result = await syncComfyUiCoreFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("sync script not found");
    });
  });

  describe("syncCustomNodesFromNfs", () => {
    it("runs the local canonical script with comfyui_root + custom_nodes path args", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-sync-cn-${Date.now()}`);
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.writeFile(
        path.join(root, "scripts", "sync-custom-nodes-from-nfs.sh"),
        "#!/usr/bin/env bash\necho \"args: $1 $2\"\n",
        { mode: 0o755 }
      );
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: "/comfy-root", venv_python: "/x/.venv/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188,
        runtime: "docker", docker_image: "img:tag", nfs_share_root: "/custom-share"
      };
      const result = await syncCustomNodesFromNfs(node, { projectRoot: root });
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("/comfy-root /custom-share/custom_nodes");
    });
  });

  describe("mergeModelRoots", () => {
    it("unions the global default roots with a node's own roots", () => {
      expect(mergeModelRoots(["/home/intel/hf_models"], ["/nfs_share"])).toEqual([
        "/home/intel/hf_models",
        "/nfs_share"
      ]);
    });

    it("dedupes overlapping entries, keeping global-first ordering", () => {
      expect(mergeModelRoots(["/a", "/b"], ["/b", "/c"])).toEqual(["/a", "/b", "/c"]);
    });

    it("returns just the global roots when the node declares none", () => {
      expect(mergeModelRoots(["/home/intel/hf_models"], [])).toEqual(["/home/intel/hf_models"]);
    });

    it("returns just the node roots when the global list is empty", () => {
      expect(mergeModelRoots([], ["/nfs_share"])).toEqual(["/nfs_share"]);
    });
  });

  describe("checkRecipeEnvironmentDrift", () => {
    // Real end-to-end checks against an actual local Python + pip install --
    // "pip" itself is a real, always-present, stably-versioned package,
    // so these exercise the genuine importlib.metadata round-trip without
    // needing a fake/mocked package.
    const localNode: GpuNode = {
      name: "local-test", kind: "local", comfyui_root: "/x", venv_python: "/usr/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };

    function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
      return {
        recipeId: "test-recipe",
        version: "1.0.0",
        nodeType: "CLIPLoader",
        xpuSupport: "patched",
        patchFile: "patches/test.patch",
        knownIssues: ["test"],
        provenance: { taskOrigin: "test-task", createdAt: "2026-01-01" },
        ...overrides
      };
    }

    it("detects drift when the recipe's baseVersion doesn't match the actually-installed package version", async () => {
      const result = await checkRecipeEnvironmentDrift(
        [makeRecipe({ recipeId: "pip-recipe", baseVersion: "pip@0.0.1-definitely-not-real" })],
        localNode
      );
      expect(result.checked).toBe(1);
      expect(result.drifted).toHaveLength(1);
      expect(result.drifted[0]).toMatchObject({ recipeId: "pip-recipe", packageName: "pip", expectedRef: "0.0.1-definitely-not-real" });
      expect(result.drifted[0].actualVersion).toBeTruthy();
    });

    it("reports no drift when the recipe's baseVersion matches the actually-installed version", async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("python3", ["-c", "import importlib.metadata as m; print(m.version('pip'))"]);
      const actualPipVersion = stdout.trim();

      const result = await checkRecipeEnvironmentDrift(
        [makeRecipe({ recipeId: "pip-recipe", baseVersion: `pip@${actualPipVersion}` })],
        localNode
      );
      expect(result.checked).toBe(1);
      expect(result.drifted).toHaveLength(0);
    });

    it("skips a recipe with no baseVersion", async () => {
      const result = await checkRecipeEnvironmentDrift([makeRecipe({ baseVersion: undefined })], localNode);
      expect(result.checked).toBe(0);
    });

    it("skips a git-repo-style baseVersion (owner/repo@commit) -- not a pip distribution name", async () => {
      const result = await checkRecipeEnvironmentDrift(
        [makeRecipe({ baseVersion: "numz/ComfyUI-SeedVR2_VideoUpscaler@4490bd1" })],
        localNode
      );
      expect(result.checked).toBe(0);
      expect(result.drifted).toHaveLength(0);
    });

    it("skips a recipe whose package name can't be resolved (not installed / typo)", async () => {
      const result = await checkRecipeEnvironmentDrift(
        [makeRecipe({ baseVersion: "definitely-not-a-real-package-xyz@1.0.0" })],
        localNode
      );
      expect(result.checked).toBe(0);
      expect(result.drifted).toHaveLength(0);
    });
  });

  describe("checkPortOccupant", () => {
    const localNode: GpuNode = {
      name: "local-test", kind: "local", comfyui_root: "/x", venv_python: "/usr/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };

    it("detects a real bound port and identifies the occupying process", async () => {
      const net = await import("node:net");
      const server = net.createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr !== "string") resolve(addr.port);
          else reject(new Error("failed to bind test server"));
        });
      });
      try {
        const result = await checkPortOccupant(localNode, port);
        expect(result.occupied).toBe(true);
        expect(result.pid).toBe(String(process.pid));
        expect(result.commandLine).toBeTruthy();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("reports occupied:false for a port nothing is bound to", async () => {
      // High port unlikely to be in use; ss/grep simply finds nothing.
      const result = await checkPortOccupant(localNode, 54217);
      expect(result.occupied).toBe(false);
      expect(result.pid).toBeUndefined();
    });
  });

  describe("checkOmniXpuAcceleration", () => {
    it("reports omniXpuNodePresent:false when the custom-node directory doesn't exist", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-omnixpu-absent-${Date.now()}`);
      await fs.mkdir(root, { recursive: true });
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: root, venv_python: "/usr/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
      };
      const result = await checkOmniXpuAcceleration(node);
      expect(result).toEqual({ omniXpuNodePresent: false, kernelImportable: false });
    });

    it("reports omniXpuNodePresent:true but kernelImportable:false when the dir exists but the kernel isn't installed in this Python", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `gn-omnixpu-present-${Date.now()}`);
      await fs.mkdir(path.join(root, "custom_nodes", "ComfyUI-OmniXPU"), { recursive: true });
      const node: GpuNode = {
        name: "d", kind: "local", comfyui_root: root, venv_python: "/usr/bin/python3",
        model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
      };
      const result = await checkOmniXpuAcceleration(node);
      expect(result).toEqual({ omniXpuNodePresent: true, kernelImportable: false });
    });
  });

  describe("getProcessElapsedSeconds / killProcessOnNode", () => {
    const localNode: GpuNode = {
      name: "local-test", kind: "local", comfyui_root: "/x", venv_python: "/usr/bin/python3",
      model_roots: ["/m"], api_host: "127.0.0.1", api_port: 8188
    };

    it("returns a plausible non-negative elapsed time for a real running process", async () => {
      const elapsed = await getProcessElapsedSeconds(localNode, String(process.pid));
      expect(elapsed).toBeDefined();
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it("returns undefined for a pid that doesn't exist", async () => {
      // A PID far beyond any plausible real process, and not reused within this test run.
      const elapsed = await getProcessElapsedSeconds(localNode, "999999999");
      expect(elapsed).toBeUndefined();
    });

    it("actually terminates a real spawned process", async () => {
      const { spawn } = await import("node:child_process");
      const child = spawn("sleep", ["100"]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const killed = await killProcessOnNode(localNode, String(child.pid));
      expect(killed).toBe(true);
      const exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      const stillRunning = await getProcessElapsedSeconds(localNode, String(child.pid));
      expect(stillRunning).toBeUndefined();
    });

    it("returns false when the pid doesn't exist", async () => {
      const killed = await killProcessOnNode(localNode, "999999999");
      expect(killed).toBe(false);
    });
  });
});
