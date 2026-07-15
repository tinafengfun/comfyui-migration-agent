import { describe, expect, it, vi } from "vitest";
import {
  enumValuePresent,
  installAndVerifyEnumPackage,
  type EnumRequirement,
  type ObjectInfo
} from "./enumPackageInstall";

const REQ: EnumRequirement[] = [
  { hostNodeType: "KSampler", slot: "sampler_name", value: "res_2s" },
  { hostNodeType: "KSampler", slot: "scheduler", value: "bong_tangent" }
];

function oi(samplers: string[], schedulers: string[]): ObjectInfo {
  return {
    KSampler: {
      input: {
        required: {
          sampler_name: [samplers, {}],
          scheduler: [schedulers, {}],
          steps: ["INT", { default: 20 }]
        }
      }
    }
  };
}

const CORE = oi(["euler", "res_multistep"], ["normal", "karras"]);
const WITH_RES4LYF = oi(["euler", "res_multistep", "res_2s"], ["normal", "karras", "bong_tangent"]);

describe("enumValuePresent", () => {
  it("detects value in an enum slot", () => {
    expect(enumValuePresent(WITH_RES4LYF, REQ[0])).toBe(true);
    expect(enumValuePresent(CORE, REQ[0])).toBe(false);
  });
  it("false for unknown node / missing object_info", () => {
    expect(enumValuePresent(undefined, REQ[0])).toBe(false);
    expect(enumValuePresent({}, REQ[0])).toBe(false);
  });
});

describe("installAndVerifyEnumPackage", () => {
  it("installs then verifies the enum values appear (happy path)", async () => {
    const fetchObjectInfo = vi.fn()
      .mockResolvedValueOnce(CORE) // baseline: missing
      .mockResolvedValueOnce(WITH_RES4LYF); // after reload: present
    const runInstall = vi.fn().mockResolvedValue({ ok: true, detail: "cloned", commit: "abc123" });
    const reloadComfyui = vi.fn().mockResolvedValue({ ok: true, detail: "up" });
    const r = await installAndVerifyEnumPackage({ repo: "url/RES4LYF", requirements: REQ, fetchObjectInfo, runInstall, reloadComfyui });
    expect(r.outcome).toBe("installed_verified");
    expect(r.requirements.every((x) => x.presentBefore === false && x.presentAfter === true)).toBe(true);
    expect(r.commit).toBe("abc123");
    expect(runInstall).toHaveBeenCalledOnce();
  });

  it("is a no-op when already satisfied (idempotent)", async () => {
    const fetchObjectInfo = vi.fn().mockResolvedValue(WITH_RES4LYF);
    const runInstall = vi.fn();
    const reloadComfyui = vi.fn();
    const r = await installAndVerifyEnumPackage({ repo: "url/RES4LYF", requirements: REQ, fetchObjectInfo, runInstall, reloadComfyui });
    expect(r.outcome).toBe("already_satisfied");
    expect(runInstall).not.toHaveBeenCalled();
    expect(reloadComfyui).not.toHaveBeenCalled();
  });

  it("verify_failed when values still missing after install (no silent substitute)", async () => {
    const fetchObjectInfo = vi.fn()
      .mockResolvedValueOnce(CORE) // baseline
      .mockResolvedValueOnce(CORE); // after reload: STILL missing
    const runInstall = vi.fn().mockResolvedValue({ ok: true, detail: "cloned" });
    const reloadComfyui = vi.fn().mockResolvedValue({ ok: true, detail: "up" });
    const r = await installAndVerifyEnumPackage({ repo: "url/RES4LYF", requirements: REQ, fetchObjectInfo, runInstall, reloadComfyui });
    expect(r.outcome).toBe("verify_failed");
    expect(r.detail).toMatch(/still missing/);
    expect(r.detail).toMatch(/human gate/);
  });

  it("install_failed short-circuits (no reload/verify)", async () => {
    const fetchObjectInfo = vi.fn().mockResolvedValueOnce(CORE);
    const runInstall = vi.fn().mockResolvedValue({ ok: false, detail: "clone: repo unreachable" });
    const reloadComfyui = vi.fn();
    const r = await installAndVerifyEnumPackage({ repo: "url/RES4LYF", requirements: REQ, fetchObjectInfo, runInstall, reloadComfyui });
    expect(r.outcome).toBe("install_failed");
    expect(reloadComfyui).not.toHaveBeenCalled();
  });

  it("comfyui_unreachable when baseline object_info can't be fetched", async () => {
    const fetchObjectInfo = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await installAndVerifyEnumPackage({
      repo: "url/RES4LYF", requirements: REQ,
      fetchObjectInfo, runInstall: vi.fn(), reloadComfyui: vi.fn()
    });
    expect(r.outcome).toBe("comfyui_unreachable");
  });
});
