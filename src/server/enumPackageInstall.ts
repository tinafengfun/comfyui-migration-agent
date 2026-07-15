/**
 * Enum-package install + verify — the deterministic "apple-to-apple" resolver
 * for implicit package dependencies (see enumDependencies.ts).
 *
 * When a workflow uses an enum widget value (sampler_name/scheduler/…) that a
 * source-side custom package injected into a core node's dropdown (e.g. RES4LYF
 * adds `res_2s`/`bong_tangent` to KSampler), the fix that keeps the workflow
 * IDENTICAL to source is to INSTALL that package on the target — never to
 * substitute the value. This module automates the 4-phase loop proven by hand:
 *
 *   1. baseline  — GET /object_info, is the value already present?
 *   2. install   — git clone the repo into custom_nodes/ + pip install reqs
 *   3. reload    — restart ComfyUI, wait for /object_info
 *   4. verify    — GET /object_info again, assert the value now appears
 *
 * The core is pure/injectable (fetchObjectInfo, runInstall, reloadComfyui) so the
 * orchestrator can drive real local/ssh execution and tests can mock it.
 */

/** object_info shape (partial) — { NodeType: { input: { required/optional: { slot: [ [enum...], meta ] } } } } */
export type ObjectInfo = Record<
  string,
  { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
>;

export interface EnumRequirement {
  hostNodeType: string; // node whose dropdown carries the value, e.g. "KSampler"
  slot: string; // "sampler_name" | "scheduler" | …
  value: string; // "res_2s" | "bong_tangent" | …
}

export interface EnumPackageInstallInput {
  repo: string; // git url to clone
  requirements: EnumRequirement[]; // values that must appear after install
  /** Fetch the target's current object_info (undefined/throw ⇒ ComfyUI down). */
  fetchObjectInfo: () => Promise<ObjectInfo | undefined>;
  /** Clone repo + pip install on the target (local or ssh). Resolve on success. */
  runInstall: (repo: string) => Promise<{ ok: boolean; detail: string; commit?: string }>;
  /** Restart ComfyUI and wait until /object_info responds again. */
  reloadComfyui: () => Promise<{ ok: boolean; detail: string }>;
}

export interface EnumRequirementResult extends EnumRequirement {
  presentBefore: boolean;
  presentAfter: boolean;
}

export interface EnumPackageInstallReport {
  repo: string;
  outcome: "already_satisfied" | "installed_verified" | "install_failed" | "verify_failed" | "comfyui_unreachable";
  requirements: EnumRequirementResult[];
  commit?: string;
  detail: string;
}

/** Does object_info list `value` in `hostNodeType`.`slot`'s enum options? */
export function enumValuePresent(
  objectInfo: ObjectInfo | undefined,
  req: EnumRequirement
): boolean {
  const def = objectInfo?.[req.hostNodeType];
  if (!def?.input) return false;
  for (const bucket of [def.input.required, def.input.optional]) {
    const spec = bucket?.[req.slot];
    if (Array.isArray(spec) && Array.isArray(spec[0]) && (spec[0] as unknown[]).includes(req.value)) {
      return true;
    }
  }
  return false;
}

/**
 * Run the 4-phase install+verify loop. Deterministic + idempotent:
 * - if every requirement is already present → `already_satisfied` (no install).
 * - install → reload → verify; any requirement still missing → `verify_failed`.
 * Never substitutes. Returns a structured report; the caller decides whether a
 * failure becomes a human gate (substitution is a human-approved last resort).
 */
export async function installAndVerifyEnumPackage(
  input: EnumPackageInstallInput
): Promise<EnumPackageInstallReport> {
  const { repo, requirements } = input;

  // Phase 1 — baseline
  let before: ObjectInfo | undefined;
  try {
    before = await input.fetchObjectInfo();
  } catch {
    before = undefined;
  }
  if (!before) {
    return {
      repo,
      outcome: "comfyui_unreachable",
      requirements: requirements.map((r) => ({ ...r, presentBefore: false, presentAfter: false })),
      detail: "Could not fetch target /object_info before install (ComfyUI not reachable)."
    };
  }
  const presentBefore = new Map(requirements.map((r) => [reqKey(r), enumValuePresent(before, r)]));
  if (requirements.every((r) => presentBefore.get(reqKey(r)))) {
    return {
      repo,
      outcome: "already_satisfied",
      requirements: requirements.map((r) => ({ ...r, presentBefore: true, presentAfter: true })),
      detail: "All required enum values already present on target — package already installed."
    };
  }

  // Phase 2 — install
  const install = await input.runInstall(repo);
  if (!install.ok) {
    return {
      repo,
      outcome: "install_failed",
      requirements: requirements.map((r) => ({
        ...r,
        presentBefore: presentBefore.get(reqKey(r)) ?? false,
        presentAfter: presentBefore.get(reqKey(r)) ?? false
      })),
      commit: install.commit,
      detail: `Install failed: ${install.detail}`
    };
  }

  // Phase 3 — reload
  const reload = await input.reloadComfyui();
  if (!reload.ok) {
    return {
      repo,
      outcome: "install_failed",
      requirements: requirements.map((r) => ({
        ...r,
        presentBefore: presentBefore.get(reqKey(r)) ?? false,
        presentAfter: false
      })),
      commit: install.commit,
      detail: `Installed but ComfyUI failed to reload: ${reload.detail}`
    };
  }

  // Phase 4 — verify
  let after: ObjectInfo | undefined;
  try {
    after = await input.fetchObjectInfo();
  } catch {
    after = undefined;
  }
  const results: EnumRequirementResult[] = requirements.map((r) => ({
    ...r,
    presentBefore: presentBefore.get(reqKey(r)) ?? false,
    presentAfter: enumValuePresent(after, r)
  }));
  const allPresent = results.every((r) => r.presentAfter);
  return {
    repo,
    outcome: allPresent ? "installed_verified" : "verify_failed",
    requirements: results,
    commit: install.commit,
    detail: allPresent
      ? `Installed ${repo} and verified all ${results.length} enum value(s) now present in target /object_info.`
      : `Installed ${repo} but these values are still missing after reload: ${results
          .filter((r) => !r.presentAfter)
          .map((r) => `${r.hostNodeType}.${r.slot}="${r.value}"`)
          .join(", ")}. Do NOT substitute silently — surface a human gate.`
  };
}

function reqKey(r: EnumRequirement): string {
  return `${r.hostNodeType}\0${r.slot}\0${r.value}`;
}
