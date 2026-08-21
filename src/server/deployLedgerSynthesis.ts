/**
 * Deterministic deploy-ledger synthesis (hard-layer fallback).
 *
 * The catalog write-back (`catalogValidateAndWriteBack`) consumes a Step-05
 * deploy ledger (`05-catalog-deploy-ledger.json`) that pairs each deployed
 * custom-node class_type with its provenance (repo/commit). That ledger is
 * emitted by the Step-05 AGENT — a SOFT layer. Live runs show the LLM sometimes
 * skips emitting it, which zeroed the whole self-learning loop: no ledger → no
 * write-back → the catalog never grows even after a fully successful migration.
 *
 * Per the two-layer principle ([[feedback_two_layer_injection]]: hard determinism
 * must not depend on soft agent output), this module lets the orchestrator
 * RECONSTRUCT the ledger from artifacts + ground truth it controls, for every
 * node whose provenance is AUTHORITATIVE (never guessed):
 *   1. the `KNOWN_CUSTOM_NODES` registry (static class_type-prefix → repo), and
 *   2. real git metadata harvested from the deployed container/host
 *      (`custom_nodes/<dir>/.git` remote + HEAD).
 * A class_type whose provider we cannot attribute to a real repository is SKIPPED
 * (surfaced to the caller), not recorded under a fabricated key — data quality
 * over coverage. The branch-harvest fresh-tested gate still governs which of the
 * synthesized nodes actually enter the catalog, so "只 record 真正测试过的 node"
 * is preserved: synthesis only supplies the type→repo mapping; it never asserts a
 * node passed.
 */
import type { CatalogDeployLedgerNode } from "./xpuCatalogWriteBack";
import { knownCustomNodeForType } from "./knownCustomNodes";

/** One workflow node type + the python module ComfyUI reports as its provider. */
export interface WorkflowNodeType {
  nodeType: string;
  /** e.g. "custom_nodes.comfyui-workflow-encrypt" or "nodes" (core) or "comfy_extras.*". */
  pythonModule?: string;
}

/** Authoritative git provenance for one deployed custom_nodes dir. */
export interface GitProvenance {
  repository: string;
  commit?: string;
}

/** custom_nodes dir name → its harvested git provenance (only dirs that HAVE a remote). */
export type ProvenanceMap = Record<string, GitProvenance>;

export interface SynthesisResult {
  nodes: CatalogDeployLedgerNode[];
  /** class_types recognised as custom but with no authoritative repo (not recorded). */
  unattributed: string[];
}

/** "custom_nodes.comfyui-workflow-encrypt" → "comfyui-workflow-encrypt". */
export function packageDirFromModule(pythonModule?: string): string | undefined {
  if (!pythonModule) return undefined;
  const m = /^custom_nodes\.([^.]+)/.exec(pythonModule);
  return m ? m[1] : undefined;
}

/** A node is custom iff ComfyUI attributes it to a `custom_nodes.*` module. */
export function isCustomNodeModule(pythonModule?: string): boolean {
  return typeof pythonModule === "string" && pythonModule.startsWith("custom_nodes.");
}

/**
 * Synthesize deploy-ledger nodes from workflow node types + authoritative
 * provenance. Pure. Registry match wins (static, curated); otherwise fall back to
 * harvested git provenance keyed by the node's custom_nodes dir. Types with
 * neither are returned in `unattributed` and NOT recorded.
 */
export function synthesizeLedgerNodes(types: WorkflowNodeType[], provenance: ProvenanceMap = {}): SynthesisResult {
  const nodes: CatalogDeployLedgerNode[] = [];
  const unattributed: string[] = [];
  const seen = new Set<string>();

  for (const t of types) {
    if (!t.nodeType || seen.has(t.nodeType)) continue;

    // (1) Static registry — the curated class_type-prefix → repo map.
    const known = knownCustomNodeForType(t.nodeType);
    if (known) {
      seen.add(t.nodeType);
      nodes.push({
        nodeType: t.nodeType,
        repository: known.repository,
        packageName: known.packageName,
        ...(known.pip ? { pip: { backend: known.pip.backend } } : {})
      });
      continue;
    }

    // Only custom_nodes.* modules are candidates for git-provenance attribution.
    if (!isCustomNodeModule(t.pythonModule)) continue; // core / comfy_extras — not a catalog node
    seen.add(t.nodeType);

    // (2) Ground-truth git provenance harvested from the deployed dir.
    const dir = packageDirFromModule(t.pythonModule);
    const prov = dir ? provenance[dir] : undefined;
    if (prov?.repository) {
      nodes.push({
        nodeType: t.nodeType,
        repository: prov.repository,
        packageName: dir,
        ...(prov.commit ? { commit: prov.commit } : {})
      });
      continue;
    }

    // Custom node, but no authoritative repo (copied-from-NFS, no .git, not in
    // registry). Do NOT invent a key — surface it instead.
    unattributed.push(t.nodeType);
  }

  return { nodes, unattributed };
}

/**
 * Read the Step-05 `object_info` workflow-node summary into WorkflowNodeType[].
 * Shape: `{ [class_type]: { python_module?: string, ... } }`. Lenient: unknown
 * shapes yield [].
 */
export function parseWorkflowNodeTypes(objectInfoSummary: unknown): WorkflowNodeType[] {
  if (!objectInfoSummary || typeof objectInfoSummary !== "object") return [];
  const out: WorkflowNodeType[] = [];
  for (const [nodeType, v] of Object.entries(objectInfoSummary as Record<string, unknown>)) {
    const pythonModule =
      v && typeof v === "object" && typeof (v as { python_module?: unknown }).python_module === "string"
        ? (v as { python_module: string }).python_module
        : undefined;
    out.push({ nodeType, pythonModule });
  }
  return out;
}
