import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";

interface WorkflowNode {
  id?: number | string;
  type?: string;
  properties?: Record<string, unknown>;
  widgets_values?: unknown[];
  inputs?: Array<{ link?: number | null }>;
  outputs?: Array<{ links?: Array<number | null> | null }>;
}

interface WorkflowGraph {
  nodes?: WorkflowNode[];
}

const modelPattern = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;

export interface AssetPrepResult {
  assetsPath: string;
  customNodesPath: string;
  modelCount: number;
  customNodeCount: number;
  gapCount: number;
}

export async function ensureAssetPrep(input: {
  task: MigrationTask;
  modelRoots: string[];
  comfyuiRoot: string;
  stepId?: string;
}): Promise<AssetPrepResult> {
  const stepId = input.stepId ?? "01";
  const workflow = JSON.parse(await fs.readFile(input.task.workflowPath, "utf8")) as WorkflowGraph;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const modelRoots = uniquePaths([...input.modelRoots, path.join(input.comfyuiRoot, "models")]);
  const models = extractModels(nodes);
  const modelIndex = await indexModels(modelRoots);
  const customRows = await customNodeRows(nodes, path.join(input.comfyuiRoot, "custom_nodes"));
  const assetRows = models.map((model) => {
    const exact = exactModelMatches(model.name, modelIndex);
    const aliases = findAliases(model.name, modelIndex);
    const state = exact.length ? "staged" : aliases.length ? "alias staged" : "source unknown";
    const bestMatch = exact[0] ?? aliases[0] ?? "";
    return {
      asset_name: model.name,
      requested_name: model.name,
      resolved_path: bestMatch,
      source: exact[0] ? "local model root exact match" : aliases.length ? aliases.slice(0, 3).join("; ") : "not found",
      state,
      staged_path: exact[0] ?? "",
      custom_node_repo: "",
      custom_node_cache_path: "",
      wrapper_source_evidence: model.node,
      commit: "",
      install_status: exact[0] ? "present" : aliases.length ? "alias candidate" : "missing",
      acquisition_status: exact[0] ? "complete" : aliases.length ? "alias matched, pending source verification" : "unresolved",
      mirror_used: "none",
      credential_recorded: "false",
      gap: exact[0] ? "" : aliases.length ? "alias available, not source-identical" : "source-identical asset not staged"
    };
  });
  const assetsPath = path.join(input.task.artifactPath, `${stepId}-assets.csv`);
  const customNodesPath = path.join(input.task.artifactPath, `${stepId}-custom-nodes.md`);
  await fs.writeFile(assetsPath, csv(assetRows), "utf8");
  await fs.writeFile(
    customNodesPath,
    customNodesMarkdown(input.task, input.comfyuiRoot, customRows, stepId),
    "utf8"
  );
  const gapCount =
    assetRows.filter((row) => row.gap && !row.gap.includes("alias available")).length + customRows.filter((row) => row.state !== "source known").length;
  return {
    assetsPath,
    customNodesPath,
    modelCount: models.length,
    customNodeCount: customRows.length,
    gapCount
  };
}

function extractModels(nodes: WorkflowNode[]): Array<{ name: string; node: string }> {
  const rows = new Map<string, { name: string; node: string }>();
  for (const node of nodes) {
    for (const value of node.widgets_values ?? []) {
      if (typeof value !== "string" || !modelPattern.test(value)) continue;
      rows.set(`${value}\0${node.id}`, { name: value, node: `${node.id ?? "?"}:${node.type ?? "(unknown)"}` });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function exactModelMatches(request: string, index: Map<string, string[]>): string[] {
  const matches: string[] = [];
  for (const key of modelLookupKeys(request)) {
    matches.push(...(index.get(key) ?? []));
  }
  return [...new Set(matches)];
}

function modelLookupKeys(request: string): string[] {
  const normalized = request.replaceAll("\\", "/");
  return [...new Set([request, normalized, path.posix.basename(normalized)])];
}

async function indexModels(roots: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const root of roots) {
    await walk(root, (file) => {
      if (!modelPattern.test(file)) return;
      for (const name of indexKeysForFile(root, file)) {
        const matches = result.get(name) ?? [];
        matches.push(file);
        result.set(name, matches);
      }
    });
  }
  return result;
}

function indexKeysForFile(root: string, file: string): string[] {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return [...new Set([path.basename(file), relative, relative.replaceAll("/", "\\")])];
}

async function customNodeRows(nodes: WorkflowNode[], customNodeRoot: string) {
  const rawDirs = await fs.readdir(customNodeRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const validDirNames: string[] = [];
  const brokenSymlinks: string[] = [];
  for (const entry of rawDirs) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(customNodeRoot, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        validDirNames.push(entry.name);
      }
    } catch {
      brokenSymlinks.push(entry.name);
    }
  }
  const dirHasContent = new Map<string, boolean>();
  for (const dirName of validDirNames) {
    dirHasContent.set(dirName, await dirContainsPyFiles(path.join(customNodeRoot, dirName)));
  }
  for (const broken of brokenSymlinks) {
    dirHasContent.set(broken, false);
  }
  const allDirNames = [...validDirNames, ...brokenSymlinks];
  const rows = new Map<string, { nodeType: string; packageHint: string; evidence: string; state: string }>();
  for (const node of nodes) {
    const type = node.type ?? "(unknown)";
    const hint = packageHint(node);
    if (!hint || hint === "comfy-core") continue;
    const evidence = findEvidence(hint, type, allDirNames);
    const matchedDir = evidence.length ? evidence[0] : "";
    const hasContent = matchedDir ? (dirHasContent.get(matchedDir) ?? false) : false;
    const state = matchedDir && hasContent ? "source known" : matchedDir && !hasContent ? "environment gap" : "source known";
    const evidenceStr = matchedDir
      ? hasContent
        ? `custom_nodes/${matchedDir}`
        : brokenSymlinks.includes(matchedDir)
          ? `custom_nodes/${matchedDir} (broken symlink — needs re-clone)`
          : `custom_nodes/${matchedDir} (empty or missing Python files — needs install)`
      : "package hint from workflow only";
    rows.set(`${type}\0${hint}`, {
      nodeType: type,
      packageHint: hint,
      evidence: evidenceStr,
      state
    });
  }
  return [...rows.values()].sort((a, b) => a.nodeType.localeCompare(b.nodeType));
}

async function dirContainsPyFiles(dir: string): Promise<boolean> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".py")) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hasPy = await dirContainsPyFiles(path.join(dir, entry.name));
      if (hasPy) return true;
    }
  }
  return false;
}

function customNodesMarkdown(
  task: MigrationTask,
  comfyuiRoot: string,
  rows: Array<{ nodeType: string; packageHint: string; evidence: string; state: string }>,
  stepId: string
): string {
  return [
    `# ${stepId} - Asset and custom-node resolution`,
    "",
    "orchestrator_status: complete",
    "",
    `task_id: \`${task.id}\``,
    `workflow: \`${task.workflowPath}\``,
    `artifact_folder: \`${task.artifactPath}\``,
    `comfyui_root: \`${comfyuiRoot}\``,
    "",
    "## Status",
    "",
    "Backend deterministic asset/custom-node ledgers complete. No models or custom nodes were installed, no credentials were recorded, and the source workflow was not modified.",
    "",
    "## Custom-node source table",
    "",
    "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
    "| --- | --- | --- | --- | --- |",
    ...(rows.length
      ? rows.map((row) => `| ${cell(row.nodeType)} | ${cell(row.packageHint)} | ${cell(row.evidence)} | ${row.state} | none |`)
      : ["| none detected | - | - | - | - |"]),
    "",
    "## Boundary",
    "",
    `Missing source-identical model files remain documented in \`${stepId}-assets.csv\`; alias candidates are noted but not source-identical — fidelity claims must reflect this boundary.`,
    ""
  ].join("\n");
}

function csv(rows: Array<Record<string, string>>): string {
  const headers = [
    "asset_name",
    "requested_name",
    "resolved_path",
    "source",
    "state",
    "staged_path",
    "custom_node_repo",
    "custom_node_cache_path",
    "wrapper_source_evidence",
    "commit",
    "install_status",
    "acquisition_status",
    "mirror_used",
    "credential_recorded",
    "gap"
  ];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => quote(row[header] ?? "")).join(",")), ""].join("\n");
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function findAliases(request: string, index: Map<string, string[]>): string[] {
  const normalizedRequest = normalizeModel(request);
  const requestTokens = significantTokens(normalizedRequest);
  const requestBasename = path.basename(request).replace(/\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i, "").toLowerCase();
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const [name, paths] of index) {
    if (name === request) continue;
    const normalizedName = normalizeModel(name);
    const nameTokens = significantTokens(normalizedName);
    const nameBasename = path.basename(name).replace(/\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i, "").toLowerCase();
    const sharesSpecificPrefix = hasSpecificPrefixOverlap(requestTokens, nameTokens);
    const isAlias =
      normalizedName.includes(normalizedRequest) ||
      normalizedRequest.includes(normalizedName) ||
      (sharesSpecificPrefix && sharedTokens(requestTokens, nameTokens) >= 2) ||
      basenameAliasMatch(requestBasename, nameBasename);
    if (isAlias) {
      for (const p of paths) {
        if (!seen.has(p)) {
          seen.add(p);
          aliases.push(p);
        }
      }
    }
  }
  return aliases.slice(0, 5);
}

function basenameAliasMatch(request: string, candidate: string): boolean {
  const requestParts = request.replace(/[_\-.\s]+/g, " ").split(/\s+/).filter(Boolean);
  const candidateParts = candidate.replace(/[_\-.\s]+/g, " ").split(/\s+/).filter(Boolean);
  let shared = 0;
  for (const rp of requestParts) {
    for (const cp of candidateParts) {
      if (rp === cp || (rp.length >= 3 && cp.length >= 3 && (rp.startsWith(cp) || cp.startsWith(rp)))) {
        shared++;
        break;
      }
    }
  }
  return shared >= 1 && shared >= Math.min(requestParts.length, candidateParts.length) * 0.5;
}

async function walk(dir: string, visit: (file: string) => void): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, visit);
    else visit(fullPath);
  }
}

function packageHint(node: WorkflowNode): string {
  const properties = node.properties ?? {};
  const hint = properties.cnr_id ?? properties.aux_id;
  if (typeof hint === "string" && hint) return hint;
  if (String(node.type ?? "").toLowerCase().includes("rgthree")) return "rgthree-comfy";
  return "";
}

function findEvidence(hint: string, type: string, dirs: string[]): string[] {
  const terms = [hint, type.split(":")[0], type].map(normalize).filter((term) => term.length >= 4);
  return dirs.filter((dir) => {
    const normalized = normalize(dir);
    return terms.some((term) => normalized.includes(term) || term.includes(normalized));
  });
}

function normalizeModel(value: string): string {
  return path.basename(value, path.extname(value)).toLowerCase().replace(/[_\-.]+/g, " ");
}

function significantTokens(value: string): string[] {
  const stop = new Set([
    "bf16",
    "fp16",
    "fp8",
    "e4m3fn",
    "scaled",
    "mixed",
    "safetensors",
    "lora",
    "loras",
    "model",
    "models",
    "comfyui",
    "step",
    "steps",
    "distill",
    "rank",
    "cfg"
  ]);
  return value.split(/[^a-z0-9]+/).filter((token) => (token.length >= 2 || token === "z") && !stop.has(token));
}

function sharedTokens(a: string[], b: string[]): number {
  const bTokens = new Set(b);
  return a.filter((token) => bTokens.has(token)).length;
}

function hasSpecificPrefixOverlap(a: string[], b: string[]): boolean {
  const bTokens = new Set(b);
  return a.some((token) => token.length >= 4 && bTokens.has(token)) || (a.includes("z") && b.includes("z") && a.includes("image") && b.includes("image"));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
