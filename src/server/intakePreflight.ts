import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import {
  detectEnumDependencies,
  renderEnumDependencyCsv,
  type EnumDependency,
  type ObjectInfo
} from "./enumDependencies";

export interface IntakePreflightResult {
  artifactPath: string;
  canContinueToFeasibility: "yes" | "no" | "yes-with-gaps";
  hardStops: string[];
  modelRows: AssetRow[];
  customNodeRows: CustomNodeRow[];
  enumDependencies: EnumDependency[];
}

interface AssetRow {
  requestedAsset: string;
  workflowRole: string;
  expectedFolder: string;
  localStatus: string;
  sourceNote: string;
  state: string;
  humanAction: string;
}

interface CustomNodeRow {
  nodeType: string;
  criticalPath: string;
  evidence: string;
  sourcePackage: string;
  state: string;
  humanAction: string;
}

interface WorkflowNode {
  id?: number | string;
  type?: string;
  title?: string;
  mode?: number;
  inputs?: Array<{ link?: number | null }>;
  outputs?: Array<{ links?: Array<number | null> | null }>;
  properties?: Record<string, unknown>;
  widgets_values?: unknown[];
}

interface WorkflowGraph {
  nodes?: WorkflowNode[];
  links?: unknown[];
}

const modelFilePattern = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;
const mediaFilePattern = /\.(png|jpe?g|webp|gif|mp4|mov|webm|avi|mkv|wav|mp3|flac)$/i;

export async function ensureIntakePreflight(input: {
  task: MigrationTask;
  modelRoots: string[];
  comfyuiRoot: string;
  /** Source-environment object_info (truth table) for implicit-package detection. */
  sourceObjectInfo?: ObjectInfo;
  /** Maps an enum (slot,value) → the package that provides it (from recipes). */
  resolveEnumPackage?: (slot: string, value: string) => string | undefined;
}): Promise<IntakePreflightResult> {
  const workflow = JSON.parse(await fs.readFile(input.task.workflowPath, "utf8")) as WorkflowGraph;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const links = Array.isArray(workflow.links) ? workflow.links : [];
  const artifactPath = path.join(input.task.artifactPath, "00-intake-preflight.md");
  const customNodeRoot = path.join(input.comfyuiRoot, "custom_nodes");
  const modelRoots = uniquePaths([...input.modelRoots, path.join(input.comfyuiRoot, "models")]);
  const modelRequests = extractModelRequests(nodes);
  const mediaRequests = extractInputMediaRequests(nodes);
  const modelIndex = await indexExactFilenames(modelRoots, modelRequests.map((request) => request.name));
  const aliasIndex = await indexPossibleAliases(modelRoots, modelRequests.map((request) => request.name));
  const customNodeRows = await buildCustomNodeRows(nodes, customNodeRoot);
  // Implicit package dependencies: enum widget values (sampler_name, scheduler, …)
  // injected by a source-side custom package but absent from target core. These are
  // invisible to node-type scanning (the host node is often comfy-core).
  const enumDeps = detectEnumDependencies(nodes, input.sourceObjectInfo, input.resolveEnumPackage);
  const enumDepCsv = renderEnumDependencyCsv(enumDeps);
  await fs.writeFile(path.join(input.task.artifactPath, "00-enum-dependencies.csv"), enumDepCsv, "utf8");
  const modelRows = modelRequests.map((request) =>
    buildAssetRow(request, modelIndex.get(request.name) ?? [], aliasIndex.get(request.name) ?? [])
  );
  const mediaRows = mediaRequests.map((asset) => ({
    requestedAsset: asset,
    workflowRole: "input media",
    expectedFolder: "workflow input/media",
    localStatus: "not staged in task workspace",
    sourceNote: "No local source note found in workflow preflight.",
    state: "source unknown",
    humanAction: "Provide the source media or confirm it is not required for this workflow."
  }));
  const rows = [...modelRows, ...mediaRows];
  const hardStops = [
    ...rows
      .filter((row) => row.state === "source unknown" || row.state === "access blocked")
      .map((row) => `Required asset source is not proven: ${row.requestedAsset}`),
    ...customNodeRows
      .filter((row) => row.criticalPath === "yes" && row.state === "source unknown")
      .map((row) => `Critical custom-node source is not proven: ${row.nodeType}`),
    // Enum-value dependency whose providing package we cannot identify → hard stop
    // (a human must identify the source package). Ones with a known package are
    // NOT a hard stop — they're resolvable by install at Step 01/05.
    ...enumDeps
      .filter((d) => d.state === "source unknown")
      .map(
        (d) =>
          `Implicit package dependency unidentified: node ${d.nodeId} ${d.nodeType}.${d.slot}="${d.value}" is not a target-core value and no providing package is known — identify it from the source environment (do NOT substitute).`
      )
  ];
  // Enum deps with a known package are resolvable gaps (install at Step 01/05).
  const enumDepGaps = enumDeps.filter((d) => d.state === "source known").length;
  const canContinueToFeasibility =
    hardStops.length > 0
      ? "no"
      : rows.some((row) => row.state !== "staged") || enumDepGaps > 0
        ? "yes-with-gaps"
        : "yes";
  const outputNodes = nodes
    .filter((node) => isOutputNode(node.type))
    .map((node) => `${node.id ?? "?"}:${node.type ?? "(unknown)"}`);
  const noteTexts = nodes
    .filter((node) => String(node.type ?? "").toLowerCase() === "note")
    .flatMap((node) => iterWidgetValues(node.widgets_values).filter((value): value is string => typeof value === "string"));

  const content = [
    `workflow: \`${input.task.workflowPath}\``,
    `artifact_folder: \`${input.task.artifactPath}\``,
    "model_roots_checked:",
    ...modelRoots.map((root) => `- \`${root}\``),
    `model_source_notes: ${noteTexts.length ? noteTexts.map((note) => `\`${sanitizeInline(note)}\``).join("; ") : "no model source notes found in workflow"}`,
    `custom_node_roots_checked: \`${customNodeRoot}\``,
    "custom_node_source_notes: inferred from workflow node `properties.cnr_id` and local custom_nodes directory names",
    "remote_or_shared_sources_reachable: deferred to Step 01; Step 00 does not perform URL, repository, SSH, or provider-network searches",
    "credentials_handling: no credentials recorded",
    `node_count: ${nodes.length}`,
    `link_count: ${links.length}`,
    `output_nodes: ${outputNodes.length ? outputNodes.join(", ") : "none detected"}`,
    `required_models: ${modelRequests.length ? modelRequests.map((request) => request.name).join(", ") : "none detected"}`,
    `required_input_media: ${mediaRequests.length ? mediaRequests.join(", ") : "none detected"}`,
    `required_custom_nodes: ${customNodeRows.length ? customNodeRows.map((row) => row.nodeType).join(", ") : "none detected"}`,
    `implicit_package_dependencies: ${enumDeps.length ? enumDeps.map((d) => `${d.nodeType}.${d.slot}="${d.value}"→${d.resolvingPackage}`).join("; ") : "none detected"}`,
    `dependency_states: ${summarizeStates([...rows, ...customNodeRows])}`,
    `hard_stops: ${hardStops.length ? hardStops.join("; ") : "none"}`,
    `human_inputs_needed: ${humanInputs(rows, customNodeRows)}`,
    `can_continue_to_feasibility: ${canContinueToFeasibility}`,
    `next_step: 01-asset-and-custom-node-resolution`,
    "",
    "## Model and input source table",
    "",
    "| Requested asset | Workflow role | Expected folder | Local status | Source note / source path | State | Human action |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length ? rows.map(formatAssetRow) : ["| none detected | - | - | - | - | - | - |"]),
    "",
    "## Custom-node source table",
    "",
    "| Node type | Critical path? | Installed / registered evidence | Source package or repo | State | Human action |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(customNodeRows.length
      ? customNodeRows.map(formatCustomNodeRow)
      : ["| none detected | - | - | - | - | - |"]),
    "",
    "## Implicit package dependencies (enum widget values)",
    "",
    "Enum widget values (sampler_name, scheduler, …) that a source-side custom package injected into a node's dropdown. Apple-to-apple fix = install the providing package on the target (see `00-enum-dependencies.csv`); substitution is a human-approved last resort.",
    "",
    "| Node | Slot | Value | In target core? | Resolving package | State |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(enumDeps.length
      ? enumDeps.map(
          (d) =>
            `| ${d.nodeId}:${d.nodeType} | ${d.slot} | ${d.value} | ${d.targetCoreHas ? "yes" : "no"} | ${d.resolvingPackage} | ${d.state} |`
        )
      : ["| none detected | - | - | - | - | - |"]),
    "",
    "## Preflight decision",
    "",
    "| Decision item | Result |",
    "| --- | --- |",
    `| Can continue to feasibility? | ${canContinueToFeasibility} |`,
    `| Blocking model/input gaps | ${rows.filter((row) => row.state === "source unknown" || row.state === "access blocked").map((row) => row.requestedAsset).join(", ") || "none"} |`,
    `| Blocking custom-node gaps | ${customNodeRows.filter((row) => row.criticalPath === "yes" && row.state === "source unknown").map((row) => row.nodeType).join(", ") || "none"} |`,
    "| Credentials omitted from artifacts? | yes |",
    "| Next artifact | `01-assets.csv` / `01-custom-nodes.md` |",
    "",
    "## Backend single-step debug note",
    "",
    "This artifact was produced by the backend deterministic Step 00 preflight. No URL/repository/provider search, download, install, workflow mutation, or ComfyUI execution was performed. Deep source search and acquisition are Step 01 responsibilities.",
    ""
  ].join("\n");

  await fs.writeFile(artifactPath, content, "utf8");
  return { artifactPath, canContinueToFeasibility, hardStops, modelRows, customNodeRows, enumDependencies: enumDeps };
}

function extractModelRequests(nodes: WorkflowNode[]): Array<{ name: string; role: string; expectedFolder: string }> {
  const requests = new Map<string, { name: string; role: string; expectedFolder: string }>();
  for (const node of nodes) {
    const type = String(node.type ?? "");
    for (const value of iterWidgetValues(node.widgets_values)) {
      if (typeof value !== "string" || !modelFilePattern.test(value)) continue;
      // Normalize backslash separators (Windows-style paths from exported workflows)
      const normalizedName = value.replace(/\\/g, "/");
      const name = path.basename(normalizedName);
      const request = {
        name,
        role: type || "model dependency",
        expectedFolder: expectedModelFolder(type)
      };
      requests.set(`${request.name}\0${request.role}`, request);
    }
  }
  return [...requests.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractInputMediaRequests(nodes: WorkflowNode[]): string[] {
  const result = new Set<string>();
  for (const node of nodes) {
    const type = String(node.type ?? "").toLowerCase();
    if (!type.includes("load") && !type.includes("input")) continue;
    for (const value of iterWidgetValues(node.widgets_values)) {
      if (typeof value === "string" && (mediaFilePattern.test(value) || value.startsWith("http"))) {
        result.add(value);
      }
    }
  }
  return [...result].sort();
}

function expectedModelFolder(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("lora")) return "models/loras";
  if (lower.includes("clip")) return "models/text_encoders or models/clip";
  if (lower.includes("vae") && lower.includes("seedvr")) return "models/SEEDVR2";
  if (lower.includes("seedvr")) return "models/SEEDVR2";
  if (lower.includes("vae")) return "models/vae";
  if (lower.includes("unet")) return "models/diffusion_models";
  return "models";
}

function buildAssetRow(
  request: { name: string; role: string; expectedFolder: string },
  exactMatches: string[],
  aliasMatches: string[]
): AssetRow {
  if (exactMatches.length > 0) {
    return {
      requestedAsset: request.name,
      workflowRole: request.role,
      expectedFolder: request.expectedFolder,
      localStatus: "exact filename found",
      sourceNote: exactMatches.map((item) => `\`${item}\``).join("<br>"),
      state: "staged",
      humanAction: "none"
    };
  }
  if (aliasMatches.length > 0) {
    return {
      requestedAsset: request.name,
      workflowRole: request.role,
      expectedFolder: request.expectedFolder,
      localStatus: "exact filename missing",
      sourceNote: `Similar local file(s), not source-identical without approval: ${aliasMatches.map((item) => `\`${item}\``).join("<br>")}`,
      state: "smoke-only alias candidate",
      humanAction: "Provide the exact source-identical file or explicitly approve a smoke-only alias."
    };
  }
  return {
    requestedAsset: request.name,
    workflowRole: request.role,
    expectedFolder: request.expectedFolder,
    localStatus: "not found under checked model roots",
    sourceNote: "No source-identical local or source note found.",
    state: "source unknown",
    humanAction: "Provide source-identical model file/source before feasibility."
  };
}

async function buildCustomNodeRows(nodes: WorkflowNode[], customNodeRoot: string): Promise<CustomNodeRow[]> {
  const dirs = await fs.readdir(customNodeRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const dirNames = dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const custom = new Map<string, { type: string; packageHint: string; critical: boolean }>();
  for (const node of nodes) {
    const type = String(node.type ?? "(unknown)");
    const properties = isRecord(node.properties) ? node.properties : {};
    const packageHint = String(properties.cnr_id ?? properties.aux_id ?? inferPackageHint(type));
    if (!isCustomNode(type, packageHint)) continue;
    const critical = isCriticalPathNode(node);
    const key = `${type}\0${packageHint}`;
    const prior = custom.get(key);
    custom.set(key, { type, packageHint, critical: critical || prior?.critical === true });
  }
  return [...custom.values()]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((item) => {
      const evidence = findCustomNodeEvidence(item, dirNames);
      return {
        nodeType: item.type,
        criticalPath: item.critical ? "yes" : "no",
        evidence: evidence.length ? evidence.map((name) => `custom_nodes/${name}`).join("<br>") : "no matching local directory evidence",
        sourcePackage: item.packageHint || "unknown",
        state: evidence.length || item.packageHint ? "source known" : "source unknown",
        humanAction: evidence.length || item.packageHint ? "none" : "Provide the custom-node source package."
      };
    });
}

function isCustomNode(type: string, packageHint: string): boolean {
  if (packageHint === "comfy-core") return false;
  const coreTypes = new Set([
    "CLIPLoader",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "ImageScaleToTotalPixels",
    "KSampler",
    "LoraLoaderModelOnly",
    "Note",
    "PreviewImage",
    "SaveImage",
    "UNETLoader",
    "VAEDecode",
    "VAELoader"
  ]);
  return !coreTypes.has(type) || Boolean(packageHint);
}

function inferPackageHint(type: string): string {
  if (type.toLowerCase().includes("rgthree")) return "rgthree-comfy";
  return "";
}

function isCriticalPathNode(node: WorkflowNode): boolean {
  const outputLinked = (node.outputs ?? []).some((output) => (output.links ?? []).some((link) => link !== null));
  const inputLinked = (node.inputs ?? []).some((input) => input.link !== null && input.link !== undefined);
  return outputLinked || inputLinked || isOutputNode(node.type);
}

function isOutputNode(type?: string): boolean {
  return /save|preview|output|video/i.test(String(type ?? ""));
}

function findCustomNodeEvidence(
  item: { type: string; packageHint: string },
  dirNames: string[]
): string[] {
  const terms = [item.packageHint, item.type.split(":")[0], item.type]
    .map(normalize)
    .filter((term) => term.length >= 4);
  return dirNames.filter((name) => {
    const normalized = normalize(name);
    return terms.some((term) => normalized.includes(term) || term.includes(normalized));
  });
}

async function indexExactFilenames(roots: string[], names: string[]): Promise<Map<string, string[]>> {
  const wanted = new Set(names);
  const result = new Map<string, string[]>();
  await walkModelRoots(roots, (filePath) => {
    const base = path.basename(filePath);
    if (!wanted.has(base)) return;
    const matches = result.get(base) ?? [];
    matches.push(filePath);
    result.set(base, matches);
  });
  return result;
}

async function indexPossibleAliases(roots: string[], names: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const normalizedRequests = names.map((name) => ({ name, normalized: normalizeModelName(name) }));
  await walkModelRoots(roots, (filePath) => {
    if (!modelFilePattern.test(filePath)) return;
    const normalizedFile = normalizeModelName(path.basename(filePath));
    for (const request of normalizedRequests) {
      if (path.basename(filePath) === request.name) continue;
      if (!looksLikeAlias(request.normalized, normalizedFile)) continue;
      const matches = result.get(request.name) ?? [];
      matches.push(filePath);
      result.set(request.name, matches.slice(0, 5));
    }
  });
  return result;
}

async function walkModelRoots(roots: string[], visit: (filePath: string) => void): Promise<void> {
  for (const root of roots) {
    await walk(root, visit);
  }
}

async function walk(dir: string, visit: (filePath: string) => void): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch (error) {
    // Tolerate unreadable dirs: model roots are often shared (read-only NFS)
    // and may contain subdirs this user can't traverse. Skip rather than abort.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else {
      visit(fullPath);
    }
  }
}

function looksLikeAlias(request: string, file: string): boolean {
  if (request.length < 6 || file.length < 6) return false;
  return request.includes(file) || file.includes(request) || sharedTokenCount(request, file) >= 2;
}

function sharedTokenCount(a: string, b: string): number {
  const bTokens = new Set(b.split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  return a.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && bTokens.has(token)).length;
}

function normalizeModelName(name: string): string {
  return path.basename(name, path.extname(name)).toLowerCase().replace(/[_\-.]+/g, " ");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function summarizeStates(rows: Array<{ state: string }>): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return [...counts.entries()].map(([state, count]) => `${state}: ${count}`).join(", ") || "none";
}

function humanInputs(assetRows: AssetRow[], customNodeRows: CustomNodeRow[]): string {
  const inputs = [
    ...assetRows.filter((row) => row.humanAction !== "none").map((row) => `${row.requestedAsset}: ${row.humanAction}`),
    ...customNodeRows.filter((row) => row.humanAction !== "none").map((row) => `${row.nodeType}: ${row.humanAction}`)
  ];
  return inputs.length ? inputs.join("; ") : "none";
}

function formatAssetRow(row: AssetRow): string {
  return `| ${cell(row.requestedAsset)} | ${cell(row.workflowRole)} | ${cell(row.expectedFolder)} | ${cell(row.localStatus)} | ${cell(row.sourceNote)} | ${cell(row.state)} | ${cell(row.humanAction)} |`;
}

function formatCustomNodeRow(row: CustomNodeRow): string {
  return `| ${cell(row.nodeType)} | ${cell(row.criticalPath)} | ${cell(row.evidence)} | ${cell(row.sourcePackage)} | ${cell(row.state)} | ${cell(row.humanAction)} |`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function iterWidgetValues(widgetsValues: unknown): unknown[] {
  if (Array.isArray(widgetsValues)) return widgetsValues;
  if (isRecord(widgetsValues)) return Object.values(widgetsValues);
  return [];
}
