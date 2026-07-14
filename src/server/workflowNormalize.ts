/**
 * GUI→API workflow graph normalization.
 *
 * Workflows exported from the ComfyUI GUI can contain constructs the API/DAG
 * engine rejects — most commonly a dependency cycle created when a GUI-only
 * group toggle (rgthree "Fast Groups Bypasser", Comfyroll switch) isn't
 * persisted into the links, so the export leaves two nodes active in a loop.
 * ComfyUI's /prompt then returns `dependency_cycle`.
 *
 * First principles:
 *  P1 coverage parity — every active GUI node must still execute (re-wire, never
 *     delete/skip).
 *  P2 break dead loops — a cycle can't run in ComfyUI's DAG; cut the back-edge.
 *  P3 order/count → VRAM — a cycle = ∞ invocations; breaking it makes each node
 *     run once, source→sink, offload-friendly.
 *
 * This module is deterministic and side-effect free (no fs); the orchestrator
 * writes the normalized workflow + report artifacts.
 */
export interface WorkflowGraph {
  nodes?: Array<{ id: number; type?: string; mode?: number; widgets_values?: unknown; title?: string }>;
  links?: Array<[number, number, number, number, number, string] | unknown[]>;
  [key: string]: unknown;
}

export interface NormalizationChange {
  cycle: number[];
  linkId: number;
  node: number;
  slot: number;
  fromNode: number;
  toNode: number; // the VAEDecode / image producer the input was rewired to
  transform: string;
}

export interface NormalizationReport {
  changed: boolean;
  cyclesFound: number;
  changes: NormalizationChange[];
  isDag: boolean;
  coverage: { execute: number; active: number };
  primaryImageProducer: number | undefined;
  executionOrder: number[];
  heavyNodes: Array<{ id: number; type: string }>;
  unresolved: string[]; // cycles we couldn't auto-resolve (need human/recipe)
}

export interface NormalizeResult {
  workflow: WorkflowGraph; // normalized (a deep copy; original untouched)
  report: NormalizationReport;
}

const IMAGE = /^IMAGE$/i;

/** Find the workflow's primary IMAGE producer (VAEDecode feeding a sink, else any VAEDecode/LoadImage). */
function pickPrimaryImageProducer(
  nodes: Array<{ id: number; type?: string }>,
  links: Array<unknown[]>,
  nodeIds: Set<number>
): number | undefined {
  const type = (id: number) => nodes.find((n) => n.id === id)?.type ?? "";
  const isSink = (id: number) => /SaveImage|Comparer|PreviewImage|VHS_VideoCombine/i.test(type(id));
  const sinkTargets = new Set(links.filter((l) => isSink(l[3] as number)).map((l) => l[3] as number));
  const vaeToSink = nodes.find(
    (n) => /VAEDecode/i.test(n.type ?? "") && links.some((l) => l[1] === n.id && sinkTargets.has(l[3] as number))
  );
  if (vaeToSink) return vaeToSink.id;
  const anyVae = nodes.find((n) => /VAEDecode/i.test(n.type ?? ""));
  if (anyVae) return anyVae.id;
  const anyProducer = nodes.find((n) => /VAEDecode|LoadImage|VHS_/i.test(n.type ?? ""));
  return anyProducer?.id;
}

/** Tarjan SCC on the directed execution graph. */
function stronglyConnectedComponents(
  nodeIds: Set<number>,
  execLinks: Array<unknown[]>
): number[][] {
  const adj = new Map<number, number[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const l of execLinks) (adj.get(l[1] as number) ?? []).push(l[3] as number);
  let idx = 0;
  const stack: number[] = [];
  const onStack = new Set<number>();
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const sccs: number[][] = [];
  const strongconnect = (v: number) => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const v of nodeIds) if (!index.has(v)) strongconnect(v);
  return sccs;
}

/** Kahn topological sort → execution order; returns order + whether it's a DAG. */
function topoSort(
  nodeIds: Set<number>,
  execLinks: Array<unknown[]>
): { order: number[]; isDag: boolean; reachable: Set<number> } {
  const adj = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  for (const id of nodeIds) {
    adj.set(id, []);
    indeg.set(id, 0);
  }
  for (const l of execLinks) {
    adj.get(l[1] as number)!.push(l[3] as number);
    indeg.set(l[3] as number, (indeg.get(l[3] as number) ?? 0) + 1);
  }
  const q = [...nodeIds].filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: number[] = [];
  const seen = new Set<number>();
  while (q.length) {
    const v = q.shift()!;
    order.push(v);
    seen.add(v);
    for (const w of adj.get(v) ?? []) {
      indeg.set(w, (indeg.get(w) ?? 0) - 1);
      if (indeg.get(w) === 0) q.push(w);
    }
  }
  return { order, isDag: seen.size === nodeIds.size, reachable: seen };
}

/**
 * Normalize a GUI-exported workflow for API/DAG execution. Returns a deep copy
 * with cycles resolved (never mutates the input). See module doc for behavior.
 */
export function normalizeWorkflowForApi(input: WorkflowGraph): NormalizeResult {
  const workflow: WorkflowGraph = JSON.parse(JSON.stringify(input)); // deep copy
  const nodes = workflow.nodes ?? [];
  // Work on a copy of links as mutable tuples.
  const links = (workflow.links ?? []).map((l) => [...(l as unknown[])]) as Array<unknown[]>;

  // P1/P2 baseline: honor ComfyUI native mute (mode 2) — muted nodes leave the graph.
  const muted = new Set(nodes.filter((n) => n.mode === 2).map((n) => n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  let execLinks = links.filter((l) => !muted.has(l[1] as number) && !muted.has(l[3] as number));
  const typeOf = (id: number) => nodes.find((n) => n.id === id)?.type ?? "";

  const primaryProducer = pickPrimaryImageProducer(nodes, execLinks, nodeIds);
  const changes: NormalizationChange[] = [];
  const unresolved: string[] = [];

  // Detect cycles; resolve transform-loop cycles by cutting the transform's IMAGE
  // back-edge and rewiring it to the primary image producer.
  let sccs = stronglyConnectedComponents(nodeIds, execLinks).filter((c) => c.length > 1);
  let guard = 0;
  while (sccs.length && guard++ < 16) {
    for (const comp of sccs) {
      const inComp = new Set(comp);
      // The transform = upscaler/sampler/scale, or the node with external non-IMAGE inputs.
      const transform =
        comp.find((id) =>
          execLinks.some((l) => l[3] === id && !inComp.has(l[1] as number) && !IMAGE.test(String(l[5])))
        ) ??
        comp.find((id) => /Upscale|SeedVR|Scale|Sampler|Transform/i.test(typeOf(id))) ??
        comp[0];
      const backEdge = execLinks.find(
        (l) => l[3] === transform && inComp.has(l[1] as number) && IMAGE.test(String(l[5])) && l[1] !== primaryProducer
      );
      if (backEdge && primaryProducer !== undefined) {
        const linkId = backEdge[0] as number;
        const fromNode = backEdge[1] as number;
        const node = backEdge[3] as number;
        const slot = backEdge[4] as number;
        backEdge[1] = primaryProducer;
        backEdge[2] = 0; // image producer outputs IMAGE at slot 0
        changes.push({ cycle: comp, linkId, node, slot, fromNode, toNode: primaryProducer, transform: typeOf(transform) });
      } else {
        unresolved.push(
          `cycle [${comp.join(",")}]: no rewirable IMAGE back-edge (producer=${primaryProducer ?? "none"}) — needs human/recipe`
        );
      }
    }
    // Persist execLinks back into the canonical links (by linkId) before re-detecting.
    const byId = new Map(links.map((l) => [l[0], l]));
    for (const l of execLinks) byId.set(l[0] as number, l);
    links.length = 0;
    links.push(...byId.values());
    execLinks = links.filter((l) => !muted.has(l[1] as number) && !muted.has(l[3] as number));
    sccs = unresolved.length === 0 ? stronglyConnectedComponents(nodeIds, execLinks).filter((c) => c.length > 1) : [];
  }

  workflow.links = links as unknown as WorkflowGraph["links"];

  const activeCount = nodeIds.size - muted.size;
  const { order, isDag, reachable } = topoSort(nodeIds, execLinks);
  const heavyNodes = nodes
    .filter((n) => /SeedVR|Upscale|UNETLoader|CheckpointLoader|CLIPLoader|Quant/i.test(n.type ?? ""))
    .map((n) => ({ id: n.id, type: n.type ?? "" }));

  const report: NormalizationReport = {
    changed: changes.length > 0,
    cyclesFound: changes.length + unresolved.length,
    changes,
    isDag,
    coverage: { execute: reachable.size, active: activeCount },
    primaryImageProducer: primaryProducer,
    executionOrder: order,
    heavyNodes,
    unresolved
  };
  return { workflow, report };
}
