/**
 * generate-gui-workflow.mts — Convert source workflow + runtime-policy changes into
 * a GUI-importable workflow JSON.
 *
 * Usage:
 *   npx tsx scripts/generate-gui-workflow.mts \
 *     --source <workflow.json> \
 *     --changes <06b-runtime-policy-changes.json> \
 *     --output <runtime-policy-gui-workflow.json>
 *
 * Algorithm:
 *   1. Read source workflow JSON and runtime-policy changes JSON.
 *   2. Deep-copy the source workflow (source never modified).
 *   3. For each change entry (by node_id):
 *      a. Look up the node's class_type in ComfyUI /object_info to get the
 *         registered widget order.
 *      b. Map the input_name to its index in the widget registration order.
 *      c. If the node has a widgets_values array, apply the new_value at that
 *         index. If widgets_values doesn't exist, create it.
 *   4. If the change affects "mode", apply directly (mode is a scalar, not in
 *      widgets_values).
 *   5. Write the resulting GUI workflow to --output.
 *
 * Notes:
 *   - Widget_values index mapping is automated via /object_info, so no
 *     hand-coded index-to-field-name tables are needed.
 *   - Only widget-values changes (device/schema/output-prefix) are supported.
 *     Structural changes (node adds/removes/rewires) must go through different
 *     tools.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(__dirname, "..");

// ── CLI argument helpers ──────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usageAndExit(msg?: string): void {
  if (msg) console.error(msg);
  console.error(
    `Usage: npx tsx scripts/generate-gui-workflow.mts --source <workflow.json> --changes <changes.json> --output <out.json> [--object-info <object_info.json>]`
  );
  process.exit(2);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single runtime-policy change entry from 06b-runtime-policy-changes.json */
interface RuntimePolicyChange {
  node_id: string;
  class_type: string;
  input_name: string;
  old_value: unknown;
  new_value: unknown;
  reason?: string;
}

/** ComfyUI /object_info entry for a single node class */
interface ObjectInfoEntry {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: unknown[];
  output_node?: boolean;
  name?: string;
  category?: string;
  description?: string;
}

/** ComfyUI /object_info root: map of class_type -> ObjectInfoEntry */
type ObjectInfo = Record<string, ObjectInfoEntry>;

/** A single node in the GUI workflow JSON */
interface WorkflowNode {
  id: number;
  type: string;
  mode?: number;
  widgets_values?: unknown[];
  properties?: Record<string, unknown>;
  inputs?: Record<string, unknown> | Array<{ name: string; type: string; link?: number }>;
  outputs?: Array<{ name: string; type: string; links?: number[] }>;
  title?: string;
  [key: string]: unknown;
}

/** The GUI workflow JSON structure */
interface WorkflowJson {
  nodes?: WorkflowNode[];
  links?: unknown[];
  last_node_id?: number;
  last_link_id?: number;
  groups?: unknown[];
  config?: Record<string, unknown>;
  version?: unknown;
  [key: string]: unknown;
}

// ── Object info widget-order resolver ─────────────────────────────────────────

/**
 * Base ComfyUI types that always serialize as a widget value (not a socket
 * connector) unless explicitly forced to be a link input via
 * `{"forceInput": true}` in the input's options dict.
 */
const WIDGET_PRIMITIVE_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

/**
 * Determine whether a single /object_info input spec (`[type, options?]`)
 * serializes into `widgets_values`.
 *
 * ComfyUI only puts INT/FLOAT/STRING/BOOLEAN and COMBO (a literal list of
 * choices, e.g. `[["auto", "disabled"]]`) into `widgets_values` by default.
 * Named socket types (MODEL, CLIP, VAE, CONDITIONING, LATENT, IMAGE, MASK,
 * and any custom node type name) are link-only and never appear in
 * `widgets_values`, even though they share the same `required`/`optional`
 * key ordering in `/object_info`. `forceInput: true` demotes an otherwise
 * widget-eligible primitive to a link-only socket as well.
 */
function isWidgetInputSpec(spec: unknown): boolean {
  if (!Array.isArray(spec) || spec.length === 0) return false;
  const [type, options] = spec as [unknown, Record<string, unknown> | undefined];
  if (options && typeof options === "object" && (options as Record<string, unknown>).forceInput) {
    return false;
  }
  if (Array.isArray(type)) return true; // COMBO: literal choice list
  return typeof type === "string" && WIDGET_PRIMITIVE_TYPES.has(type);
}

/**
 * Extract the ordered list of widget (input) names from an /object_info entry.
 *
 * ComfyUI registers widgets as the required inputs + optional inputs for a node
 * class, but only the subset that are widget-eligible types (see
 * `isWidgetInputSpec`) actually appear in `widgets_values` — link/socket
 * inputs (MODEL, CLIP, CONDITIONING, LATENT, IMAGE, ...) are skipped even
 * though they share the same key ordering in `/object_info`. This function
 * reconstructs the `widgets_values` order by filtering to widget-eligible
 * inputs only, in required-then-optional registration order.
 *
 * Returns an array of input names in widget registration order.
 */
function getWidgetOrderFromObjectInfo(classType: string, info?: ObjectInfoEntry): string[] {
  if (!info) return [];

  const order: string[] = [];
  const input = info.input;
  if (!input) return [];

  // Required inputs are registered first, in object key order
  if (input.required) {
    for (const [name, spec] of Object.entries(input.required)) {
      if (isWidgetInputSpec(spec)) order.push(name);
    }
  }

  // Optional inputs come after required, in object key order
  if (input.optional) {
    for (const [name, spec] of Object.entries(input.optional)) {
      if (isWidgetInputSpec(spec)) order.push(name);
    }
  }

  return order;
}

/**
 * Map an input_name to its index in the widget registration order.
 *
 * Returns -1 if the input_name is not found in the widget registration order
 * (meaning it's not a widget — it may be an input/slot instead, which should
 * be handled differently).
 */
function findWidgetIndex(
  inputName: string,
  classType: string,
  objectInfo?: ObjectInfo
): number {
  const info = objectInfo?.[classType];
  const order = getWidgetOrderFromObjectInfo(classType, info);
  return order.indexOf(inputName);
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Apply runtime-policy changes to a deep-copied GUI workflow.
 *
 * Returns the modified deep copy (source is never touched).
 */
function applyChanges(
  workflow: WorkflowJson,
  changes: RuntimePolicyChange[],
  objectInfo?: ObjectInfo
): { workflow: WorkflowJson; applied: number; skipped: unknown[] } {
  // Deep copy
  const wf: WorkflowJson = JSON.parse(JSON.stringify(workflow));

  const nodes: WorkflowNode[] = wf.nodes ?? [];
  const skipped: unknown[] = [];
  let applied = 0;

  for (const change of changes) {
    const nodeId = Number(change.node_id);
    const node = nodes.find((n) => n.id === nodeId);

    if (!node) {
      skipped.push({
        change,
        reason: `node ${change.node_id} not found in workflow`,
      });
      continue;
    }

    // ── Handle "mode" changes directly ──
    if (change.input_name === "mode") {
      node.mode = Number(change.new_value);
      applied++;
      continue;
    }

    // ── Determine widget index for this input_name ──
    const idx = findWidgetIndex(change.input_name, change.class_type, objectInfo);

    if (idx < 0) {
      // Input not found in widget order; try direct field on node (e.g., some
      // custom nodes store values as top-level node properties).
      // If the node has a property matching input_name, set it directly.
      if (node[change.input_name] !== undefined) {
        node[change.input_name] = change.new_value;
        applied++;
        continue;
      }

      // Try inputs object if set directly (API-prompt style: { "samples": [...], "model": [...] })
      const inputsProp = node.inputs;
      if (inputsProp && typeof inputsProp === "object" && !Array.isArray(inputsProp)) {
        // Node might have an inputs object (CombinedInputs style) — cast safely
        const dict = inputsProp as Record<string, unknown>;
        if (dict[change.input_name] !== undefined) {
          dict[change.input_name] = change.new_value;
          applied++;
          continue;
        }
      }

      skipped.push({
        change,
        reason: `input "${change.input_name}" not found in widget order for class "${change.class_type}" and no direct property match`,
        objectInfoOrder: objectInfo ? getWidgetOrderFromObjectInfo(change.class_type, objectInfo[change.class_type]) : undefined,
      });
      continue;
    }

    // ── Apply widget_values change at the computed index ──
    const wv = node.widgets_values ?? [];
    // Expand array if needed (padded with nulls)
    while (wv.length <= idx) wv.push(null);
    node.widgets_values = wv;

    const prev = wv[idx];
    wv[idx] = change.new_value;

    // Also record in a notes-like metadata field for traceability
    const title = node.title || node.type || String(node.id);

    applied++;
  }

  return { workflow: wf, applied, skipped };
}

// ── Node/link counting helpers ────────────────────────────────────────────────

function countNodes(wf: WorkflowJson): number {
  return wf.nodes?.length ?? 0;
}

function countLinks(wf: WorkflowJson): number {
  return wf.links?.length ?? 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sourcePath = argValue("--source");
  const changesPath = argValue("--changes");
  const outputPath = argValue("--output");
  const objectInfoPath = argValue("--object-info");

  if (!sourcePath) usageAndExit("Missing required --source <path>");
  if (!changesPath) usageAndExit("Missing required --changes <path>");
  if (!outputPath) usageAndExit("Missing required --output <path>");

  const sourceAbs = path.resolve(sourcePath);
  const changesAbs = path.resolve(changesPath);
  const outputAbs = path.resolve(outputPath);

  if (!fs.existsSync(sourceAbs)) usageAndExit(`Source workflow not found: ${sourceAbs}`);
  if (!fs.existsSync(changesAbs)) usageAndExit(`Changes file not found: ${changesAbs}`);

  // ── Load inputs ──
  const workflow: WorkflowJson = JSON.parse(fs.readFileSync(sourceAbs, "utf8"));
  const changes: RuntimePolicyChange[] = JSON.parse(fs.readFileSync(changesAbs, "utf8"));

  // ── Load /object_info if available ──
  let objectInfo: ObjectInfo | undefined;
  if (objectInfoPath) {
    const oiAbs = path.resolve(objectInfoPath);
    if (fs.existsSync(oiAbs)) {
      objectInfo = JSON.parse(fs.readFileSync(oiAbs, "utf8")) as ObjectInfo;
    } else {
      console.error(`Warning: --object-info path not found: ${oiAbs}; will attempt changes without widget order mapping`);
    }
  } else {
    // Try to find object_info from common relative paths
    const candidatePaths = [
      path.resolve(AGENT_ROOT, "data", "object-info.json"),
    ];
    for (const cp of candidatePaths) {
      if (fs.existsSync(cp)) {
        objectInfo = JSON.parse(fs.readFileSync(cp, "utf8")) as ObjectInfo;
        break;
      }
    }
  }

  const beforeNodes = countNodes(workflow);
  const beforeLinks = countLinks(workflow);

  // ── Apply changes ──
  const result = applyChanges(workflow, changes, objectInfo);

  // ── Write output ──
  const outputDir = path.dirname(outputAbs);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputAbs, JSON.stringify(result.workflow, null, 2), "utf8");

  // ── Report ──
  const afterNodes = countNodes(result.workflow);
  const afterLinks = countLinks(result.workflow);

  console.log(`Generated GUI workflow -> ${outputAbs}`);
  console.log(`Changes: ${result.applied} applied, ${result.skipped.length} skipped`);
  console.log(`Nodes: ${beforeNodes} -> ${afterNodes} (preserved: ${beforeNodes === afterNodes})`);
  console.log(`Links: ${beforeLinks} -> ${afterLinks} (preserved: ${beforeLinks === afterLinks})`);

  if (result.skipped.length > 0) {
    console.log("Skipped changes:");
    for (const s of result.skipped) {
      const entry = s as { change?: RuntimePolicyChange; reason?: string; objectInfoOrder?: string[] };
      const c = entry.change;
      console.log(`  - Node ${c?.node_id} ${c?.class_type}: ${c?.input_name} = ${JSON.stringify(c?.new_value)} — ${entry.reason}`);
      if (entry.objectInfoOrder) {
        console.log(`    (widget order: [${entry.objectInfoOrder.join(", ")}])`);
      }
    }
  }

  // Exit with error if any changes were skipped (user should know)
  if (result.skipped.length > 0) {
    console.error(`ERROR: ${result.skipped.length} change(s) could not be applied`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
