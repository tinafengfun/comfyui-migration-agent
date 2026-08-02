import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAssetResolution, lookupAssetResolution } from "./assetResolutionLedger";
import { ensureDir } from "./fsUtils";
import fs from "node:fs/promises";

describe("asset resolution ledger", () => {
  it("returns undefined when the ledger doesn't exist yet", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-ledger-missing-${Date.now()}`);
    const ledgerPath = path.join(root, "asset-resolutions.jsonl");
    await expect(lookupAssetResolution(ledgerPath, "model.safetensors")).resolves.toBeUndefined();
  });

  it("returns the most recent entry for an asset whose resolved file still exists", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-ledger-${Date.now()}`);
    await ensureDir(root);
    const ledgerPath = path.join(root, "asset-resolutions.jsonl");
    const resolvedFile = path.join(root, "model.safetensors");
    await fs.writeFile(resolvedFile, "fake weights", "utf8");

    await appendAssetResolution(ledgerPath, {
      assetName: "model.safetensors",
      resolvedPath: resolvedFile,
      source: "huggingface",
      sourceIdentical: true,
      workflowName: "WorkflowA",
      workflowSha256: "abc123",
      taskId: "task-1",
      resolvedAt: "2026-01-01T00:00:00Z"
    });
    await appendAssetResolution(ledgerPath, {
      assetName: "model.safetensors",
      resolvedPath: resolvedFile,
      source: "huggingface",
      sourceIdentical: true,
      workflowName: "WorkflowB",
      workflowSha256: "def456",
      taskId: "task-2",
      resolvedAt: "2026-01-02T00:00:00Z"
    });

    const entry = await lookupAssetResolution(ledgerPath, "model.safetensors");
    expect(entry?.taskId).toBe("task-2");
    expect(entry?.resolvedPath).toBe(resolvedFile);
  });

  it("skips a stale entry whose resolved file no longer exists (never trusts a ledger hit blindly)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-ledger-stale-${Date.now()}`);
    await ensureDir(root);
    const ledgerPath = path.join(root, "asset-resolutions.jsonl");
    const goneFile = path.join(root, "removed-model.safetensors");
    const stillThereFile = path.join(root, "still-there.safetensors");
    await fs.writeFile(stillThereFile, "fake weights", "utf8");

    await appendAssetResolution(ledgerPath, {
      assetName: "still-there.safetensors",
      resolvedPath: stillThereFile,
      source: "local",
      sourceIdentical: true,
      workflowName: "WorkflowA",
      taskId: "task-1",
      resolvedAt: "2026-01-01T00:00:00Z"
    });
    // Newest entry points at a file that no longer exists -- must be skipped,
    // not returned as a false-positive reuse hit.
    await appendAssetResolution(ledgerPath, {
      assetName: "still-there.safetensors",
      resolvedPath: goneFile,
      source: "local",
      sourceIdentical: true,
      workflowName: "WorkflowB",
      taskId: "task-2",
      resolvedAt: "2026-01-02T00:00:00Z"
    });

    const entry = await lookupAssetResolution(ledgerPath, "still-there.safetensors");
    expect(entry?.taskId).toBe("task-1");
    expect(entry?.resolvedPath).toBe(stillThereFile);
  });

  it("skips torn/malformed lines instead of throwing", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-ledger-torn-${Date.now()}`);
    await ensureDir(root);
    const ledgerPath = path.join(root, "asset-resolutions.jsonl");
    await fs.writeFile(ledgerPath, "{not valid json\n", "utf8");

    await expect(lookupAssetResolution(ledgerPath, "model.safetensors")).resolves.toBeUndefined();
  });
});
