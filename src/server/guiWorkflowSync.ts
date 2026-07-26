import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { readJson } from "./fsUtils";
import { nodeApiUrl, type GpuNode } from "./gpuNodes";

interface Step12AcceptanceSummary {
  gui_workflow_json?: { path?: string };
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
    const relativeWorkflowPath = summary.gui_workflow_json?.path;
    if (!relativeWorkflowPath) {
      return { synced: false, reason: "12-gui-acceptance-summary.json has no gui_workflow_json.path" };
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
