/**
 * GPU Node Bootstrap — bring a fresh remote to a runnable state and register it.
 *
 * One-shot CLI tool. Each step is idempotent so re-runs skip completed work.
 * GUI never runs this; it's a peer of the GUI for the heavy provisioning path.
 *
 * Usage (full):
 *   npx tsx scripts/bootstrap-gpu-node.mts \
 *     --name remote-a770-48gb \
 *     --host 172.16.114.200 \
 *     --user intel \
 *     --comfyui-root /home/intel/ComfyUI \
 *     --vram-gb 48 \
 *     --allow-sudo
 *
 * Quick verify-only (no provisioning, just register an already-prepped node):
 *   npx tsx scripts/bootstrap-gpu-node.mts \
 *     --name remote-a770-48gb \
 *     --host 172.16.114.200 \
 *     --user intel \
 *     --comfyui-root /home/intel/ComfyUI \
 *     --no-setup-ssh-key --no-install-comfyui --no-setup-nfs
 *
 * Flags:
 *   --name <unique-id>            Required. Node name in gpu-nodes.json.
 *   --host <hostname-or-ip>       Required. SSH target.
 *   --user <username>             Required.
 *   --port <n>                    SSH port (default 22).
 *   --comfyui-root <path>         Required (remote path).
 *   --venv-python <path>          Remote venv python (default ${comfyui-root}/.venv-xpu/bin/python3).
 *   --model-roots <a:b>           Colon-separated remote paths (default /home/intel/hf_models).
 *   --api-host <ip>               ComfyUI API host as seen from the agent (default = --host).
 *   --api-port <n>                Default 8188.
 *   --vram-gb <n>                 Display only.
 *   --local-ip <ip>               For NFS export. Auto-detected via `hostname -I` if omitted.
 *   --key-path <path>             Existing SSH key to use (default ~/.ssh/id_ed25519).
 *   --[no-]setup-ssh-key          Default: yes.
 *   --[no-]install-comfyui        Default: yes.
 *   --[no-]setup-nfs              Default: yes.
 *   --[no-]register               Default: yes.
 *   --allow-sudo                  Required to actually run sudo commands (default: print only).
 *   --force                       Overwrite an existing node with the same name.
 *   --dry-run                     Print every command, run nothing.
 *
 * Exit codes: 0 success, 1 user error, 2 step failure (see stderr for which step).
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as stdinRaw, stdout as stdoutRaw } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  name: string;
  host: string;
  user: string;
  port: number;
  comfyuiRoot: string;
  venvPython: string;
  modelRoots: string[];
  apiHost: string;
  apiPort: number;
  vramGb?: number;
  localIp?: string;
  keyPath: string;
  setupSshKey: boolean;
  installComfyui: boolean;
  setupNfs: boolean;
  register: boolean;
  allowSudo: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean | number> = {
    port: "22",
    apiPort: "8188",
    modelRoots: "/home/intel/hf_models",
    setupSshKey: true,
    installComfyui: true,
    setupNfs: true,
    register: true,
    allowSudo: false,
    force: false,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case "--name": out.name = next(); break;
      case "--host": out.host = next(); break;
      case "--user": out.user = next(); break;
      case "--port": out.port = Number(next()); break;
      case "--comfyui-root": out.comfyuiRoot = next(); break;
      case "--venv-python": out.venvPython = next(); break;
      case "--model-roots": out.modelRoots = next(); break;
      case "--api-host": out.apiHost = next(); break;
      case "--api-port": out.apiPort = Number(next()); break;
      case "--vram-gb": out.vramGb = Number(next()); break;
      case "--local-ip": out.localIp = next(); break;
      case "--key-path": out.keyPath = next(); break;
      case "--setup-ssh-key": out.setupSshKey = true; break;
      case "--no-setup-ssh-key": out.setupSshKey = false; break;
      case "--install-comfyui": out.installComfyui = true; break;
      case "--no-install-comfyui": out.installComfyui = false; break;
      case "--setup-nfs": out.setupNfs = true; break;
      case "--no-setup-nfs": out.setupNfs = false; break;
      case "--register": out.register = true; break;
      case "--no-register": out.register = false; break;
      case "--allow-sudo": out.allowSudo = true; break;
      case "--force": out.force = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }

  const required = ["name", "host", "user", "comfyuiRoot"] as const;
  for (const key of required) {
    if (!out[key]) {
      throw new Error(`--${key.replace(/([A-Z])/g, "-$1").toLowerCase()} is required`);
    }
  }

  return {
    name: String(out.name),
    host: String(out.host),
    user: String(out.user),
    port: Number(out.port),
    comfyuiRoot: String(out.comfyuiRoot),
    venvPython: String(out.venvPython ?? `${out.comfyuiRoot}/.venv-xpu/bin/python3`),
    modelRoots: String(out.modelRoots).split(":").filter(Boolean),
    apiHost: String(out.apiHost ?? out.host),
    apiPort: Number(out.apiPort),
    vramGb: out.vramGb !== undefined ? Number(out.vramGb) : undefined,
    localIp: out.localIp ? String(out.localIp) : undefined,
    keyPath: String(out.keyPath ?? path.join(os.homedir(), ".ssh", "id_ed25519")),
    setupSshKey: Boolean(out.setupSshKey),
    installComfyui: Boolean(out.installComfyui),
    setupNfs: Boolean(out.setupNfs),
    register: Boolean(out.register),
    allowSudo: Boolean(out.allowSudo),
    force: Boolean(out.force),
    dryRun: Boolean(out.dryRun)
  };
}

function printHelp(): void {
  console.log(`GPU Node Bootstrap — bring a fresh remote to a runnable state and register it.

See file header in scripts/bootstrap-gpu-node.mts for full flag reference.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging + shell helpers
// ─────────────────────────────────────────────────────────────────────────────

function step(n: number, total: number, label: string): void {
  console.log(`\n[${n}/${total}] ${label}`);
}

function info(msg: string): void { console.log(`  ${msg}`); }
function warn(msg: string): void { console.warn(`  ⚠ ${msg}`); }
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }

class StepError extends Error {
  constructor(readonly stepLabel: string, message: string) {
    super(`${message} (step: ${stepLabel})`);
    this.name = "StepError";
  }
}

async function run(
  cmd: string,
  args: string[],
  opts: { dryRun: boolean; label?: string; timeoutMs?: number; stdin?: string; allowFail?: boolean } = { dryRun: false }
): Promise<{ stdout: string; stderr: string; code: number }> {
  const label = opts.label ?? `${cmd} ${args.join(" ")}`;
  if (opts.dryRun) {
    console.log(`  [dry-run] ${label}`);
    return { stdout: "", stderr: "", code: 0 };
  }
  info(`$ ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || opts.allowFail) {
        resolve({ stdout, stderr, code: code ?? 0 });
      } else {
        reject(new StepError(opts.label ?? cmd, `exit ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function sshArgs(args: Args, remoteCmd: string, opts: { batchMode?: boolean; keyPath?: string } = {}): string[] {
  const port = String(args.port);
  const a = [
    "-p", port,
    "-o", `BatchMode=${opts.batchMode === false ? "no" : "yes"}`,
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new"
  ];
  if (opts.keyPath ?? args.keyPath) a.push("-i", opts.keyPath ?? args.keyPath);
  a.push(`${args.user}@${args.host}`, remoteCmd);
  return a;
}

async function ssh(args: Args, remoteCmd: string, opts: { dryRun: boolean; batchMode?: boolean; label?: string; stdin?: string; allowFail?: boolean } = { dryRun: false }): Promise<{ stdout: string; stderr: string; code: number }> {
  return run("ssh", sshArgs(args, remoteCmd, { batchMode: opts.batchMode, keyPath: args.keyPath }), {
    dryRun: opts.dryRun,
    label: opts.label ?? `ssh ${args.user}@${args.host} '${remoteCmd.length > 80 ? remoteCmd.slice(0, 77) + "..." : remoteCmd}'`,
    stdin: opts.stdin,
    allowFail: opts.allowFail
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

async function preflightSsh(args: Args): Promise<void> {
  step(1, 5, "SSH connectivity pre-flight");
  // Try passwordless first; fall back to allowing password prompt.
  const passwordless = await run("ssh", sshArgs(args, "echo OK", { batchMode: true }), {
    dryRun: args.dryRun,
    allowFail: true
  });
  if (passwordless.code === 0) {
    ok(`Passwordless SSH already works to ${args.user}@${args.host}.`);
    return;
  }
  // Allow one interactive password attempt.
  info("Passwordless SSH failed. Trying once with BatchMode=no (may prompt for password)...");
  const interactive = await run("ssh", sshArgs(args, "echo OK", { batchMode: false }), {
    dryRun: args.dryRun,
    allowFail: true
  });
  if (interactive.code !== 0) {
    throw new StepError("SSH pre-flight", `Cannot reach ${args.user}@${args.host}. Check network / credentials.`);
  }
  ok(`SSH works to ${args.user}@${args.host} (currently using password auth).`);
}

async function setupSshKey(args: Args): Promise<void> {
  step(2, 5, "SSH key setup");
  if (!existsSync(args.keyPath)) {
    info(`Generating new Ed25519 key at ${args.keyPath}...`);
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", args.keyPath], { dryRun: args.dryRun });
  } else {
    ok(`Key already exists: ${args.keyPath}`);
  }

  // Verify passwordless with this key.
  const verify = await run("ssh", sshArgs(args, "echo OK"), { dryRun: args.dryRun, allowFail: true });
  if (verify.code === 0) {
    ok(`Passwordless SSH via ${args.keyPath} works.`);
    return;
  }
  if (args.dryRun) return;

  // Run ssh-copy-id (will prompt for remote password once).
  info(`Installing public key on remote with ssh-copy-id (you may be prompted for ${args.user}@${args.host}'s password)...`);
  const result = await run("ssh-copy-id", [
    "-i", `${args.keyPath}.pub`,
    "-p", String(args.port),
    `${args.user}@${args.host}`
  ], { dryRun: args.dryRun, allowFail: true });
  if (result.code !== 0) {
    throw new StepError("SSH key setup", `ssh-copy-id failed: ${result.stderr || result.stdout}`);
  }
  // Re-verify.
  const reverify = await run("ssh", sshArgs(args, "echo OK"), { dryRun: args.dryRun, allowFail: true });
  if (reverify.code !== 0) {
    throw new StepError("SSH key setup", "Key installed but passwordless still fails. Check remote sshd config (PubkeyAuthentication yes).");
  }
  ok(`Passwordless SSH established via ${args.keyPath}.`);
}

async function installComfyui(args: Args): Promise<void> {
  step(3, 5, "Remote ComfyUI install");

  // Already installed?
  const check = await ssh(args, `test -f ${shellQuote(args.comfyuiRoot + "/main.py")} && echo yes || echo no`, {
    dryRun: args.dryRun,
    allowFail: true
  });
  if (check.stdout.trim() === "yes") {
    ok(`ComfyUI already exists at ${args.comfyuiRoot} — skipping clone.`);
  } else {
    info(`Cloning ComfyUI into ${args.comfyuiRoot}...`);
    const parent = path.posix.dirname(args.comfyuiRoot);
    const leaf = path.posix.basename(args.comfyuiRoot);
    await ssh(args, `mkdir -p ${shellQuote(parent)} && cd ${shellQuote(parent)} && git clone https://github.com/comfyanonymous/ComfyUI.git ${shellQuote(leaf)}`, { dryRun: args.dryRun });
  }

  // Venv exists?
  const venvCheck = await ssh(args, `test -x ${shellQuote(args.venvPython)} && echo yes || echo no`, {
    dryRun: args.dryRun,
    allowFail: true
  });
  const venvDir = path.posix.dirname(path.posix.dirname(args.venvPython));
  if (venvCheck.stdout.trim() === "yes") {
    ok(`venv python already exists at ${args.venvPython} — skipping create.`);
  } else {
    info(`Creating venv at ${venvDir}...`);
    await ssh(args, `python3 -m venv ${shellQuote(venvDir)}`, { dryRun: args.dryRun });
    info("Upgrading pip...");
    await ssh(args, `${shellQuote(args.venvPython)} -m pip install --upgrade pip`, { dryRun: args.dryRun, timeoutMs: 5 * 60_000 });
    info("Installing torch + torchvision + torchaudio (XPU wheel)...");
    await ssh(
      args,
      `${shellQuote(args.venvPython)} -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu`,
      { dryRun: args.dryRun, timeoutMs: 20 * 60_000 }
    );
    info("Installing ComfyUI requirements.txt...");
    await ssh(
      args,
      `${shellQuote(args.venvPython)} -m pip install -r ${shellQuote(args.comfyuiRoot + "/requirements.txt")}`,
      { dryRun: args.dryRun, timeoutMs: 20 * 60_000 }
    );
  }

  // Verify torch.xpu.is_available()
  info("Verifying torch.xpu.is_available() on remote...");
  const xpuCheck = await ssh(
    args,
    `${shellQuote(args.venvPython)} -c "import torch; print('xpu_available=' + str(torch.xpu.is_available()))"`,
    { dryRun: args.dryRun, allowFail: true }
  );
  if (args.dryRun) return;
  const m = xpuCheck.stdout.match(/xpu_available=(True|False)/);
  if (!m) {
    warn("Could not parse torch.xpu.is_available() output. Continuing (you can debug on the remote).");
  } else if (m[1] === "True") {
    ok("torch.xpu.is_available() = True on the remote.");
  } else {
    warn("torch.xpu.is_available() = False. ComfyUI will start but XPU won't be used. Check drivers / oneAPI runtime on the remote.");
  }
}

async function setupNfs(args: Args): Promise<{ installed: boolean; localIp: string }> {
  step(4, 5, "NFS export + mount");
  const localIp = args.localIp ?? (await detectLocalIp());
  info(`Local IP (for NFS export): ${localIp}`);
  if (!localIp) {
    warn("Could not auto-detect --local-ip. Skipping NFS setup; pass --local-ip explicitly to retry.");
    return { installed: false, localIp };
  }

  const primaryModelRoot = args.modelRoots[0];
  if (!primaryModelRoot) {
    warn("No model_roots configured. Skipping NFS.");
    return { installed: false, localIp };
  }

  const exportLine = `${primaryModelRoot}  ${args.host}/24(ro,sync,no_subtree_check,no_root_squash)`;
  const remoteMountCmd = `sudo mkdir -p ${shellQuote(primaryModelRoot)} && sudo mount -t nfs ${shellQuote(`${localIp}:${primaryModelRoot}`)} ${shellQuote(primaryModelRoot)}`;
  const remoteFstabLine = `${localIp}:${primaryModelRoot}  ${primaryModelRoot}  nfs  ro,hard,nosuid  0 0`;

  if (!args.allowSudo) {
    info("--allow-sudo NOT set. Run these commands manually, then press ENTER to continue:");
    console.log("\n  ── On THIS machine (model server) ──");
    console.log("    # Check /etc/exports has this line (or add it):");
    console.log(`    ${exportLine}`);
    console.log("    sudo exportfs -ra");
    console.log("    sudo systemctl enable --now nfs-server");
    console.log("\n  ── On the REMOTE GPU node ──");
    console.log(`    ${remoteMountCmd}`);
    console.log(`    echo '${remoteFstabLine}' | sudo tee -a /etc/fstab`);
    if (args.dryRun) return { installed: false, localIp };
    const rl = readline.createInterface({ input: stdinRaw, output: stdoutRaw });
    await rl.question("\n  Press ENTER once both sides are done (or Ctrl-C to abort): ");
    rl.close();
  } else {
    info("--allow-sudo set. Running sudo commands (will prompt for sudo password if needed).");
    if (args.dryRun) {
      console.log(`  [dry-run] local:  echo '${exportLine}' | sudo tee -a /etc/exports && sudo exportfs -ra`);
      console.log(`  [dry-run] remote: ${remoteMountCmd}`);
      console.log(`  [dry-run] remote: echo '${remoteFstabLine}' | sudo tee -a /etc/fstab`);
      return { installed: false, localIp };
    }
    const sudoPassword = await promptSudoPasswordOnce();
    // Local export
    await run("sudo", ["-S", "sh", "-c", `grep -qxF ${shellQuote(exportLine)} /etc/exports || echo ${shellQuote(exportLine)} >> /etc/exports; exportfs -ra`], {
      dryRun: false, stdin: sudoPassword + "\n", label: "update local /etc/exports"
    });
    ok("Local NFS export updated.");
    // Remote mount + fstab
    await ssh(
      args,
      `echo ${shellQuote(sudoPassword)} | sudo -S sh -c "mkdir -p ${shellQuote(primaryModelRoot)} && mountpoint -q ${shellQuote(primaryModelRoot)} || mount -t nfs ${shellQuote(`${localIp}:${primaryModelRoot}`)} ${shellQuote(primaryModelRoot)}; grep -qxF ${shellQuote(remoteFstabLine)} /etc/fstab || echo ${shellQuote(remoteFstabLine)} >> /etc/fstab"`,
      { dryRun: false, label: "remote mount + fstab update" }
    );
    ok("Remote NFS mount + fstab updated.");
  }

  // Verify: ls model_roots on remote should return non-empty.
  info("Verifying NFS-same-path...");
  const ls = await ssh(args, `ls -1 ${shellQuote(primaryModelRoot)} 2>/dev/null | head -3`, { dryRun: args.dryRun, allowFail: true });
  if (args.dryRun) return { installed: false, localIp };
  const entries = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) {
    warn(`Remote ${primaryModelRoot} is empty or unreadable. NFS may not be mounted yet.`);
    return { installed: false, localIp };
  }
  ok(`Remote sees ${entries.length}+ entries under ${primaryModelRoot}: ${entries.slice(0, 3).join(", ")}`);
  return { installed: true, localIp };
}

async function detectLocalIp(): Promise<string> {
  try {
    const { stdout } = await run("hostname", ["-I"], { dryRun: false, allowFail: true });
    return stdout.trim().split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

async function promptSudoPasswordOnce(): Promise<string> {
  const rl = readline.createInterface({ input: stdinRaw, output: undefined as unknown as NodeJS.WritableStream });
  // Hide output while typing the password.
  (stdoutRaw as unknown as { muted?: boolean }).muted = true;
  const answer = await rl.question("sudo password (will not echo): ");
  (stdoutRaw as unknown as { muted?: boolean }).muted = false;
  rl.close();
  console.log("");
  return answer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────────────────

async function registerNode(args: Args, nfsResult: { installed: boolean; localIp: string }): Promise<void> {
  step(5, 5, "Register in gpu-nodes.json");

  // Lazy import the server-side helper. tsx resolves the relative path.
  const { loadGpuNodes, saveGpuNodes } = await import("../src/server/gpuNodes.ts");
  const { loadConfig } = await import("../src/server/config.ts");
  const config = loadConfig();

  // Build the node entry.
  const node = {
    name: args.name,
    kind: "ssh" as const,
    ...(args.vramGb !== undefined ? { vram_gb: args.vramGb } : {}),
    comfyui_root: args.comfyuiRoot,
    venv_python: args.venvPython,
    model_roots: args.modelRoots,
    api_host: args.apiHost,
    api_port: args.apiPort,
    launch_flags: ["--reserve-vram", "1"],
    ssh: {
      host: args.host,
      user: args.user,
      port: args.port,
      key_path: args.keyPath
    },
    model_share: (nfsResult.installed ? "nfs_same_path" : "none") as "nfs_same_path" | "none"
  };

  let registry;
  try {
    registry = loadGpuNodes(config);
  } catch {
    // Missing file → loadGpuNodes synthesizes a default. Real errors propagate.
    registry = loadGpuNodes(config);
  }

  const existing = registry.nodes.find((n) => n.name === args.name);
  if (existing && !args.force) {
    if (args.dryRun) {
      console.log(`  [dry-run] would overwrite existing "${args.name}" (--force not set, would prompt)`);
      return;
    }
    const rl = readline.createInterface({ input: stdinRaw, output: stdoutRaw });
    const answer = await rl.question(`Node "${args.name}" already exists. Overwrite? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      warn("Aborted by user. Existing gpu-nodes.json unchanged.");
      return;
    }
  }

  if (args.dryRun) {
    console.log(`  [dry-run] would upsert node ${JSON.stringify(node, null, 2)}`);
    return;
  }

  const without = registry.nodes.filter((n) => n.name !== args.name);
  const updated = { default_node: registry.default_node, nodes: [...without, node] };
  await saveGpuNodes(config, updated);

  ok(`Registered "${args.name}" in ${config.gpuNodesPath}.`);
  console.log(`\nNext steps:`);
  console.log(`  1. Precheck + prepare env deps (custom nodes, sampler packages, xpu, models):`);
  console.log(`       npx tsx scripts/node-precheck.mts --node "${args.name}" --prepare`);
  console.log(`     (prepares a fresh node ONCE so migrations don't trip on missing nodes/packages)`);
  console.log(`  2. Open the web UI and pick "${args.name}" from the GPU node dropdown.`);
  console.log(`  3. Upload a workflow, run to Step 05 — the agent will SSH-launch ComfyUI on the remote.`);
  console.log(`  See scripts/TOOLS.md for the full tool index.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell quoting (single-quote style, like gpuNodes.ts verifySsh)
// ─────────────────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\nSee --help for usage.`);
    process.exit(1);
  }

  console.log(`Bootstrapping GPU node "${args.name}" → ${args.user}@${args.host}:${args.port}`);
  console.log(`  comfyui_root: ${args.comfyuiRoot}`);
  console.log(`  venv_python:  ${args.venvPython}`);
  console.log(`  model_roots:  ${args.modelRoots.join(":")}`);
  console.log(`  options:      ssh-key=${args.setupSshKey} install-comfyui=${args.installComfyui} setup-nfs=${args.setupNfs} register=${args.register} allow-sudo=${args.allowSudo} dry-run=${args.dryRun}`);

  const total = 1
    + (args.setupSshKey ? 1 : 0)
    + (args.installComfyui ? 1 : 0)
    + (args.setupNfs ? 1 : 0)
    + (args.register ? 1 : 0);
  let n = 1;

  try {
    await preflightSsh(args);
    if (args.setupSshKey) { await setupSshKey(args); n++; }
    if (args.installComfyui) { await installComfyui(args); n++; }
    let nfsResult = { installed: false, localIp: "" };
    if (args.setupNfs) { nfsResult = await setupNfs(args); n++; }
    if (args.register) { await registerNode(args, nfsResult); n++; }
    void total; void n;
    console.log("\n✓ Done.");
  } catch (err) {
    if (err instanceof StepError) {
      console.error(`\n✗ FAILED at: ${err.stepLabel}`);
      console.error(`  ${err.message}`);
      console.error(`\nRe-run with the matching --no-* flag to skip completed steps:`);
      console.error(`  --no-setup-ssh-key --no-install-comfyui --no-setup-nfs`);
      process.exit(2);
    }
    throw err;
  }
}

void main();
