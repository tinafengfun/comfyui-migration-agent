/**
 * Thin git wrapper for the catalog working clone (a checkout of the independent
 * comfyui-xpu-catalog repo). Only the single catalog-server process uses this;
 * it is the sole committer/pusher, so there is never a multi-writer git race.
 *
 * Local commit is synchronous + fast (tiny repo). Push is async (network) and is
 * driven by the writer's push queue — a push failure (proxy down, offline) never
 * blocks a write: the commit is durable locally on /nfs_share and the push is
 * retried. On the deploy host, `git push` inherits the host git proxy config
 * (proxy.ims.intel.com:911 + Intel CA), so this code sets no proxy itself.
 */
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFile = promisify(execFileCb);

export interface GitRepoOptions {
  /** Optional remote URL; when set, ensureClone() clones/fetches it. */
  remote?: string;
  branch?: string;
  /** Committer identity (defaults to a bot identity). */
  authorName?: string;
  authorEmail?: string;
}

export class GitRepo {
  readonly dir: string;
  readonly branch: string;
  private readonly remote?: string;
  private readonly authorName: string;
  private readonly authorEmail: string;

  constructor(dir: string, opts: GitRepoOptions = {}) {
    this.dir = dir;
    this.remote = opts.remote;
    this.branch = opts.branch ?? "main";
    this.authorName = opts.authorName ?? "xpu-catalog-bot";
    this.authorEmail = opts.authorEmail ?? "xpu-catalog-bot@intel.local";
  }

  private gitSync(args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
      env: process.env
    }).trim();
  }

  /** Ensure `dir` is a git repo on `branch` with identity set. Clones the remote if given. */
  ensureRepo(): void {
    const dotGit = path.join(this.dir, ".git");
    if (!fs.existsSync(dotGit)) {
      fs.mkdirSync(this.dir, { recursive: true });
      // If a remote is configured and the dir is empty, we still init locally and
      // wire the remote — a real clone happens on first fetch/pull. This keeps the
      // server bootable offline (the working clone is the source of truth on NFS).
      this.gitSync(["init", "-q", "-b", this.branch]);
      if (this.remote) {
        try {
          this.gitSync(["remote", "add", "origin", this.remote]);
        } catch {
          /* remote already present */
        }
      }
    }
    this.gitSync(["config", "user.name", this.authorName]);
    this.gitSync(["config", "user.email", this.authorEmail]);
  }

  /** Stage the given repo-relative paths and commit. Returns the new commit sha (or "" if nothing changed). */
  commitPaths(relPaths: string[], message: string): string {
    if (relPaths.length === 0) return "";
    this.gitSync(["add", "--", ...relPaths]);
    // Nothing staged (identical content) → skip an empty commit.
    const status = this.gitSync(["status", "--porcelain"]);
    if (!status) return "";
    this.gitSync(["commit", "-q", "-m", message]);
    return this.gitSync(["rev-parse", "HEAD"]);
  }

  hasRemote(): boolean {
    if (!this.remote) return false;
    try {
      return this.gitSync(["remote"]).split("\n").includes("origin");
    } catch {
      return false;
    }
  }

  /** Push current branch to origin. Throws on failure (caller's push queue retries). */
  async push(): Promise<void> {
    if (!this.hasRemote()) return; // no remote configured → local-only, nothing to push
    await execFile("git", ["-C", this.dir, "push", "origin", this.branch], {
      env: process.env,
      timeout: 120_000
    });
  }

  /** Pull+rebase from origin before a write to stay current (best-effort). */
  async pullRebase(): Promise<void> {
    if (!this.hasRemote()) return;
    await execFile("git", ["-C", this.dir, "pull", "--rebase", "origin", this.branch], {
      env: process.env,
      timeout: 120_000
    });
  }
}
