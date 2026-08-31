/**
 * wheelhouse.ts — the shared wheel cache + Node-Class taxonomy (V2 Phase 2).
 *
 * Principle: Worker CONSUMES prebuilt artifacts, Builder BUILDS them. A worker
 * never compiles a Class-A package (flash-attn / xformers / sageattention /
 * onnxruntime-xpu / bitsandbytes …): those must arrive as prebuilt wheels in the
 * shared wheelhouse (`/nfs_share/wheelhouse`, published by scripts/build-wheel.mts,
 * generalized from build-sycl-image.sh). With the worker-local venv's
 * PIP_NO_INDEX (see comfyuiLifecycle), a Class-A install with no cached wheel
 * simply cannot compile from sdist — this module turns that into an explicit,
 * deterministic "route to the Builder" hard-stop instead of an opaque pip error.
 *
 * This is also the single source of truth for the A/B/C node class (unifying the
 * three prior taxonomies: install-deps.sh SKIP_RE, migrationRoute, and the
 * parse-xlsx buckets):
 *   A = recompile   → needs a prebuilt XPU wheel (this module's CLASS_A_PATTERNS)
 *   B = pip deps    → plain pip (installable offline once cached)
 *   C = pure python → no build, no pip
 * Image-provided packages (torch family, CUDA-only) are neither built nor
 * installed — they come from the base image or are irrelevant on XPU.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

/** Shared wheel cache dir (bind-mounted at the same path in the container). */
export const WHEELHOUSE_DIR = "/nfs_share/wheelhouse";
/** Optional manifest at the wheelhouse root; falls back to scanning *.whl. */
export const WHEELHOUSE_MANIFEST_FILE = "index.json";

/**
 * Class-A: needs a prebuilt XPU/SYCL wheel from the Builder — the worker must
 * NOT try to compile these. (flash-attn, xformers, sageattention, bitsandbytes,
 * onnxruntime-gpu→onnxruntime-xpu.)
 */
export const CLASS_A_PATTERNS: readonly RegExp[] = [
  /^flash[-_]?attn/i,
  /^xformers/i,
  /^sageattention/i,
  /^bitsandbytes/i,
  /^onnxruntime[-_]?gpu/i
];

/**
 * Image-provided / CUDA-only: never built, never installed. torch family is
 * satisfied by the image's --system-site-packages stack (installing it would
 * pull a CUDA torch and shadow the XPU one — the torch-pull incident); nvidia-*,
 * cupy-cuda, triton are CUDA-only and irrelevant on XPU.
 */
export const IMAGE_PROVIDED_PATTERNS: readonly RegExp[] = [
  /^torch($|[-_=<>! [])/i,
  /^torchvision/i,
  /^torchaudio/i,
  /^torchsde/i,
  /^nvidia-/i,
  /^cupy-cuda/i,
  /^triton($|[-_=<>! ])/i
];

export type RequirementClass = "image" | "classA" | "normal";

/** The bare distribution name from a requirements line ("flash-attn==2.5 # x" → "flash-attn"). */
export function parseRequirementName(line: string): string {
  const stripped = line.split("#")[0].trim();
  const m = /^[A-Za-z0-9._-]+/.exec(stripped);
  return m ? m[0] : "";
}

/** pip-style normalization: lowercase, runs of -/_/. collapse to a single "-". */
export function normalizePackage(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Classify a requirements.txt line (or a bare package name). */
export function classifyRequirement(line: string): RequirementClass {
  const name = parseRequirementName(line) || line.trim();
  if (!name) return "normal";
  if (IMAGE_PROVIDED_PATTERNS.some((re) => re.test(name))) return "image";
  if (CLASS_A_PATTERNS.some((re) => re.test(name))) return "classA";
  return "normal";
}

/** Node class A/B/C for a package, from its (optional) requirements set. */
export function nodeClassFor(requirements: readonly string[]): "A" | "B" | "C" {
  const classes = requirements.map(classifyRequirement);
  if (classes.includes("classA")) return "A";
  if (classes.some((c) => c === "normal")) return "B";
  return "C";
}

// ── wheelhouse index ──────────────────────────────────────────────────────────

export interface WheelhouseEntry {
  /** normalized package name */
  package: string;
  /** wheel filename under the wheelhouse dir */
  file: string;
  version?: string;
  /** e.g. "xpu-sycl" — what the wheel was built for */
  builtFor?: string;
}
export interface WheelhouseIndex {
  entries: WheelhouseEntry[];
}

/** Parse the package + version out of a wheel filename ({name}-{ver}-{tags}.whl). */
export function parseWheelFilename(file: string): { package: string; version?: string } | undefined {
  if (!file.endsWith(".whl")) return undefined;
  const base = file.slice(0, -4);
  const parts = base.split("-");
  if (parts.length < 2) return undefined;
  return { package: normalizePackage(parts[0]), version: parts[1] };
}

/**
 * Read the wheelhouse index: prefer an explicit manifest (index.json), else scan
 * the directory for *.whl. Returns an empty index when the dir is absent (a
 * worker with no wheelhouse yet) — callers treat "absent" like "no wheels".
 */
export async function readWheelhouseIndex(dir: string = WHEELHOUSE_DIR): Promise<WheelhouseIndex> {
  const manifestPath = path.join(dir, WHEELHOUSE_MANIFEST_FILE);
  try {
    const raw = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { entries?: WheelhouseEntry[] };
    if (Array.isArray(raw?.entries)) {
      return { entries: raw.entries.map((e) => ({ ...e, package: normalizePackage(e.package) })) };
    }
  } catch {
    /* fall through to scan */
  }
  const files = await fsp.readdir(dir).catch(() => [] as string[]);
  const entries: WheelhouseEntry[] = [];
  for (const file of files) {
    const parsed = parseWheelFilename(file);
    if (parsed) entries.push({ package: parsed.package, file, version: parsed.version });
  }
  return { entries };
}

/** Find a prebuilt wheel for a package (normalized match). */
export function wheelForPackage(index: WheelhouseIndex, pkg: string): WheelhouseEntry | undefined {
  const wanted = normalizePackage(parseRequirementName(pkg) || pkg);
  return index.entries.find((e) => e.package === wanted);
}

/** Insert or replace an entry by normalized package name. Pure (returns a new index). */
export function upsertWheelhouseEntry(index: WheelhouseIndex, entry: WheelhouseEntry): WheelhouseIndex {
  const normalized: WheelhouseEntry = { ...entry, package: normalizePackage(entry.package) };
  const entries = index.entries.filter((e) => e.package !== normalized.package);
  entries.push(normalized);
  entries.sort((a, b) => a.package.localeCompare(b.package));
  return { entries };
}

/** Persist the manifest (index.json) at the wheelhouse root. */
export async function writeWheelhouseIndex(dir: string, index: WheelhouseIndex): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, WHEELHOUSE_MANIFEST_FILE), JSON.stringify(index, null, 2), "utf8");
}

// ── install planning + Class-A enforcement ────────────────────────────────────

export interface WheelInstallPlan {
  /** normal (Class-B) requirements to `pip install` (offline via --find-links). */
  install: string[];
  /** image-provided lines to skip (torch family / CUDA-only). */
  skipped: string[];
  /** Class-A packages WITH a cached wheel — installable offline. */
  classAResolved: string[];
  /** Class-A packages with NO cached wheel — the worker must NOT compile these. */
  classAMissing: string[];
}

/**
 * Plan an offline install of a requirements set against the wheelhouse. Pure.
 * `classAMissing` is the enforcement signal: a non-empty list means a Builder
 * must build those wheels before this node can run on a worker.
 */
export function planWheelInstall(requirements: readonly string[], index: WheelhouseIndex): WheelInstallPlan {
  const plan: WheelInstallPlan = { install: [], skipped: [], classAResolved: [], classAMissing: [] };
  for (const raw of requirements) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cls = classifyRequirement(line);
    if (cls === "image") {
      plan.skipped.push(line);
    } else if (cls === "classA") {
      const name = parseRequirementName(line);
      if (wheelForPackage(index, name)) plan.classAResolved.push(name);
      else plan.classAMissing.push(name);
    } else {
      plan.install.push(line);
    }
  }
  return plan;
}

/**
 * Scan the profile packages' requirements.txt (under a custom_nodes root) and
 * return the Class-A dependencies that have NO prebuilt wheel — i.e. the ones a
 * worker would be forced to compile. Deterministic pre-launch enforcement for
 * the worker-local-venv (offline) path. Best-effort per package (a missing
 * requirements.txt just contributes nothing).
 */
export async function missingClassAWheels(input: {
  packages: readonly string[];
  customNodesRoot: string;
  wheelhouseDir?: string;
}): Promise<string[]> {
  const index = await readWheelhouseIndex(input.wheelhouseDir ?? WHEELHOUSE_DIR);
  const missing = new Set<string>();
  for (const pkg of input.packages) {
    const reqPath = path.join(input.customNodesRoot, pkg, "requirements.txt");
    const text = await fsp.readFile(reqPath, "utf8").catch(() => "");
    if (!text) continue;
    const plan = planWheelInstall(text.split(/\r?\n/), index);
    for (const m of plan.classAMissing) missing.add(m);
  }
  return [...missing];
}

/** The hard-stop reason when a worker would otherwise be asked to compile Class-A. */
export function classAHardStopMessage(missing: readonly string[]): string {
  return (
    `Class-A dependencies have no prebuilt wheel in the wheelhouse (${missing.join(", ")}). ` +
    `A Worker never compiles Class-A packages (offline, no build toolchain). ` +
    `Route these to the Builder: run scripts/build-wheel.mts to compile an XPU wheel ` +
    `into ${WHEELHOUSE_DIR}, then re-run. This is a build-infrastructure stop, not a workflow issue.`
  );
}
