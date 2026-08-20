import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EXPLORE_ROUNDS,
  attemptsFor,
  bumpAttempt,
  recordExploreAttempt
} from "./exploreBudget";

describe("bumpAttempt (pure)", () => {
  it("increments and flags exhausted at the max (default 3)", () => {
    let s = { attempts: {} as Record<string, number> };
    const r1 = bumpAttempt(s, "k");
    expect(r1).toMatchObject({ attempts: 1, exhausted: false });
    s = r1.state;
    const r2 = bumpAttempt(s, "k");
    expect(r2).toMatchObject({ attempts: 2, exhausted: false });
    s = r2.state;
    const r3 = bumpAttempt(s, "k");
    expect(r3).toMatchObject({ attempts: 3, exhausted: true });
    expect(MAX_EXPLORE_ROUNDS).toBe(3);
  });

  it("tracks node keys independently", () => {
    const a = bumpAttempt({ attempts: {} }, "a");
    const b = bumpAttempt(a.state, "b");
    expect(b.state.attempts).toEqual({ a: 1, b: 1 });
    expect(b.attempts).toBe(1);
  });

  it("respects a custom max", () => {
    const r = bumpAttempt({ attempts: { k: 1 } }, "k", 2);
    expect(r).toMatchObject({ attempts: 2, exhausted: true });
  });
});

describe("recordExploreAttempt (fs-backed)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "explore-budget-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("persists across calls and exhausts at round 3", () => {
    expect(recordExploreAttempt(dir, "owner__pkg")).toMatchObject({ attempts: 1, exhausted: false });
    expect(recordExploreAttempt(dir, "owner__pkg")).toMatchObject({ attempts: 2, exhausted: false });
    expect(recordExploreAttempt(dir, "owner__pkg")).toMatchObject({ attempts: 3, exhausted: true });
    expect(attemptsFor(dir, "owner__pkg")).toBe(3);
    expect(attemptsFor(dir, "other")).toBe(0);
  });

  it("survives a corrupt budget file (starts fresh)", () => {
    fs.writeFileSync(path.join(dir, "catalog-explore-budget.json"), "{ not json");
    expect(recordExploreAttempt(dir, "k")).toMatchObject({ attempts: 1, exhausted: false });
  });
});
