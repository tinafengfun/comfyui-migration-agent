import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";
import { ensureDir, readJson } from "./fsUtils";

interface Step12AcceptanceSummary {
  manual_result?: string;
}

export interface ArchiveResult {
  archived: boolean;
  destination?: string;
  reason?: string;
}

/**
 * Best-effort archival of a task's accepted Step 11 delivery bundle to a
 * shared NFS directory, named `<original workflow name>_intel_<timestamp>`.
 * Never throws — a failure here must not affect Step 12's own completion or
 * the task's status.
 */
export async function archiveAcceptedWorkflowIfNeeded(input: {
  task: MigrationTask;
  nfsArchiveRoot: string;
}): Promise<ArchiveResult> {
  const { task, nfsArchiveRoot } = input;
  try {
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
