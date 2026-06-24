import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  lintWorkspacePurity,
  formatPurityReport,
  type LintOptions
} from "./lintWorkspacePurity";

/**
 * Create a synthetic ComfyUI-shaped git repo at tmpDir with the listed
 * relative paths committed (or untracked). Each entry in `untracked` is
 * written but NOT git-add'd; each entry in `modified` is committed first
 * then overwritten with new content; each entry in `trackedClean` is
 * committed and left alone.
 */
function makeFakeComfyUI(opts: {
  untracked?: string[];
  modified?: Array<{ path: string; original: string; changed: string }>;
  trackedClean?: Array<{ path: string; content: string }>;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), "lint-comfyui-"));
  // Init git with a default identity so commit/modify works without user config.
  const git = (args: string[]) =>
    execSync(`git -C ${root} ${args.join(" ")}`, { stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "lint@test.local"]);
  git(["config", "user.name", "Lint Test"]);

  // Tracked-clean baseline: an existing file that nothing touches.
  for (const f of opts.trackedClean ?? []) {
    mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
    writeFileSync(path.join(root, f.path), f.content);
  }
  // Modified baseline: commit the original first.
  for (const f of opts.modified ?? []) {
    mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
    writeFileSync(path.join(root, f.path), f.original);
  }
  if ((opts.trackedClean ?? []).length > 0 || (opts.modified ?? []).length > 0) {
    git(["add", "."]);
    git(["commit", "-q", "-m", "baseline"]);
  }
  // Apply modifications on top of the baseline.
  for (const f of opts.modified ?? []) {
    writeFileSync(path.join(root, f.path), f.changed);
  }
  // Untracked pollution.
  for (const rel of opts.untracked ?? []) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "pollution\n");
  }
  return root;
}

let roots: string[] = [];
function makeOpts(root: string): LintOptions {
  return { comfyuiRoot: root, allowedSubdirs: ["agent-demo", "patches", "debug-archives"] };
}
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("lintWorkspacePurity classification", () => {
  it("flags .agent-patched backups as errors", () => {
    const root = makeFakeComfyUI({
      untracked: ["server.py.agent-patched", "comfy/foo.py.agent-patched"]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    expect(report.clean).toBe(false);
    expect(report.errors.map((f) => f.gitPath).sort()).toEqual([
      "comfy/foo.py.agent-patched",
      "server.py.agent-patched"
    ]);
    expect(report.errors.every((f) => f.category === "patch_backup")).toBe(true);
  });

  it("flags vim swap files (.swp/.swo) as errors", () => {
    const root = makeFakeComfyUI({
      untracked: [".foo.swp", "xpu-bug-investigation/.bar.py.swo"]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    expect(report.errors.length).toBe(2);
    expect(report.errors.every((f) => f.category === "swap_file")).toBe(true);
  });

  it("flags garbage names: single char, repeated chars, pythonXXX pattern", () => {
    const root = makeFakeComfyUI({
      untracked: ["p", "ppppppppppppppp", "pythonxxxxxxxxxxxxxxxxxx"]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    expect(report.errors.length).toBe(3);
    expect(report.errors.every((f) => f.category === "garbage_name")).toBe(true);
    const names = report.errors.map((f) => f.gitPath).sort();
    expect(names).toEqual(["p", "ppppppppppppppp", "pythonxxxxxxxxxxxxxxxxxx"]);
  });

  it("does NOT flag normal untracked files as garbage (e.g. 'output.png')", () => {
    const root = makeFakeComfyUI({
      untracked: ["output.png", "report.md", "data.csv"]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    // These come through as warnings (untracked_dump), not errors.
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.length).toBe(3);
    expect(report.warnings.every((f) => f.category === "untracked_dump")).toBe(true);
    expect(report.clean).toBe(true); // warnings don't break clean state
  });

  it("reports tracked-file modifications as info, not error", () => {
    const root = makeFakeComfyUI({
      modified: [
        {
          path: "comfy/ops.py",
          original: "def foo(): pass\n",
          changed: "def foo(): return 42\n"
        }
      ]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    expect(report.errors).toHaveLength(0);
    expect(report.infos).toHaveLength(1);
    expect(report.infos[0].category).toBe("tracked_modified");
    expect(report.infos[0].gitPath).toBe("comfy/ops.py");
    expect(report.clean).toBe(true);
  });

  it("skips paths under allowed subdirs (agent-demo/, patches/, debug-archives/)", () => {
    const root = makeFakeComfyUI({
      untracked: [
        "agent-demo/src/server/newFeature.ts",
        "patches/0001-some-fix.patch",
        "debug-archives/task-001-05-2026/repro.py",
        "real_pollution.txt"
      ]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    const paths = report.findings.map((f) => f.gitPath);
    expect(paths).not.toContain("agent-demo/src/server/newFeature.ts");
    expect(paths).not.toContain("patches/0001-some-fix.patch");
    expect(paths).not.toContain("debug-archives/task-001-05-2026/repro.py");
    expect(paths).toContain("real_pollution.txt");
  });

  it("honors custom allowedRoots (absolute prefixes)", () => {
    const root = makeFakeComfyUI({
      untracked: ["somefile.txt"]
    });
    roots.push(root);
    const report = lintWorkspacePurity({
      comfyuiRoot: root,
      allowedSubdirs: [],
      allowedRoots: [path.join(root, "somefile.txt")]
    });
    expect(report.findings).toHaveLength(0);
  });

  it("reports clean when there's nothing to flag", () => {
    const root = makeFakeComfyUI({
      trackedClean: [{ path: "main.py", content: "print('hi')\n" }]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("returns a degenerate report when comfyuiRoot is not a git repo", () => {
    const notGit = mkdtempSync(path.join(tmpdir(), "lint-notgit-"));
    roots.push(notGit);
    const report = lintWorkspacePurity(makeOpts(notGit));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].severity).toBe("info");
    expect(report.findings[0].reason).toMatch(/git status failed/);
    expect(report.clean).toBe(true);
  });

  it("sorts findings by severity (error, warning, info), then path", () => {
    const root = makeFakeComfyUI({
      untracked: ["zzz_warning.txt", "aaa_warning.txt", "p"],
      modified: [
        {
          path: "comfy/ops.py",
          original: "x\n",
          changed: "y\n"
        }
      ]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    const severities = report.findings.map((f) => f.severity);
    expect(severities).toEqual(["error", "warning", "warning", "info"]);
    // Within warnings, alphabetical.
    const warningPaths = report.warnings.map((f) => f.gitPath);
    expect(warningPaths).toEqual(["aaa_warning.txt", "zzz_warning.txt"]);
  });
});

describe("formatPurityReport", () => {
  it("renders a readable report", () => {
    const root = makeFakeComfyUI({
      untracked: ["p", "real_artifact.json"],
      modified: [
        { path: "comfy/ops.py", original: "a\n", changed: "b\n" }
      ]
    });
    roots.push(root);
    const report = lintWorkspacePurity(makeOpts(root));
    const text = formatPurityReport(report);
    expect(text).toContain("errors:      1");
    expect(text).toContain("warnings:    1");
    expect(text).toContain("infos:       1");
    expect(text).toContain("[garbage_name] p");
    expect(text).toContain("[tracked_modified] comfy/ops.py");
  });
});
