/**
 * profileLaunch.ts — the "Profile-scoped launch" seam.
 *
 * A Profile = the set of custom-node packages ONE workflow actually needs.
 * Instead of bind-mounting a GPU node's ENTIRE (accumulated, ~40+ node)
 * `comfyui_root/custom_nodes` into the container — which loads every node and
 * crashes on duplicate POST-route registration (bug B: WAN2.2 / remote-124-12)
 * — the orchestrator builds a per-task `custom_nodes` dir containing ONLY the
 * workflow's nodes and overlays it at `/comfyui/custom_nodes`.
 *
 * This is the exact mechanism `scripts/catalog-import/harvest-objectinfo.py`
 * (`harvest_batch`) already uses to scope a batch: an isolated dir of symlinks
 * + `-v {dir}:/comfyui/custom_nodes`. It also matches the code's own documented
 * intent (the Step-05 skill and the GpuNode comment both say "per-task
 * isolation, not the full tree").
 *
 * Resolution is deterministic (hard-layer principle): the profile package set
 * comes from the Step-05 deploy ledger when present, else the Step-00 intake
 * profile artifact (the FIRST Step-05 launch, before any ledger exists), always
 * unioned with the enum-dependency closure and an always-on infra set. If
 * neither source yields anything, resolution is `degraded` and the caller falls
 * back to the full-tree mount rather than launch an empty custom_nodes.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveNfsShareRoot, type GpuNode } from "./gpuNodes";
import { CATALOG_DEPLOY_LEDGER_FILE, type CatalogDeployLedger } from "./xpuCatalogWriteBack";

/** Machine-readable per-task Profile, written by Step-00 intake. */
export const PROFILE_ARTIFACT_FILE = "00-custom-nodes.json";
/** Step-00 enum-dependency ledger (packages required only via enum widget values). */
const ENUM_DEPS_FILE = "00-enum-dependencies.csv";

/**
 * Always included in every profile regardless of the workflow graph:
 *   - ComfyUI-OmniXPU — the compiled XPU attention backend (omni_xpu_kernel /
 *     cute+esimd). Dropping it from the scoped mount would silently break XPU
 *     attention. See gpuNodes.checkOmniXpuAcceleration / orchestrator.ts.
 */
export const ALWAYS_INCLUDE_PACKAGES: readonly string[] = ["ComfyUI-OmniXPU"];

export interface ProfileNodeEntry {
  nodeType: string;
  /** custom_nodes/<dir> directory names this node's evidence resolved to. */
  packages: string[];
  sourcePackage?: string;
  criticalPath?: boolean;
}
export interface ProfileArtifact {
  nodes: ProfileNodeEntry[];
}

export interface ProfileResolution {
  /** Union of profile packages incl. enum closure + ALWAYS_INCLUDE. Deduped. */
  packages: string[];
  /** Where the base set came from (before enum/infra union). */
  origin: "ledger" | "intake" | "none";
  /**
   * true → the profile could not be resolved from a ledger or intake artifact;
   * the caller should NOT scope the mount (fall back to the full tree) rather
   * than launch an empty custom_nodes.
   */
  degraded: boolean;
}

// ── pure parsers ────────────────────────────────────────────────────────────

/** Rows shaped like intakePreflight's CustomNodeRow (a subset we need). Pure. */
export function customNodeRowsToProfile(
  rows: ReadonlyArray<{ nodeType: string; evidence?: string; sourcePackage?: string; criticalPath?: string }>
): ProfileArtifact {
  const nodes: ProfileNodeEntry[] = rows.map((row) => ({
    nodeType: row.nodeType,
    packages: parseEvidenceDirs(row.evidence),
    sourcePackage: row.sourcePackage && row.sourcePackage !== "unknown" ? row.sourcePackage : undefined,
    criticalPath: row.criticalPath === "yes"
  }));
  return { nodes };
}

/** Extract the `custom_nodes/<dir>` directory names from an evidence cell. Pure. */
export function parseEvidenceDirs(evidence: string | undefined): string[] {
  if (!evidence) return [];
  const out: string[] = [];
  for (const part of evidence.split(/<br>|\n/)) {
    const m = /custom_nodes\/(.+)$/.exec(part.trim());
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

/** Package dir-names implied by a deploy ledger (packageName + basename(nfsPath)). Pure. */
export function parseLedgerPackages(ledger: CatalogDeployLedger | undefined): string[] {
  const set = new Set<string>();
  for (const node of ledger?.nodes ?? []) {
    if (node.packageName) set.add(node.packageName);
    if (node.nfsPath) {
      const base = path.basename(node.nfsPath.replace(/\/+$/, ""));
      if (base) set.add(base);
    }
  }
  return [...set];
}

/** Providing packages from the enum-dependency CSV (skips unresolved). Pure. */
export function parseEnumPackages(csv: string | undefined): string[] {
  if (!csv) return [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return []; // header only / empty
  const set = new Set<string>();
  for (const line of lines.slice(1)) {
    // header: node_id,node_type,widget_slot,value,source_has,target_core_has,resolving_package,state
    const cols = splitCsvLine(line);
    const pkg = (cols[6] ?? "").trim();
    if (!pkg) continue;
    if (/^unknown/i.test(pkg)) continue; // "unknown — identify from source environment"
    set.add(pkg);
  }
  return [...set];
}

function splitCsvLine(line: string): string[] {
  // Minimal CSV: fields may be double-quoted (csvCell quotes cells containing
  // commas/quotes and doubles internal quotes). Enough for this fixed schema.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Union + dedupe helper, preserving first-seen order. Pure. */
export function unionPackages(...groups: ReadonlyArray<readonly string[]>): string[] {
  const set = new Set<string>();
  for (const g of groups) for (const p of g) if (p) set.add(p);
  return [...set];
}

// ── I/O ─────────────────────────────────────────────────────────────────────

async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the profile package set for a task from its artifact dir. Fallback
 * chain: (1) deploy ledger, (2) intake profile artifact, always unioned with
 * (3) enum-dependency closure and (4) the always-on infra set.
 */
export async function resolveProfilePackages(artifactPath: string): Promise<ProfileResolution> {
  const ledger = await readJsonIfExists<CatalogDeployLedger>(path.join(artifactPath, CATALOG_DEPLOY_LEDGER_FILE));
  const ledgerPkgs = parseLedgerPackages(ledger);

  let base: string[] = ledgerPkgs;
  let origin: ProfileResolution["origin"] = ledgerPkgs.length ? "ledger" : "none";

  if (!base.length) {
    const profile = await readJsonIfExists<ProfileArtifact>(path.join(artifactPath, PROFILE_ARTIFACT_FILE));
    const intakePkgs = unionPackages(
      ...(profile?.nodes ?? []).map((n) => [...n.packages, ...(n.sourcePackage ? [n.sourcePackage] : [])])
    );
    if (intakePkgs.length) {
      base = intakePkgs;
      origin = "intake";
    }
  }

  const enumPkgs = parseEnumPackages(await readTextIfExists(path.join(artifactPath, ENUM_DEPS_FILE)));

  if (origin === "none") {
    // Nothing to scope against — signal the caller to keep the full-tree mount
    // rather than launch a container with an (almost) empty custom_nodes.
    return { packages: [], origin, degraded: true };
  }

  return {
    packages: unionPackages(base, enumPkgs, ALWAYS_INCLUDE_PACKAGES),
    origin,
    degraded: false
  };
}

// ── profile dir builder ──────────────────────────────────────────────────────

/** Case-insensitive lookup of `name` among a directory's entries. */
function findCaseInsensitive(entries: readonly string[], name: string): string | undefined {
  if (entries.includes(name)) return name;
  const lower = name.toLowerCase();
  return entries.find((e) => e.toLowerCase() === lower);
}

/**
 * Build the per-task scoped custom_nodes dir under the node's NFS root (which is
 * bind-mounted at the same absolute path inside the container, so symlink
 * targets resolve). Mirrors harvest-objectinfo.py's harvest_batch: rm+mkdir,
 * then symlink only the profile's packages.
 *
 * - NFS sources (`{nfs}/custom_nodes/<name>`) are symlinked (path stable
 *   host↔container).
 * - comfyui_root-only sources are copied (their host path maps to the container
 *   `/comfyui/custom_nodes/<name>` which THIS overlay shadows, so a symlink
 *   would dangle — copy dereferences it into the profile dir instead).
 * - Case-duplicate packages are collapsed (only the first wins) — this also
 *   neutralizes the CamelCase/lowercase double-load at the mount layer.
 *
 * Idempotent: a forceRelaunch (Step 12) rebuilds the identical dir.
 * Returns the absolute profile dir (to pass as buildDockerStartScript's
 * customNodesDir), or undefined when no NFS root is available for the node.
 */
export async function buildProfileDir(input: {
  node: GpuNode;
  taskId: string;
  packages: readonly string[];
  /** injectable for tests; defaults to real fs ops */
  log?: (msg: string) => void;
}): Promise<string | undefined> {
  const { node, taskId, packages, log } = input;
  const nfsRoot = resolveNfsShareRoot(node);
  if (!nfsRoot) return undefined; // Phase 0 is docker/NFS only

  const profileDir = path.join(nfsRoot, "profiles", taskId, "custom_nodes");
  await fsp.rm(profileDir, { recursive: true, force: true });
  await fsp.mkdir(profileDir, { recursive: true });

  const nfsNodes = path.join(nfsRoot, "custom_nodes");
  const rootNodes = path.join(node.comfyui_root, "custom_nodes");
  const nfsEntries = await fsp.readdir(nfsNodes).catch(() => [] as string[]);
  const rootEntries = await fsp.readdir(rootNodes).catch(() => [] as string[]);

  const placed = new Set<string>(); // lowercased names already in the profile
  const missing: string[] = [];
  for (const wanted of packages) {
    const lower = wanted.toLowerCase();
    if (placed.has(lower)) continue; // case-dup collapse

    const nfsName = findCaseInsensitive(nfsEntries, wanted);
    if (nfsName) {
      await fsp.symlink(path.join(nfsNodes, nfsName), path.join(profileDir, nfsName));
      placed.add(lower);
      continue;
    }
    const rootName = findCaseInsensitive(rootEntries, wanted);
    if (rootName) {
      // copy (dereference) — a symlink into comfyui_root would be shadowed in-container
      await fsp.cp(path.join(rootNodes, rootName), path.join(profileDir, rootName), {
        recursive: true,
        dereference: true
      });
      placed.add(lower);
      continue;
    }
    missing.push(wanted);
  }

  if (missing.length && log) {
    log(`profile ${taskId}: ${placed.size} packages scoped; ${missing.length} unresolved (${missing.join(", ")})`);
  }
  return profileDir;
}
