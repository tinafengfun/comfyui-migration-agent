import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, StepJob } from "../shared/types";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { serializeStepJobForAgent } from "./promptSkillCompiler";

export interface CliWorkerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  promptPath: string;
  logPath: string;
}

export async function runCopilotCliWorker(
  config: AppConfig,
  job: StepJob,
  emit: (event: Omit<AgentEvent, "id" | "createdAt">) => Promise<void>
): Promise<CliWorkerResult> {
  const agentDir = path.join(job.workspacePath, ".agent");
  await ensureDir(agentDir);
  const promptPath = path.join(agentDir, `step-${job.stepId}-prompt.md`);
  const logPath = path.join(agentDir, `step-${job.stepId}-copilot-cli.log`);
  await fs.writeFile(promptPath, serializeStepJobForAgent(job), "utf8");

  const cliPath = config.copilotCliPath ?? "copilot";
  await emit({
    taskId: job.taskId,
    stepId: job.stepId,
    type: "progress",
    message: `Starting Copilot CLI worker in ${job.workspacePath}`,
    data: { cliPath, promptPath, logPath }
  });

  const child = spawn(cliPath, [], {
    cwd: job.workspacePath,
    env: {
      ...process.env,
      COPILOT_MIGRATION_TASK_ID: job.taskId,
      COPILOT_MIGRATION_STEP_ID: job.stepId
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const logHandle = await fs.open(logPath, "a");
  child.stdin.write(await fs.readFile(promptPath, "utf8"));
  child.stdin.end("\n");

  child.stdout.on("data", (chunk: Buffer) => {
    void logHandle.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    void logHandle.write(chunk);
  });

  const result = await new Promise<Pick<CliWorkerResult, "exitCode" | "signal">>((resolve) => {
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await logHandle.close();

  await emit({
    taskId: job.taskId,
    stepId: job.stepId,
    type: result.exitCode === 0 ? "step_summary" : "step_failed",
    message:
      result.exitCode === 0
        ? "Copilot CLI worker completed."
        : `Copilot CLI worker exited with code ${result.exitCode ?? "null"} signal ${result.signal ?? "null"}.`,
    data: { ...result, promptPath, logPath }
  });

  return { ...result, promptPath, logPath };
}
