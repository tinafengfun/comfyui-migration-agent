import fs from "node:fs/promises";
import path from "node:path";

export interface TaskWorkspaceLayout {
  taskId: string;
  root: string;
  sourceDir: string;
  workflowPath: string;
  artifactPath: string;
  cacheDir: string;
  customNodeCacheDir: string;
  comfyUserDir: string;
  outputsDir: string;
  previewOutputDir: string;
  validationRunsDir: string;
  guiAcceptanceDir: string;
  logsDir: string;
  sdkLogPath: string;
  packageDir: string;
  packageManifestPath: string;
  bundlePath: string;
  taskStatePath: string;
}

export async function createTaskWorkspace(input: {
  workspaceRootPath: string;
  taskId: string;
  workflowFileName: string;
  modelStorageRoot: string;
}): Promise<TaskWorkspaceLayout> {
  const layout = getTaskWorkspaceLayout(input);
  assertInsideWorkspaceRoot(input.workspaceRootPath, layout.root);
  await Promise.all([
    fs.mkdir(layout.sourceDir, { recursive: true }),
    fs.mkdir(layout.artifactPath, { recursive: true }),
    fs.mkdir(layout.customNodeCacheDir, { recursive: true }),
    fs.mkdir(layout.comfyUserDir, { recursive: true }),
    fs.mkdir(layout.previewOutputDir, { recursive: true }),
    fs.mkdir(layout.validationRunsDir, { recursive: true }),
    fs.mkdir(layout.guiAcceptanceDir, { recursive: true }),
    fs.mkdir(layout.logsDir, { recursive: true }),
    fs.mkdir(layout.packageDir, { recursive: true })
  ]);
  await writePackageManifest(layout, input.modelStorageRoot);
  return layout;
}

export function getTaskWorkspaceLayout(input: {
  workspaceRootPath: string;
  taskId: string;
  workflowFileName: string;
}): TaskWorkspaceLayout {
  const root = path.join(path.resolve(input.workspaceRootPath), input.taskId);
  const sourceDir = path.join(root, "source");
  const artifactPath = path.join(root, "artifacts");
  const cacheDir = path.join(root, "cache");
  const outputsDir = path.join(root, "outputs");
  const logsDir = path.join(root, "logs");
  const packageDir = path.join(root, "package");
  const workflowFileName = safeWorkflowFileName(input.workflowFileName);
  return {
    taskId: input.taskId,
    root,
    sourceDir,
    workflowPath: path.join(sourceDir, workflowFileName),
    artifactPath,
    cacheDir,
    customNodeCacheDir: path.join(cacheDir, "custom_nodes"),
    comfyUserDir: path.join(cacheDir, "comfyui-user"),
    outputsDir,
    previewOutputDir: path.join(outputsDir, "previews"),
    validationRunsDir: path.join(outputsDir, "validation-runs"),
    guiAcceptanceDir: path.join(outputsDir, "gui-acceptance"),
    logsDir,
    sdkLogPath: path.join(logsDir, "sdk-session.jsonl"),
    packageDir,
    packageManifestPath: path.join(packageDir, "manifest.json"),
    bundlePath: path.join(packageDir, "migration-bundle.zip"),
    taskStatePath: path.join(root, "task-state.json")
  };
}

export function getLayoutForTask(task: {
  id: string;
  workspacePath: string;
  workflowPath: string;
  artifactPath: string;
}): TaskWorkspaceLayout {
  const root = path.resolve(task.workspacePath);
  const sourceDir = path.dirname(task.workflowPath);
  const cacheDir = path.join(root, "cache");
  const outputsDir = path.join(root, "outputs");
  const logsDir = path.join(root, "logs");
  const packageDir = path.join(root, "package");
  return {
    taskId: task.id,
    root,
    sourceDir,
    workflowPath: task.workflowPath,
    artifactPath: task.artifactPath,
    cacheDir,
    customNodeCacheDir: path.join(cacheDir, "custom_nodes"),
    comfyUserDir: path.join(cacheDir, "comfyui-user"),
    outputsDir,
    previewOutputDir: path.join(outputsDir, "previews"),
    validationRunsDir: path.join(outputsDir, "validation-runs"),
    guiAcceptanceDir: path.join(outputsDir, "gui-acceptance"),
    logsDir,
    sdkLogPath: path.join(logsDir, "sdk-session.jsonl"),
    packageDir,
    packageManifestPath: path.join(packageDir, "manifest.json"),
    bundlePath: path.join(packageDir, "migration-bundle.zip"),
    taskStatePath: path.join(root, "task-state.json")
  };
}

export async function deleteTaskWorkspace(
  workspaceRootPath: string,
  workspacePath: string
): Promise<void> {
  assertInsideWorkspaceRoot(workspaceRootPath, workspacePath);
  const resolved = path.resolve(workspacePath);
  await fs.rm(resolved, { recursive: true, force: true });
}

async function writePackageManifest(layout: TaskWorkspaceLayout, modelStorageRoot: string): Promise<void> {
  const manifest = {
    manifestVersion: "migration-workspace-v1",
    taskId: layout.taskId,
    createdAt: new Date().toISOString(),
    layout: {
      sourceWorkflow: relative(layout, layout.workflowPath),
      taskState: relative(layout, layout.taskStatePath),
      artifacts: relative(layout, layout.artifactPath),
      cache: relative(layout, layout.cacheDir),
      customNodeCache: relative(layout, layout.customNodeCacheDir),
      comfyUser: relative(layout, layout.comfyUserDir),
      outputs: relative(layout, layout.outputsDir),
      previews: relative(layout, layout.previewOutputDir),
      validationRuns: relative(layout, layout.validationRunsDir),
      guiAcceptance: relative(layout, layout.guiAcceptanceDir),
      logs: relative(layout, layout.logsDir),
      sdkLog: relative(layout, layout.sdkLogPath),
      packageDir: relative(layout, layout.packageDir),
      bundle: relative(layout, layout.bundlePath)
    },
    packagingPolicy: {
      includeLargeModels: false,
      modelStorageRoot,
      note: "Bundle task evidence and reports only; reference large model files by path and digest instead of copying them."
    }
  };
  await fs.writeFile(layout.packageManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertInsideWorkspaceRoot(workspaceRootPath: string, workspacePath: string): void {
  const workspaceRoot = path.resolve(workspaceRootPath);
  const resolved = path.resolve(workspacePath);
  if (resolved === workspaceRoot || !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Refusing to operate on task workspace outside workspace root: ${workspacePath}`);
  }
}

function safeWorkflowFileName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow.json";
}

function relative(layout: TaskWorkspaceLayout, filePath: string): string {
  return path.relative(layout.root, filePath).split(path.sep).join("/");
}
