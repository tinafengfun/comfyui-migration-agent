import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir, writeJson } from "./fsUtils";
import { archiveAcceptedWorkflowIfNeeded, archiveTaskSnapshot } from "./workflowArchive";

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

  it("suffixes the destination name on collision between two DIFFERENT tasks sharing a name, instead of overwriting", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-collision`);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
    try {
      const nfsArchiveRoot = path.join(root, "nfs-workflows");
      // Two distinct tasks (distinct artifactPath -> distinct marker files)
      // that happen to share the same sanitized name -- unlike the same
      // task called twice (see the idempotency test below), both of these
      // are genuinely new archives and neither should be skipped.
      const taskA = await makeTask(path.join(root, "task-a"), { id: "task-a", name: "same-name" });
      const taskB = await makeTask(path.join(root, "task-b"), { id: "task-b", name: "same-name" });
      for (const task of [taskA, taskB]) {
        await seedDeliveryBundle(task.artifactPath);
        await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });
      }

      const first = await archiveAcceptedWorkflowIfNeeded({ task: taskA, nfsArchiveRoot });
      const second = await archiveAcceptedWorkflowIfNeeded({ task: taskB, nfsArchiveRoot });

      expect(first.archived).toBe(true);
      expect(second.archived).toBe(true);
      expect(second.destination).not.toBe(first.destination);
      expect(second.destination).toMatch(/-2$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent: archiving the SAME task twice only copies once (safe to call from two trigger points)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-idempotent`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await seedDeliveryBundle(task.artifactPath);
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });

    const first = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });
    const second = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(first.archived).toBe(true);
    expect(second.archived).toBe(false);
    expect(second.reason).toContain("already archived");
    expect(second.reason).toContain(first.destination);

    const entries = await fs.readdir(nfsArchiveRoot);
    expect(entries).toHaveLength(1);
  });

  it("copies the actual GUI-tested workflow to <destination>/workflow.json when present", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-gui-workflow`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await seedDeliveryBundle(task.artifactPath);
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });
    await ensureDir(path.join(task.artifactPath, "12-gui-acceptance"));
    await fs.writeFile(
      path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
      '{"nodes":[],"links":[],"tested":true}\n',
      "utf8"
    );

    const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(result.archived).toBe(true);
    await expect(fs.readFile(path.join(result.destination!, "workflow.json"), "utf8")).resolves.toBe(
      '{"nodes":[],"links":[],"tested":true}\n'
    );
  });

  it("still archives fine when there's no GUI-tested workflow file (best-effort, not required)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `wf-archive-${Date.now()}-no-gui-workflow`);
    const nfsArchiveRoot = path.join(root, "nfs-workflows");
    const task = await makeTask(root);
    await seedDeliveryBundle(task.artifactPath);
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });

    const result = await archiveAcceptedWorkflowIfNeeded({ task, nfsArchiveRoot });

    expect(result.archived).toBe(true);
    await expect(fs.access(path.join(result.destination!, "workflow.json"))).rejects.toThrow();
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

describe("archiveTaskSnapshot", () => {
  it("snapshots task-state.json, artifacts/, logs/, and package/manifest.json regardless of outcome", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `task-snapshot-${Date.now()}`);
    const taskArchiveRoot = path.join(root, "migration-tasks");
    const task = await makeTask(root, { status: "hard_stopped", steps: [{ id: "08", status: "hard_stopped" }] });
    await fs.writeFile(task.workflowPath, '{"nodes":[],"links":[]}\n', "utf8");
    await fs.writeFile(path.join(task.workspacePath, "task-state.json"), '{"id":"task"}\n', "utf8");
    await fs.writeFile(path.join(task.artifactPath, "08-full-validation-report.md"), "# hard stop\n", "utf8");
    await ensureDir(path.join(task.workspacePath, "logs"));
    await fs.writeFile(path.join(task.workspacePath, "logs", "sdk-session.jsonl"), '{"event":"x"}\n', "utf8");
    await ensureDir(path.join(task.workspacePath, "package"));
    await fs.writeFile(path.join(task.workspacePath, "package", "manifest.json"), '{"manifestVersion":"v1"}\n', "utf8");

    const result = await archiveTaskSnapshot({ task, taskArchiveRoot });

    expect(result.archived).toBe(true);
    const destination = result.destination!;
    await expect(fs.readFile(path.join(destination, "task-state.json"), "utf8")).resolves.toBe('{"id":"task"}\n');
    await expect(
      fs.readFile(path.join(destination, "artifacts", "08-full-validation-report.md"), "utf8")
    ).resolves.toBe("# hard stop\n");
    await expect(fs.readFile(path.join(destination, "logs", "sdk-session.jsonl"), "utf8")).resolves.toBe(
      '{"event":"x"}\n'
    );
    await expect(fs.readFile(path.join(destination, "package", "manifest.json"), "utf8")).resolves.toBe(
      '{"manifestVersion":"v1"}\n'
    );

    const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
    expect(manifest.taskId).toBe("task");
    expect(manifest.finalStatus).toBe("hard_stopped");
    expect(manifest.steps).toEqual([{ id: "08", status: "hard_stopped" }]);
    expect(manifest.workflowSha256).toBeTruthy();
  });

  it("never throws when task-state.json/logs/package are all missing (best-effort)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `task-snapshot-${Date.now()}-sparse`);
    const taskArchiveRoot = path.join(root, "migration-tasks");
    const task = await makeTask(root);

    const result = await archiveTaskSnapshot({ task, taskArchiveRoot });

    expect(result.archived).toBe(true);
    await expect(fs.access(path.join(result.destination!, "artifacts"))).resolves.toBeUndefined();
  });

  it("excludes cache/ and outputs/ from the snapshot", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `task-snapshot-${Date.now()}-excludes`);
    const taskArchiveRoot = path.join(root, "migration-tasks");
    const task = await makeTask(root);
    await ensureDir(path.join(task.workspacePath, "cache", "custom_nodes", "some-node"));
    await fs.writeFile(path.join(task.workspacePath, "cache", "custom_nodes", "some-node", "x.py"), "x", "utf8");
    await ensureDir(path.join(task.workspacePath, "outputs", "previews"));
    await fs.writeFile(path.join(task.workspacePath, "outputs", "previews", "frame.png"), "x", "utf8");

    const result = await archiveTaskSnapshot({ task, taskArchiveRoot });

    expect(result.archived).toBe(true);
    await expect(fs.access(path.join(result.destination!, "cache"))).rejects.toThrow();
    await expect(fs.access(path.join(result.destination!, "outputs"))).rejects.toThrow();
  });
});
