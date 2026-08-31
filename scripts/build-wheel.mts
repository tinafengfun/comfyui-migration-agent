/**
 * build-wheel.mts — the Builder (V2 Phase 2). Generalizes
 * catalog-import/build-sycl-image.sh from the one hard-coded llama-cpp SYCL
 * build into a reusable "compile any Class-A package into an XPU wheel and
 * publish it to the shared wheelhouse" tool.
 *
 * Principle: the Builder BUILDS, the Worker CONSUMES. A worker never compiles a
 * Class-A package (flash-attn / xformers / sageattention / onnxruntime-xpu /
 * bitsandbytes); this script produces the prebuilt wheel they consume via
 * `pip install --no-index --find-links=/nfs_share/wheelhouse`.
 *
 * The wheel is built INSIDE the base image (which ships the oneAPI icx/icpx
 * toolchain + torch-xpu), so it links against the same XPU stack the worker runs.
 * After building, the wheelhouse manifest (index.json) is updated so
 * wheelhouse.readWheelhouseIndex / planWheelInstall can resolve it.
 *
 * Usage:
 *   npx tsx scripts/build-wheel.mts --pip-spec sageattention [--sycl]
 *     [--base intel/llm-scaler-omni:0.1.0-b7] [--nfs-root /nfs_share]
 *     [--built-for xpu-sycl] [--extra-cmake "-DGGML_SYCL=on ..."]
 *
 * --sycl adds the oneAPI SYCL CMake flags (icx/icpx). Omit for a plain XPU pip
 * wheel that just needs the image's torch/oneAPI at build time.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  WHEELHOUSE_DIR,
  readWheelhouseIndex,
  upsertWheelhouseEntry,
  writeWheelhouseIndex,
  parseWheelFilename,
  normalizePackage,
  parseRequirementName,
  classifyRequirement
} from "../src/server/wheelhouse";

const execFileAsync = promisify(execFileCb);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function sh(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function main(): Promise<void> {
  const pipSpec = arg("pip-spec");
  if (!pipSpec) {
    console.error("usage: build-wheel.mts --pip-spec <package> [--sycl] [--base IMG] [--nfs-root DIR] [--built-for TAG]");
    process.exit(2);
    return;
  }
  const base = arg("base", "intel/llm-scaler-omni:0.1.0-b7")!;
  const nfsRoot = arg("nfs-root", "/nfs_share")!;
  const wheelhouse = nfsRoot === "/nfs_share" ? WHEELHOUSE_DIR : path.join(nfsRoot, "wheelhouse");
  const useSycl = flag("sycl");
  const builtFor = arg("built-for", useSycl ? "xpu-sycl" : "xpu")!;
  const extraCmake = arg("extra-cmake", "-DGGML_SYCL=on -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx")!;

  const pkgName = parseRequirementName(pipSpec) || pipSpec;
  const cls = classifyRequirement(pkgName);
  if (cls === "image") {
    console.error(`refusing to build ${pkgName}: it is image-provided (torch family / CUDA-only). It must NOT be built or installed.`);
    process.exit(2);
    return;
  }
  console.log(`== Builder: ${pipSpec} (class ${cls === "classA" ? "A" : "B"}, ${builtFor}) from ${base} → ${wheelhouse} ==`);

  const cn = "wheel-builder";
  const oneapi = "source /opt/intel/oneapi/setvars.sh >/dev/null 2>&1 || true";
  const cmakeEnv = useSycl ? `CMAKE_ARGS="${extraCmake}"` : "";

  // render GIDs for /dev/dri
  let gidFlags: string[] = [];
  try {
    const gids = (await sh("bash", ["-c", "stat -c '%g' /dev/dri/render* 2>/dev/null | sort -u"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    gidFlags = gids.flatMap((g) => ["--group-add", g]);
  } catch {
    /* no /dev/dri — build may still succeed for pure-python-ish wheels */
  }

  await sh("docker", ["rm", "-f", cn]).catch(() => "");
  await sh("docker", [
    "run", "-d", "--name", cn, "--device", "/dev/dri", ...gidFlags,
    "-e", "ZE_AFFINITY_MASK=0",
    "-e", "HTTP_PROXY", "-e", "HTTPS_PROXY", "-e", "http_proxy", "-e", "https_proxy", "-e", "NO_PROXY", "-e", "no_proxy",
    "-v", `${nfsRoot}:${nfsRoot}`,
    "--entrypoint", "sleep", base, "infinity"
  ]);

  try {
    const outDir = `${wheelhouse}`;
    console.log(`-- pip wheel --no-deps → ${outDir} --`);
    await sh("docker", [
      "exec", cn, "bash", "-lc",
      `${oneapi}; mkdir -p '${outDir}'; ${cmakeEnv} pip wheel --no-deps -w '${outDir}' '${pipSpec}'`
    ]).then((o) => process.stdout.write(o));
  } finally {
    await sh("docker", ["rm", "-f", cn]).catch(() => "");
  }

  // Find the wheel we just built and record it in the manifest.
  const files = await fsp.readdir(wheelhouse).catch(() => [] as string[]);
  const wanted = normalizePackage(pkgName);
  const built = files
    .map((f) => ({ f, parsed: parseWheelFilename(f) }))
    .filter((x) => x.parsed && x.parsed.package === wanted);
  if (!built.length) {
    console.error(`build produced no wheel matching ${pkgName} in ${wheelhouse} (check the pip output above)`);
    process.exit(1);
    return;
  }
  // newest by name (version) — good enough for the manifest pointer
  built.sort((a, b) => a.f.localeCompare(b.f));
  const chosen = built[built.length - 1];

  let index = await readWheelhouseIndex(wheelhouse);
  index = upsertWheelhouseEntry(index, {
    package: wanted,
    file: chosen.f,
    version: chosen.parsed!.version,
    builtFor
  });
  await writeWheelhouseIndex(wheelhouse, index);
  console.log(`== published ${chosen.f} → ${wheelhouse}/index.json (${builtFor}) ==`);
  console.log(`   worker install: pip install --no-index --find-links=${wheelhouse} ${pkgName}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
