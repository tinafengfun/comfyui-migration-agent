import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { readJson } from "./fsUtils";
import { nodeApiUrl, type GpuNode } from "./gpuNodes";

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
    const contents = await fs.readFile(localWorkflowPath, "utf8");

    const destName = `${sanitizeName(task.name)}-step12-gui-acceptance.json`;
    const destination = `workflows/${destName}`;
    const url = `${nodeApiUrl(node)}/api/userdata/${encodeURIComponent(destination)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: contents,
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      return { synced: false, reason: `userdata POST returned ${res.status} ${res.statusText}` };
    }
    return { synced: true, destination };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { synced: false, reason: `sync failed: ${message}` };
  }
}

function sanitizeName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow";
}
