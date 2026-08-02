/**
 * Cross-task asset-resolution ledger (shared NFS JSONL, see config.ts's
 * assetResolutionLedgerPath).
 *
 * What this is:
 *   model_roots / extra_model_paths.yaml already make the model FILES
 *   persistent and shared across tasks via /nfs_share. What doesn't survive
 *   a task's workspace deletion is the KNOWLEDGE of which asset name
 *   resolved to which file, via what source, source-identical vs. an
 *   approved substitute -- that only ever lived in the per-task
 *   01-assets.csv. This ledger closes that gap so Step 01 doesn't have to
 *   re-search for an asset it has already resolved before.
 *
 * Why append-only JSONL and not read-modify-write JSON:
 *   Avoids read-modify-write races across concurrent tasks (same rationale
 *   as feedbackLog.ts's feedback-events.jsonl). The most recent entry for a
 *   given asset name wins on lookup.
 *
 * Trust model:
 *   A ledger entry is a hint, never a guarantee -- lookupAssetResolution
 *   always confirms the resolved path still exists on disk before returning
 *   it, since a file can be removed/moved after the entry was written.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface AssetResolutionEntry {
  assetName: string;
  resolvedPath: string;
  source: string;
  sourceIdentical: boolean;
  workflowName: string;
  workflowSha256?: string;
  taskId: string;
  resolvedAt: string;
}

export async function appendAssetResolution(
  ledgerPath: string,
  entry: AssetResolutionEntry
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Returns the most recent ledger entry for assetName whose resolvedPath
 * still exists on disk, or undefined if no entry exists or every matching
 * entry's file has since been removed. Malformed/torn lines (possible under
 * concurrent appends, see feedbackLog.ts's own note on this) are skipped,
 * never thrown.
 */
export async function lookupAssetResolution(
  ledgerPath: string,
  assetName: string
): Promise<AssetResolutionEntry | undefined> {
  let content: string;
  try {
    content = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const entries: AssetResolutionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AssetResolutionEntry;
      if (parsed.assetName === assetName) entries.push(parsed);
    } catch {
      // Torn/malformed line -- skip, never throw.
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (await pathExists(candidate.resolvedPath)) return candidate;
  }
  return undefined;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
