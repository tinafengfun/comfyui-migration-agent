/**
 * decode-workflow-node-types.mts — decode a source workflow JSON's node types
 * against a running ComfyUI instance's /object_info.
 *
 * Some workflow export formats (e.g. certain GUI exports or `.workspace.json`
 * variants) store node types as integer IDs or truncated names rather than the
 * canonical class_type strings that ComfyUI's /object_info uses. This tool
 * resolves every node's type by:
 *   1. Reading the workflow JSON (standard ComfyUI API export or integer-id format).
 *   2. Fetching /object_info from a running ComfyUI instance.
 *   3. Matching each node's `type` field against /object_info keys (direct match
 *      or via an optional `NodeTypes` integer-id mapping in the workflow).
 *   4. Emitting a CSV with node_id, type_name, class_type for all nodes.
 *
 * Usage:
 *   npx tsx scripts/decode-workflow-node-types.mts <workflow.json> [--comfyui-url http://host:8188]
 *     [--format csv|json] [--output <path>]
 *
 * If --comfyui-url is omitted, the tool tries the default GPU node's API URL
 * from gpu-nodes.json or the env's COMFYUI_PORT.
 *
 * Output (default CSV):
 *   node_id,type_name,resolved_class_type
 *   Each workflow node is one row. Unresolvable nodes get `resolved_class_type`
 *   set to "UNRESOLVED".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGpuNodes, pickNode, nodeApiUrl } from "../src/server/gpuNodes";
import { loadConfig } from "../src/server/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────────────────────

const workflowPath = process.argv[2];
const comfyuiUrl = argValue("--comfyui-url");
const format = argValue("--format") ?? "csv";
const outputPath = argValue("--output");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface WorkflowNode {
  id?: number | string;
  type?: string;
}

interface ObjectInfoEntry {
  input?: Record<string, unknown>;
  output?: unknown[];
  name?: string;
  display_name?: string;
  description?: string;
  category?: string;
  python_module?: string;
}

type ObjectInfo = Record<string, ObjectInfoEntry>;

interface DecodeRow {
  nodeId: string;
  typeName: string;
  resolvedClassType: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the ComfyUI API URL. Priority:
 *   1. Explicit --comfyui-url flag
 *   2. Default GPU node from gpu-nodes.json
 *   3. Local fallback to 127.0.0.1:COMFYUI_PORT (or 8188)
 */
function resolveComfyuiUrl(flagUrl?: string): string {
  if (flagUrl) return flagUrl.replace(/\/+$/, "");

  try {
    const config = loadConfig();
    const registry = loadGpuNodes(config);
    const node = pickNode(registry);
    return nodeApiUrl(node).replace(/\/+$/, "");
  } catch {
    // fallback: localhost
    const port = process.env.COMFYUI_PORT ?? "8188";
    return `http://127.0.0.1:${port}`;
  }
}

/**
 * Fetch /object_info from the ComfyUI API.
 */
async function fetchObjectInfo(baseUrl: string): Promise<ObjectInfo> {
  const url = `${baseUrl}/object_info`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`/object_info returned ${res.status} from ${url}`);
  }
  return (await res.json()) as ObjectInfo;
}

/**
 * Parse workflow JSON. Returns nodes array and any integer-id mapping.
 *
 * Standard API format: { nodes: [{ id, type, ... }] }
 * Some GUI exports include { NodeTypes: { 101: "KSampler", ... } }
 */
function parseWorkflow(filePath: string): { nodes: WorkflowNode[]; nodeTypesMap?: Record<string, string> } {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;

  const nodes: WorkflowNode[] = Array.isArray(data.nodes) ? data.nodes as WorkflowNode[] : [];
  const nodeTypesMap = data.NodeTypes as Record<string, string> | undefined;

  return { nodes, nodeTypesMap };
}

/**
 * Build a reverse lookup: class_type → any matching /object_info name.
 * Matches are case-sensitive exact match, then case-insensitive match.
 */
function buildTypeIndex(objectInfo: ObjectInfo): {
  byName: Map<string, string>;       // normalized name → canonical key
} {
  const byName = new Map<string, string>();
  for (const key of Object.keys(objectInfo)) {
    byName.set(key, key); // exact match (canonical)
    byName.set(key.toLowerCase(), key);
  }
  return { byName };
}

/**
 * Resolve a single node's class_type.
 * Strategy (ordered):
 *   1. If nodeTypesMap is provided and node.id exists as a key there, use it.
 *   2. If node.type is a direct key in /object_info, use it.
 *   3. If node.type is a case-insensitive key in /object_info, use the canonical form.
 *   4. Otherwise "UNRESOLVED".
 */
function resolveType(
  node: WorkflowNode,
  objectInfo: ObjectInfo,
  index: Map<string, string>,
  nodeTypesMap?: Record<string, string>,
): string {
  // Strategy 1: integer-id mapping
  if (nodeTypesMap && node.id !== undefined) {
    const mapped = nodeTypesMap[String(node.id)];
    if (mapped && objectInfo[mapped]) return mapped;
    if (mapped) {
      const ci = index.get(mapped.toLowerCase());
      if (ci) return ci;
    }
  }

  const rawType = node.type;
  if (!rawType) return "UNRESOLVED";

  // Strategy 2: direct match
  if (objectInfo[rawType]) return rawType;

  // Strategy 3: case-insensitive match
  const ci = index.get(rawType.toLowerCase());
  if (ci) return ci;

  return "UNRESOLVED";
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!workflowPath) {
    console.error("usage: decode-workflow-node-types.mts <workflow.json> [--comfyui-url http://host:8188] [--format csv|json] [--output <path>]");
    process.exit(2);
  }

  // Resolve API URL
  const baseUrl = resolveComfyuiUrl(comfyuiUrl);

  // Parse workflow
  const { nodes, nodeTypesMap } = parseWorkflow(workflowPath);
  if (nodes.length === 0) {
    console.error(`No nodes found in ${workflowPath}`);
    process.exit(1);
  }

  // Fetch object_info
  console.error(`Fetching /object_info from ${baseUrl} ...`);
  const objectInfo = await fetchObjectInfo(baseUrl);
  console.error(`  ${Object.keys(objectInfo).length} node types registered`);

  // Build lookup index
  const index = buildTypeIndex(objectInfo).byName;

  // Resolve each node
  let resolved = 0;
  const rows: DecodeRow[] = nodes.map((node) => {
    const classType = resolveType(node, objectInfo, index, nodeTypesMap);
    if (classType !== "UNRESOLVED") resolved++;
    return {
      nodeId: String(node.id ?? ""),
      typeName: node.type ?? "(empty)",
      resolvedClassType: classType,
    };
  });

  // Summary to stderr (keeps stdout clean for CSV/JSON piping)
  console.error(`  ${nodes.length} nodes, ${resolved} resolved, ${nodes.length - resolved} unresolved`);

  // Output
  const output = outputPath ? outputPath : undefined;

  if (format === "json") {
    const json = JSON.stringify(rows, null, 2) + "\n";
    if (output) fs.writeFileSync(output, json, "utf8");
    else process.stdout.write(json);
  } else {
    // CSV
    const header = "node_id,type_name,resolved_class_type";
    const csvLines = rows.map((r) =>
      `${escapeCsv(r.nodeId)},${escapeCsv(r.typeName)},${escapeCsv(r.resolvedClassType)}`
    );
    const csv = [header, ...csvLines].join("\n") + "\n";
    if (output) fs.writeFileSync(output, csv, "utf8");
    else process.stdout.write(csv);
  }

  if (output) {
    console.error(`  wrote -> ${output}`);
  }

  process.exit(nodes.length > 0 && resolved > 0 ? 0 : 1);
}

function escapeCsv(value: string): string {
  if (/[,"\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main().catch((e) => { console.error(e); process.exit(1); });
