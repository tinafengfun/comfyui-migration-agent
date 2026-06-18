import fs from "node:fs";
import path from "node:path";

/**
 * Minimal fallback set of core node types.
 * Used only if the ComfyUI source cannot be parsed at startup.
 */
const FALLBACK_CORE_TYPES = new Set<string>([
  "KSampler", "KSamplerAdvanced", "CheckpointLoaderSimple", "CheckpointLoader",
  "CLIPTextEncode", "CLIPSetLastLayer", "CLIPLoader", "DualCLIPLoader",
  "VAEDecode", "VAEEncode", "VAELoader", "VAEDecodeTiled", "VAEEncodeTiled",
  "EmptyLatentImage", "EmptyImage", "LoadImage", "LoadImageMask", "SaveImage",
  "PreviewImage", "UNETLoader", "LoraLoader", "LoraLoaderModelOnly",
  "ImageScale", "ImageScaleBy", "ImageScaleToTotalPixels", "ImageInvert",
  "ImageBatch", "LatentUpscale", "LatentComposite", "LatentBlend",
  "ControlNetApply", "ControlNetApplyAdvanced", "ControlNetLoader",
  "ConditioningCombine", "ConditioningConcat", "ConditioningSetMask",
  "Note", "Reroute",
]);

let cachedTypes: Set<string> | undefined;

/**
 * Parse ComfyUI source files (nodes.py + comfy_extras/*.py) to build the
 * complete set of built-in node type names.
 *
 * ComfyUI uses two registration patterns:
 * 1. Legacy: `NODE_CLASS_MAPPINGS = {"NodeName": NodeClass, ...}`
 * 2. Modern: `node_id = "NodeName"` inside class definitions (IO.ComfyNode / io.ComfyNode)
 *
 * This parser captures both patterns to produce the complete set.
 *
 * The result is cached for the process lifetime (safe because the
 * ComfyUI checkout doesn't change during a single server run).
 */
export function loadBuiltinNodeTypes(comfyuiRoot: string): Set<string> {
  if (cachedTypes) return cachedTypes;

  const types = new Set<string>(FALLBACK_CORE_TYPES);

  // Parse nodes.py (at ComfyUI root)
  const nodesPy = path.join(comfyuiRoot, "nodes.py");
  extractNodeMappings(nodesPy, types);

  // Parse comfy_extras/*.py
  const extrasDir = path.join(comfyuiRoot, "comfy_extras");
  try {
    const entries = fs.readdirSync(extrasDir);
    for (const file of entries) {
      if (!file.endsWith(".py")) continue;
      extractNodeMappings(path.join(extrasDir, file), types);
    }
  } catch {
    // comfy_extras not found — fallback list is still usable
  }

  cachedTypes = types;
  return types;
}

/**
 * Extract node type names from a Python file.
 * Handles both legacy NODE_CLASS_MAPPINGS dicts and modern node_id attributes.
 */
function extractNodeMappings(filePath: string, types: Set<string>): void {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  // Pattern 1: Legacy NODE_CLASS_MAPPINGS dict entries: "NodeName": ClassName
  const idx = text.indexOf("NODE_CLASS_MAPPINGS");
  if (idx >= 0) {
    const body = text.slice(idx);
    for (const match of body.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']\s*:/g)) {
      types.add(match[1]);
    }
  }

  // Pattern 2: Modern node registration: node_id="NodeName"
  for (const match of text.matchAll(/node_id\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) {
    types.add(match[1]);
  }
}

/**
 * Reset the cache. Only for testing.
 */
export function resetBuiltinNodeCache(): void {
  cachedTypes = undefined;
}
