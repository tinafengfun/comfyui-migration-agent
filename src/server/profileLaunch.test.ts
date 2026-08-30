import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GpuNode } from "./gpuNodes";
import {
  parseEvidenceDirs,
  parseLedgerPackages,
  parseEnumPackages,
  customNodeRowsToProfile,
  unionPackages,
  resolveProfilePackages,
  buildProfileDir,
  ALWAYS_INCLUDE_PACKAGES,
  PROFILE_ARTIFACT_FILE
} from "./profileLaunch";
import { CATALOG_DEPLOY_LEDGER_FILE } from "./xpuCatalogWriteBack";

describe("profileLaunch pure parsers", () => {
  it("parseEvidenceDirs pulls custom_nodes/<dir> names from a <br>-joined cell", () => {
    expect(parseEvidenceDirs("custom_nodes/ComfyUI-KJNodes<br>custom_nodes/rgthree-comfy")).toEqual([
      "ComfyUI-KJNodes",
      "rgthree-comfy"
    ]);
    expect(parseEvidenceDirs("no matching local directory evidence")).toEqual([]);
    expect(parseEvidenceDirs(undefined)).toEqual([]);
  });

  it("parseLedgerPackages unions packageName + basename(nfsPath) + basename(repository), skips core", () => {
    const pkgs = parseLedgerPackages({
      nodes: [
        { nodeType: "A", packageName: "ComfyUI-KJNodes", nfsPath: "/nfs_share/custom_nodes/ComfyUI-KJNodes/" },
        { nodeType: "B", nfsPath: "/nfs_share/custom_nodes/rgthree-comfy" },
        // real ledgers often carry only `repository` (owner/name):
        { nodeType: "D", repository: "city96/ComfyUI-GGUF" },
        { nodeType: "CLIPLoader", nodeKey: "core", repository: "comfyui-core" },
        { nodeType: "C" }
      ]
    });
    expect(pkgs.sort()).toEqual(["ComfyUI-GGUF", "ComfyUI-KJNodes", "rgthree-comfy"]);
  });

  it("parseEnumPackages reads resolving_package, skips header + unknowns", () => {
    const csv = [
      "node_id,node_type,widget_slot,value,source_has,target_core_has,resolving_package,state",
      "3,KSampler,sampler_name,res_2s,true,false,RES4LYF,source known",
      "4,KSampler,scheduler,bong_tangent,true,false,unknown — identify from source environment,source unknown"
    ].join("\n");
    expect(parseEnumPackages(csv)).toEqual(["RES4LYF"]);
    expect(parseEnumPackages("")).toEqual([]);
    expect(parseEnumPackages(undefined)).toEqual([]);
  });

  it("customNodeRowsToProfile maps rows → profile entries", () => {
    const profile = customNodeRowsToProfile([
      { nodeType: "KJNode", evidence: "custom_nodes/ComfyUI-KJNodes", sourcePackage: "ComfyUI-KJNodes", criticalPath: "yes" },
      { nodeType: "Unknown", evidence: "no matching local directory evidence", sourcePackage: "unknown", criticalPath: "no" }
    ]);
    expect(profile.nodes[0]).toEqual({
      nodeType: "KJNode",
      packages: ["ComfyUI-KJNodes"],
      sourcePackage: "ComfyUI-KJNodes",
      criticalPath: true
    });
    expect(profile.nodes[1].packages).toEqual([]);
    expect(profile.nodes[1].sourcePackage).toBeUndefined();
  });

  it("unionPackages dedupes preserving first-seen order", () => {
    expect(unionPackages(["a", "b"], ["b", "c"], ["a"])).toEqual(["a", "b", "c"]);
  });
});

describe("resolveProfilePackages fallback chain", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "profile-artifacts-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("prefers the deploy ledger and always unions enum + ALWAYS_INCLUDE", async () => {
    await fsp.writeFile(
      path.join(dir, CATALOG_DEPLOY_LEDGER_FILE),
      JSON.stringify({ nodes: [{ nodeType: "A", packageName: "ComfyUI-KJNodes" }] })
    );
    await fsp.writeFile(
      path.join(dir, "00-enum-dependencies.csv"),
      "node_id,node_type,widget_slot,value,source_has,target_core_has,resolving_package,state\n3,K,sampler_name,res_2s,true,false,RES4LYF,source known\n"
    );
    const res = await resolveProfilePackages(dir);
    expect(res.origin).toBe("ledger");
    expect(res.degraded).toBe(false);
    expect(res.packages).toContain("ComfyUI-KJNodes");
    expect(res.packages).toContain("RES4LYF");
    expect(res.packages).toContain(ALWAYS_INCLUDE_PACKAGES[0]);
  });

  it("falls back to the intake profile artifact before any ledger exists", async () => {
    await fsp.writeFile(
      path.join(dir, PROFILE_ARTIFACT_FILE),
      JSON.stringify({ nodes: [{ nodeType: "A", packages: ["rgthree-comfy"], sourcePackage: "rgthree-comfy" }] })
    );
    const res = await resolveProfilePackages(dir);
    expect(res.origin).toBe("intake");
    expect(res.degraded).toBe(false);
    expect(res.packages).toContain("rgthree-comfy");
    expect(res.packages).toContain(ALWAYS_INCLUDE_PACKAGES[0]);
  });

  it("is degraded (full-tree fallback) when no ledger and no intake artifact exist", async () => {
    const res = await resolveProfilePackages(dir);
    expect(res.origin).toBe("none");
    expect(res.degraded).toBe(true);
    expect(res.packages).toEqual([]);
  });
});

describe("buildProfileDir", () => {
  let root: string;
  let node: GpuNode;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "profile-build-"));
    // simulate: NFS custom_nodes source tree + a comfyui_root-only package
    await fsp.mkdir(path.join(root, "nfs", "custom_nodes", "ComfyUI-KJNodes"), { recursive: true });
    await fsp.mkdir(path.join(root, "nfs", "custom_nodes", "ComfyUI-OmniXPU"), { recursive: true });
    await fsp.mkdir(path.join(root, "comfyui", "custom_nodes", "LocalOnlyNode"), { recursive: true });
    await fsp.writeFile(path.join(root, "comfyui", "custom_nodes", "LocalOnlyNode", "x.py"), "print(1)");
    node = {
      name: "t",
      kind: "local",
      runtime: "docker",
      docker_image: "img",
      comfyui_root: path.join(root, "comfyui"),
      venv_python: "/v/bin/python3",
      nfs_share_root: path.join(root, "nfs"),
      model_roots: [path.join(root, "nfs")],
      api_host: "127.0.0.1",
      api_port: 8188
    } as GpuNode;
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("symlinks NFS packages, copies comfyui_root-only packages, and reports missing", async () => {
    const missing: string[] = [];
    const profileDir = await buildProfileDir({
      node,
      taskId: "task-1",
      packages: ["ComfyUI-KJNodes", "LocalOnlyNode", "DoesNotExist"],
      log: (m) => missing.push(m)
    });
    expect(profileDir).toBe(path.join(root, "nfs", "profiles", "task-1", "custom_nodes"));

    // NFS package → symlink pointing at the NFS source (stable in-container path)
    const kjStat = await fsp.lstat(path.join(profileDir!, "ComfyUI-KJNodes"));
    expect(kjStat.isSymbolicLink()).toBe(true);
    expect(await fsp.readlink(path.join(profileDir!, "ComfyUI-KJNodes"))).toBe(
      path.join(root, "nfs", "custom_nodes", "ComfyUI-KJNodes")
    );

    // comfyui_root-only package → copied (not a symlink) so it resolves in-container
    const localStat = await fsp.lstat(path.join(profileDir!, "LocalOnlyNode"));
    expect(localStat.isSymbolicLink()).toBe(false);
    expect(localStat.isDirectory()).toBe(true);
    expect(await fsp.readFile(path.join(profileDir!, "LocalOnlyNode", "x.py"), "utf8")).toBe("print(1)");

    // missing package is logged
    expect(missing.join(" ")).toContain("DoesNotExist");
  });

  it("collapses case-duplicate packages (only the first wins)", async () => {
    // add a CamelCase dup of an existing lowercase-ish entry
    await fsp.mkdir(path.join(root, "nfs", "custom_nodes", "comfyui-kjnodes"), { recursive: true });
    const profileDir = await buildProfileDir({
      node,
      taskId: "task-2",
      packages: ["ComfyUI-KJNodes", "comfyui-kjnodes"]
    });
    const entries = await fsp.readdir(profileDir!);
    const kjLike = entries.filter((e) => e.toLowerCase() === "comfyui-kjnodes");
    expect(kjLike).toHaveLength(1);
  });

  it("is idempotent across two builds (forceRelaunch rebuilds identically)", async () => {
    const first = await buildProfileDir({ node, taskId: "task-3", packages: ["ComfyUI-KJNodes"] });
    const firstEntries = await fsp.readdir(first!);
    const second = await buildProfileDir({ node, taskId: "task-3", packages: ["ComfyUI-KJNodes"] });
    expect(second).toBe(first);
    expect((await fsp.readdir(second!)).sort()).toEqual(firstEntries.sort());
  });
});
