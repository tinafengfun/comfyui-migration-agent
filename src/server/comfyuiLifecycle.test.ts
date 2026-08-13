import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { GpuNode } from "./gpuNodes";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => {
    const cb = args[args.length - 1];
    execFileMock(...args)
      .then((r: any) => cb(null, r))
      .catch((e: any) => cb(e));
  }
}));

const writeFileSyncMock = vi.fn();
vi.mock("node:fs", () => ({
  default: { writeFileSync: (...args: any[]) => writeFileSyncMock(...args) },
  writeFileSync: (...args: any[]) => writeFileSyncMock(...args)
}));

function dockerNode(overrides: Partial<GpuNode> = {}): GpuNode {
  return {
    name: "local-xpu",
    kind: "local",
    runtime: "docker",
    docker_image: "intel/llm-scaler-omni:0.1.0-b7",
    comfyui_root: "/nfs_share/comfyui-core",
    venv_python: "/nfs_share/venv-container-xpu/bin/python3",
    model_roots: ["/nfs_share"],
    api_host: "127.0.0.1",
    api_port: 8188,
    ...overrides
  } as GpuNode;
}

describe("buildDockerStartScript", () => {
  it("produces the proven working pattern: --entrypoint venv_python, comfyui_root bind-mounted at /comfyui, --net=host", async () => {
    const { buildDockerStartScript } = await import("./comfyuiLifecycle");
    const script = buildDockerStartScript(dockerNode(), 8188, "127.0.0.1", "comfyui-task-1");

    expect(script).toContain("docker rm -f 'comfyui-task-1'");
    expect(script).toContain("--entrypoint '/nfs_share/venv-container-xpu/bin/python3'");
    expect(script).toContain("-v '/nfs_share/comfyui-core:/comfyui'");
    expect(script).toContain("-v '/nfs_share:/nfs_share'");
    expect(script).toContain("--net=host");
    expect(script).toContain("'intel/llm-scaler-omni:0.1.0-b7'");
    expect(script).toContain("/comfyui/main.py --port 8188 --listen 127.0.0.1");
    // Never the image's own default entrypoint/ComfyUI.
    expect(script).not.toContain("/workspace/comfyui");
  });

  it("enables the native-fp8 XPU recipe: OMNI_FP8_KEEP_ON_MOVE=1 env, dynamic VRAM on, no --cpu-vae", async () => {
    const { buildDockerStartScript } = await import("./comfyuiLifecycle");
    const script = buildDockerStartScript(dockerNode(), 8188, "127.0.0.1", "comfyui-task-1");
    // fp8-keep-on-move patch gate must be passed into the container.
    expect(script).toContain("-e OMNI_FP8_KEEP_ON_MOVE=1");
    expect(script).toContain("--reserve-vram 1");
    // Dynamic VRAM must stay enabled (offload/swap depends on it) and VAE stays on XPU.
    expect(script).not.toContain("--disable-dynamic-vram");
    expect(script).not.toContain("--cpu-vae");
    // No attention override unless the node asks for one.
    expect(script).not.toContain("OMNI_ATTN_BACKEND");
  });

  it("passes OMNI_ATTN_BACKEND only when the node sets attn_backend (ESIMD device-lost fallback)", async () => {
    const { buildDockerStartScript } = await import("./comfyuiLifecycle");
    const script = buildDockerStartScript(dockerNode({ attn_backend: "torch" }), 8188, "127.0.0.1", "c1");
    expect(script).toContain("-e OMNI_ATTN_BACKEND=torch");
  });

  it("appends escalated lossless VRAM flags from VRAM_ESCALATION_LADDER (capacity retry)", async () => {
    const { buildDockerStartScript, VRAM_ESCALATION_LADDER } = await import("./comfyuiLifecycle");
    const l0 = buildDockerStartScript(dockerNode(), 8188, "127.0.0.1", "c1", VRAM_ESCALATION_LADDER[0]);
    expect(l0).toContain("--port 8188 --listen 127.0.0.1 --reserve-vram 1");
    expect(l0).not.toContain("--lowvram");

    const l1 = buildDockerStartScript(dockerNode(), 8188, "127.0.0.1", "c1", VRAM_ESCALATION_LADDER[1]);
    expect(l1).toContain("--reserve-vram 1 --lowvram");

    const l2 = buildDockerStartScript(dockerNode(), 8188, "127.0.0.1", "c1", VRAM_ESCALATION_LADDER[2]);
    expect(l2).toContain("--reserve-vram 1 --novram");
    expect(VRAM_ESCALATION_LADDER).toHaveLength(3);
  });

  it("omits the nfs_share bind mount when the node has no shared NFS tree", async () => {
    const { buildDockerStartScript } = await import("./comfyuiLifecycle");
    const script = buildDockerStartScript(
      { ...dockerNode(), runtime: undefined, nfs_share_root: undefined } as GpuNode,
      8188,
      "127.0.0.1",
      "comfyui-x"
    );
    expect(script).not.toContain("-v '/nfs_share:/nfs_share'");
  });

  it("throws instead of silently launching when docker_image or venv_python is missing", async () => {
    const { buildDockerStartScript } = await import("./comfyuiLifecycle");
    // Malformed/incomplete config at runtime -- the static type says these
    // are required, but a bad gpu-nodes.json could still omit them.
    expect(() =>
      buildDockerStartScript({ ...dockerNode(), docker_image: undefined } as unknown as GpuNode, 8188, "127.0.0.1", "x")
    ).toThrow(/no docker_image configured/);
    expect(() =>
      buildDockerStartScript({ ...dockerNode(), venv_python: "" } as unknown as GpuNode, 8188, "127.0.0.1", "x")
    ).toThrow(/no venv_python configured/);
  });
});

describe("defaultContainerName", () => {
  it("sanitizes the node name into a valid container name", async () => {
    const { defaultContainerName } = await import("./comfyuiLifecycle");
    expect(defaultContainerName(dockerNode({ name: "remote 124.12!" }))).toBe("comfyui-remote-124.12-");
  });
});

describe("ensureComfyUiUp", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns already_up without touching docker at all when /system_stats already responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { ensureComfyUiUp } = await import("./comfyuiLifecycle");

    const result = await ensureComfyUiUp({ node: dockerNode(), apiUrl: "http://127.0.0.1:8188" });

    expect(result).toMatchObject({ ok: true, action: "already_up" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("launches a fresh container via the correct script when nothing matches and the endpoint stays down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    // `docker inspect` on a container that doesn't exist yet exits non-zero
    // (rejects) -- the launch script itself "succeeds" (exit 0) but
    // /system_stats never comes up within the short test waitSec.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "inspect") return Promise.reject({ stdout: "", stderr: "no such container" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    writeFileSyncMock.mockReset();

    const { ensureComfyUiUp } = await import("./comfyuiLifecycle");
    const result = await ensureComfyUiUp({
      node: dockerNode(),
      apiUrl: "http://127.0.0.1:8188",
      container: "comfyui-task-1",
      waitSec: 5
    });

    expect(result).toMatchObject({ ok: false, action: "failed" });
    expect(result.detail).toContain("did not bring up /system_stats");
    // Confirms it used the deterministic script path, not some other mechanism.
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("start-comfyui-docker"),
      expect.stringContaining("--entrypoint '/nfs_share/venv-container-xpu/bin/python3'"),
      expect.anything()
    );
  }, 15_000);

  it("forceRelaunch + resetXpu runs xpu-smi --reset AFTER teardown and BEFORE relaunch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const seen: string[] = [];
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      seen.push(`${cmd} ${Array.isArray(args) ? args.join(" ") : ""}`);
      if (cmd === "bash" && args?.[1]?.includes("xpu-smi")) {
        return Promise.resolve({ stdout: "It may take one minute...\nSucceed to reset the GPU 0", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    writeFileSyncMock.mockReset();

    const { ensureComfyUiUp } = await import("./comfyuiLifecycle");
    const result = await ensureComfyUiUp({
      node: dockerNode(),
      apiUrl: "http://127.0.0.1:8188",
      container: "comfyui-task-1",
      waitSec: 5,
      vramFlags: ["--reserve-vram", "1", "--lowvram"],
      forceRelaunch: true,
      resetXpu: true
    });

    const rmIdx = seen.findIndex((s) => s.includes("rm -f") && s.includes("comfyui-task-1"));
    const resetIdx = seen.findIndex((s) => s.includes("xpu-smi config -d 0 --reset"));
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(rmIdx); // reset happens after the container is torn down
    expect(result.detail).toContain("xpu-smi reset GPU 0");
  }, 15_000);

  it("forceRelaunch WITHOUT resetXpu never calls xpu-smi", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const seen: string[] = [];
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      seen.push(`${cmd} ${Array.isArray(args) ? args.join(" ") : ""}`);
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    writeFileSyncMock.mockReset();

    const { ensureComfyUiUp } = await import("./comfyuiLifecycle");
    await ensureComfyUiUp({
      node: dockerNode(),
      apiUrl: "http://127.0.0.1:8188",
      container: "comfyui-task-1",
      waitSec: 5,
      vramFlags: ["--reserve-vram", "1", "--lowvram"],
      forceRelaunch: true
    });
    expect(seen.some((s) => s.includes("xpu-smi"))).toBe(false);
  }, 15_000);
});

describe("resetXpuDevice", () => {
  beforeEach(() => execFileMock.mockReset());
  it("runs `xpu-smi config -d <device> --reset` on the node and confirms success", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash" && args?.[1]?.includes("xpu-smi config -d 3 --reset")) {
        return Promise.resolve({ stdout: "Succeed to reset the GPU 3", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    const { resetXpuDevice } = await import("./comfyuiLifecycle");
    const r = await resetXpuDevice(dockerNode({ xpu_device: 3 }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("GPU 3");
  });

  it("defaults to device 0 and reports not-confirmed when the reset output is missing", async () => {
    execFileMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
    const { resetXpuDevice } = await import("./comfyuiLifecycle");
    const r = await resetXpuDevice(dockerNode());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("GPU 0");
  });
});
