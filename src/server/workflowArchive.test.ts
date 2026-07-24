import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir, writeJson } from "./fsUtils";
import { archiveAcceptedWorkflowIfNeeded } from "./workflowArchive";

async function makeTask(root: string, overrides: Partial<MigrationTask> = {}): Promise<MigrationTask> {
  const artifactPath = path.join(root, "artifacts");
  await ensureDir(artifactPath);
  return {
    id: "task",
    name: "My Zimage Workflow!!",
    status: "running",
    workflowPath: path.join(root, "workflow.json"),
    workspacePath: root,
    artifactPath,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    steps: [{ id: "12", status: "running" }],
    ...overrides
  };
}

async function seedDeliveryBundle(artifactPath: string): Promise<void> {
  const deliveryDir = path.join(artifactPath, "11-delivery", "workflows");
  await ensureDir(deliveryDir);
  await fs.writeFile(path.join(deliveryDir, "runtime-policy-gui-workflow.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(artifactPath, "11-delivery", "GUI-IMPORT-README.md"), "# readme\n", "utf8");
}

describe("archiveAcceptedWorkflowIfNeeded", () => {
  it("archives the delivery bundle when manual_result is accepted", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await seedDeliveryBundle(task.artifactPath);
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });

    const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(result.archived).toBe(true);
    expect(result.destination).toBeDefined();
    expect(path.basename(result.destination!)).toMatch(/^My_Zimage_Workflow___intel_\d{8}T\d{6}Z$/);
    const copiedFile = path.join(result.destination!, "workflows", "runtime-policy-gui-workflow.json");
    await expect(fs.readFile(copiedFile, "utf8")).resolves.toBe("{}\n");
  });

  it.each(["rejected", "blocked", "pending_human_run"])(
    "does not archive when manual_result is %s",
    async (manualResult) => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-${manualResult}`);
      const nfsArchiveRoot = path.join(root, "nfs-workflows");
      const task = await makeTask(root);
      await seedDeliveryBundle(task.artifactPath);
      await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: manualResult });

      const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

      expect(result.archived).toBe(false);
      await expect(fs.access(nfsArchiveRoot)).rejects.toThrow();
    }
  );

  it("does not archive when the summary file is missing", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-missing`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await seedDeliveryBundle(task.artifactPath);

    const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(result.archived).toBe(false);
    expect(result.reason).toContain("unset");
  });

  it("suffixes the destination name on collision instead of overwriting", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-collision`);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
    try {
      const nfsArchiveRoot = path.join(root, "nfs-workflows");
      const task = await makeTask(root, { name: "same-name" });
      await seedDeliveryBundle(task.artifactPath);
      await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });

      const first = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });
      const second = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

      expect(first.archived).toBe(true);
      expect(second.archived).toBe(true);
      expect(second.destination).not.toBe(first.destination);
      expect(second.destination).toMatch(/-2$/);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns archived: false instead of throwing when the source bundle is absent", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-nosrc`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });

    const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(result.archived).toBe(false);
    expect(result.reason).toContain("not found");
  });
});
