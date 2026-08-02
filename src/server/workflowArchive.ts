import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { ensureDir, readJson, writeJson } from "./fsUtils";
import { TASK_FILES, TASK_SUBDIRS } from "./paths";
import { computeWorkflowSha256 } from "./workflowKnowledge";

interface Step12AcceptanceSummary {
  manual_result?: string;
}

export interface ArchiveResult {
  archived: boolean;
  destination?: string;
  reason?: string;
}

const ARCHIVE_MARKER_FILE = ".nfs-archive-marker.json";

/**
 * Best-effort archival of a task's accepted Step 11 delivery bundle (plus
 * the actual GUI-tested workflow, see below) to a shared NFS directory,
 * named `<original workflow name>_intel_<timestamp>`. Never throws — a
 * failure here must not affect the calling step's own completion or the
 * task's status.
 *
 * Called from TWO places in orchestrator.ts (Step 12b AND Step 13
 * completion -- see updateStepAndPersist) so a missed/delayed acceptance
 * signal at Step 12b still gets one more chance to archive by the time the
 * whole 00-13 pipeline finishes. The primary trigger sits on Step 12b (not
 * Step 12 itself) so the archived bundle includes Step 12b's own final
 * docker deployment guide, added under 11-delivery/final-delivery/.
 * Confirmed live: a task's real GUI
 * acceptance ("passed the test looks good") never made it into
 * manual_result in time due to a since-fixed resumeStep bug, and the
 * archive never fired at all -- by the time anyone noticed, the task's
 * entire workspace had already been wiped by a later task's creation
 * (prepareExclusiveNewTask deletes every other task's workspace). Two
 * trigger points narrows that window; the marker-file idempotency check
 * below is what makes calling this from two places safe (never archives
 * the same task twice, never produces two _intel_<timestamp> folders).
 */
export async function archiveAcceptedWorkflowIfNeeded(input: {
  task: MigrationTask;
  nfsArchiveRoot: string;
}): Promise<ArchiveResult> {
  const { task, nfsArchiveRoot } = input;
  try {
    const markerPath = path.join(task.artifactPath, ARCHIVE_MARKER_FILE);
    const existingMarker = await readJson<{ destination?: string } | undefined>(markerPath, undefined);
    if (existingMarker?.destination) {
      return { archived: false, reason: `already archived at ${existingMarker.destination}` };
    }

    const summaryPath = path.join(task.artifactPath, "12-gui-acceptance-summary.json");
    const summary = await readJson<Step12AcceptanceSummary>(summaryPath, {});
    if (summary.manual_result !== "accepted") {
      return { archived: false, reason: `manual_result is ${summary.manual_result ?? "unset"}, not "accepted"` };
    }

    const sourceDir = path.join(task.artifactPath, "11-delivery");
    if (!(await pathExists(sourceDir))) {
      return { archived: false, reason: `source delivery bundle not found at ${sourceDir}` };
    }

    await ensureDir(nfsArchiveRoot);
    const destination = await resolveDestination(nfsArchiveRoot, task.name);
    await fs.cp(sourceDir, destination, { recursive: true });

    // Best-effort: the delivery bundle's own workflow copy is built before
    // Step 12 runs, so it isn't guaranteed byte-identical to what a human
    // actually clicked through in the GUI. Copy that exact tested file in
    // too, at the top level, so it's unambiguous which one was accepted.
    const guiWorkflowPath = path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json");
    if (await pathExists(guiWorkflowPath)) {
      await fs.copyFile(guiWorkflowPath, path.join(destination, "workflow.json"));
    }

    await writeJson(markerPath, { destination, archivedAt: new Date().toISOString() });
    return { archived: true, destination };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { archived: false, reason: `archive failed: ${message}` };
  }
}

async function resolveDestination(nfsArchiveRoot: string, taskName: string): Promise<string> {
  const base = `${sanitizeArchiveName(taskName)}_intel_${formatTimestamp(new Date())}`;
  let candidate = path.join(nfsArchiveRoot, base);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(nfsArchiveRoot, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

/**
 * Best-effort snapshot of a task's raw evidence trail (task-state.json,
 * artifacts/, logs/, package/manifest.json -- deliberately excluding
 * cache/custom_nodes, cache/comfyui-user, and outputs/ generated media to
 * keep this cheap and bounded) to a shared NFS directory, regardless of the
 * task's final outcome. Never throws -- a failure here must not block the
 * deletion it's meant to precede.
 *
 * Unlike archiveAcceptedWorkflowIfNeeded (which only fires for an accepted
 * task and only copies the curated 11-delivery/ bundle), this covers EVERY
 * task -- accepted, rejected, hard-stopped, or never finished -- since
 * prepareExclusiveNewTask and the manual task-delete endpoints destroy a
 * task's entire workspace unconditionally on every outcome.
 */
export async function archiveTaskSnapshot(input: {
  task: MigrationTask;
  taskArchiveRoot: string;
}): Promise<ArchiveResult> {
  const { task, taskArchiveRoot } = input;
  try {
    await ensureDir(taskArchiveRoot);
    const destination = await resolveDestination(taskArchiveRoot, task.name);
    await ensureDir(destination);

    const taskStatePath = path.join(task.workspacePath, TASK_FILES.taskState);
    if (await pathExists(taskStatePath)) {
      await fs.copyFile(taskStatePath, path.join(destination, TASK_FILES.taskState));
    }

    if (await pathExists(task.artifactPath)) {
      await fs.cp(task.artifactPath, path.join(destination, TASK_SUBDIRS.artifacts), { recursive: true });
    }

    const logsDir = path.join(task.workspacePath, TASK_SUBDIRS.logs);
    if (await pathExists(logsDir)) {
      await fs.cp(logsDir, path.join(destination, TASK_SUBDIRS.logs), { recursive: true });
    }

    const packageManifestPath = path.join(task.workspacePath, TASK_SUBDIRS.package, TASK_FILES.packageManifest);
    if (await pathExists(packageManifestPath)) {
      await fs.cp(
        path.dirname(packageManifestPath),
        path.join(destination, TASK_SUBDIRS.package),
        { recursive: true }
      );
    }

    let workflowSha256: string | undefined;
    try {
      workflowSha256 = await computeWorkflowSha256(task.workflowPath);
    } catch {
      workflowSha256 = undefined;
    }

    await writeJson(path.join(destination, "manifest.json"), {
      taskId: task.id,
      workflowName: task.name,
      workflowSha256,
      finalStatus: task.status,
      archivedAt: new Date().toISOString(),
      steps: task.steps.map((step) => ({ id: step.id, status: step.status }))
    });

    return { archived: true, destination };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { archived: false, reason: `task snapshot failed: ${message}` };
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function sanitizeArchiveName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow";
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
