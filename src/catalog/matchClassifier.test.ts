import { describe, expect, it } from "vitest";
import { classifyCatalogMatch, routeCreatesOrUpdatesRecord } from "./matchClassifier";
import type { XpuNodeRecord } from "./schema";

function rec(over: Partial<XpuNodeRecord> = {}): XpuNodeRecord {
  return {
    schemaVersion: 1,
    nodeKey: "owner__pkg",
    packageName: "pkg",
    repository: "https://github.com/owner/pkg",
    nodeTypePrefixes: ["Pkg"],
    execution: "xpu",
    xpuSupport: "patched",
    tier: "trusted",
    commit: "abc123",
    supportedDtypes: ["fp8_e4m3fn"],
    version: 1,
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    ...over
  };
}

describe("classifyCatalogMatch", () => {
  it("miss when no record", () => {
    expect(classifyCatalogMatch(null)).toBe("miss");
    expect(classifyCatalogMatch(undefined)).toBe("miss");
  });

  it("apply-known: trusted, commit + dtype match", () => {
    expect(classifyCatalogMatch(rec(), { commit: "abc123", dtype: "fp8_e4m3fn" })).toBe("apply-known");
  });

  it("adapt: trusted, dtype matches but commit drifted", () => {
    expect(classifyCatalogMatch(rec(), { commit: "def456", dtype: "fp8_e4m3fn" })).toBe("adapt");
  });

  it("explore: dtype drift forces re-migration regardless of tier/commit", () => {
    expect(classifyCatalogMatch(rec(), { commit: "abc123", dtype: "bf16" })).toBe("explore");
    // even a candidate with dtype drift → explore
    expect(classifyCatalogMatch(rec({ tier: "candidate" }), { dtype: "bf16" })).toBe("explore");
  });

  it("apply-candidate: candidate hit, no dtype drift", () => {
    expect(classifyCatalogMatch(rec({ tier: "candidate" }), { commit: "abc123", dtype: "fp8_e4m3fn" })).toBe("apply-candidate");
    // commit drift on a candidate still routes to apply-candidate (agent validates/adapts within)
    expect(classifyCatalogMatch(rec({ tier: "candidate" }), { commit: "zzz", dtype: "fp8_e4m3fn" })).toBe("apply-candidate");
  });

  it("explore: an unsupported record is re-attempted", () => {
    expect(classifyCatalogMatch(rec({ tier: "unsupported" }), { dtype: "fp8_e4m3fn" })).toBe("explore");
  });

  it("dtype-agnostic record (no supportedDtypes) matches any dtype", () => {
    expect(classifyCatalogMatch(rec({ supportedDtypes: [] }), { commit: "abc123", dtype: "anything" })).toBe("apply-known");
  });

  it("missing context (no commit/dtype) treated as match, not drift", () => {
    expect(classifyCatalogMatch(rec(), {})).toBe("apply-known");
  });

  it("versionsSupported set counts as a commit match", () => {
    expect(classifyCatalogMatch(rec({ versionsSupported: ["def456"] }), { commit: "def456", dtype: "fp8_e4m3fn" })).toBe("apply-known");
  });

  it("routeCreatesOrUpdatesRecord: apply-known is the only route that does NOT create/update", () => {
    expect(routeCreatesOrUpdatesRecord("apply-known")).toBe(false);
    for (const r of ["adapt", "apply-candidate", "explore", "miss"] as const) {
      expect(routeCreatesOrUpdatesRecord(r)).toBe(true);
    }
  });
});
