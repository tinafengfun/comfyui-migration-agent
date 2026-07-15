import { describe, expect, it, vi } from "vitest";
import { runNodePrecheck, reposToPrepare, type NodePrecheckInput } from "./nodePrecheck";
import type { ObjectInfo } from "./enumPackageInstall";

const BASELINE = [
  { dir: "rgthree-comfy", repo: "url/rgthree" },
  { dir: "RES4LYF", repo: "url/RES4LYF" }
];
const SAMPLER_PKGS = [{ repo: "url/RES4LYF", hostNodeType: "KSampler", slot: "sampler_name", value: "res_2s" }];

function oiWith(res2s: boolean): ObjectInfo {
  return { KSampler: { input: { required: { sampler_name: [res2s ? ["euler", "res_2s"] : ["euler"], {}] } } } };
}

function baseInput(over: Partial<NodePrecheckInput["probes"]> = {}, kind: "local" | "ssh" = "ssh"): NodePrecheckInput {
  return {
    nodeName: "n1", nodeKind: kind, baseline: BASELINE, samplerPackages: SAMPLER_PKGS,
    probes: {
      sshReachable: vi.fn().mockResolvedValue({ ok: true, detail: "ok" }),
      xpuAvailable: vi.fn().mockResolvedValue({ ok: true, detail: "xpu true" }),
      fetchObjectInfo: vi.fn().mockResolvedValue(oiWith(true)),
      listCustomNodes: vi.fn().mockResolvedValue(["rgthree-comfy", "RES4LYF"]),
      checkModelRoots: vi.fn().mockResolvedValue({ ok: true, detail: "reachable" }),
      ...over
    }
  };
}

describe("runNodePrecheck", () => {
  it("all-present → ok, no gaps", async () => {
    const r = await runNodePrecheck(baseInput());
    expect(r.ok).toBe(true);
    expect(r.gaps).toHaveLength(0);
  });

  it("flags a missing custom node as a fixable gap with repo", async () => {
    const r = await runNodePrecheck(baseInput({ listCustomNodes: vi.fn().mockResolvedValue(["rgthree-comfy"]) }));
    expect(r.ok).toBe(false);
    const gap = r.gaps.find((g) => g.name === "custom_node:RES4LYF");
    expect(gap?.fixable).toBe(true);
    expect(gap?.repo).toBe("url/RES4LYF");
    expect(reposToPrepare(r)).toContain("url/RES4LYF");
  });

  it("flags a missing sampler value (res_2s absent) as fixable", async () => {
    const r = await runNodePrecheck(baseInput({ fetchObjectInfo: vi.fn().mockResolvedValue(oiWith(false)) }));
    const gap = r.gaps.find((g) => g.name.startsWith("sampler_pkg:"));
    expect(gap?.status).toBe("gap");
    expect(gap?.repo).toBe("url/RES4LYF");
  });

  it("xpu unavailable → gap", async () => {
    const r = await runNodePrecheck(baseInput({ xpuAvailable: vi.fn().mockResolvedValue({ ok: false, detail: "xpu false" }) }));
    expect(r.gaps.some((g) => g.name === "torch_xpu")).toBe(true);
  });

  it("comfyui down → object_info gap, sampler checks skipped", async () => {
    const r = await runNodePrecheck(baseInput({ fetchObjectInfo: vi.fn().mockResolvedValue(undefined) }));
    expect(r.gaps.some((g) => g.name === "object_info")).toBe(true);
    expect(r.checks.some((c) => c.name.startsWith("sampler_pkg:"))).toBe(false);
  });

  it("local node skips ssh check", async () => {
    const r = await runNodePrecheck(baseInput({}, "local"));
    expect(r.checks.find((c) => c.name === "ssh_reachable")?.status).toBe("skip");
  });
});
