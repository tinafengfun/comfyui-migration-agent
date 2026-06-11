import fs from "node:fs";
import path from "node:path";

// Default model root — can be overridden via MODEL_ROOTS env var.
// Kept as a constant for backward compat with assetAcquisition and assetSourceCli.
export const demoModelRoot = process.env.MODEL_ROOTS?.split(":")[0]
  || process.env.MODEL_ROOT
  || "/opt/models";

export interface AppConfig {
  port: number;
  projectRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  draftDocRoot: string;
  comfyuiRoot: string;
  comfyuiVenv: string;          // Python venv directory (e.g. /opt/ComfyUI/.venv-xpu)
  comfyuiPython: string;        // Full path to python3 binary inside venv
  modelRoots: string[];
  copilotCliPath?: string;
  autoApproveAgentPermissions: boolean;
}

const projectRoot = process.cwd();

function resolveFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function loadConfig(): AppConfig {
  // ComfyUI root — REQUIRED. Must point to a ComfyUI checkout with main.py.
  const comfyuiRoot = resolveFromProject(
    process.env.COMFYUI_ROOT ?? defaultComfyUiRoot()
  );

  // ComfyUI Python venv — defaults to .venv-xpu inside ComfyUI root
  const comfyuiVenv = process.env.COMFYUI_VENV
    ? resolveFromProject(process.env.COMFYUI_VENV)
    : path.join(comfyuiRoot, ".venv-xpu");
  const comfyuiPython = path.join(comfyuiVenv, "bin", "python3");

  // Model roots — no hardcoded default; must be configured via env
  const configuredModelRoots = (process.env.MODEL_ROOTS ?? process.env.MODEL_ROOT ?? "")
    .split(":")
    .filter(Boolean)
    .map(resolveFromProject);

  return {
    port: Number(process.env.PORT ?? "3001"),
    projectRoot,
    workspaceRoot: resolveFromProject(process.env.DEMO_WORKSPACE_ROOT ?? "workspaces"),
    stateRoot: resolveFromProject(process.env.DEMO_STATE_ROOT ?? ".demo-state"),
    // Default to bundled prompts/ dir; fall back to ComfyUI docs/draft for backwards compat
    draftDocRoot: resolveFromProject(
      process.env.DRAFT_DOC_ROOT ?? defaultDraftDocRoot(comfyuiRoot)
    ),
    comfyuiRoot,
    comfyuiVenv,
    comfyuiPython,
    modelRoots: uniquePaths(configuredModelRoots),
    copilotCliPath: process.env.COPILOT_CLI_PATH,
    autoApproveAgentPermissions: process.env.MIGRATION_AGENT_AUTO_APPROVE !== "0"
  };
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map(resolveFromProject))];
}

function defaultComfyUiRoot(): string {
  // Try sibling ComfyUI directory (agent-demo sits inside ComfyUI checkout)
  const siblingCheckout = resolveFromProject("..");
  if (fs.existsSync(path.join(siblingCheckout, "main.py"))) return siblingCheckout;
  // Try parent of agent-demo's parent (ComfyUI/agent-demo → ComfyUI)
  const parentCheckout = resolveFromProject("../..");
  if (fs.existsSync(path.join(parentCheckout, "main.py"))) return parentCheckout;
  // Fallback: assume current directory
  return projectRoot;
}

function defaultDraftDocRoot(comfyuiRoot: string): string {
  // Prefer bundled prompts/ dir (self-contained repo)
  const bundled = resolveFromProject("prompts");
  if (fs.existsSync(path.join(bundled, "migration-workflow-v2"))) return bundled;
  // Fall back to ComfyUI docs/draft for backwards compatibility
  return path.join(comfyuiRoot, "docs/draft");
}
