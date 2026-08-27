#!/usr/bin/env node
/**
 * Phase 4 — backfill `migrationRoute` onto existing catalog records from the
 * human-curated triage in docs/catalog-unsupported-nodes.md (+ the P3-recovered
 * dep nodes). One-shot; POSTs via the catalog-server (never writes SQLite/JSON
 * directly). Idempotent: sets the route, upserts, logs applied/unchanged/missing.
 *
 * Env: XPU_CATALOG_ENABLED=1 XPU_CATALOG_SERVER_URL=http://127.0.0.1:3100
 * Usage: npx tsx scripts/catalog-import/backfill-routes.mts [--dry-run]
 */
import type { MigrationRoute, XpuNodeRecord } from "../../src/catalog/schema";

const DRY = process.argv.includes("--dry-run");
const U = (process.env.XPU_CATALOG_SERVER_URL ?? "http://127.0.0.1:3100") + "/api/xpu-catalog";

/** packageName → migrationRoute (from docs/catalog-unsupported-nodes.md A/B/C/D triage). */
const ROUTE_BY_PACKAGE: Record<string, MigrationRoute> = {
  // A — dep-driven (agent installs deps in-container). Includes the 4 P3-recovered ones.
  "comfyui-dream-project": "auto_deps",
  "CRT-Nodes": "auto_deps",
  "comfyui-tensorops": "auto_deps",
  "ComfyUI_Fill-Nodes": "auto_deps",
  "comfyui_image_metadata_extension": "auto_deps",
  "ComfyUI_WordCloud": "auto_deps",
  "Bjornulf_custom_nodes": "auto_deps",
  "comfyui-ollama": "auto_deps",
  "ComfyUI-Woosh": "auto_deps",
  "ComfyUI-Crystools": "auto_deps",
  "ComfyUI-Image-Saver": "auto_deps",
  "ComfyUI-Inspire-Pack": "auto_deps",
  "ComfyUI-MieNodes": "auto_deps",
  // B — mechanical cuda→xpu device redirect
  "ComfyUI-wanBlockswap": "auto_device_redirect",
  "ComfyUI-segment-anything-2": "auto_device_redirect",
  "ComfyUI-Impact-Pack": "auto_device_redirect",
  // B — needs human code work (import/code bug, config choice)
  "ComfyUI-AutomaticCFG": "human_source_work",
  "ComfyUI-Dev-Utils": "human_source_work",
  "ComfyUI_FizzNodes": "human_source_work",
  "ComfyUI_PuLID_Flux_ll": "human_source_work",
  "ComfyUI-LivePortraitKJ": "human_source_work",
  // B — env/version conflict vs the pinned image
  "ComfyUI_IndexTTS": "human_env_conflict",
  "ComfyUI-FluxTrainer": "human_env_conflict",
  // C — pure CUDA, no XPU path
  "ComfyUI-3D-Pack": "unsupported_cuda_kernel",
  "ComfyUI-nunchaku": "unsupported_cuda_kernel",
  "ComfyUI-FlashVSR": "unsupported_cuda_kernel",
  "ComfyUI-FlashVSR_Ultra_Fast": "unsupported_cuda_kernel",
  // D — dead/moved repo → human source re-identification
  "comfyui-reactor-node": "human_source_unknown",
  "ComfyUI_CatVTON_Wrapper": "human_source_unknown",
  // D — use built-in / unmaintained → nothing to migrate
  "AIGODLIKE-COMFYUI-TRANSLATION": "not_applicable",
  "ComfyUI-DD-Translation": "not_applicable",
  "ComfyUI-Manager": "not_applicable",
  "ComfyUI-TeaCache": "not_applicable"
};

async function main() {
  if (process.env.XPU_CATALOG_ENABLED !== "1") {
    console.error("XPU_CATALOG_ENABLED not set — refusing to write."); process.exit(2);
  }
  const all = (await (await fetch(`${U}/nodes`)).json()).nodes as XpuNodeRecord[];
  const byPkg = new Map(all.map((r) => [r.packageName, r]));
  let applied = 0, unchanged = 0;
  const missing: string[] = [];
  for (const [pkg, route] of Object.entries(ROUTE_BY_PACKAGE)) {
    const rec = byPkg.get(pkg);
    if (!rec) { missing.push(pkg); continue; }
    // A pure-CUDA node with no XPU path is genuinely tier "unsupported", not the
    // default "candidate" — set both so the Step-00 boundary pre-triage (tier-gated)
    // fires on it. Other routes leave tier untouched (human_* stay candidate).
    const nextTier = route === "unsupported_cuda_kernel" ? "unsupported" : rec.tier;
    if (rec.migrationRoute === route && rec.tier === nextTier) { unchanged++; continue; }
    if (DRY) { console.log(`DRY  ${pkg}: route ${rec.migrationRoute ?? "(none)"} -> ${route}${nextTier !== rec.tier ? `, tier ${rec.tier} -> ${nextTier}` : ""}`); applied++; continue; }
    const next = { ...rec, migrationRoute: route, tier: nextTier };
    const r = await fetch(`${U}/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    if (r.ok) { console.log(`  ${pkg}: ${rec.migrationRoute ?? "(none)"} -> ${route}`); applied++; }
    else { console.log(`  ${pkg}: upsert FAILED ${r.status}`); }
  }
  console.log(`\napplied ${applied}, unchanged ${unchanged}, missing ${missing.length}${missing.length ? ` -> ${missing.join(", ")}` : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
