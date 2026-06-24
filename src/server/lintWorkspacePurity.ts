/**
 * Workspace purity linter (§C).
 *
 * Why this exists:
 *   The design doc §4.1 fixes allowed paths for every kind of agent write.
 *   In practice, the agent sometimes writes:
 *     - Patch backups at ComfyUI root (`server.py.agent-patched`)
 *     - Editor swap files in source-audit dirs (`.repro1.py.swp`)
 *     - Garbage from mis-typed shell redirects (`p`, `pppp...`, `pythonxxx...`)
 *     - Output images in `ComfyUI/output/` instead of workspace `outputs/`
 *
 *   Over time these pollute the shared ComfyUI checkout and break reproducibility.
 *   This linter surfaces them so a human can clean them up (or a future
 *   --fix mode can quarantine them).
 *
 * What it does NOT do:
 *   - Auto-fix / delete anything. First cut is report-only.
 *   - Track approved patches. Tracked-file modifications show up as `info`
 *     severity for human review; we don't try to whitelist them automatically
 *     (that needs the patch-application ledger from §E/§I).
 *
 * Algorithm:
 *   1. Run `git status --porcelain` in comfyuiRoot.
 *   2. Split entries by their path: anything under an allowed root (agent demo,
 *      patches, debug-archives) is dropped from the report.
 *   3. Remaining entries are classified by pattern:
 *        - *.agent-patched  → error (leftover patch backup)
 *        - *.swp / *.swo    → error (editor swap file)
 *        - all-same-char or single-char names → error (shell typo / dump)
 *        - tracked-modified (status " M") → info (potential approved patch)
 *        - default (untracked) → warning
 *   4. Sort by severity, then path, for stable diffs.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

export interface PurityFinding {
  /** Absolute path of the offending file. */
  path: string;
  /** Path as git reported it (relative to comfyuiRoot). */
  gitPath: string;
  /** Why this was flagged. */
  reason: string;
  /** Rough classification. */
  category:
    | "patch_backup"
    | "swap_file"
    | "garbage_name"
    | "untracked_dump"
    | "tracked_modified";
  severity: Severity;
  /** Two-char git status code (XY from porcelain v1). */
  gitStatus: string;
}

export interface PurityReport {
  comfyuiRoot: string;
  scannedAt: string;
  findings: PurityFinding[];
  /** Convenience: error-severity findings only. */
  errors: PurityFinding[];
  warnings: PurityFinding[];
  infos: PurityFinding[];
  /** True iff no errors (warnings/infos are allowed in clean state). */
  clean: boolean;
}

export interface LintOptions {
  comfyuiRoot: string;
  /** Subdirs under comfyuiRoot where agent writes are sanctioned. */
  allowedSubdirs?: string[];
  /** Extra allowed-root prefixes (absolute). */
  allowedRoots?: string[];
}

// Default allowed subdirs under ComfyUI root. The agent is permitted to
// leave files here without polluting "real" ComfyUI source.
const DEFAULT_ALLOWED_SUBDIRS = ["agent-demo", "patches", "debug-archives", ".git"];

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the lint. Never throws for missing git repo or git failures —
 * returns a report with a single info-level finding explaining the issue,
 * because a missing ComfyUI git repo is itself a configuration problem
 * the operator should know about.
 */
export function lintWorkspacePurity(opts: LintOptions): PurityReport {
  const comfyuiRoot = path.resolve(opts.comfyuiRoot);
  const allowedSubdirs = opts.allowedSubdirs ?? DEFAULT_ALLOWED_SUBDIRS;
  const allowedRoots = (opts.allowedRoots ?? []).map((p) => path.resolve(p));

  const rawLines = runGitStatus(comfyuiRoot);
  if (typeof rawLines === "string") {
    // git itself failed — return a degenerate report with one info finding.
    const finding: PurityFinding = {
      path: comfyuiRoot,
      gitPath: "(root)",
      reason: `git status failed: ${rawLines}`,
      category: "untracked_dump",
      severity: "info",
      gitStatus: "??"
    };
    return {
      comfyuiRoot,
      scannedAt: new Date().toISOString(),
      findings: [finding],
      errors: [],
      warnings: [],
      infos: [finding],
      clean: true
    };
  }

  const findings: PurityFinding[] = [];
  for (const parsed of rawLines) {
    if (isAllowed(parsed.gitPath, allowedSubdirs, allowedRoots)) continue;
    const finding = classify(parsed, comfyuiRoot);
    findings.push(finding);
  }

  findings.sort(bySeverityThenPath);
  return {
    comfyuiRoot,
    scannedAt: new Date().toISOString(),
    findings,
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
    infos: findings.filter((f) => f.severity === "info"),
    clean: findings.filter((f) => f.severity === "error").length === 0
  };
}

/** Render a report as a human-readable multi-line string. */
export function formatPurityReport(report: PurityReport): string {
  const lines: string[] = [
    `# Workspace purity report`,
    `comfyuiRoot: ${report.comfyuiRoot}`,
    `scannedAt:   ${report.scannedAt}`,
    `clean:       ${report.clean}`,
    `errors:      ${report.errors.length}`,
    `warnings:    ${report.warnings.length}`,
    `infos:       ${report.infos.length}`,
    ""
  ];
  const emit = (label: string, items: PurityFinding[]) => {
    if (items.length === 0) return;
    lines.push(`## ${label} (${items.length})`);
    for (const f of items) {
      lines.push(`- [${f.category}] ${f.gitPath}`);
      lines.push(`    ${f.reason}`);
    }
    lines.push("");
  };
  emit("Errors", report.errors);
  emit("Warnings", report.warnings);
  emit("Infos", report.infos);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedPorcelain {
  gitStatus: string;
  gitPath: string;
}

function runGitStatus(comfyuiRoot: string): ParsedPorcelain[] | string {
  try {
    const out = execFileSync(
      "git",
      // -uall forces file-level listing of untracked dirs; without it, git
      // collapses fully-untracked dirs into a single "dir/" entry and we'd
      // miss nested pollution like comfy/foo.py.agent-patched.
      ["-C", comfyuiRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    // -z separates entries with NUL; each entry is XY <space> PATH.
    // For renames there's also a " -> " form, which we don't split here.
    const entries = out.split("\0").filter((s) => s.length > 0);
    return entries.map((entry) => {
      // First two chars are status, third is space, rest is path.
      const gitStatus = entry.slice(0, 2);
      const gitPath = entry.slice(3);
      return { gitStatus, gitPath };
    });
  } catch (e) {
    return (e as Error).message;
  }
}

function isAllowed(
  gitPath: string,
  allowedSubdirs: string[],
  allowedRoots: string[]
): boolean {
  // Subdir check: top-level path component must be in allowedSubdirs.
  // gitPath is relative to the repo root, so the first segment is the top dir.
  const top = gitPath.split(path.sep)[0];
  if (top && allowedSubdirs.includes(top)) return true;
  // Absolute-prefix check. gitPath is relative, so resolve against cwd.
  // (allowedRoots are passed as absolute paths by callers.)
  for (const root of allowedRoots) {
    const resolved = path.resolve(root);
    if (resolved === gitPath || gitPath === path.basename(resolved)) return true;
    if (gitPath.startsWith(`${resolved}${path.sep}`)) return true;
  }
  return false;
}

function classify(parsed: ParsedPorcelain, comfyuiRoot: string): PurityFinding {
  const abs = path.resolve(comfyuiRoot, parsed.gitPath);
  const base = path.basename(parsed.gitPath);

  // Patch backup suffix from agent's own patch tooling.
  if (base.endsWith(".agent-patched")) {
    return {
      path: abs,
      gitPath: parsed.gitPath,
      reason: "Leftover .agent-patched backup. The patch should be re-applied cleanly or removed.",
      category: "patch_backup",
      severity: "error",
      gitStatus: parsed.gitStatus
    };
  }

  // Editor swap files (vim, some others).
  if (base.endsWith(".swp") || base.endsWith(".swo") || base.startsWith(".swp")) {
    return {
      path: abs,
      gitPath: parsed.gitPath,
      reason: "Editor swap file leaked into the workspace. Safe to delete.",
      category: "swap_file",
      severity: "error",
      gitStatus: parsed.gitStatus
    };
  }

  // Garbage names: single character, or runs of a single repeated character,
  // or extremely long repeats. Catches typos like `p`, `pppppp`, `pythonxxxx`.
  if (isGarbageName(base)) {
    return {
      path: abs,
      gitPath: parsed.gitPath,
      reason: "Filename looks like a shell typo or accidental dump. Likely safe to delete.",
      category: "garbage_name",
      severity: "error",
      gitStatus: parsed.gitStatus
    };
  }

  // Tracked modification — could be intentional patch.
  if (parsed.gitStatus[1] === "M" || parsed.gitStatus[0] === "M") {
    return {
      path: abs,
      gitPath: parsed.gitPath,
      reason: "Tracked file modified. If this is an approved recipe patch, link it in patches/; otherwise revert.",
      category: "tracked_modified",
      severity: "info",
      gitStatus: parsed.gitStatus
    };
  }

  // Default: untracked file at ComfyUI root level that the agent shouldn't have written there.
  return {
    path: abs,
    gitPath: parsed.gitPath,
    reason: "Untracked file under ComfyUI root. If this is agent output, move it to workspaces/<taskId>/ or debug-archives/.",
    category: "untracked_dump",
    severity: "warning",
    gitStatus: parsed.gitStatus
  };
}

/**
 * Heuristic for accidental dumps. Conservative — only flags obvious cases:
 *   - 1-2 character names without extension
 *   - Names consisting entirely of one repeated character (3+ chars)
 *   - Names like "pythonXXXXX..." or "nodeXXX..." (long runs of one repeated letter)
 */
function isGarbageName(name: string): boolean {
  // Strip a leading dot so ".p" doesn't sneak through; we still want ".swp"
  // to be handled by the swap_file branch above, so bail if it's a dotfile.
  if (name.startsWith(".")) return false;

  const stripped = name.replace(/\.[a-zA-Z0-9]+$/, ""); // drop one extension
  if (stripped.length === 0) return false;
  if (stripped.length <= 2) return true;

  // All-same-character check (e.g. "pppppp", "xxxxxxxxxxxx").
  const first = stripped[0];
  if ([...stripped].every((c) => c === first)) return true;

  // "pythonXXXX..." / "nodeXXXX..." patterns: a word prefix followed by a long
  // run of the same letter.
  const m = stripped.match(/^([a-z]+?)([a-z])\2{4,}$/i);
  if (m && m[1].length >= 2) return true;

  return false;
}

function bySeverityThenPath(a: PurityFinding, b: PurityFinding): number {
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  if (order[a.severity] !== order[b.severity]) {
    return order[a.severity] - order[b.severity];
  }
  return a.gitPath.localeCompare(b.gitPath);
}
