import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { readJson } from "./fsUtils";
import { nodeApiUrl, runShellOnNode, type GpuNode } from "./gpuNodes";

// Real incident this closes: the Step 12 skill's own "Output" list just names
// the field `gui_workflow_json` without pinning down its exact JSON shape or
// nesting -- a real run wrote it as `artifacts.gui_workflow_json` (a plain
// relative-path string), not the `gui_workflow_json.path` object this code
// originally only checked for. Auto-push silently fell back to manual import
// every time as a result. Same defensive-parsing philosophy used elsewhere
// for SDK-authored JSON (never assume the SDK's shape matches exactly) --
// try every plausible location/shape, then fall back to the one thing that
// IS a fixed, documented convention regardless of summary-JSON shape: the
// skill's own required evidence filename,
// `12-gui-acceptance/12-runtime-policy-gui-workflow.json`.
interface Step12AcceptanceSummary {
  gui_workflow_json?: string | { path?: string };
  artifacts?: { gui_workflow_json?: string | { path?: string } };
}

const DEFAULT_GUI_WORKFLOW_RELATIVE_PATH = "12-gui-acceptance/12-runtime-policy-gui-workflow.json";

function extractPath(value: string | { path?: string } | undefined): string | undefined {
  if (typeof value === "string") return value || undefined;
  return value?.path || undefined;
}

async function resolveGuiWorkflowRelativePath(
  summary: Step12AcceptanceSummary,
  taskArtifactPath: string
): Promise<string | undefined> {
  const candidate =
    extractPath(summary.gui_workflow_json) ?? extractPath(summary.artifacts?.gui_workflow_json);
  if (candidate) return candidate;
  const exists = await fs
    .stat(path.join(taskArtifactPath, DEFAULT_GUI_WORKFLOW_RELATIVE_PATH))
    .then((stat) => stat.isFile())
    .catch(() => false);
  return exists ? DEFAULT_GUI_WORKFLOW_RELATIVE_PATH : undefined;
}

export interface GuiWorkflowSyncResult {
  synced: boolean;
  destination?: string;
  reason?: string;
  reducedApplied?: number;
}

interface ReducedChange {
  node_id: string | number;
  input: string;
  new: unknown;
}

/**
 * Ordered names of a node type's WIDGET inputs (INT/FLOAT/STRING/BOOLEAN/combo),
 * required then optional -- this is exactly the order of a GUI node's
 * `widgets_values` array, so `indexOf(inputName)` gives the widget position.
 */
function widgetInputNames(nodeDef: any): string[] {
  const req = nodeDef?.input?.required ?? {};
  const opt = nodeDef?.input?.optional ?? {};
  const names: string[] = [];
  for (const [name, spec] of [...Object.entries(req), ...Object.entries(opt)]) {
    const t = Array.isArray(spec) ? (spec as any[])[0] : spec;
    const isWidget = Array.isArray(t) || t === "INT" || t === "FLOAT" || t === "STRING" || t === "BOOLEAN";
    if (isWidget) names.push(name);
  }
  return names;
}

/**
 * Apply the reduced-tier node edits to a GUI-format workflow's `widgets_values`
 * so the graph the operator loads is genuinely reduced (not full-size). Handles
 * both dict widgets_values (set by key, e.g. VHS_LoadVideo.frame_load_cap) and
 * list widgets_values (map input name -> widget index via object_info). Returns
 * the number of edits applied. Pure/deterministic; no live ComfyUI needed beyond
 * the object_info passed in.
 */
export function reduceGuiWorkflow(
  workflow: any,
  changes: ReducedChange[],
  objectInfo: Record<string, any>
): number {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const byId = new Map<string, any>(nodes.map((n) => [String(n.id), n]));
  let applied = 0;
  for (const change of changes) {
    const node = byId.get(String(change.node_id));
    if (!node) continue;
    const wv = node.widgets_values;
    if (wv && typeof wv === "object" && !Array.isArray(wv)) {
      if (change.input in wv) {
        wv[change.input] = change.new;
        // keep the VHS videopreview display in sync too
        if (wv.videopreview?.params && change.input in wv.videopreview.params) {
          wv.videopreview.params[change.input] = change.new;
        }
        applied += 1;
      }
    } else if (Array.isArray(wv)) {
      const order = widgetInputNames(objectInfo?.[node.type]);
      const idx = order.indexOf(change.input);
      if (idx >= 0 && idx < wv.length) {
        wv[idx] = change.new;
        applied += 1;
      }
    }
  }
  return applied;
}

async function loadReducedChanges(taskArtifactPath: string): Promise<ReducedChange[]> {
  try {
    const cfg = await readJson<any>(path.join(taskArtifactPath, "effective-run-config.json"), {});
    if (!cfg?.reduced_tier) return [];
    const changes = cfg?.recommended_reduced_setting?.changes;
    return Array.isArray(changes) ? changes : [];
  } catch {
    return [];
  }
}

/**
 * Best-effort push of Step 12's prepared GUI-acceptance workflow into the
 * running ComfyUI server's own "Workflows" sidebar, via its live userdata
 * HTTP API (`POST /api/userdata/workflows%2F<name>.json`).
 *
 * Confirmed live: this endpoint works regardless of runtime (bare-metal or
 * docker) or node kind (local or ssh) -- unlike a filesystem cp/scp, it goes
 * through the server's own process, so it always lands wherever *that*
 * server actually reads its workflow list from. Before this existed, Step 12
 * left the workflow JSON sitting only in the orchestrator host's own
 * artifact directory: a human operator opening the ComfyUI GUI (often on a
 * different machine entirely) had no way to find it short of a manual
 * drag-and-drop of a file they didn't have local access to.
 *
 * Never throws -- a failure here must not block Step 12's own human gate;
 * the operator can still fall back to manual drag-and-drop import.
 */
export async function syncGuiWorkflowToComfyUIServer(input: {
  task: MigrationTask;
  node: GpuNode;
}): Promise<GuiWorkflowSyncResult> {
  const { task, node } = input;
  try {
    const summaryPath = path.join(task.artifactPath, "12-gui-acceptance-summary.json");
    const summary = await readJson<Step12AcceptanceSummary>(summaryPath, {});
    const relativeWorkflowPath = await resolveGuiWorkflowRelativePath(summary, task.artifactPath);
    if (!relativeWorkflowPath) {
      return {
        synced: false,
        reason:
          "12-gui-acceptance-summary.json has no usable gui_workflow_json pointer, and the default " +
          `${DEFAULT_GUI_WORKFLOW_RELATIVE_PATH} is missing`
      };
    }

    const localWorkflowPath = path.join(task.artifactPath, relativeWorkflowPath);
    let contents = await fs.readFile(localWorkflowPath, "utf8");

    // Reduced tier: the graph the operator loads MUST be the reduced one, or they
    // queue full-size and OOM/DEVICE_LOST (real incident 2026-08-11). Apply the
    // deterministic reduced-tier edits to the GUI widgets_values before pushing.
    let reducedApplied = 0;
    const reducedChanges = await loadReducedChanges(task.artifactPath);
    if (reducedChanges.length > 0) {
      try {
        const objRes = await fetch(`${nodeApiUrl(node)}/object_info`, { signal: AbortSignal.timeout(15_000) });
        const objectInfo = objRes.ok ? ((await objRes.json()) as Record<string, any>) : {};
        const workflow = JSON.parse(contents);
        reducedApplied = reduceGuiWorkflow(workflow, reducedChanges, objectInfo);
        if (reducedApplied > 0) contents = JSON.stringify(workflow);
      } catch {
        // best-effort: fall back to pushing the unmodified workflow (Step 12 skill
        // still instructs verifying the reduction before acceptance)
      }
    }

    const destName = `${sanitizeName(task.name)}${reducedApplied > 0 ? "-REDUCED" : ""}-step12-gui-acceptance.json`;
    const destination = `workflows/${destName}`;

    // PRIMARY: write straight into the node's workflows dir. For runtime=docker the
    // comfyui_root is bind-mounted to /comfyui, so <comfyui_root>/user/default/
    // workflows lands directly in the container's Workflows sidebar; for bare-metal
    // it IS the sidebar dir. Hardened because the HTTP userdata write is 405 on some
    // ComfyUI versions (confirmed live on 0.27.0) -- the file write + read-back byte
    // check is the reliable path and is self-verifying.
    const fsWrite = await writeGuiWorkflowToNodeFs(node, destName, contents);
    if (fsWrite.ok) {
      return { synced: true, destination: `user/default/${destination}`, reducedApplied };
    }

    // FALLBACK: HTTP userdata POST (works on ComfyUI versions that allow it).
    let httpReason = "";
    try {
      const url = `${nodeApiUrl(node)}/api/userdata/${encodeURIComponent(destination)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: contents,
        signal: AbortSignal.timeout(15_000)
      });
      if (res.ok) return { synced: true, destination, reducedApplied };
      httpReason = `userdata POST returned ${res.status} ${res.statusText}`;
    } catch (error) {
      httpReason = `userdata POST threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { synced: false, reason: `fs write failed (${fsWrite.detail}); http fallback: ${httpReason}`, reducedApplied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { synced: false, reason: `sync failed: ${message}` };
  }
}

function sanitizeName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow";
}

/**
 * Write a GUI workflow into the node's ComfyUI workflows dir and VERIFY it landed
 * (read back the byte count). `<comfyui_root>/user/default/workflows` is the
 * ComfyUI sidebar dir (bind-mounted into the container for runtime=docker). Content
 * is base64-piped so arbitrary JSON can't break the shell. Best-effort, never throws.
 */
async function writeGuiWorkflowToNodeFs(
  node: GpuNode,
  destName: string,
  contents: string
): Promise<{ ok: boolean; detail: string }> {
  if (!node.comfyui_root) return { ok: false, detail: "node has no comfyui_root" };
  const dir = `${node.comfyui_root.replace(/\/+$/, "")}/user/default/workflows`;
  const filePath = `${dir}/${destName}`;
  const b64 = Buffer.from(contents, "utf8").toString("base64");
  const expected = Buffer.byteLength(contents, "utf8");
  // write, then echo back the on-disk byte count so we can confirm it landed.
  const cmd = `mkdir -p '${dir}' && printf %s '${b64}' | base64 -d > '${filePath}' && wc -c < '${filePath}'`;
  const out = await runShellOnNode(node, cmd, 20_000);
  const bytes = out ? Number.parseInt(out.trim(), 10) : Number.NaN;
  if (Number.isFinite(bytes) && bytes === expected) {
    return { ok: true, detail: `wrote+verified ${bytes} bytes to ${filePath}` };
  }
  return {
    ok: false,
    detail: `write/verify mismatch at ${filePath} (expected ${expected}, got ${out?.trim() ?? "no output"})`
  };
}
