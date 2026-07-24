import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSharedVenvLockScriptDeployed } from "./sharedVenvLock";

function makeProject(root: string, scriptContent: string): void {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "with-shared-venv-lock.sh"), scriptContent, "utf8");
}

describe("ensureSharedVenvLockScriptDeployed", () => {
  it("deploys the script to <nfsShareRoot>/bin/ when missing", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `svl-deploy-${Date.now()}`);
    const nfsShareRoot = path.join(root, "nfs_share");
    makeProject(root, "#!/usr/bin/env bash\necho v1\n");

    const deployedPath = ensureSharedVenvLockScriptDeployed({ projectRoot: root }, nfsShareRoot);

    expect(deployedPath).toBe(path.join(nfsShareRoot, "bin", "with-shared-venv-lock.sh"));
    expect(fs.readFileSync(deployedPath, "utf8")).toBe("#!/usr/bin/env bash\necho v1\n");
    expect(fs.statSync(deployedPath).mode & 0o777).toBe(0o755);
  });

  it("does not rewrite when already up to date", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `svl-noop-${Date.now()}`);
    const nfsShareRoot = path.join(root, "nfs_share");
    makeProject(root, "#!/usr/bin/env bash\necho v1\n");
    ensureSharedVenvLockScriptDeployed({ projectRoot: root }, nfsShareRoot);
    const deployedPath = path.join(nfsShareRoot, "bin", "with-shared-venv-lock.sh");
    const before = fs.statSync(deployedPath).mtimeMs;

    ensureSharedVenvLockScriptDeployed({ projectRoot: root }, nfsShareRoot);

    const after = fs.statSync(deployedPath).mtimeMs;
    expect(after).toBe(before);
  });

  it("redeploys when the source script has changed", () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `svl-update-${Date.now()}`);
    const nfsShareRoot = path.join(root, "nfs_share");
    makeProject(root, "#!/usr/bin/env bash\necho v1\n");
    const deployedPath = ensureSharedVenvLockScriptDeployed({ projectRoot: root }, nfsShareRoot);
    expect(fs.readFileSync(deployedPath, "utf8")).toContain("v1");

    makeProject(root, "#!/usr/bin/env bash\necho v2\n");
    ensureSharedVenvLockScriptDeployed({ projectRoot: root }, nfsShareRoot);

    expect(fs.readFileSync(deployedPath, "utf8")).toContain("v2");
  });
});
