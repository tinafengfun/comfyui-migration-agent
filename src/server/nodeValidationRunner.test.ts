import { describe, expect, it, vi } from "vitest";
import { buildHarnessArgs, parseHarnessReport, runNodeValidation } from "./nodeValidationRunner";

const base = {
  pythonPath: "/venv/bin/python3",
  harnessPath: "/tools/validate_node_xpu.py",
  apiUrl: "http://127.0.0.1:8188",
  promptPath: "/ws/06-runtime-policy-prompt.json",
  comfyRoot: "/nfs_share/comfyui-core",
  nodeTypes: ["BerniniConditioning", "VHS_LoadVideo"]
};

describe("buildHarnessArgs", () => {
  it("includes api/prompt/comfy-root/report/expect + one --node-type each", () => {
    const a = buildHarnessArgs({ ...base, reportPath: "/tmp/r.json" });
    expect(a).toEqual(
      expect.arrayContaining([
        "/tools/validate_node_xpu.py",
        "--api-url", "http://127.0.0.1:8188",
        "--prompt", "/ws/06-runtime-policy-prompt.json",
        "--comfy-root", "/nfs_share/comfyui-core",
        "--report", "/tmp/r.json",
        "--expect-execution", "xpu",
        "--node-type", "BerniniConditioning",
        "--node-type", "VHS_LoadVideo"
      ])
    );
    expect(a).not.toContain("--writeback");
  });

  it("adds --writeback + threshold + expect-execution override when given", () => {
    const a = buildHarnessArgs({ ...base, writebackPath: "/ws/catalog-writeback.json", xpuUtilThreshold: 20, expectExecution: "cpu" });
    expect(a).toEqual(expect.arrayContaining(["--writeback", "/ws/catalog-writeback.json", "--xpu-util-threshold", "20", "--expect-execution", "cpu"]));
  });
});

describe("parseHarnessReport", () => {
  it("maps nodes[] to verdicts", () => {
    const v = parseHarnessReport({
      nodes: [
        { nodeType: "Foo", nodeId: "3", passed: true, historyResult: "success", xpuUtilizationPct: 80, cpuFallbackSuspected: false },
        { nodeType: "Bar", passed: false, historyResult: "cpu_fallback_suspected", xpuUtilizationPct: 2, cpuFallbackSuspected: true }
      ]
    });
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ nodeType: "Foo", nodeId: "3", passed: true, xpuUtilizationPct: 80 });
    expect(v[1]).toMatchObject({ nodeType: "Bar", passed: false, cpuFallbackSuspected: true });
  });

  it("returns [] for a report with no nodes array", () => {
    expect(parseHarnessReport({})).toEqual([]);
    expect(parseHarnessReport(null)).toEqual([]);
  });
});

describe("runNodeValidation (mocked exec)", () => {
  it("runs the harness and returns parsed verdicts", async () => {
    const execFile = vi.fn().mockResolvedValue(undefined);
    const report = { nodes: [{ nodeType: "Foo", passed: true, xpuUtilizationPct: 77 }] };
    const v = await runNodeValidation({ ...base, reportPath: "/tmp/r.json" }, { execFile, readReport: () => report });
    expect(execFile).toHaveBeenCalledOnce();
    expect(v[0]).toMatchObject({ nodeType: "Foo", passed: true });
  });

  it("still reads the report when the harness exits non-zero (a failing node is a valid verdict)", async () => {
    const execFile = vi.fn().mockRejectedValue(new Error("exit 1"));
    const report = { nodes: [{ nodeType: "Foo", passed: false, historyResult: "failed_runtime" }] };
    const v = await runNodeValidation({ ...base, reportPath: "/tmp/r.json" }, { execFile, readReport: () => report });
    expect(v[0]).toMatchObject({ passed: false, historyResult: "failed_runtime" });
  });

  it("returns [] when the report can't be read", async () => {
    const execFile = vi.fn().mockResolvedValue(undefined);
    const v = await runNodeValidation({ ...base, reportPath: "/tmp/r.json" }, {
      execFile,
      readReport: () => {
        throw new Error("no file");
      }
    });
    expect(v).toEqual([]);
  });
});
