import fs from "node:fs";
import path from "node:path";

export const demoModelRoot = "/home/intel/hf_models";

export interface AppConfig {
  port: number;
  projectRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  draftDocRoot: string;
  comfyuiRoot: string;
  modelRoots: string[];
  copilotCliPath?: string;
  autoApproveAgentPermissions: boolean;
}

const projectRoot = process.cwd();

function resolveFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function loadConfig(): AppConfig {
  const comfyuiRoot = resolveFromProject(process.env.COMFYUI_ROOT ?? defaultComfyUiRoot());
  const configuredModelRoots = (process.env.MODEL_ROOTS ?? process.env.MODEL_ROOT ?? demoModelRoot)
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
    modelRoots: uniquePaths([demoModelRoot, ...configuredModelRoots]),
    copilotCliPath: process.env.COPILOT_CLI_PATH,
    autoApproveAgentPermissions: process.env.MIGRATION_AGENT_AUTO_APPROVE !== "0"
  };
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map(resolveFromProject))];
}

function defaultComfyUiRoot(): string {
  const siblingCheckout = resolveFromProject("../ComfyUI");
  if (fs.existsSync(path.join(siblingCheckout, "docs/draft"))) return siblingCheckout;
  const parentCheckout = resolveFromProject("..");
  if (fs.existsSync(path.join(parentCheckout, "docs/draft"))) return parentCheckout;
  return siblingCheckout;
}

function defaultDraftDocRoot(comfyuiRoot: string): string {
  // Prefer bundled prompts/ dir (self-contained repo)
  const bundled = resolveFromProject("prompts");
  if (fs.existsSync(path.join(bundled, "migration-workflow-v2"))) return bundled;
  // Fall back to ComfyUI docs/draft for backwards compatibility
  return path.join(comfyuiRoot, "docs/draft");
}
