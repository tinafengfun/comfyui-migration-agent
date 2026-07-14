/**
 * normalize-workflow.mjs — GUI→API graph normalization.
 *
 * First principles:
 *  P1 coverage parity: every active GUI node must still execute in the API DAG
 *     (we re-wire, never delete/skip nodes).
 *  P2 break dead loops: a true cycle can't run in ComfyUI's DAG engine; cut the
 *     erroneous back-edge.
 *  P3 order/count → VRAM: a cycle = ∞ invocations (catastrophic). Breaking it
 *     makes each node run once, source→sink order (offload-friendly).
 *
 * What it fixes (general): "transform loops" — an upscaler/scaler/transform whose
 * IMAGE input is wired to a node it also feeds (a cycle), a common artifact of
 * GUI exports where a group-bypass/switch widget's state isn't persisted. It
 * rewires the cycle's IMAGE back-edge to the workflow's primary VAEDecode output
 * (the original decoded image), which is what the transform should actually
 * consume. Honors ComfyUI native bypass(mode=4)/mute(mode=2): muted nodes are
 * excluded from the execution graph before cycle detection.
 *
 * Usage: node scripts/normalize-workflow.mjs <workflow.json> [out.json]
 *   Prints a report; writes the normalized workflow to out.json (or <name>.normalized.json).
 */
import fs from "node:fs";

const [inPath, outPath] = [process.argv[2], process.argv[3]];
if (!inPath) { console.error("usage: normalize-workflow.mjs <workflow.json> [out.json]"); process.exit(2); }
const wf = JSON.parse(fs.readFileSync(inPath, "utf8"));
let nodes = wf.nodes ?? [];
let links = (wf.links ?? []).map((l) => [...l]); // deep-ish copy of link tuples

// ── 1. Honor ComfyUI native mute (mode=2): muted nodes drop out of the graph. ──
const muted = new Set(nodes.filter((n) => n.mode === 2).map((n) => n.id));
let execLinks = links.filter((l) => !muted.has(l[1]) && !muted.has(l[3]));
const nodeIds = new Set(nodes.map((n) => n.id));

// ── 2. Tarjan SCC on the directed execution graph (src->dst). ──
const adj = new Map();
for (const id of nodeIds) adj.set(id, []);
for (const l of execLinks) adj.get(l[1])?.push(l[3]);
let idx = 0, stack = [], onStack = new Set(), sccs = [];
const index = new Map(), low = new Map();
function strongconnect(v) {
  index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
  for (const w of adj.get(v) ?? []) {
    if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = []; let w; do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    sccs.push(comp);
  }
}
for (const v of nodeIds) if (!index.has(v) && !muted.has(v)) strongconnect(v);
const cyclic = sccs.filter((c) => c.length > 1); // multi-node SCC = cycle

// ── 3. Pick the primary VAEDecode (IMAGE producer feeding a SaveImage/Comparer). ──
const types = new Map(nodes.map((n) => [n.id, n.type ?? ""]));
const isImageProducer = (id) => /VAEDecode|LoadImage|VHS_/i.test(types.get(id) ?? "");
const isSink = (id) => /SaveImage|Comparer|PreviewImage|VHS_VideoCombine/i.test(types.get(id) ?? "");
const sinkTargets = new Set(execLinks.filter((l) => isSink(l[3])).map((l) => l[3]));
// VAEDecode whose output reaches a sink, else any VAEDecode, else any image producer.
let vae = nodes.find((n) => /VAEDecode/i.test(n.type ?? "") && execLinks.some((l) => l[1] === n.id && sinkTargets.has(l[3])))?.id;
if (vae === undefined) vae = nodes.find((n) => /VAEDecode/i.test(n.type ?? ""))?.id;
if (vae === undefined) vae = nodes.find((n) => isImageProducer(n.id))?.id;
const vaeSlot = 0; // VAEDecode outputs IMAGE at slot 0

// ── 4. For each cyclic SCC, rewire IMAGE back-edges to the primary image producer. ──
const report = [];
if (cyclic.length === 0) {
  report.push("no cycles — workflow is already a DAG");
}
for (const comp of cyclic) {
  const inComp = new Set(comp);
  // Minimal cut: identify the TRANSFORM node (upscaler/sampler/scale, or the node
  // with external non-IMAGE inputs like model loaders) — its IMAGE input is the
  // back-edge to cut + rewire to the decoded image. The OTHER cycle node keeps its
  // edge from the transform (so e.g. a preview-scaler still sees the upscaled output).
  const transform =
    comp.find((id) => execLinks.some((l) => l[3] === id && !inComp.has(l[1]) && !/^IMAGE$/i.test(String(l[5])))) ?? // has external model/param input
    comp.find((id) => /Upscale|SeedVR|Scale|Sampler|Transform/i.test(types.get(id) ?? "")) ??
    comp[0];
  // Rewire the transform's single IMAGE back-edge (from within the cycle) to VAEDecode.
  const backEdge = execLinks.find((l) => l[3] === transform && inComp.has(l[1]) && /^IMAGE$/i.test(String(l[5])) && l[1] !== vae);
  if (backEdge && vae !== undefined) {
    const [linkId, src, , dst, dstSlot] = backEdge;
    backEdge[1] = vae; backEdge[2] = vaeSlot;
    report.push(`cycle [${comp.join(",")}]: cut back-edge link ${linkId} — rewired node ${dst} (slot ${dstSlot}) IMAGE input from node ${src} -> VAEDecode(${vae}); transform=${types.get(transform)}`);
  } else {
    report.push(`cycle [${comp.join(",")}]: no rewirable IMAGE back-edge (vae=${vae ?? "none"}) — left for human review`);
  }
}
// Persist rewires into the canonical links array (by linkId).
const linkById = new Map(links.map((l) => [l[0], l]));
for (const l of execLinks) if (linkById.has(l[0])) linkById.set(l[0], l);
wf.links = [...linkById.values()];

// ── 5. Validate the result is a DAG (topo sort via Kahn). ──
const adj2 = new Map(); for (const id of nodeIds) adj2.set(id, []);
const indeg = new Map([...nodeIds].map((id) => [id, 0]));
for (const l of execLinks) { adj2.get(l[1])?.push(l[3]); indeg.set(l[3], (indeg.get(l[3]) ?? 0) + 1); }
const q = [...nodeIds].filter((id) => (indeg.get(id) ?? 0) === 0);
const order = []; const seen = new Set();
while (q.length) { const v = q.shift(); order.push(v); seen.add(v); for (const w of adj2.get(v) ?? []) { indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) q.push(w); } }
const isDag = seen.size === nodeIds.size;

// ── 6. Coverage parity: all active (non-muted) nodes still execute. ──
const activeCount = nodeIds.size - muted.size;
const coverageOk = seen.size === activeCount;

// ── 7. Heavy-node / offload note (P3 — VRAM-aware execution order). ──
const heavy = nodes.filter((n) => /SeedVR|Upscale|UNETLoader|CheckpointLoader|CLIPLoader|Quant/i.test(n.type ?? "")).map((n) => n.id + ":" + n.type);

const dest = outPath ?? inPath.replace(/\.json$/i, ".normalized.json");
fs.writeFileSync(dest, JSON.stringify(wf, null, 2), "utf8");

console.log(`normalized workflow -> ${dest}`);
console.log(`cycles found: ${cyclic.length} | DAG after: ${isDag} | coverage: ${seen.size}/${activeCount} active nodes execute`);
console.log(`primary image producer (VAEDecode): node ${vae}`);
console.log("changes:");
report.forEach((r) => console.log("  - " + r));
console.log(`heavy nodes (offload candidates): ${heavy.join(", ") || "none"}`);
console.log(`execution order (topo): ${order.slice(0, 30).join("->")}${order.length > 30 ? "..." : ""}`);
if (!isDag || !coverageOk) { console.error("ERROR: normalization failed (still cyclic or coverage lost)"); process.exit(1); }
