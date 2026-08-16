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
  /** Which base graph was pushed: the agent's GUI workflow, or the source-workflow fallback. */
  baseSource?: string;
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

    // Base GUI workflow to push. Prefer the agent-prepared runtime-policy GUI workflow;
    // but if the agent hasn't produced one yet (real incident 2026-08-16: Step 12 gate
    // fired with no 12-gui-acceptance artifact, so the sync had nothing to push and a
    // STALE sidebar workflow from a prior run stayed in place), FALL BACK to the source
    // GUI workflow (task.workflowPath) as the base. reduceGuiWorkflow below then applies
    // the Step-07/08-VALIDATED reduced changes to it, so the sidebar always gets a fresh,
    // correctly-reduced graph for THIS task -- never a stale/full-size leftover.
    let contents: string;
    let baseSource: string;
    if (relativeWorkflowPath) {
      contents = await fs.readFile(path.join(task.artifactPath, relativeWorkflowPath), "utf8");
      baseSource = `agent GUI workflow (${relativeWorkflowPath})`;
    } else if (task.workflowPath) {
      try {
        contents = await fs.readFile(task.workflowPath, "utf8");
        baseSource = "source GUI workflow (fallback; agent artifact missing)";
      } catch (e) {
        return {
          synced: false,
          reason:
            `no agent GUI workflow (12-gui-acceptance) and the source workflow ${task.workflowPath} ` +
            `could not be read: ${e instanceof Error ? e.message : String(e)}`
        };
      }
    } else {
      return {
        synced: false,
        reason:
          "12-gui-acceptance-summary.json has no usable gui_workflow_json pointer, the default " +
          `${DEFAULT_GUI_WORKFLOW_RELATIVE_PATH} is missing, and task.workflowPath is unset`
      };
    }

    // Reduced tier: the graph the operator loads MUST be the reduced one, or they
    // queue full-size and OOM/DEVICE_LOST (real incident 2026-08-11). Apply the
    // deterministic reduced-tier edits to the GUI widgets_values before pushing.
    let reducedApplied = 0;
    const reducedChanges = await loadReducedChanges(task.artifactPath);
    if (reducedChanges.length > 0) {
      // object_info is only needed to map LIST widgets_values by input name -> index
      // (e.g. BerniniConditioning.ref_max_size). Fetch it best-effort: if the server
      // is briefly unreachable, DICT widgets_values (e.g. VHS_LoadVideo.frame_load_cap)
      // still reduce by key without it -- so don't let an object_info blip skip ALL
      // reduction and silently push a full-size graph.
      let objectInfo: Record<string, any> = {};
      try {
        const objRes = await fetch(`${nodeApiUrl(node)}/object_info`, { signal: AbortSignal.timeout(15_000) });
        if (objRes.ok) objectInfo = (await objRes.json()) as Record<string, any>;
      } catch {
        // object_info unreachable -> dict-widget reductions still apply below
      }
      try {
        const workflow = JSON.parse(contents);
        reducedApplied = reduceGuiWorkflow(workflow, reducedChanges, objectInfo);
        if (reducedApplied > 0) contents = JSON.stringify(workflow);
      } catch {
        // malformed workflow JSON -> push as-is (Step 12 skill still verifies reduction)
      }
    }

    // ALWAYS write to the SINGLE canonical acceptance name. The tier is carried in the
    // file *content*, never the filename. A "-REDUCED" filename suffix (previous design)
    // was itself the trap: it wrote a twin the operator never opens and left the canonical
    // `<name>-step12-gui-acceptance.json` free for a STALE full-size workflow (from a prior
    // run, often root-owned) to squat -- the operator opened that canonical name and queued
    // full-size -> OOM/DEVICE_LOST (real incident 2026-08-12: seq=155440 vs reduced 73080).
    // writeGuiWorkflowToNodeFs rm -f's the target first so it overwrites even a root-owned
    // stale file (removal uses the workflows-dir write perm, not the file's).
    const destName = `${sanitizeName(task.name)}-step12-gui-acceptance.json`;
    const destination = `workflows/${destName}`;

    // PRIMARY: write straight into the node's workflows dir. For runtime=docker the
    // comfyui_root is bind-mounted to /comfyui, so <comfyui_root>/user/default/
    // workflows lands directly in the container's Workflows sidebar; for bare-metal
    // it IS the sidebar dir. Hardened because the HTTP userdata write is 405 on some
    // ComfyUI versions (confirmed live on 0.27.0) -- the file write + read-back byte
    // check is the reliable path and is self-verifying.
    const fsWrite = await writeGuiWorkflowToNodeFs(node, destName, contents);
    if (fsWrite.ok) {
      return { synced: true, destination: `user/default/${destination}`, reducedApplied, baseSource };
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
      if (res.ok) return { synced: true, destination, reducedApplied, baseSource };
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
  // rm -f BEFORE writing: (1) overwrites a stale/full-size file squatting the canonical
  // name even when it is root-owned (rm needs the *directory* write bit -- which the
  // orchestrator user has -- not the file's, so a plain `> file` truncate would fail
  // EACCES while `rm` + recreate succeeds); (2) also drops the legacy "-REDUCED" twin
  // from the previous naming scheme so the sidebar holds exactly ONE acceptance workflow
  // for this task, and it is the one we just wrote. Then write and echo the byte count.
  const legacyTwin = `${dir}/${destName.replace(/-step12-gui-acceptance\.json$/, "-REDUCED-step12-gui-acceptance.json")}`;
  const cmd =
    `mkdir -p '${dir}' && rm -f '${filePath}' '${legacyTwin}' && ` +
    `printf %s '${b64}' | base64 -d > '${filePath}' && wc -c < '${filePath}'`;
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
