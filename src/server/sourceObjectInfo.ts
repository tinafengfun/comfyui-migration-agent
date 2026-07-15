/**
 * Load the source-environment object_info (truth table) and build a recipe-backed
 * resolver mapping enum (slot,value) → the package that provides it.
 *
 * Used by Step 00 intake to detect implicit package dependencies (enum widget
 * values injected by a source-side custom package). See enumDependencies.ts.
 */
import fs from "node:fs/promises";
import type { AppConfig } from "./config";
import type { ObjectInfo } from "./enumDependencies";
import { loadAllRecipes } from "./recipeLibrary";

/**
 * Fetch/read the source object_info. Priority: explicit snapshot path → URL.
 * Returns undefined if neither is configured or the fetch fails (detection then
 * falls back to the comfy-core baseline + recipe mapping only).
 */
export async function loadSourceObjectInfo(config: AppConfig): Promise<ObjectInfo | undefined> {
  if (config.sourceObjectInfoPath) {
    try {
      return JSON.parse(await fs.readFile(config.sourceObjectInfoPath, "utf8")) as ObjectInfo;
    } catch {
      /* fall through to URL */
    }
  }
  if (config.sourceObjectInfoUrl) {
    try {
      const base = config.sourceObjectInfoUrl.replace(/\/+$/, "");
      const url = base.endsWith("/object_info") ? base : `${base}/object_info`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return (await res.json()) as ObjectInfo;
    } catch {
      /* unreachable — undefined */
    }
  }
  return undefined;
}

/**
 * Build a resolver: given an enum (slot, value), return the providing package's
 * repo URL (or id) from recipes that declare `providesEnumValues`. Undefined if
 * no recipe knows the value.
 */
export function buildEnumPackageResolver(
  recipesRoot?: string
): (slot: string, value: string) => string | undefined {
  const { recipes } = loadAllRecipes(recipesRoot);
  // index: value → packageRepo (or recipeId), optionally slot-scoped
  const byValue = new Map<string, string>();
  for (const r of recipes) {
    if (!r.providesEnumValues?.length) continue;
    const label = r.packageRepo ?? r.recipeId;
    for (const v of r.providesEnumValues) {
      byValue.set(v, label);
      if (r.enumSlots?.length) for (const s of r.enumSlots) byValue.set(`${s}\0${v}`, label);
    }
  }
  return (slot: string, value: string) => byValue.get(`${slot}\0${value}`) ?? byValue.get(value);
}
