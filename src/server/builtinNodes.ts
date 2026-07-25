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

// Keyed by comfyuiRoot (not a single unkeyed cache): a caller that checks a
// scratch worktree/alternate checkout -- e.g. coreNodeRecipeVerification.ts,
// which applies a candidate patch to an isolated copy before ever touching
// the live checkout -- needs its own fresh parse, not the live root's
// already-cached result. Still safe/cheap for the common single-root case:
// each distinct root is parsed once per process lifetime.
const cachedTypesByRoot = new Map<string, Set<string>>();

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
 * The result is cached per comfyuiRoot for the process lifetime (safe
 * because a given checkout's source doesn't change during a single server
 * run -- but a *different* root, like a scratch verification worktree, gets
 * its own independent parse).
 */
export function loadBuiltinNodeTypes(comfyuiRoot: string): Set<string> {
  const cached = cachedTypesByRoot.get(comfyuiRoot);
  if (cached) return cached;

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

  cachedTypesByRoot.set(comfyuiRoot, types);
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
  cachedTypesByRoot.clear();
}
