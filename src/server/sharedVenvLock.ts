import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config";

/**
 * scripts/with-shared-venv-lock.sh only needs to exist ONCE, centrally, since
 * /nfs_share is already mounted on every docker-runtime node — unlike the
 * docker-image-sync scripts (which have to be scp'd to remote nodes because
 * they operate on the orchestrator's own local script file), this script can
 * simply live on the shared NFS tree and be reachable by path from any node's
 * shell (local bash -c, or ssh), local or remote, with zero transport step.
 *
 * Idempotent: only (re)writes when missing or out of date, so every caller
 * can call this defensively before constructing a pip-install shell command.
 */
export function ensureSharedVenvLockScriptDeployed(
  config: Pick<AppConfig, "projectRoot">,
  nfsShareRoot = "/nfs_share"
): string {
  const sourcePath = path.join(config.projectRoot, "scripts", "with-shared-venv-lock.sh");
  const deployedPath = path.join(nfsShareRoot, "bin", "with-shared-venv-lock.sh");

  const source = fs.readFileSync(sourcePath, "utf8");
  const current = fs.existsSync(deployedPath) ? fs.readFileSync(deployedPath, "utf8") : undefined;
  if (current !== source) {
    fs.mkdirSync(path.dirname(deployedPath), { recursive: true });
    fs.writeFileSync(deployedPath, source, { mode: 0o755 });
    fs.chmodSync(deployedPath, 0o755);
  }
  return deployedPath;
}
