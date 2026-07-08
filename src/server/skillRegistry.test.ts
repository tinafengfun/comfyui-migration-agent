/**
 * Tests for skillRegistry.ts (§M).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadRegistry,
  loadActiveSkills,
  findSkillById
} from "./skillRegistry";

let registryPath: string;
let skillsDir: string;

const FP8_SKILL_FM = `---
skillId: fp8-feasibility-checklist
version: 1.0.0
tier: on-demand
trigger:
  stepId: "02"
  condition:
    anyOf:
      - modelPattern: "*fp8*.safetensors"
provenance:
  taskOrigin: "manual"
  createdAt: "2026-06-25"
---
# FP8 skill body
Checklist content here.
`;

const CORE_SKILL_FM = `---
skillId: core-intake
version: 1.0.0
tier: core
provenance:
  taskOrigin: "manual"
  createdAt: "2026-06-25"
---
# Core intake skill
Always loaded.
`;

const BAD_FM = `---
skillId: bad-skill
version: "not-semver"
tier: on-demand
provenance:
  taskOrigin: "manual"
  createdAt: "2026-06-25"
---
Broken frontmatter.
`;

beforeEach(async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "skill-reg-"));
  registryPath = path.join(tmp, "skills-registry.json");
  skillsDir = await mkdtemp(path.join(tmpdir(), "skill-dir-"));
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(path.dirname(registryPath), { recursive: true, force: true });
  await rm(skillsDir, { recursive: true, force: true });
});

async function writeRegistry(active: string[]) {
  await writeFile(registryPath, JSON.stringify({ active, retired: {} }));
}

describe("skillRegistry.loadRegistry", () => {
  it("returns empty maps when registry file does not exist", () => {
    const result = loadRegistry("/nonexistent/registry.json");
    expect(result.active).toEqual([]);
    expect(result.retired).toEqual({});
  });

  it("reads active skill IDs from the registry file", async () => {
    await writeRegistry(["fp8-feasibility-checklist", "core-intake"]);
    const result = loadRegistry(registryPath);
    expect(result.active).toEqual(["fp8-feasibility-checklist", "core-intake"]);
  });

  it("returns empty if registry JSON is corrupt", async () => {
    await writeFile(registryPath, "{ broken json");
    const result = loadRegistry(registryPath);
    expect(result.active).toEqual([]);
  });
});

describe("skillRegistry.loadActiveSkills", () => {
  it("loads valid on-demand skills with frontmatter and body", async () => {
    await writeRegistry(["fp8-feasibility-checklist"]);
    await writeFile(path.join(skillsDir, "fp8-feasibility-checklist.md"), FP8_SKILL_FM);

    const { skills, invalid } = loadActiveSkills(registryPath, skillsDir);
    expect(invalid).toHaveLength(0);
    expect(skills).toHaveLength(1);
    expect(skills[0].frontmatter.skillId).toBe("fp8-feasibility-checklist");
    expect(skills[0].frontmatter.tier).toBe("on-demand");
    expect(skills[0].body).toContain("FP8 skill body");
  });

  it("reports skills missing from disk as invalid", async () => {
    await writeRegistry(["nonexistent-skill"]);
    const { skills, invalid } = loadActiveSkills(registryPath, skillsDir);
    expect(skills).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].skillId).toBe("nonexistent-skill");
    expect(invalid[0].reason).toContain("not found");
  });

  it("reports skills that fail schema validation as invalid", async () => {
    await writeRegistry(["bad-skill"]);
    await writeFile(path.join(skillsDir, "bad-skill.md"), BAD_FM);
    const { skills, invalid } = loadActiveSkills(registryPath, skillsDir);
    expect(skills).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].skillId).toBe("bad-skill");
  });

  it("returns empty result when registry has no active skills", async () => {
    await writeRegistry([]);
    const { skills, invalid } = loadActiveSkills(registryPath, skillsDir);
    expect(skills).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  it("loads multiple skills sorted alphabetically by skillId", async () => {
    await writeRegistry(["fp8-feasibility-checklist", "core-intake"]);
    await writeFile(path.join(skillsDir, "fp8-feasibility-checklist.md"), FP8_SKILL_FM);
    await writeFile(path.join(skillsDir, "core-intake.md"), CORE_SKILL_FM);

    const { skills } = loadActiveSkills(registryPath, skillsDir);
    expect(skills).toHaveLength(2);
    expect(skills[0].frontmatter.skillId).toBe("core-intake");
    expect(skills[1].frontmatter.skillId).toBe("fp8-feasibility-checklist");
  });
});

describe("skillRegistry.findSkillById", () => {
  it("returns the skill entry when found", async () => {
    await writeRegistry(["fp8-feasibility-checklist"]);
    await writeFile(path.join(skillsDir, "fp8-feasibility-checklist.md"), FP8_SKILL_FM);

    const skill = findSkillById("fp8-feasibility-checklist", registryPath, skillsDir);
    expect(skill).toBeDefined();
    expect(skill?.frontmatter.skillId).toBe("fp8-feasibility-checklist");
  });

  it("returns undefined for unknown skillId", async () => {
    await writeRegistry(["fp8-feasibility-checklist"]);
    const skill = findSkillById("unknown", registryPath, skillsDir);
    expect(skill).toBeUndefined();
  });
});
