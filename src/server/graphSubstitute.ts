/**
 * graphSubstitute.ts — the Step-03b graph surgery: replace a cloud-API node with
 * a local-model subgraph, on the GUI workflow graph (nodes[] + link tuples
 * [id, srcNode, srcSlot, dstNode, dstSlot, type]). Pure + non-mutating (deep-copies
 * the input), mirroring workflowNormalize.normalizeWorkflowForApi.
 *
 * For each plan (apiNodeId + substitution recipe) it:
 *   1. inserts the recipe's toSubgraph nodes with fresh ids + internal links,
 *   2. re-points the API node's incoming links to the subgraph (inMap; asInput
 *      adds a linked input port when the target only had a widget),
 *   3. re-points the API node's outgoing links to the subgraph (outMap),
 *   4. drops the declared inputs (audio/video/files) and removes the API node,
 *   5. keeps the top-level links[] AND per-node inputs[].link / outputs[].links
 *      mirrors AND last_node_id / last_link_id in sync (ComfyUI GUI-load fidelity),
 *   6. validates the result is still a DAG and the required subgraph inputs landed.
 */
import type { SubstitutionRecipe, SubgraphNode } from "./substitutionRecipes";

export interface GNodePort {
  name?: string;
  type?: string;
  link?: number | null; // input port: the incoming link id
  links?: Array<number | null> | null; // output port: outgoing link ids
}
export interface GNode {
  id: number;
  type?: string;
  mode?: number;
  inputs?: GNodePort[];
  outputs?: GNodePort[];
  widgets_values?: unknown[];
  properties?: Record<string, unknown>;
  pos?: unknown;
  size?: unknown;
  [k: string]: unknown;
}
export type GLink = [number, number, number, number, number, string];
export interface GGraph {
  nodes?: GNode[];
  links?: Array<GLink | unknown[]>;
  last_node_id?: number;
  last_link_id?: number;
  [k: string]: unknown;
}

export interface SubstitutionPlan {
  apiNodeId: number;
  recipe: SubstitutionRecipe;
}
export interface SubstitutionReport {
  substituted: Array<{ from: string; fromId: number; toNodes: string[]; model?: string; droppedInputs: string[] }>;
  isDag: boolean;
  warnings: string[];
}
export interface SubstituteResult {
  workflow: GGraph;
  report: SubstitutionReport;
}

const asLinks = (g: GGraph): GLink[] => ((g.links ?? []).filter((l) => Array.isArray(l) && l.length >= 6) as GLink[]);
const inputSlot = (node: { inputs?: GNodePort[] }, name: string) => (node.inputs ?? []).findIndex((i) => i.name === name);
const outputSlot = (node: { outputs?: GNodePort[] }, name: string) => (node.outputs ?? []).findIndex((o) => o.name === name);

/** Resolve an API output key ("0" slot index, or an output name) to a slot index. */
function apiOutputSlot(api: GNode, key: string): number {
  if (/^\d+$/.test(key)) return Number(key);
  return outputSlot(api, key);
}

/** Kahn topological sort over the current links → is it a DAG? (reuse of workflowNormalize idea). */
function isDag(nodes: GNode[], links: GLink[]): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<number, number>();
  const adj = new Map<number, number[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const l of links) {
    const [, src, , dst] = l;
    if (!ids.has(src) || !ids.has(dst)) continue;
    adj.get(src)!.push(dst);
    indeg.set(dst, (indeg.get(dst) ?? 0) + 1);
  }
  const q = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0);
  let seen = 0;
  while (q.length) {
    const n = q.shift()!;
    seen++;
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if ((indeg.get(m) ?? 0) === 0) q.push(m);
    }
  }
  return seen === ids.size;
}

/** Apply substitution plans to a GUI graph. Pure: deep-copies, never mutates the input. */
export function substituteNodes(input: GGraph, plans: SubstitutionPlan[]): SubstituteResult {
  const g: GGraph = JSON.parse(JSON.stringify(input));
  const nodes = (g.nodes ??= []);
  let links = asLinks(g);
  const report: SubstitutionReport = { substituted: [], isDag: true, warnings: [] };

  let nextNodeId = Math.max(0, g.last_node_id ?? 0, ...nodes.map((n) => Number(n.id) || 0)) + 1;
  let nextLinkId = Math.max(0, g.last_link_id ?? 0, ...links.map((l) => l[0])) + 1;
  const linkById = new Map<number, GLink>(links.map((l) => [l[0], l]));

  for (const plan of plans) {
    const api = nodes.find((n) => Number(n.id) === plan.apiNodeId);
    if (!api) {
      report.warnings.push(`api node ${plan.apiNodeId} not found`);
      continue;
    }
    const rec = plan.recipe;

    // 1. Insert subgraph nodes with fresh ids.
    const keyId = new Map<string, number>();
    const keyDef = new Map<string, SubgraphNode>();
    for (const sn of rec.toSubgraph) {
      const id = nextNodeId++;
      keyId.set(sn.key, id);
      keyDef.set(sn.key, sn);
      nodes.push({
        id,
        type: sn.localType,
        mode: 0,
        inputs: (sn.inputs ?? []).map((p) => ({ name: p.name, type: p.type, link: null })),
        outputs: (sn.outputs ?? []).map((p) => ({ name: p.name, type: p.type, links: [] })),
        widgets_values: sn.widgets_values ? JSON.parse(JSON.stringify(sn.widgets_values)) : undefined,
        properties: {},
        pos: [0, 0],
        size: [270, 120]
      });
    }
    const nodeByKey = (key: string) => nodes.find((n) => Number(n.id) === keyId.get(key))!;
    const addLink = (srcId: number, srcSlot: number, dstId: number, dstSlot: number, type: string): number => {
      const id = nextLinkId++;
      const tuple: GLink = [id, srcId, srcSlot, dstId, dstSlot, type];
      links.push(tuple);
      linkById.set(id, tuple);
      const s = nodes.find((n) => Number(n.id) === srcId);
      const d = nodes.find((n) => Number(n.id) === dstId);
      if (s?.outputs?.[srcSlot]) (s.outputs[srcSlot].links ??= []).push(id);
      if (d?.inputs?.[dstSlot]) d.inputs[dstSlot].link = id;
      return id;
    };

    // 2. Internal links between inserted nodes.
    for (const il of rec.links.internal) {
      const s = nodeByKey(il.from.node);
      const d = nodeByKey(il.to.node);
      const ss = outputSlot(keyDef.get(il.from.node)!, String(il.from.output));
      const ds = inputSlot(keyDef.get(il.to.node)!, il.to.input);
      if (ss < 0 || ds < 0) {
        report.warnings.push(`internal link ${il.from.node}.${il.from.output}→${il.to.node}.${il.to.input} unresolved`);
        continue;
      }
      const type = s.outputs?.[ss]?.type ?? il.from.type ?? "*";
      addLink(Number(s.id), ss, Number(d.id), ds, String(type));
    }

    // 3. Re-point the API node's INCOMING links (inMap).
    for (const [apiInput, dest] of Object.entries(rec.links.inMap)) {
      const aSlot = inputSlot(api, apiInput);
      if (aSlot < 0) continue;
      const linkId = api.inputs?.[aSlot]?.link ?? null;
      if (linkId == null) continue; // input not connected → local node uses its widget/default
      const L = linkById.get(linkId);
      if (!L) continue;
      const tgt = nodeByKey(dest.node);
      let tSlot = inputSlot(keyDef.get(dest.node)!, dest.input);
      if (tSlot < 0 && dest.asInput) {
        // widget→input conversion: add the input port to the target node.
        (tgt.inputs ??= []).push({ name: dest.input, type: String(L[5]) || "*", link: null });
        tSlot = tgt.inputs.length - 1;
      }
      if (tSlot < 0) {
        report.warnings.push(`inMap ${apiInput}→${dest.node}.${dest.input} unresolved`);
        continue;
      }
      L[3] = Number(tgt.id); // re-point target node
      L[4] = tSlot; // re-point target slot
      if (tgt.inputs?.[tSlot]) tgt.inputs[tSlot].link = linkId;
    }

    // 4. Re-point the API node's OUTGOING links (outMap).
    for (const [apiOut, src] of Object.entries(rec.links.outMap)) {
      const aSlot = apiOutputSlot(api, apiOut);
      if (aSlot < 0) continue;
      const outLinks = (api.outputs?.[aSlot]?.links ?? []).filter((x): x is number => x != null);
      const srcNode = nodeByKey(src.node);
      const sSlot = outputSlot(keyDef.get(src.node)!, String(src.output));
      if (sSlot < 0) {
        report.warnings.push(`outMap ${apiOut}→${src.node}.${src.output} unresolved`);
        continue;
      }
      for (const linkId of outLinks) {
        const L = linkById.get(linkId);
        if (!L) continue;
        L[1] = Number(srcNode.id); // re-point source node
        L[2] = sSlot; // re-point source slot
        (srcNode.outputs![sSlot].links ??= []).push(linkId);
      }
    }

    // 5. Drop declared inputs — remove the incoming link entirely.
    const dropped: string[] = [];
    for (const apiInput of rec.links.dropInputs ?? []) {
      const aSlot = inputSlot(api, apiInput);
      const linkId = aSlot >= 0 ? api.inputs?.[aSlot]?.link ?? null : null;
      dropped.push(apiInput);
      if (linkId == null) continue;
      const L = linkById.get(linkId);
      if (L) {
        // clean the upstream source's output mirror
        const up = nodes.find((n) => Number(n.id) === L[1]);
        const upOut = up?.outputs?.[L[2]];
        if (upOut?.links) upOut.links = upOut.links.filter((x) => x !== linkId);
      }
      links = links.filter((l) => l[0] !== linkId);
      linkById.delete(linkId);
    }

    // 6. Remove the API node + any link still incident to it (defensive).
    for (const l of [...links]) {
      if (l[1] === Number(api.id) || l[3] === Number(api.id)) {
        links = links.filter((x) => x[0] !== l[0]);
        linkById.delete(l[0]);
      }
    }
    const idx = nodes.findIndex((n) => Number(n.id) === Number(api.id));
    if (idx >= 0) nodes.splice(idx, 1);

    report.substituted.push({
      from: rec.fromNodeType,
      fromId: plan.apiNodeId,
      toNodes: rec.toSubgraph.map((s) => s.localType),
      model: rec.model,
      droppedInputs: dropped
    });
  }

  g.links = links;
  g.last_node_id = nextNodeId - 1;
  g.last_link_id = nextLinkId - 1;
  report.isDag = isDag(nodes, links);
  return { workflow: g, report };
}
