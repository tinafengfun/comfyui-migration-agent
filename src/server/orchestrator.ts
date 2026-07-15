import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentEvent,
  HumanDecision,
  HumanDecisionContext,
  HumanQuestion,
  MigrationStepDefinition,
  MigrationTask
} from "../shared/types";
import type { AppConfig } from "./config";
import {
  ensureAssetAcquisitionJob,
  type AssetAcquisitionUnresolvedItem
} from "./assetAcquisition";
import { ensureAssetPrep } from "./assetPrep";
import { checkRequiredArtifactCompletion, checkRequiredArtifactGate } from "./artifactCompletion";
import { analyzeRunReport } from "./evolutionAnalyzer";
import { computeWorkflowSha256, extractAndSaveRules } from "./workflowKnowledge";
import { generateRunReport } from "./runReport";
import { ensureBranchSmokeAggregate } from "./branchSmokeAggregate";
import {
  CopilotSdkRunner,
  SdkStepTimeoutError,
  type AgentEventSink,
  type HumanDecisionWaiter,
  type SdkRawEventObserver,
  type SdkRunResult
} from "./copilotSdkRunner";
import {
  ContextBudgetExceededError,
  ContextBudgetTracker,
  type ContextBudgetSnapshot
} from "./contextBudget";
import {
  sdkEventToContextBudgetEvent,
  shouldPersistApiEvent
} from "./contextRetention";
import { ensureFeasibility } from "./feasibility";
import { ensureDir, safeJoin, writeJson } from "./fsUtils";
import { HumanApprovalBroker } from "./humanApprovalBroker";
import { ensureIntakePreflight } from "./intakePreflight";
import { loadSourceObjectInfo, buildEnumPackageResolver } from "./sourceObjectInfo";
import {
  compactStoredPhase1TaskState,
  normalizePhase1StepStatus,
  preparePhase1Driver,
  readPhase1TaskState,
  type Phase1StepState,
  type Phase1TaskState
} from "./phase1Agent";
import { compileStepJob } from "./promptSkillCompiler";
import { ensureSourceAuditCheckpoint } from "./sourceAuditCheckpoint";
import type { StateStore } from "./state";
import { ensureStepArtifactScaffold } from "./stepArtifactScaffold";
import { createTaskWorkspace, deleteTaskWorkspace, getLayoutForTask } from "./taskWorkspaces";
import { STEP_OUTPUT_SUBDIR } from "./paths";
import { appendFeedbackEvent, type FeedbackEventInput } from "./feedbackLog";
import { recordRecipeOutcome } from "./analyticsDb";
import { ensureWorkflowInventory } from "./workflowInventory";
import { normalizeWorkflowForApi } from "./workflowNormalize";
import { loadGpuNodes, pickNode, type GpuNode } from "./gpuNodes";

type EventListener = (event: AgentEvent) => void;
type QuestionEventData = Record<string, unknown> & {
  question: string;
  choices: string[];
  allowFreeform: boolean;
  blockingReason: string;
  decisionContext?: HumanDecisionContext;
};

/**
 * Maps a step that runs ComfyUI to the outputs/ subdir its results land in.
 * Used by rerunStep to clean stale runtime outputs so the agent doesn't read
 * expired images/logs from the previous run.
 *
 * The map itself is imported from paths.ts (single source of truth).
 */

class HumanGatePauseError extends Error {
  constructor(readonly stepId: string) {
    super(`Step ${stepId} paused for human decision.`);
    this.name = "HumanGatePauseError";
  }
}

interface StepSdkRunner {
  preflight?: CopilotSdkRunner["preflight"];
  runStep(
    job: Parameters<CopilotSdkRunner["runStep"]>[0],
    emit: AgentEventSink,
    waitForDecision?: HumanDecisionWaiter,
    observeSdkEvent?: SdkRawEventObserver
  ): Promise<SdkRunResult>;
}

export class MigrationOrchestrator {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sdkRunner: StepSdkRunner;
  private readonly approvalBroker = new HumanApprovalBroker();
  private readonly autorunningTasks = new Set<string>();
  private readonly activeStepRuns = new Set<string>();
  // Task IDs that have been hard-stopped/terminated. Their lingering run-locks
  // (held while an in-flight SDK call winds down) must not block new work.
  private readonly hardStoppedTaskIds = new Set<string>();
  private readonly sdkTimeoutRetries = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly steps: MigrationStepDefinition[],
    sdkRunner?: StepSdkRunner
  ) {
    this.sdkRunner = sdkRunner ?? new CopilotSdkRunner(config);
  }

  async createTask(input: {
    name: string;
    workflowFileName: string;
    workflowJson: unknown;
    gpuNode?: string;
  }) {
    await this.prepareExclusiveNewTask();

    const taskId = crypto.randomUUID();
    const layout = await createTaskWorkspace({
      workspaceRootPath: this.config.workspaceRoot,
      taskId,
      workflowFileName: input.workflowFileName
    });
    await fs.writeFile(layout.workflowPath, `${JSON.stringify(input.workflowJson, null, 2)}\n`, "utf8");

    const task = await this.store.createTask({
      id: taskId,
      name: input.name,
      workflowPath: layout.workflowPath,
      workspacePath: layout.root,
      artifactPath: layout.artifactPath,
      steps: this.steps,
      ...(input.gpuNode ? { gpuNode: input.gpuNode } : {})
    });

    await this.store.appendArtifact({
      taskId,
      path: layout.workflowPath,
      relativePath: path.relative(layout.root, layout.workflowPath),
      kind: "workflow"
    });
    await this.store.appendArtifact({
      taskId,
      path: layout.packageManifestPath,
      relativePath: path.relative(layout.root, layout.packageManifestPath),
      kind: "json"
    });

    await this.emit({
      taskId,
      type: "progress",
      message: "Task workspace created.",
      data: {
        workflowPath: layout.workflowPath,
        artifactPath: layout.artifactPath,
        layout: {
          cacheDir: layout.cacheDir,
          outputsDir: layout.outputsDir,
          logsDir: layout.logsDir,
          packageManifestPath: layout.packageManifestPath
        }
      }
    });
    return task;
  }

  async createTaskFromWorkflowFile(input: { name: string; sourcePath: string }) {
    const workflowJson = JSON.parse(await fs.readFile(input.sourcePath, "utf8")) as unknown;
    return this.createTask({
      name: input.name,
      workflowFileName: path.basename(input.sourcePath),
      workflowJson
    });
  }

  async runStep(
    taskId: string,
    stepId: string,
    resumeContext?: Record<string, unknown>,
    options: { pauseOnHumanGate?: boolean } = {}
  ): Promise<void> {
    const runKey = this.stepRunKey(taskId, stepId);
    if (this.activeStepRuns.has(runKey)) {
      throw new Error(`Step is already running in this API process: ${taskId} ${stepId}`);
    }
    await this.reconcileStaleActiveTasks(
      "Before starting a migration step; stale running state from earlier server sessions must not block new work."
    );
    this.assertNoLiveStepRuns(`Start step ${stepId}`);
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const step = this.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);
    const preRunArtifactCompletion = await checkRequiredArtifactCompletion(task, step);
    this.activeStepRuns.add(runKey);

    try {
    await this.store.updateStep(taskId, stepId, "running");
    await this.emit({
      taskId,
      stepId,
      type: "step_started",
      message: `Step ${stepId} ${step.name} started.`
    });

    const job = await compileStepJob({ config: this.config, task, step, resumeContext });
    const jobPath = path.join(task.artifactPath, `${stepId}-step-job.json`);
    await writeJson(jobPath, job);
    await this.emit({
      taskId,
      stepId,
      type: "artifact_created",
      message: `Compiled StepJob for step ${stepId}.`,
      data: { path: jobPath }
    });

    if (stepId === "00") {
      // Source object_info + recipe-backed package resolver enable implicit
      // package-dependency detection (enum widget values injected by a source-side
      // custom package). Best-effort: undefined source info falls back to the
      // comfy-core baseline + recipe mapping.
      const sourceObjectInfo = await loadSourceObjectInfo(this.config);
      if (sourceObjectInfo) {
        const soiPath = path.join(task.artifactPath, "00-source-object-info.json");
        await fs.writeFile(soiPath, `${JSON.stringify(sourceObjectInfo, null, 2)}\n`, "utf8");
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: soiPath,
          relativePath: path.relative(task.workspacePath, soiPath),
          kind: "json"
        });
      }
      const resolveEnumPackage = buildEnumPackageResolver();
      const intake = await ensureIntakePreflight({
        task,
        modelRoots: this.config.modelRoots,
        comfyuiRoot: this.config.comfyuiRoot,
        sourceObjectInfo,
        resolveEnumPackage
      });
      await this.store.appendArtifact({
        taskId,
        stepId,
        path: intake.artifactPath,
        relativePath: path.relative(task.workspacePath, intake.artifactPath),
        kind: "markdown"
      });
      await this.emit({
        taskId,
        stepId,
        type: "artifact_created",
        message: "Created deterministic Step 00 intake preflight artifact.",
        data: {
          path: intake.artifactPath,
          canContinueToFeasibility: intake.canContinueToFeasibility,
          hardStopCount: intake.hardStops.length
        }
      });
      const summary =
        intake.canContinueToFeasibility === "no"
          ? "Step 00 intake preflight completed with dependency-source gaps. Deep source search/download is deferred to Step 01 asset/custom-node resolution."
          : `Step 00 intake preflight completed: ${intake.canContinueToFeasibility}. Deep URL/custom-node source search is deferred to Step 01.`;
      await this.store.updateStep(taskId, stepId, "completed", { summary, error: undefined });
      await this.emit({
        taskId,
        stepId,
        type: "step_completed",
        message: summary,
        data: {
          blockingReason: intake.canContinueToFeasibility === "no" ? "missing_asset" : undefined,
          nextStep: "01",
          artifactPath: intake.artifactPath,
          hardStopCount: intake.hardStops.length,
          searchDeferredToStep: "01"
        }
      });
      return;
    }

    if (stepId === "01") {
      const prep = await ensureAssetPrep({
        task,
        modelRoots: this.config.modelRoots,
        comfyuiRoot: this.config.comfyuiRoot,
        stepId
      });
      await this.store.appendArtifact({
        taskId,
        stepId,
        path: prep.assetsPath,
        relativePath: path.relative(task.workspacePath, prep.assetsPath),
        kind: "log"
      });
      await this.store.appendArtifact({
        taskId,
        stepId,
        path: prep.customNodesPath,
        relativePath: path.relative(task.workspacePath, prep.customNodesPath),
        kind: "markdown"
      });
      await this.emit({
        taskId,
        stepId,
        type: "artifact_created",
        message: "Created deterministic Step 01 asset and custom-node resolution ledgers.",
        data: prep
      });
      if (prep.gapCount > 0) {
        const summary = `Step 01 deterministic prep found ${prep.gapCount} gap(s). Gaps documented in ledgers — SDK agent will validate and attempt resolution.`;
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: summary,
          data: {
            ...prep,
            details: [
              `${prep.modelCount} model references checked`,
              `${prep.customNodeCount} custom-node source hints checked`,
              `${prep.gapCount} documented gap(s) in 01-assets.csv`
            ]
          }
        });
        // Write detailed gate signal for post-SDK validation, but do NOT block SDK agent.
        // The gate will be checked AFTER the SDK agent finishes (line ~494).
        const gapItems = prep.gapDetails ?? [];
        await fs.writeFile(path.join(task.artifactPath, "01-gate-signal.json"), JSON.stringify({
          stepId: "01",
          gated: true,
          category: "missing_asset",
          trigger: "deterministic",
          reason: gapItems.length > 0
            ? `Missing assets require human decision: ${gapItems.map((g: { name: string; kind: string; action: string }) => `${g.name} (${g.kind})`).join("; ")}`
            : `Step 01 found ${prep.gapCount} unresolved asset gap(s).`,
          items: gapItems
        }, null, 2), "utf8");
      }

      await this.emit({
        taskId,
        stepId,
        type: "progress",
        message: `Step 01 deterministic ledgers are ready: ${prep.modelCount} model references, ${prep.customNodeCount} custom-node source hints, no documented gaps. Continuing to SDK agent processing.`,
        data: prep
      });
    }

    if (stepId === "02") {
      const feasibility = await ensureFeasibility({
        task,
        modelRoots: this.config.modelRoots,
        stepId
      });
      await this.store.appendArtifact({
        taskId,
        stepId,
        path: feasibility.artifactPath,
        relativePath: path.relative(task.workspacePath, feasibility.artifactPath),
        kind: "markdown"
      });
      await this.emit({
        taskId,
        stepId,
        type: "artifact_created",
        message: "Created deterministic Step 02 feasibility artifact.",
        data: feasibility
      });
      if (await this.pauseIfArtifactHumanGate(task, step)) return;
      await this.emit({
        taskId,
        stepId,
        type: "progress",
        message: `Step 02 deterministic feasibility precheck is ready: ${feasibility.criticalGapCount} critical source-identical gaps. Continuing to SDK agent processing.`,
        data: feasibility
      });
    }

    if (stepId === "03") {
      const inventory = await ensureWorkflowInventory(task, stepId);
      // GUI→API graph normalization (Step 03½): detect/resolve dependency cycles
      // (e.g. from a non-persisted rgthree group-bypass widget) before execution.
      let normalizationNote = "";
      try {
        const sourceWf = JSON.parse(await fs.readFile(task.workflowPath, "utf8"));
        const { workflow: normalizedWf, report } = normalizeWorkflowForApi(sourceWf);
        const reportPath = path.join(task.artifactPath, `${stepId}-graph-normalization.json`);
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: reportPath,
          relativePath: path.relative(task.workspacePath, reportPath),
          kind: "json"
        });
        if (report.changed) {
          const normalizedPath = path.join(task.artifactPath, `${stepId}-workflow.normalized.json`);
          await fs.writeFile(normalizedPath, `${JSON.stringify(normalizedWf, null, 2)}\n`, "utf8");
          await this.store.appendArtifact({
            taskId,
            stepId,
            path: normalizedPath,
            relativePath: path.relative(task.workspacePath, normalizedPath),
            kind: "json"
          });
          // Make the normalized graph the CANONICAL workflow all downstream steps
          // read: back up the original GUI export, then overwrite task.workflowPath
          // with the normalized (acyclic) graph. Steps 05/07/08 read task.workflowPath
          // directly, so a soft "please use the normalized file" note is not enough —
          // the executed graph must actually be the DAG.
          const guiBackupPath = task.workflowPath.replace(/\.json$/i, "") + ".gui-original.json";
          await fs.copyFile(task.workflowPath, guiBackupPath).catch(() => {});
          await fs.writeFile(task.workflowPath, `${JSON.stringify(normalizedWf, null, 2)}\n`, "utf8");
          normalizationNote = ` Graph normalized: ${report.changes.length} cycle back-edge(s) cut → rewired to image producer ${report.primaryImageProducer}. The source workflow was replaced with the normalized DAG (GUI original backed up to ${path.basename(guiBackupPath)}); Steps 05/07/08 execute the normalized graph.`;
          await this.emit({
            taskId,
            stepId,
            type: "artifact_created",
            message: `Graph normalization applied: ${report.changes.length} cycle(s) resolved. Source workflow replaced with the normalized DAG for execution (GUI original backed up).`
          });
        } else if (!report.isDag || report.unresolved.length) {
          normalizationNote = ` Graph has ${report.unresolved.length} unresolved cycle(s) — see ${stepId}-graph-normalization.json.`;
        }
      } catch (e) {
        normalizationNote = ` Graph normalization skipped: ${(e as Error).message}`;
      }
      await this.store.appendArtifact({
        taskId,
        stepId,
        path: inventory.artifactPath,
        relativePath: path.relative(task.workspacePath, inventory.artifactPath),
        kind: "markdown"
      });
      await this.emit({
        taskId,
        stepId,
        type: "artifact_created",
        message: "Created deterministic Step 03 workflow inventory artifact.",
        data: inventory
      });
      const summary = `Step 03 deterministic workflow inventory completed: ${inventory.nodeCount} nodes, ${inventory.linkCount} links.${normalizationNote}`;
      await this.store.updateStep(taskId, stepId, "completed", { summary, error: undefined });
      await this.emit({
        taskId,
        stepId,
        type: "step_completed",
        message: summary,
        data: inventory
      });
      return;
    }

    if (stepId === "05" && await this.pauseEnvironmentDeploymentOnAssetGaps(task, step)) {
      return;
    }

    if (stepId !== "00" && stepId !== "01" && stepId !== "02" && stepId !== "03" && stepId !== "04") {
      const scaffold = await ensureStepArtifactScaffold(task, step);
      if (scaffold.path) {
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: scaffold.path,
          relativePath: scaffold.relativePath ?? path.relative(task.workspacePath, scaffold.path),
          kind: scaffold.path.endsWith(".json")
            ? "json"
            : scaffold.path.endsWith(".csv")
              ? "log"
              : "markdown"
        });
        await this.emit({
          taskId,
          stepId,
          type: "artifact_created",
          message: scaffold.created
            ? `Created Step ${stepId} in-progress artifact scaffold.`
            : `Step ${stepId} artifact scaffold already exists.`,
          data: scaffold
        });
      }
    }

    if (stepId === "04") {
      const checkpoint = await ensureSourceAuditCheckpoint({
        task,
        comfyuiRoot: this.config.comfyuiRoot
      });
      if (checkpoint.created) {
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: checkpoint.path,
          relativePath: path.relative(task.workspacePath, checkpoint.path),
          kind: "markdown"
        });
        await this.emit({
          taskId,
          stepId,
          type: "artifact_created",
          message: "Created Step 04 source-audit checkpoint before deep SDK analysis.",
          data: checkpoint
        });
      }
    }

    if (stepId === "07") {
      const aggregate = await ensureBranchSmokeAggregate(task);
      if (aggregate.created) {
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: aggregate.path,
          relativePath: path.relative(task.workspacePath, aggregate.path),
          kind: "markdown"
        });
        await this.emit({
          taskId,
          stepId,
          type: "artifact_created",
          message: "Created Step 07 first-stage smoke aggregate from branch evidence.",
          data: aggregate
        });
      }
    }

    if (await this.pauseIfArtifactHumanGate(task, step)) return;

    // Sync input-media files to running ComfyUI before steps that submit prompts (07+)
    const stepNum = parseInt(stepId, 10);
    if (stepNum >= 7) {
      await this.syncInputMediaToComfyUI(task);
    }

    if (preRunArtifactCompletion.complete) {
      const summary = `Step ${stepId} completed from existing required artifact. ${preRunArtifactCompletion.reason}`;
      await this.store.updateStep(taskId, stepId, "completed", { summary, error: undefined });
      await this.emit({
        taskId,
        stepId,
        type: "step_completed",
        message: summary,
        data: preRunArtifactCompletion
      });
      return;
    }

      const result = await this.sdkRunner.runStep(job, async (event) => {
        return this.emit(event);
      }, async (event) => {
        await this.store.updateStep(taskId, stepId, "waiting_for_human");
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Step ${stepId} is waiting for a web human decision.`
        });
        // Replay: check for a pre-recorded decision before pausing or waiting
        const replayDecision = await this.findReplayDecisionForStep(taskId, stepId);
        if (replayDecision) {
          const replayResult: HumanDecision = {
            taskId,
            stepId,
            questionEventId: event.id,
            answer: replayDecision.answer,
            wasFreeform: replayDecision.wasFreeform ?? true,
            decidedAt: new Date().toISOString()
          };
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Replay: auto-injecting SDK decision for Step ${stepId}: "${replayDecision.answer}"`
          });
          await this.store.appendDecision(replayResult);
          await this.store.updateStep(taskId, stepId, "running");
          return replayResult;
        }
        if (options.pauseOnHumanGate) {
          // All steps support multi-round human-agent interaction.
          // Keep the SDK session alive so the agent can process the answer
          // and continue or write final artifacts.
          const decision = await this.approvalBroker.waitForDecision(event);
          await this.store.updateStep(taskId, stepId, "running");
          return decision;
        }
        const decision = await this.approvalBroker.waitForDecision(event);
        await this.store.updateStep(taskId, stepId, "running");
        return decision;
      });
      const summary = result.summary ?? "Copilot SDK session completed without a final assistant summary.";

      // For Step 01: re-evaluate gaps after SDK agent may have resolved them.
      // Remove the deterministic gate signal, then check if gaps remain.
      if (stepId === "01") {
        const detGatePath = path.join(task.artifactPath, "01-gate-signal.json");
        await fs.unlink(detGatePath).catch(() => {});
        // Re-check assets.csv for remaining unresolved gaps
        const remainingGaps = await this.collectAssetGaps(task);
        if (remainingGaps.length > 0) {
          await fs.writeFile(detGatePath, JSON.stringify({
            stepId: "01",
            gated: true,
            category: "missing_asset",
            trigger: "post_sdk_validation",
            reason: `After SDK validation, ${remainingGaps.length} asset(s) still require human decision: ${remainingGaps.map((g: { name: string; kind: string }) => `${g.name} (${g.kind})`).join("; ")}`,
            items: remainingGaps
          }, null, 2), "utf8");
        }
      }

      if (await this.pauseIfArtifactHumanGate(task, step)) return;
      const postRunArtifactCompletion = await checkRequiredArtifactCompletion(task, step, { skipScaffoldCheck: true });
      if (!postRunArtifactCompletion.complete) {
        throw new Error(
          `Step ${stepId} SDK session ended before required evidence was complete. ${postRunArtifactCompletion.reason}`
        );
      }
      // If a hard-stop / terminate landed while the SDK call was in flight, the
      // step is no longer "running" — don't clobber it back to completed (that
      // would make runUntilGate think the step succeeded and advance past the
      // stop). Leave the terminal status as-is.
      const liveStep = (await this.store.getTask(taskId))?.steps.find((s) => s.id === stepId);
      if (liveStep && (liveStep.status === "hard_stopped" || liveStep.status === "terminated")) {
        return;
      }
      await this.store.updateStep(taskId, stepId, "completed", { summary });
      // §H: record recipe outcome for analytics (fire-and-forget).
      recordRecipeOutcome(taskId, stepId, "success");
      await this.emit({
        taskId,
        stepId,
        type: "step_completed",
        message: summary,
        data: { ...result, artifactCompletion: postRunArtifactCompletion }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HumanGatePauseError) {
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Auto-run paused at Step ${stepId} for human input.`
        });
        return;
      }
      if (error instanceof SdkStepTimeoutError) {
        // Retry once on SDK timeout — LLM API transient failures are common
        const retryCount = this.sdkTimeoutRetries.get(runKey) ?? 0;
        if (retryCount < 1) {
          this.sdkTimeoutRetries.set(runKey, retryCount + 1);
          this.activeStepRuns.delete(runKey);
          await this.store.updateStep(taskId, stepId, "running");
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Step ${stepId} SDK timeout (LLM API unresponsive). Retrying (attempt ${retryCount + 1}/1)...`
          });
          return this.runStep(taskId, stepId, undefined, options);
        }
        this.sdkTimeoutRetries.delete(runKey);
        if (await this.pauseIfArtifactHumanGate(task, step, message)) return;
        const artifactCompletion = await checkRequiredArtifactCompletion(task, step);
        if (artifactCompletion.complete) {
          const summary = `Step ${stepId} completed by required artifact after SDK watchdog timeout. ${artifactCompletion.reason}`;
          await this.store.updateStep(taskId, stepId, "completed", { summary });
          await this.emit({
            taskId,
            stepId,
            type: "step_completed",
            message: summary,
            data: { timeout: message, artifactCompletion }
          });
          return;
        }
      }
      const hasOpenHumanQuestion = (await this.store.listEvents(taskId)).some(
        (event) => event.stepId === stepId && event.type === "human_question"
      );
      if (hasOpenHumanQuestion) {
        await this.store.updateStep(taskId, stepId, "waiting_for_human", { error: message });
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Step ${stepId} paused for human input: ${message}`
        });
      } else if (error instanceof SdkStepTimeoutError) {
        // SDK watchdog timed out but the underlying SDK session may still be
        // alive — keep the step in `paused` so the user can resume without
        // losing prior agent context. rerunStep remains available as the
        // heavier "start over" option.
        await this.store.updateStep(taskId, stepId, "paused", { error: message });
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Step ${stepId} paused after SDK timeout. Use resume to continue with the existing session, or re-run to start over. Reason: ${message}`
        });
        // §G.wire: SDK hang is system-side. Capture for Step 13 + opencode escalation triage.
        await this.recordFeedback(taskId, {
          stepId,
          source: "agent_self",
          type: "agent_bug",
          severity: "degrade",
          message: `SDK step timeout: ${message}`,
          proposedAction: "escalate_opencode"
        });
      } else {
        await this.store.updateStep(taskId, stepId, "failed", { error: message });
        // §H: record recipe outcome for analytics (fire-and-forget).
        recordRecipeOutcome(taskId, stepId, "failed");
        await this.emit({
          taskId,
          stepId,
          type: "step_failed",
          message
        });
        // §G.wire: unhandled step failure. Type defaults to comfyui_bug
        // because most runtime failures in step 05/07/08 are XPU/ComfyUI-side,
        // not agent-side. Step 13 will reclassify if the artifact shows otherwise.
        await this.recordFeedback(taskId, {
          stepId,
          source: "agent_self",
          type: "comfyui_bug",
          severity: "blocker",
          message: `Step ${stepId} failed: ${message}`,
          proposedAction: "record_only"
        });
      }
      throw error;
    } finally {
      this.activeStepRuns.delete(runKey);
      this.sdkTimeoutRetries.delete(runKey);
    }
  }

  async runUntilGate(taskId: string): Promise<void> {
    if (this.autorunningTasks.has(taskId)) {
      throw new Error(`Task is already auto-running: ${taskId}`);
    }
    await this.reconcileStaleActiveTasks(
      "Before auto-running a migration task; stale running state from earlier server sessions must be closed."
    );
    this.assertNoLiveStepRuns("Auto-run migration task");
    this.autorunningTasks.add(taskId);
    try {
      await this.emit({
        taskId,
        type: "progress",
        message: "Auto-run started. The task will pause at human gates, hard stops, failures, or completion."
      });
      while (true) {
        const task = await this.store.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        // If the task was hard-stopped / terminated (e.g. by a concurrent
        // terminateWithHardStop) while a step was in flight or between steps,
        // stop the auto-run instead of advancing to the next step.
        if (task.status === "hard_stopped" || task.status === "terminated") {
          await this.emit({
            taskId,
            type: "progress",
            message: `Auto-run stopped: task is ${task.status}.`
          });
          return;
        }
        const blockingStep = task.steps.find((step) =>
          ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(
            step.status
          )
        );
        if (blockingStep) {
          // Replay decision injection: if a step is waiting_for_human and replay
          // decisions are available, auto-inject the matching decision and continue.
          if (blockingStep.status === "waiting_for_human") {
            const injected = await this.tryInjectReplayDecision(taskId, blockingStep.id);
            if (injected) continue; // re-check task state after injection
          }
          await this.emit({
            taskId,
            stepId: blockingStep.id,
            type: "progress",
            message: `Auto-run stopped at Step ${blockingStep.id}: ${blockingStep.status}.`
          });
          return;
        }
        const nextStep = this.steps.find((step) => {
          const state = task.steps.find((item) => item.id === step.id);
          return !state || state.status !== "completed";
        });
        if (!nextStep) {
          await this.emit({
            taskId,
            type: "step_completed",
            message: "Auto-run reached the end of the migration flow."
          });
          // Generate run report for completed pipeline
          await this.writeRunReport(taskId);
          return;
        }
        try {
          await this.runStep(taskId, nextStep.id, undefined, { pauseOnHumanGate: true });
        } catch (error) {
          await this.emit({
            taskId,
            stepId: nextStep.id,
            type: "progress",
            message: `Auto-run stopped after Step ${nextStep.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          });
          // Generate run report even on failure
          await this.writeRunReport(taskId).catch(() => {});
          return;
        }
      }
    } finally {
      this.autorunningTasks.delete(taskId);
    }
  }

  async runPhase1Agent(taskId: string): Promise<void> {
    const runKey = this.stepRunKey(taskId, "phase1");
    if (this.activeStepRuns.has(runKey)) {
      throw new Error(`Phase 1 agent is already running for task: ${taskId}`);
    }
    await this.reconcileStaleActiveTasks(
      "Before starting the Phase 1 monolithic agent; stale running state from earlier server sessions must not block new work."
    );
    this.assertNoLiveStepRuns("Run Phase 1 monolithic agent");
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const decisions = await this.store.listDecisions(taskId);
    const phase1 = await preparePhase1Driver({
      config: this.config,
      task,
      steps: this.steps,
      decisions
    });
    const contextBudget = new ContextBudgetTracker({
      budgetPath: phase1.contextBudgetPath,
      trackedPaths: [
        phase1.promptPath,
        phase1.taskStatePath,
        phase1.runningSummaryPath,
        phase1.contextDebtPath,
        phase1.phase3ExtractionPath,
        phase1.stepHandoffDir
      ]
    });

    const activeStepId = this.firstPhase1StepToMarkRunning(task);
    let phase1SyncTimer: NodeJS.Timeout | undefined;
    this.activeStepRuns.add(runKey);
    try {
      if (activeStepId) {
        await this.store.updateStep(taskId, activeStepId, "running");
      }
      for (const artifactPath of [
        phase1.taskStatePath,
        phase1.promptPath,
        phase1.runningSummaryPath,
        phase1.contextDebtPath,
        phase1.phase3ExtractionPath,
        phase1.contextBudgetPath
      ]) {
        await this.store.appendArtifact({
          taskId,
          stepId: "phase1",
          path: artifactPath,
          relativePath: path.relative(task.workspacePath, artifactPath),
          kind: artifactPath.endsWith(".json")
            ? "json"
            : artifactPath.endsWith(".md")
              ? "markdown"
              : "other"
        });
      }
      await this.emit({
        taskId,
        stepId: "phase1",
        type: "artifact_created",
        message: "Prepared Phase 1 monolithic driver state, prompt, and compaction artifacts.",
        data: {
          taskStatePath: phase1.taskStatePath,
          promptPath: phase1.promptPath,
          runningSummaryPath: phase1.runningSummaryPath,
          contextDebtPath: phase1.contextDebtPath,
          phase3ExtractionPath: phase1.phase3ExtractionPath,
          contextBudgetPath: phase1.contextBudgetPath,
          stepHandoffDir: phase1.stepHandoffDir
        }
      });
      const initialBudget = await contextBudget.writeSnapshot("phase1_start");
      await this.emitContextBudgetAlert(taskId, initialBudget, contextBudget);
      await this.emit({
        taskId,
        stepId: "phase1",
        type: "progress",
        message:
          "Phase 1 monolithic Copilot agent started. It will update task-state.json and phase1-context artifacts after each step."
      });

      let lastPhase1SyncAt = 0;
      let phase1SyncInFlight = false;
      const syncPhase1Progress = async () => {
        const now = Date.now();
        const syncIntervalMs = phase1SyncIntervalMs();
        if (phase1SyncInFlight || now - lastPhase1SyncAt < syncIntervalMs) return;
        lastPhase1SyncAt = now;
        phase1SyncInFlight = true;
        try {
          await this.syncPhase1TaskState(taskId);
          const snapshot = await contextBudget.writeSnapshot("periodic_phase1_sync");
          await this.emitContextBudgetAlert(taskId, snapshot, contextBudget);
        } catch (syncError) {
          await this.emit({
            taskId,
            stepId: "phase1",
            type: "progress",
            message: `Phase 1 periodic task-state sync skipped: ${
              syncError instanceof Error ? syncError.message : String(syncError)
            }`
          });
        } finally {
          phase1SyncInFlight = false;
        }
      };
      phase1SyncTimer = setInterval(() => {
        void syncPhase1Progress();
      }, phase1SyncIntervalMs());
      phase1SyncTimer.unref?.();
      const observePhase1SdkEvent: SdkRawEventObserver = async (sdkEvent, semanticProgress) => {
        const budgetEvent = phase1ContextBudgetEvent(taskId, sdkEvent, semanticProgress);
        const snapshot = budgetEvent ? await contextBudget.recordSdkEvent(budgetEvent) : undefined;
        if (snapshot) {
          await this.emitContextBudgetAlert(taskId, snapshot, contextBudget);
          if (snapshot.level === "critical") {
            throw new ContextBudgetExceededError(snapshot);
          }
        }
        await syncPhase1Progress();
      };

      const result = await this.sdkRunner.runStep(
        phase1.job,
        async (event) => {
          return this.emit(event);
        },
        async (event) => this.approvalBroker.waitForDecision(event),
        observePhase1SdkEvent
      );
      const synced = await this.syncPhase1TaskState(taskId);
      const finalBudget = await contextBudget.writeSnapshot("phase1_session_completed");
      await this.emitContextBudgetAlert(taskId, finalBudget, contextBudget);
      await this.assertPhase1SessionReachedTerminalState(taskId);
      const exposedGate = await this.emitPhase1HumanGateIfNeeded(taskId);
      await this.promotePhase1Artifacts(taskId);
      await this.emit({
        taskId,
        stepId: "phase1",
        type: "step_summary",
        message: result.summary ?? "Phase 1 monolithic Copilot agent completed.",
        data: {
          sessionId: result.sessionId,
          sessionArtifacts: result.sessionArtifacts,
          syncedSteps: synced,
          exposedHumanGate: exposedGate
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ContextBudgetExceededError) {
        await contextBudget.writeSnapshot("phase1_context_budget_pause");
        await this.syncPhase1TaskState(taskId).catch(() => []);
        await this.pausePhase1ForContextBudget(taskId, error.snapshot);
        return;
      }
      try {
        await this.syncPhase1TaskState(taskId);
      } catch (syncError) {
        await this.emit({
          taskId,
          stepId: "phase1",
          type: "progress",
          message: `Phase 1 task-state sync failed after agent error: ${
            syncError instanceof Error ? syncError.message : String(syncError)
          }`
        });
      }
      const refreshed = await this.store.getTask(taskId);
      if (refreshed) {
        await this.failPhase1TargetStepAfterError(refreshed, message);
      }
      await this.emit({
        taskId,
        stepId: "phase1",
        type: "step_failed",
        message
      });
      throw error;
    } finally {
      if (phase1SyncTimer) clearInterval(phase1SyncTimer);
      this.activeStepRuns.delete(runKey);
    }
  }

  /**
   * Copy key artifacts from phase1-context/ to the root artifacts directory
   * so that subsequent steps (e.g., Step 02) can find them at the expected paths.
   */
  private async promotePhase1Artifacts(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) return;
    const phase1Dir = path.join(task.artifactPath, "phase1-context");
    const artifactDir = task.artifactPath;
    // Artifacts that downstream steps expect at the root level
    const artifactsToPromote = [
      "00-intake-preflight.md",
      "00-node-scan.csv",
      "01-assets.csv",
      "01-custom-nodes.md",
      "01-node-dependency-scan.csv",
      "02-feasibility.md"
    ];
    for (const name of artifactsToPromote) {
      const src = path.join(phase1Dir, name);
      const dest = path.join(artifactDir, name);
      try {
        await fs.access(src);
        await fs.copyFile(src, dest);
      } catch {
        // Source doesn't exist, skip
      }
    }
  }

  private async assertPhase1SessionReachedTerminalState(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const phase1State = await compactStoredPhase1TaskState(task);
    if (isTerminalPhase1Status(phase1State.status)) return;
    const anyTerminalStep = phase1State.steps.some(
      (step) =>
        step.status === "waiting_for_human" ||
        step.status === "human_gate" ||
        step.status === "human_gate_reached" ||
        step.status === "hard_stopped" ||
        step.status === "hard_stop" ||
        step.status === "failed"
    );
    if (anyTerminalStep) return;

    const activeStep =
      phase1State.steps.find((step) => step.id === phase1State.current_step_id) ??
      phase1State.steps.find((step) => step.status === "running") ??
      phase1State.steps.find((step) => step.status === "pending");
    const stepId = activeStep?.id ?? phase1State.current_step_id ?? "unknown";
    throw new Error(
      [
        `Phase 1 SDK session ended before reaching a terminal task-state checkpoint; Step ${stepId} is still ${activeStep?.status ?? phase1State.status}.`,
        "The agent returned a summary but did not write the required step artifacts or advance task-state.json.",
        "Resume Phase 1 in a fresh session after inspecting the SDK transcript, or stop and repair the step prompt/tooling."
      ].join(" ")
    );
  }

  private async failPhase1TargetStepAfterError(task: MigrationTask, message: string): Promise<void> {
    const runningStep = task.steps.find((step) => step.status === "running");
    if (runningStep) {
      await this.store.updateStep(task.id, runningStep.id, "failed", { error: message });
      return;
    }

    let targetStepId: string | undefined;
    try {
      const phase1State = await readPhase1TaskState(task);
      targetStepId =
        phase1State.steps.find((step) => normalizePhase1StepStatus(step.status) === "running")?.id ??
        phase1State.current_step_id ??
        phase1State.steps.find((step) => normalizePhase1StepStatus(step.status) !== "completed")?.id;
    } catch {
      targetStepId = undefined;
    }

    const targetStep =
      task.steps.find((step) => step.id === targetStepId && step.status !== "completed") ??
      task.steps.find((step) => step.status !== "completed");
    if (targetStep) {
      await this.store.updateStep(task.id, targetStep.id, "failed", { error: message });
    }
  }

  async recordHumanDecision(input: {
    taskId: string;
    stepId?: string;
    questionEventId: string;
    answer: string;
    wasFreeform: boolean;
  }): Promise<{ decision: HumanDecision; resumedLiveSession: boolean }> {
    const rawDecision: HumanDecision = {
      ...input,
      decidedAt: new Date().toISOString()
    };
    const decision: HumanDecision = {
      ...rawDecision,
      answer: redactSensitiveText(rawDecision.answer)
    };
    await this.store.appendDecision(decision);
    // §G.wire: record non-routine decisions as feedback. Routine approvals
    // (yes/ok/continue/approve/proceed/1) don't carry useful signal — skip
    // them to keep the feedback log focused on overrides and corrections.
    if (!isRoutineApproval(input.answer)) {
      await this.recordFeedback(input.taskId, {
        stepId: input.stepId ?? "task",
        source: "human",
        type: "user_preference",
        severity: severityForDecision(input.answer),
        message: trimMessage(input.answer),
        stateSnapshot: { extraNotes: `questionEventId=${input.questionEventId}; wasFreeform=${input.wasFreeform}` }
      });
    }
    const phase1RunActive = this.activeStepRuns.has(this.stepRunKey(input.taskId, "phase1"));
    // First, try to deliver the decision to an active SDK session via the broker.
    // This handles interactive steps (like Step 02) where the SDK agent asked the question.
    const sdkResumed = this.approvalBroker.resolveDecision(rawDecision);
    const deterministicGateHandled = !sdkResumed && !phase1RunActive
      ? await this.applyDeterministicGateDecision(rawDecision)
      : false;
    const resumedLiveSession = sdkResumed || deterministicGateHandled;
    await this.emit({
      taskId: input.taskId,
      stepId: input.stepId,
      type: "progress",
      message: resumedLiveSession
        ? deterministicGateHandled
          ? "Human decision recorded and applied to deterministic gate."
          : "Human decision recorded and delivered to active SDK session."
        : "Human decision recorded for next resume.",
      data: { ...decision, resumedLiveSession }
    });
    return { decision, resumedLiveSession: resumedLiveSession };
  }

  private firstPhase1StepToMarkRunning(task: MigrationTask): string | undefined {
    const blocked = task.steps.find((step) =>
      ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(step.status)
    );
    if (blocked) return undefined;
    return this.steps.find((step) => {
      const state = task.steps.find((item) => item.id === step.id);
      return !state || state.status === "pending";
    })?.id;
  }

  private async syncPhase1TaskState(taskId: string): Promise<string[]> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const phase1State = await compactStoredPhase1TaskState(task);
    const synced: string[] = [];
    for (const phase1Step of phase1State.steps) {
      const current = task.steps.find((step) => step.id === phase1Step.id);
      if (!current) continue;
      const status = normalizePhase1StepStatus(phase1Step.status);
      if (current.status === status && current.summary === phase1Step.summary) continue;
      await this.store.updateStep(taskId, current.id, status, {
        summary: phase1Step.summary,
        error: status === "failed" || status === "hard_stopped" ? phase1Step.summary : undefined
      });
      synced.push(`${current.id}:${status}`);
    }
    await this.emit({
      taskId,
      stepId: "phase1",
      type: "progress",
      message: synced.length
        ? `Synced Phase 1 task-state step statuses: ${synced.join(", ")}.`
        : "Phase 1 task-state sync found no step status changes.",
      data: { synced, phase1Status: phase1State.status, currentStepId: phase1State.current_step_id }
    });
    return synced;
  }

  async ensurePhase1HumanGateExposed(taskId: string): Promise<boolean> {
    const acquisitionGate = await this.emitStep01AcquisitionGateIfNeeded(taskId);
    const phase1Gate = await this.emitPhase1HumanGateIfNeeded(taskId);
    return acquisitionGate || phase1Gate;
  }

  private async emitStep01AcquisitionGateIfNeeded(taskId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const step = task.steps.find((item) => item.id === "01");
    // Fire the deterministic gate for any non-failed Step 01,
    // not just "waiting_for_human", so that the gate fires even when the Phase 1
    // agent self-reports Step 01 as "completed" while leaving unresolved gaps.
    if (!step || step.status === "failed" || step.status === "terminated") return false;

    const jobPath = path.join(task.artifactPath, "01-acquisition-job.json");
    let job: Record<string, unknown>;
    try {
      job = JSON.parse(await fs.readFile(jobPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (stringValue(job.status) !== "waiting_for_secure_download") return false;
    const [assetRows, gateItems] = await Promise.all([
      readStep01AssetRows(task),
      readStep01GateItems(task)
    ]);
    const unresolvedItems = enrichAssetAcquisitionUnresolvedItems(
      normalizeAssetAcquisitionUnresolvedItems(job),
      assetRows,
      gateItems
    );
    if (unresolvedItems.length === 0) return false;

    const gateId = "phase1-step01-acquisition-unresolved-v2";
    const [events, decisions] = await Promise.all([
      this.store.listEvents(taskId),
      this.store.listDecisions(taskId)
    ]);
    const answeredQuestionIds = new Set(decisions.map((decision) => decision.questionEventId));
    const unansweredExisting = events.some((event) => {
      const data = isRecord(event.data) ? event.data : {};
      return (
        event.type === "human_question" &&
        data.phase1GateId === gateId &&
        !answeredQuestionIds.has(event.id)
      );
    });
    if (unansweredExisting) return false;

    const details = assetAcquisitionGateDetails(unresolvedItems);
    const unresolvedNames = unresolvedItems.map((item) => item.assetName).join(", ");
    const summary = `Step 01 still needs exact files for ${unresolvedItems.length} unresolved asset(s): ${unresolvedNames}.`;
    await this.emit({
      taskId,
      stepId: "01",
      type: "human_question",
      message: summary,
      data: {
        question:
          `${summary} These are ${unresolvedItems.map((item) => `${item.assetName} (${item.kind})`).join(", ")}. Provide exact local staged paths/source URLs for the named files, approve continuing with documented gaps, or stop migration.`,
        choices: [
          "Provide exact local staged files for unresolved assets",
          "Approve bounded smoke-only follow-up with documented gaps",
          "Stop migration at Step 01"
        ],
        allowFreeform: true,
        blockingReason: "missing_asset",
        phase1GateId: gateId,
        artifactPath: "artifacts/01-acquisition-report.md",
        artifactPaths: ["artifacts/01-acquisition-job.json", "artifacts/01-acquisition-report.md"],
        details,
        decisionContext: normalizeDecisionContext({
          existing: undefined,
          stepId: "01",
          question: summary,
          choices: [
            "Provide exact local staged files for unresolved assets",
            "Approve bounded smoke-only follow-up with documented gaps",
            "Stop migration at Step 01"
          ],
          blockingReason: "missing_asset",
          fallbackBackground:
            `${summary} The missing filenames, kinds, source context, expected target paths, and next actions are listed in the blocking details.`,
          details,
          claimBoundaryImpact:
            "Source-identical dependency completeness remains blocked until the named files are staged, a secure download source is provided, or a reduced route is explicitly approved."
        })
      }
    });
    return true;
  }

  private async emitPhase1HumanGateIfNeeded(taskId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    let phase1State: Phase1TaskState;
    try {
      phase1State = await compactStoredPhase1TaskState(task);
    } catch {
      return false;
    }
    const hasWaitingForHumanStep = phase1State.steps.some(
      (step) => step.status === "waiting_for_human" || step.status === "human_gate" || step.status === "human_gate_reached"
    );
    if (phase1State.status !== "waiting_for_human" && phase1State.status !== "human_gate" && phase1State.status !== "human_gate_reached" && !hasWaitingForHumanStep) return false;

    const gatedStep =
      phase1State.steps.find((step) => step.id === phase1State.current_step_id) ??
      phase1State.steps.find((step) => step.status === "waiting_for_human" || step.status === "human_gate" || step.status === "human_gate_reached");
    if (!gatedStep) return false;

    const gate = await phase1HumanGateFromStep(gatedStep, task);
    if (!gate) return false;

    const decisions = await this.store.listDecisions(taskId);
    if (decisions.some((decision) => decision.questionEventId === gate.gateId)) return false;

    const events = await this.store.listEvents(taskId);
    const alreadyExposed = events.some((event) => {
      const data = event.data as Record<string, unknown> | undefined;
      return event.type === "human_question" && data?.phase1GateId === gate.gateId;
    });
    if (alreadyExposed) return false;

    await this.emit({
      taskId,
      stepId: gatedStep.id,
      type: "human_question",
      message: gate.problemSummary,
      data: {
        question: gate.question,
        choices: gate.choices,
        allowFreeform: true,
        blockingReason: phase1BlockingReasonForStep(gatedStep.id),
        phase1GateId: gate.gateId,
        artifactPaths: gate.artifactPaths,
        claimBoundaryImpact: gate.claimBoundaryImpact,
        decisionContext: gate.decisionContext
      }
    });
    return true;
  }

  private async emitContextBudgetAlert(
    taskId: string,
    snapshot: ContextBudgetSnapshot,
    tracker: ContextBudgetTracker
  ): Promise<void> {
    if (!tracker.shouldAlert(snapshot)) return;
    await this.emit({
      taskId,
      stepId: "phase1",
      type: "progress",
      message:
        snapshot.level === "critical"
          ? "Phase 1 context budget is critical; pausing at a checkpoint before the SDK session overflows."
          : "Phase 1 context budget warning; compact checkpoint should be written before the next step.",
      data: snapshot
    });
  }

  private async pausePhase1ForContextBudget(
    taskId: string,
    snapshot: ContextBudgetSnapshot
  ): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const runningStep = task.steps.find((step) => step.status === "running");
    const stepId = runningStep?.id ?? "phase1";
    const summary =
      "Phase 1 paused at a context checkpoint before the monolithic SDK session could overflow. Resume Phase 1 to continue from task-state.json and phase1-context artifacts in a fresh SDK session.";
    if (runningStep) {
      await this.store.updateStep(taskId, runningStep.id, "waiting_for_human", { summary });
    }
    await this.emit({
      taskId,
      stepId,
      type: "human_question",
      message: summary,
      data: {
        question:
          "Context budget reached the critical threshold. Resume Phase 1 from the compact state in a fresh SDK session, or stop here for manual inspection.",
        choices: ["Resume Phase 1 from compact checkpoint", "Stop and inspect context artifacts"],
        allowFreeform: true,
        blockingReason: "capacity_policy",
        artifactPath: "artifacts/phase1-context/context-budget.json",
        details: [
          `estimated_tokens: ${snapshot.estimatedContextTokens}`,
          `critical_tokens: ${snapshot.limits.criticalEstimatedTokens}`,
          `sdk_events: ${snapshot.sdkEventCount}`,
          `critical_events: ${snapshot.limits.criticalSdkEvents}`
        ],
        decisionContext: {
          formatVersion: "human-gate-v1",
          backgroundReasonScene:
            "The backend detected that the long Phase 1 SDK session is near the configured context budget. Continuing in the same session risks losing instructions or overflowing the model context.",
          terminology: [
            {
              term: "context budget",
              explanation:
                "An estimated limit based on prompt/artifact size and SDK event volume used to decide when a long agent session should checkpoint and restart."
            },
            {
              term: "compact checkpoint",
              explanation:
                "The durable state files task-state.json, running-summary.md, context-debt.json, phase3-extraction-candidates.json, and step handoffs used to resume without relying on chat history."
            }
          ],
          consequencesAndFollowUp: [
            {
              choice: "Resume Phase 1 from compact checkpoint",
              consequence:
                "The current long SDK session is abandoned and the next Phase 1 run starts with a fresh model context.",
              followUp:
                "Run Phase 1 again; the backend will rebuild the driver prompt from task-state.json and phase1-context artifacts."
            },
            {
              choice: "Stop and inspect context artifacts",
              consequence:
                "The migration remains paused and no new step work starts.",
              followUp:
                "Inspect context-budget.json, running-summary.md, task-state.json, and step handoffs before resuming."
            }
          ]
        }
      }
    });
  }

  async startApprovalProbe(taskId: string, stepId?: string): Promise<AgentEvent> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const question = await this.emit({
      taskId,
      stepId,
      type: "human_question",
      message: "Approval probe: choose Approve once to verify web-mediated agent approval.",
      data: {
        question: "Approval probe: choose Approve once to verify web-mediated agent approval.",
        choices: ["Approve once", "Reject"],
        allowFreeform: true,
        blockingReason: "permission"
      }
    });
    void this.approvalBroker
      .waitForDecision(question, 2 * 60 * 1000)
      .then((decision) =>
        this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Approval probe resolved with: ${decision.answer}`,
          data: decision
        })
      )
      .catch((error: unknown) =>
        this.emit({
          taskId,
          stepId,
          type: "step_failed",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    return question;
  }

  async rerunStep(taskId: string, stepId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const step = this.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);

    // 0. Cancel any active SDK session / waiting broker for this step
    const runKey = this.stepRunKey(taskId, stepId);
    this.activeStepRuns.delete(runKey);
    this.approvalBroker.cancelAllForStep(stepId, `Re-run requested for step ${stepId}`);

    // 0a. Kill ComfyUI processes referencing this task's workspace (Step 05+ side effects).
    // Routes to local pgrep or remote SSH kill based on the task's GPU node kind.
    const killed = await this.killComfyUIForTask(task);
    if (killed > 0) {
      await this.emit({
        taskId,
        stepId,
        type: "progress",
        message: `Killed ${killed} ComfyUI process(es) for re-run cleanup.`
      });
    }

    // 0b. Reset task status if needed
    if (["waiting_for_human", "failed"].includes(task.status)) {
      await this.store.updateTaskStatus(taskId, "running");
    }

    // 1. Reset step state to pending
    await this.store.updateStep(taskId, stepId, "pending", { summary: undefined, error: undefined });

    // 2. Clean artifacts produced by this step
    await this.cleanStepArtifacts(task.artifactPath, stepId);

    // 3. Also reset any downstream steps that depend on this step's output
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    for (let i = stepIndex + 1; i < this.steps.length; i++) {
      const ds = this.steps[i];
      const dsState = task.steps.find((s) => s.id === ds.id);
      if (dsState && dsState.status !== "pending") {
        await this.store.updateStep(taskId, ds.id, "pending", { summary: undefined, error: undefined });
        await this.cleanStepArtifacts(task.artifactPath, ds.id);
      }
    }

    // 4. Clean runtime outputs produced by the rerun step and any downstream step.
    //    Without this, agent sees stale images/logs from the previous run.
    const layout = getLayoutForTask(task);
    const cleanTargets = new Set<string>();
    for (let i = stepIndex; i < this.steps.length; i++) {
      const sid = this.steps[i].id;
      const subdir = STEP_OUTPUT_SUBDIR[sid];
      if (subdir) cleanTargets.add(path.join(layout.outputsDir, subdir));
    }
    await this.cleanRuntimeOutputs(cleanTargets);

    await this.emit({
      taskId,
      stepId,
      type: "progress",
      message: `Step ${stepId} reset to pending. Artifacts cleaned. Re-running.`
    });

    // 4. Re-run the step
    await this.runStep(taskId, stepId);
  }

  private async cleanStepArtifacts(artifactPath: string, stepId: string): Promise<void> {
    const prefix = `${stepId}-`;
    try {
      const entries = await fs.readdir(artifactPath);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const fullPath = path.join(artifactPath, entry);
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            await fs.unlink(fullPath);
          }
        }
      }
      // Also clean from phase1-context if present
      const phase1Dir = path.join(artifactPath, "phase1-context");
      try {
        const p1Entries = await fs.readdir(phase1Dir);
        for (const entry of p1Entries) {
          if (entry.startsWith(prefix)) {
            await fs.unlink(path.join(phase1Dir, entry));
          }
        }
      } catch {
        // No phase1-context dir
      }
    } catch {
      // Artifact dir doesn't exist
    }
  }

  /**
   * Remove every file in the given output subdirs (e.g. outputs/previews/).
   * Called during rerun to prevent the agent from reading stale ComfyUI outputs
   * from a previous run. Keeps the subdir itself so ComfyUI can write into it
   * again without mkdir races.
   */
  private async cleanRuntimeOutputs(targets: Set<string>): Promise<void> {
    for (const dir of targets) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // Dir doesn't exist yet — nothing to clean
      }
    }
  }

  async resumeStep(taskId: string, stepId: string): Promise<void> {
    const decisions = await this.store.listDecisions(taskId);
    await this.runStep(taskId, stepId, {
      humanDecisions: decisions.filter((decision) => decision.stepId === stepId)
    });
  }

  private async applyDeterministicGateDecision(decision: HumanDecision): Promise<boolean> {
    if (!decision.stepId) return false;
    const task = await this.store.getTask(decision.taskId);
    const step = task?.steps.find((item) => item.id === decision.stepId);
    if (!task || step?.status !== "waiting_for_human") return false;
    const stepDefinition = this.steps.find((item) => item.id === decision.stepId);
    if (!stepDefinition) return false;

    if (await this.applyContextBudgetResumeDecision({ task, step, decision })) {
      return true;
    }

    if (decision.stepId !== "00") {
      const artifactGate = await checkRequiredArtifactGate(task, stepDefinition);
      if (!artifactGate.gated) {
        // Gate was already resolved (e.g., by file upload that deleted gate-signal).
        // If the decision is a continue/approve, complete the step directly.
        if (isContinueDecision(decision.answer)) {
          const summary = `Step ${decision.stepId} completed; gate was already resolved (assets provided).`;
          await this.store.updateStep(decision.taskId, decision.stepId, "completed", {
            summary,
            error: undefined
          });
          await this.emit({
            taskId: decision.taskId,
            stepId: decision.stepId,
            type: "step_completed",
            message: summary,
            data: { decision: { ...decision, answer: redactSensitiveText(decision.answer) } }
          });
          return true;
        }
        return false;
      }
    }

    if (isStopDecision(decision.answer)) {
      const message = `Operator stopped migration at Step ${decision.stepId} after human gate.`;
      await this.store.updateStep(decision.taskId, decision.stepId, "hard_stopped", {
        error: message
      });
      await this.emit({
        taskId: decision.taskId,
        stepId: decision.stepId,
        type: "hard_stop",
        message,
        data: { decision: { ...decision, answer: redactSensitiveText(decision.answer) } }
      });
      return true;
    }

    await this.markHumanDecisionApplying({ task, stepId: decision.stepId, decision });

    if (decision.stepId !== "00" && isActionableGateContext(decision.answer, decision.wasFreeform)) {
      await this.acceptHumanGateContext({ task, stepDefinition, decision });
      return true;
    }

    if (isContinueDecision(decision.answer)) {
      const summary = decision.stepId === "00"
        ? "Step 00 completed with human-approved bounded smoke-only follow-up. Blocking dependency-source gaps remain documented in 00-intake-preflight.md."
        : `Step ${decision.stepId} completed with human-approved continuation under documented risk/gaps.`;
      await this.store.updateStep(decision.taskId, decision.stepId, "completed", {
        summary,
        error: undefined
      });
      await this.emit({
        taskId: decision.taskId,
        stepId: decision.stepId,
        type: "step_completed",
        message: summary,
        data: {
          decision: { ...decision, answer: redactSensitiveText(decision.answer) },
          boundary: "documented risk/gaps; no source-identical claim"
        }
      });
      return true;
    }

    if (decision.stepId === "00") {
      const questionData = await this.buildStep00FollowupQuestionData(task, decision.answer);
      await this.emit({
        taskId: decision.taskId,
        stepId: decision.stepId,
        type: "human_question",
        message: questionData.question,
        data: questionData
      });
    } else {
      const summary = `Step ${decision.stepId} still needs missing context after reviewing the latest human answer.`;
      await this.store.updateStep(decision.taskId, decision.stepId, "waiting_for_human", {
        summary,
        error: undefined
      });
      await this.emit({
        taskId: decision.taskId,
        stepId: decision.stepId,
        type: "human_question",
        message:
          `Step ${decision.stepId} still needs missing context before continuing. Type the required context, choose Continue with documented risk/gaps, or stop at this gate.`,
        data: {
          question:
            `Step ${decision.stepId} still needs missing context before continuing. What should the agent use next?`,
          choices: [
            "Continue with documented risk/gaps",
            "Stop at this gate",
            "Provide missing context before continuing"
          ],
          allowFreeform: true,
          blockingReason: "quality_review"
        }
      });
    }
    return true;
  }

  private async markHumanDecisionApplying(input: {
    task: MigrationTask;
    stepId: string;
    decision: HumanDecision;
  }): Promise<void> {
    const summary = `Applying human decision for Step ${input.stepId}; the previous gate is being processed.`;
    await this.store.updateStep(input.task.id, input.stepId, "running", { summary });
    await this.emit({
      taskId: input.task.id,
      stepId: input.stepId,
      type: "progress",
      message: summary,
      data: {
        questionEventId: input.decision.questionEventId,
        decision: { ...input.decision, answer: redactSensitiveText(input.decision.answer) }
      }
    });
  }

  private async applyContextBudgetResumeDecision(input: {
    task: MigrationTask;
    step: MigrationTask["steps"][number];
    decision: HumanDecision;
  }): Promise<boolean> {
    if (!(await this.isContextBudgetGateDecision(input.decision))) return false;
    if (!isContextBudgetResumeDecision(input.decision.answer)) return false;
    const summary =
      "Context-budget checkpoint resume approved; Phase 1 can restart from task-state.json and phase1-context artifacts in a fresh SDK session.";
    await this.store.updateStep(input.task.id, input.step.id, "pending", { summary });
    await this.emit({
      taskId: input.task.id,
      stepId: input.step.id,
      type: "progress",
      message: summary,
      data: {
        decision: { ...input.decision, answer: redactSensitiveText(input.decision.answer) },
        resumeFrom: "phase1-context"
      }
    });
    return true;
  }

  private async isContextBudgetGateDecision(decision: HumanDecision): Promise<boolean> {
    const events = await this.store.listEvents(decision.taskId);
    const event = events.find((item) => item.id === decision.questionEventId);
    if (!event || event.type !== "human_question") return false;
    const data = isRecord(event.data) ? event.data : {};
    return (
      stringValue(data.blockingReason) === "capacity_policy" &&
      (stringValue(data.artifactPath)?.includes("context-budget.json") ||
        /context budget/i.test(stringValue(data.question) ?? event.message))
    );
  }

  private async acceptHumanGateContext(input: {
    task: MigrationTask;
    stepDefinition: MigrationStepDefinition;
    decision: HumanDecision;
  }): Promise<void> {
    const { task, stepDefinition, decision } = input;
    if (!decision.stepId) throw new Error("Cannot accept human gate context without a step id.");
    const stepId = decision.stepId;
    const contextKind = stepId === "01" ? "source instructions" : "operator context";
    const artifactName =
      stepId === "01"
        ? "01-human-source-instructions.md"
        : `${stepId}-human-context.md`;
    const artifactPath = path.join(task.artifactPath, artifactName);
    const redactedAnswer = redactSensitiveText(decision.answer);
    await fs.writeFile(
      artifactPath,
      [
        `# Step ${stepId} human-provided ${contextKind}`,
        "",
        "orchestrator_status: human_context_received",
        "",
        `task_id: \`${task.id}\``,
        `step_id: \`${stepId}\``,
        `step_name: \`${stepDefinition.name}\``,
        `question_event_id: \`${decision.questionEventId}\``,
        `decided_at: \`${decision.decidedAt}\``,
        "",
        "## Operator-provided context",
        "",
        "```text",
        redactedAnswer,
        "```",
        "",
        "## Boundary",
        "",
        "Credentials and private tokens are redacted and are not persisted in task state or artifacts.",
        stepId === "01"
          ? "This step records actionable source locations/instructions for the acquisition phase; it does not claim source-identical assets are already staged."
          : "This step records operator context for the gate; it does not claim validation success beyond the existing artifact evidence.",
        ""
      ].join("\n"),
      "utf8"
    );
    await this.store.appendArtifact({
      taskId: decision.taskId,
      stepId,
      path: artifactPath,
      relativePath: path.relative(task.workspacePath, artifactPath),
      kind: "markdown"
    });
    await this.emit({
      taskId: decision.taskId,
      stepId,
      type: "artifact_created",
      message: `Recorded redacted Step ${stepId} human ${contextKind}.`,
      data: {
        path: artifactPath,
        redacted: redactedAnswer !== decision.answer
      }
    });
    let step01Acquisition:
      | Awaited<ReturnType<typeof ensureAssetAcquisitionJob>>
      | undefined;
    if (stepId === "01") {
      step01Acquisition = await ensureAssetAcquisitionJob({
        task,
        modelRoots: this.config.modelRoots,
        comfyuiRoot: this.config.comfyuiRoot,
        humanContext: decision.answer,
        redactedHumanContext: redactedAnswer,
        modelRepoPath: path.resolve(this.config.projectRoot, "../model_repo"),
        stepId
      });
      await this.store.appendArtifact({
        taskId: decision.taskId,
        stepId,
        path: step01Acquisition.jobPath,
        relativePath: path.relative(task.workspacePath, step01Acquisition.jobPath),
        kind: "json"
      });
      await this.store.appendArtifact({
        taskId: decision.taskId,
        stepId,
        path: step01Acquisition.reportPath,
        relativePath: path.relative(task.workspacePath, step01Acquisition.reportPath),
        kind: "markdown"
      });
      await this.emit({
        taskId: decision.taskId,
        stepId,
        type: "artifact_created",
        message: "Executed Step 01 asset acquisition job local-search phase.",
        data: {
          jobPath: step01Acquisition.jobPath,
        reportPath: step01Acquisition.reportPath,
        status: step01Acquisition.status,
        resolvedCount: step01Acquisition.resolvedCount,
        unresolvedCount: step01Acquisition.unresolvedCount,
        pendingDownloadCount: step01Acquisition.pendingDownloadCount,
        unresolvedItems: step01Acquisition.unresolvedItems
      }
    });
  }
    const acquisitionGateDetails = step01Acquisition
      ? assetAcquisitionGateDetails(step01Acquisition.unresolvedItems)
      : [];
    const unresolvedNames = step01Acquisition?.unresolvedItems.map((item) => item.assetName).join(", ");
    const summary =
      step01Acquisition?.status === "waiting_for_secure_download"
        ? `Step 01 asset acquisition job searched local roots and still has ${step01Acquisition.unresolvedCount} unresolved source-identical asset(s): ${unresolvedNames || "see acquisition report"}. Secure download or local staging is required before feasibility.`
        : stepId === "01"
        ? "Step 01 accepted human-provided asset/custom-node source instructions. Continue to feasibility with documented acquisition context; source-identical staging is still tracked in 01-assets.csv."
        : `Step ${stepId} accepted human-provided context and completed the gate with documented operator input.`;
    const nextStatus = step01Acquisition?.status === "waiting_for_secure_download"
      ? "waiting_for_human"
      : "completed";
    await this.store.updateStep(decision.taskId, stepId, nextStatus, {
      summary,
      error: undefined
    });
    if (nextStatus === "waiting_for_human" && step01Acquisition) {
      await this.emit({
        taskId: decision.taskId,
        stepId,
        type: "human_question",
        message: summary,
        data: {
          question:
            `Step 01 created an asset acquisition job and completed local search, but these exact assets are still unresolved: ${unresolvedNames || "see details"}. Provide exact local staged files/source URLs for the named assets, approve continuing with documented gaps, or stop migration.`,
          choices: [
            "Provide exact local staged files for unresolved assets",
            "Approve bounded smoke-only follow-up with documented gaps",
            "Stop migration at Step 01"
          ],
          allowFreeform: true,
          blockingReason: "missing_asset",
          phase1GateId: "phase1-step01-acquisition-unresolved-v2",
          artifactPath: path.relative(task.workspacePath, step01Acquisition.reportPath),
          artifactPaths: [
            path.relative(task.workspacePath, step01Acquisition.jobPath),
            path.relative(task.workspacePath, step01Acquisition.reportPath)
          ],
          details: [
            `resolved_or_already_staged: ${step01Acquisition.resolvedCount}`,
            `unresolved: ${step01Acquisition.unresolvedCount}`,
            `pending_secure_download: ${step01Acquisition.pendingDownloadCount}`,
            ...acquisitionGateDetails
          ]
        }
      });
      return;
    }
    await this.emit({
      taskId: decision.taskId,
      stepId,
      type: "step_completed",
      message: summary,
      data: {
        decision: { ...decision, answer: redactedAnswer },
        humanContextArtifact: path.relative(task.workspacePath, artifactPath),
        acquisitionJobArtifact: step01Acquisition
          ? path.relative(task.workspacePath, step01Acquisition.jobPath)
          : undefined,
        boundary:
          stepId === "01"
            ? "source instructions accepted; no source-identical success claim yet"
            : "operator context accepted; no additional validation success claim"
      }
    });
  }

  async terminateWithHardStop(input: {
    taskId: string;
    stepId?: string;
    reason: string;
    improvementStrategy?: string;
  }) {
    const task = await this.store.getTask(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const now = new Date().toISOString();
    const strategy =
      input.improvementStrategy?.trim() ||
      "Review missing inputs, prompt/skill gaps, environment blockers, and retry from the last evidence-backed step.";
    const reportPath = path.join(
      task.artifactPath,
      input.stepId ? `${input.stepId}-hard-stop-report.md` : "hard-stop-report.md"
    );
    const content = [
      "# Migration hard stop report",
      "",
      `task_id: ${task.id}`,
      `step_id: ${input.stepId ?? "task"}`,
      `created_at: ${now}`,
      "",
      "## Reason",
      "",
      input.reason,
      "",
      "## Improvement strategy",
      "",
      strategy,
      "",
      "## Boundary",
      "",
      "No later migration step should claim success beyond the evidence available before this hard stop."
    ].join("\n");
    await fs.writeFile(reportPath, `${content}\n`, "utf8");
    if (input.stepId) {
      await this.store.updateStep(input.taskId, input.stepId, "hard_stopped", {
        error: input.reason
      });
    }
    await this.store.updateTaskStatus(input.taskId, "hard_stopped");
    // Free the one-run-per-process lock now (don't wait for the in-flight SDK
    // call to wind down), so new tasks can be created immediately. Also flag the
    // task so any lock the winding-down run re-acquires is ignored.
    this.hardStoppedTaskIds.add(input.taskId);
    this.releaseTaskRuns(input.taskId);
    await this.store.appendArtifact({
      taskId: input.taskId,
      stepId: input.stepId,
      path: reportPath,
      relativePath: path.relative(task.workspacePath, reportPath),
      kind: "markdown"
    });
    await this.emit({
      taskId: input.taskId,
      stepId: input.stepId,
      type: "hard_stop",
      message: input.reason,
      data: { reportPath, improvementStrategy: strategy }
    });
    // §G.wire: capture hard-stop as a feedback event for Step 13 analysis.
    // Best-effort; never blocks the return below.
    await this.recordFeedback(input.taskId, {
      stepId: input.stepId ?? "task",
      source: "human",
      type: "agent_bug",
      severity: "blocker",
      message: input.reason,
      stateSnapshot: { failingArtifactPath: reportPath },
      proposedAction: input.improvementStrategy ? "evolve_prompt" : "record_only"
    });
    return { taskId: input.taskId, stepId: input.stepId, reason: input.reason, improvementStrategy: strategy, artifactPath: reportPath, createdAt: now };
  }

  async createReflectionProposal(taskId: string) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const events = await this.store.listEvents(taskId);
    const decisions = await this.store.listDecisions(taskId);
    const reportPath = path.join(task.artifactPath, "reflection-proposal.md");
    const content = [
      "# Prompt/skill reflection proposal",
      "",
      `task_id: ${task.id}`,
      `created_at: ${new Date().toISOString()}`,
      "",
      "## Inputs reviewed",
      "",
      `- events: ${events.length}`,
      `- human decisions: ${decisions.length}`,
      "",
      "## Proposed improvements",
      "",
      "1. Review any human gate that occurred repeatedly and decide whether it should be added to the relevant prompt/skill hard-stop or checklist section.",
      "2. Review any failed or hard-stopped step and decide whether the prompt should ask for missing context earlier.",
      "3. Review generated artifacts and decide whether file naming, evidence, or GUI review requirements should be clarified.",
      "",
      "## Approval boundary",
      "",
      "This file is a proposal only. Do not modify shared prompt/skill docs automatically without user approval."
    ].join("\n");
    await fs.writeFile(reportPath, `${content}\n`, "utf8");
    await this.store.appendArtifact({
      taskId,
      path: reportPath,
      relativePath: path.relative(task.workspacePath, reportPath),
      kind: "markdown"
    });
    await this.emit({
      taskId,
      type: "reflection_proposed",
      message: "Reflection proposal generated.",
      data: { reportPath }
    });
    return { reportPath };
  }

  async preflightSdk() {
    if (this.sdkRunner.preflight) return this.sdkRunner.preflight();
    return new CopilotSdkRunner(this.config).preflight();
  }

  async generateRunReport(taskId: string): Promise<void> {
    return this.writeRunReport(taskId);
  }

  private async writeRunReport(taskId: string): Promise<void> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) return;
      const decisions = await this.store.listDecisions(taskId);
      const events = await this.store.listEvents(taskId);
      const report = await generateRunReport({ task, decisions, events });
      // Persist decisions to artifact folder so replay can read them even after
      // the source task is deleted from the state store.
      if (decisions.length > 0) {
        await fs.writeFile(
          path.join(task.artifactPath, "decisions.json"),
          JSON.stringify(decisions, null, 2),
          "utf8"
        );
      }
      // Layer 2: generate evolution analysis from run report
      const analysis = analyzeRunReport(report);
      await fs.writeFile(
        path.join(task.artifactPath, "evolution-analysis.json"),
        JSON.stringify(analysis, null, 2),
        "utf8"
      );
      // Layer 3: extract actionable rules from evolution analysis into knowledge base
      try {
        const workflowSha = await computeWorkflowSha256(task.workflowPath);
        const knowledge = await extractAndSaveRules({
          config: this.config,
          workflowSha,
          runId: task.id,
          analysis
        });
        if (knowledge.rules.length > 0) {
          await this.emit({
            taskId,
            type: "progress",
            message: `Knowledge base updated: ${knowledge.rules.length} active rules for this workflow (run #${knowledge.totalRuns}).`
          });
        }
      } catch (kbError) {
        console.error(`[knowledge] Failed to update knowledge base for ${taskId}:`, kbError instanceof Error ? kbError.message : kbError);
      }
      await this.emit({
        taskId,
        type: "artifact_created",
        message: `Run report generated: ${report.metrics.stepsCompleted} steps completed, ${report.metrics.humanGates} human gates, ${report.metrics.autoApprovedGates} auto-approved, ${report.metrics.falseGates} false gates detected.`,
        data: { reportPath: path.join(task.artifactPath, "run-report.json"), metrics: report.metrics }
      });
    } catch (error) {
      // Run report is best-effort — don't fail the pipeline
      console.error(`[run-report] Failed to generate report for ${taskId}:`, error instanceof Error ? error.message : error);
    }
  }

  private async pauseIfArtifactHumanGate(
    task: MigrationTask,
    step: MigrationStepDefinition,
    detail?: string
  ): Promise<boolean> {
    const gate = await checkRequiredArtifactGate(task, step);
    if (!gate.gated) return false;

    // Decision propagation: if a human already approved "continue" at an earlier step
    // for a similar blocking reason, auto-approve this gate without asking again.
    const blockingReason = step.id === "01" ? "capacity_policy" : "quality_review";
    const priorApproval = await this.findPriorContinueApproval(task.id, step.id, blockingReason);
    if (priorApproval) {
      const autoMessage =
        `Step ${step.id} artifact has a human-gate marker (${gate.reason}), ` +
        `but a prior human approval at Step ${priorApproval.stepId ?? "?"} already covers this category (${blockingReason}). ` +
        `Auto-continuing without re-gating.`;
      await this.emit({
        taskId: task.id,
        stepId: step.id,
        type: "progress",
        message: autoMessage,
        data: {
          autoApproved: true,
          priorStepId: priorApproval.stepId,
          priorAnswer: priorApproval.answer,
          currentGateReason: gate.reason,
          blockingReason
        }
      });
      return false;
    }

    const message = `Step ${step.id} reached a human decision gate. ${gate.reason}`;
    await this.store.updateStep(task.id, step.id, "waiting_for_human", {
      summary: message,
      error: detail
    });

    // Build specific question with actionable items from gate signal
    const gateItems = await this.readGateSignalItems(task, step.id);
    const itemList = gateItems.length > 0
      ? gateItems.map((item: { name: string; kind: string; action: string }) => `  - ${item.name} (${item.kind}): ${item.action}`).join("\n")
      : "See gate-signal.json for details.";
    const questionText = gateItems.length > 0
      ? `Step ${step.id} requires human decision on the following:\n\n${itemList}\n\nHow would you like to proceed?`
      : `${message} How should validation continue?`;

    const choices = gateItems.length > 0
      ? [
          `Provide the missing files/sources and continue`,
          `Approve smoke-only aliases and continue with reduced fidelity claims`,
          `Skip these items and continue at my own risk`,
          `Stop at this gate`
        ]
      : [
          "Continue with documented risk/gaps",
          "Stop at this gate",
          "Provide missing context before continuing"
        ];

    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "human_question",
      message,
      data: {
        question: questionText,
        choices,
        allowFreeform: true,
        blockingReason: step.id === "01" ? "missing_asset" : "quality_review",
        artifactPath: gate.matchedPath,
        decisionContext: gateItems.length > 0 ? {
          formatVersion: "human-gate-v1" as const,
          backgroundReasonScene: `Step ${step.id} found ${gateItems.length} unresolved asset(s) that cannot be automatically resolved. Each item below needs either a source file, a human-approved substitute, or an explicit skip.`,
          terminology: [
            { term: "source-identical", explanation: "The exact file referenced in the workflow, with matching filename and content hash." },
            { term: "smoke-only alias", explanation: "A similar but not identical file that can produce output but may differ in quality or behavior." }
          ],
          consequencesAndFollowUp: [
            { choice: "Provide files", consequence: "Pipeline continues with full fidelity claims.", followUp: "Upload files to the task workspace and re-run." },
            { choice: "Approve aliases", consequence: "Pipeline continues with downgraded fidelity claims.", followUp: "Smoke test results will note the substitution." },
            { choice: "Skip items", consequence: "Pipeline may fail at runtime when the missing asset is needed.", followUp: "Error will be caught at smoke test step." },
            { choice: "Stop", consequence: "Pipeline halts. No further steps will run.", followUp: "Manually resolve issues and restart." }
          ]
        } : undefined
      }
    });
    return true;
  }

  private async readGateSignalItems(task: MigrationTask, stepId: string): Promise<Array<{ name: string; kind: string; action: string }>> {
    const signalPath = path.join(task.artifactPath, `${stepId}-gate-signal.json`);
    try {
      const content = await fs.readFile(signalPath, "utf8");
      const signal = JSON.parse(content) as { items?: Array<{ name?: string; kind?: string; action?: string; asset?: string; needsHumanAction?: string }> };
      return (signal.items ?? []).map((item) => ({
        name: item.name ?? item.asset ?? "unknown",
        kind: item.kind ?? "asset",
        action: item.action ?? item.needsHumanAction ?? "requires resolution"
      }));
    } catch {
      return [];
    }
  }

  private async collectAssetGaps(task: MigrationTask): Promise<Array<{ name: string; kind: string; action: string }>> {
    const csvPath = path.join(task.artifactPath, "01-assets.csv");
    const mdPath = path.join(task.artifactPath, "01-custom-nodes.md");
    const gaps: Array<{ name: string; kind: string; action: string }> = [];
    try {
      const csvLines = (await fs.readFile(csvPath, "utf8")).split("\n");
      // Resolve column positions from the header instead of hardcoding indices —
      // the CSV schema grew (size_bytes/checksum/provider_attempts were inserted)
      // and the `gap` column moved from index 14 to 17. Hardcoded [14] read
      // size_bytes, which falsely flagged every sized model as a gap.
      const header = (csvLines[0] ?? "").split(",").map((f) => f.replace(/^"|"$/g, "").trim());
      const stateIdx = header.indexOf("state");
      const gapIdx = header.indexOf("gap");
      const nameIdx = header.indexOf("asset_name");
      for (const line of csvLines.slice(1)) {
        if (!line.trim()) continue;
        const fields = line.split(",").map((f) => f.replace(/^"|"$/g, "").trim());
        const state = stateIdx >= 0 ? (fields[stateIdx] ?? "") : "";
        const gap = gapIdx >= 0 ? (fields[gapIdx] ?? "") : "";
        if (state === "source unknown" || (gap && !gap.includes("alias available"))) {
          const name = nameIdx >= 0 ? (fields[nameIdx] ?? "unknown") : (fields[0] ?? "unknown");
          const kind = /\.(png|jpe?g|webp|gif|mp4|mov)$/i.test(name) ? "input media" : "model";
          gaps.push({ name, kind, action: gap || `Provide ${kind === "input media" ? "source media file" : "source-identical model file"}` });
        }
      }
    } catch { /* ignore */ }
    try {
      const mdContent = await fs.readFile(mdPath, "utf8");
      const cnRegex = /\|\s*(\S[^|]*?)\s*\|\s*(\S[^|]*?)\s*\|\s*(\S[^|]*?)\s*\|\s*source unknown\s*\|/g;
      let match;
      while ((match = cnRegex.exec(mdContent)) !== null) {
        gaps.push({ name: match[1].trim(), kind: "custom node", action: "Provide the custom-node source package." });
      }
    } catch { /* ignore */ }
    return gaps;
  }

  /**
   * Find a prior human "continue" decision from an earlier step that covers
   * the given blocking reason. Once a human approves at step N, later steps
   * with the same category of issue should auto-approve without re-gating.
   */
  private async findPriorContinueApproval(
    taskId: string,
    currentStepId: string,
    blockingReason: string
  ): Promise<HumanDecision | undefined> {
    const decisions = await this.store.listDecisions(taskId);
    const currentStepNum = parseInt(currentStepId, 10);
    if (isNaN(currentStepNum)) return undefined;

    return decisions.find((decision) => {
      if (!decision.stepId) return false;
      const decisionStepNum = parseInt(decision.stepId, 10);
      if (isNaN(decisionStepNum) || decisionStepNum >= currentStepNum) return false;
      if (!isContinueDecision(decision.answer)) return false;
      return isAutoApprovableCategory(blockingReason);
    });
  }

  /**
   * Read-only lookup: find a replay decision for a given step from replay-decisions.json.
   * Returns undefined if no replay file exists or no matching decision is found.
   */
  private async findReplayDecisionForStep(
    taskId: string,
    stepId: string
  ): Promise<{ answer: string; wasFreeform?: boolean } | undefined> {
    const task = await this.store.getTask(taskId);
    if (!task) return undefined;
    const replayPath = path.join(task.artifactPath, "replay-decisions.json");
    try {
      const raw = await fs.readFile(replayPath, "utf8");
      const data = JSON.parse(raw) as { sourceTaskId: string; decisions: HumanDecision[] };
      if (!Array.isArray(data.decisions)) return undefined;
      return data.decisions.find((d) => d.stepId === stepId);
    } catch {
      return undefined;
    }
  }

  /**
   * During replay mode, check if replay-decisions.json exists for this task
   * and inject a matching decision for the given step, allowing the pipeline
   * to continue without human intervention.
   */
  private async tryInjectReplayDecision(taskId: string, stepId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId);
    if (!task) return false;

    const replayPath = path.join(task.artifactPath, "replay-decisions.json");
    let replayData: { sourceTaskId: string; decisions: HumanDecision[] };
    try {
      const raw = await fs.readFile(replayPath, "utf8");
      replayData = JSON.parse(raw) as typeof replayData;
    } catch {
      return false; // no replay decisions file
    }

    if (!Array.isArray(replayData.decisions) || replayData.decisions.length === 0) return false;

    // Find a decision from the source task that matches this step
    const matchingDecision = replayData.decisions.find((d) => d.stepId === stepId);
    if (!matchingDecision) return false;

    await this.emit({
      taskId,
      stepId,
      type: "progress",
      message: `Replay: auto-injecting decision for Step ${stepId} from source run ${replayData.sourceTaskId}: "${matchingDecision.answer}"`
    });

    // Find the human_question event for this step to get the questionEventId
    const events = await this.store.listEvents(taskId);
    const questionEvent = events.find(
      (e) => e.stepId === stepId && e.type === "human_question"
    );
    const questionEventId = questionEvent?.id ?? `replay-${stepId}-${Date.now()}`;

    await this.recordHumanDecision({
      taskId,
      stepId,
      questionEventId,
      answer: matchingDecision.answer,
      wasFreeform: matchingDecision.wasFreeform ?? true
    });

    return true;
  }

  private async pauseEnvironmentDeploymentOnAssetGaps(
    task: MigrationTask,
    step: MigrationStepDefinition
  ): Promise<boolean> {
    const assetsPath = path.join(task.artifactPath, "01-assets.csv");
    let assetsContent = "";
    try {
      assetsContent = await fs.readFile(assetsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!/source-identical asset not staged/i.test(assetsContent)) return false;

    const environmentPath = path.join(task.artifactPath, "05-environment.md");
    await fs.writeFile(
      environmentPath,
      [
        "# Step 05 Environment Deployment",
        "",
        "## Status",
        "",
        "Environment deployment is blocked before SDK execution because Step 01 still documents source-identical asset gaps.",
        "",
        "No packages were installed, no ComfyUI environment was modified, no credentials were recorded, and no workflow nodes were bypassed.",
        "",
        "## Blocking evidence",
        "",
        "- `01-assets.csv` contains one or more `source-identical asset not staged` rows.",
        "- Continuing into install/runtime work would blur source-complete migration with smoke-only validation.",
        "",
        "## Required action",
        "",
        "Provide the missing source-identical assets, stop the migration here, or explicitly approve a bounded smoke-only environment attempt with documented gaps.",
        ""
      ].join("\n"),
      "utf8"
    );
    await this.store.appendArtifact({
      taskId: task.id,
      stepId: step.id,
      path: environmentPath,
      relativePath: path.relative(task.workspacePath, environmentPath),
      kind: "markdown"
    });
    // Write structured gate-signal.json instead of embedding gate status in artifact text
    const gateSignalPath = path.join(task.artifactPath, "05-gate-signal.json");
    await fs.writeFile(
      gateSignalPath,
      JSON.stringify({
        stepId: "05",
        gated: true,
        category: "missing_asset",
        trigger: "deterministic",
        reason: "Step 05 environment deployment blocked: Step 01 still has source-identical asset gaps."
      }, null, 2),
      "utf8"
    );
    const message =
      "Step 05 stopped before environment deployment because Step 01 still has source-identical asset gaps.";
    await this.store.updateStep(task.id, step.id, "waiting_for_human", {
      summary: message
    });
    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "artifact_created",
      message: "Created Step 05 environment deployment gate artifact.",
      data: { path: environmentPath }
    });
    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "human_question",
      message,
      data: {
        question:
          "Step 05 is blocked by source-identical asset gaps from Step 01. How should validation continue?",
        choices: [
          "Provide missing source-identical assets before Step 05",
          "Approve bounded smoke-only environment attempt with documented gaps",
          "Stop migration at Step 05"
        ],
        allowFreeform: true,
        blockingReason: "missing_asset",
        artifactPath: environmentPath
      }
    });
    return true;
  }

  private async buildStep00FollowupQuestionData(
    task: MigrationTask,
    previousAnswer: string
  ): Promise<QuestionEventData> {
    const artifactPath = path.join(task.artifactPath, "00-intake-preflight.md");
    const content = await fs.readFile(artifactPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const details = step00DetailsFromArtifact(content);
    return {
      question:
        `Step 00 recorded your answer, but it still needs actionable source information before Step 01. Paste exact local file paths/source notes for the missing assets, approve bounded smoke-only follow-up, or stop migration.`,
      choices: [
        "Approve bounded smoke-only follow-up with documented gaps",
        "Stop migration at Step 00"
      ],
      allowFreeform: true,
      blockingReason: "missing_asset",
      artifactPath: "artifacts/00-intake-preflight.md",
      details: [
        `Previous answer: ${redactSensitiveText(previousAnswer)}`,
        ...details,
        "If providing assets, include exact local paths or approved source locations. Do not paste credentials."
      ]
    };
  }

  async reconcileStaleActiveTasks(
    reason = "Stale active task state cleaned up; no active SDK session is attached in this API process."
  ): Promise<Array<{ id: string; name: string; stepIds: string[] }>> {
    const tasks = await this.store.listTasks();
    const liveTaskIds = this.liveTaskIds();
    const cleaned: Array<{ id: string; name: string; stepIds: string[] }> = [];

    for (const task of tasks) {
      if (!hasPersistedActiveState(task) || liveTaskIds.has(task.id)) continue;

      await this.syncPhase1TaskState(task.id).catch(() => []);
      const refreshedTask = (await this.store.getTask(task.id)) ?? task;
      if (!hasPersistedActiveState(refreshedTask)) continue;

      const stepIds = refreshedTask.steps
        .filter((step) => step.status === "running")
        .map((step) => step.id);
      if (await this.failCompletedButIncompletePhase1Session(refreshedTask, reason, stepIds)) {
        cleaned.push({ id: refreshedTask.id, name: refreshedTask.name, stepIds });
        continue;
      }
      const updated = await this.store.terminateActiveTaskState(refreshedTask.id, reason);
      if (!updated) continue;
      cleaned.push({ id: refreshedTask.id, name: refreshedTask.name, stepIds });
      await this.emit({
        taskId: refreshedTask.id,
        type: "progress",
        message: `Cleaned up stale active task state: ${reason}`,
        data: { staleStepIds: stepIds }
      });
    }

    return cleaned;
  }

  private async failCompletedButIncompletePhase1Session(
    task: MigrationTask,
    reason: string,
    stepIds: string[]
  ): Promise<boolean> {
    const events = await this.store.listEvents(task.id);
    const completedPhase1Session = [...events].reverse().find((event) => {
      if (event.stepId !== "phase1" || event.type !== "step_summary") return false;
      return isRecord(event.data) && isRecord(event.data.sessionArtifacts);
    });
    if (!completedPhase1Session) return false;

    const message = [
      "Phase 1 SDK session already ended, but task-state.json still has running steps.",
      reason,
      `Stale running steps: ${stepIds.join(", ") || "unknown"}.`,
      "The run is marked failed instead of left running because no live SDK session can continue it."
    ].join(" ");

    for (const stepId of stepIds) {
      await this.store.updateStep(task.id, stepId, "failed", { error: message });
    }
    await this.emit({
      taskId: task.id,
      stepId: "phase1",
      type: "step_failed",
      message,
      data: {
        staleStepIds: stepIds,
        completedPhase1SessionEventId: completedPhase1Session.id
      }
    });
    return true;
  }

  private async prepareExclusiveNewTask(): Promise<void> {
    await this.reconcileStaleActiveTasks(
      "Before creating a new migration task; previous server sessions cannot keep SDK steps attached."
    );
    this.assertNoLiveStepRuns("Create a new migration task");

    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      await deleteTaskWorkspace(this.config.workspaceRoot, task.workspacePath);
      await this.store.deleteTask(task.id);
    }
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => listeners.delete(listener);
  }

  private async emit(event: Omit<AgentEvent, "id" | "createdAt">): Promise<AgentEvent> {
    const normalized = normalizeHumanQuestionEvent(event);
    const record = shouldPersistApiEvent(normalized)
      ? await this.store.appendEvent(normalized)
      : {
          ...normalized,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        };
    for (const listener of this.listeners.get(record.taskId) ?? []) {
      listener(record);
    }
    return record;
  }

  /**
   * Best-effort feedback-event writer (§G.wire). Fire-and-forget at call
   * sites via `await this.recordFeedback(...)`. Never throws — feedback
   * collection must not break the main orchestrator flow.
   *
   * Call sites:
   *   - terminateWithHardStop     (human explicitly stops a step)
   *   - recordHumanDecision       (non-routine human input only)
   *   - SDK paused                 (watchdog timeout, session kept alive)
   *   - step failure catch block   (unhandled exception)
   */
  private async recordFeedback(taskId: string, input: FeedbackEventInput): Promise<void> {
    try {
      await appendFeedbackEvent(this.config.workspaceRoot, taskId, input);
    } catch (e) {
      // Swallow. The next daily-check (§J) won't surface this since the
      // event never landed; accept the loss rather than blocking the user.
      console.warn(
        `[feedbackLog] write failed (task=${taskId} step=${input.stepId}): ${(e as Error).message}`
      );
    }
  }

  private stepRunKey(taskId: string, stepId: string): string {
    return `${taskId}:${stepId}`;
  }

  private liveTaskIds(): Set<string> {
    return new Set([...this.activeStepRuns].map((key) => key.split(":", 1)[0]));
  }

  private assertNoLiveStepRuns(action: string): void {
    if (this.activeStepRuns.size === 0) return;
    // Ignore run-locks held by hard-stopped/terminated tasks: those locks are
    // just the in-flight SDK call winding down and must not block new work.
    const blocking = [...this.activeStepRuns].filter((key) => {
      const tid = key.split(":", 1)[0];
      return !this.hardStoppedTaskIds.has(tid);
    });
    if (blocking.length === 0) return;
    throw new Error(
      `${action} cannot continue while another migration step is actively running in this API process.`
    );
  }

  /**
   * Release every run-lock held by a task. Called by terminateWithHardStop so a
   * hard-stopped task frees the one-run-per-process lock immediately, instead of
   * holding it until the in-flight SDK call happens to return (which can take
   * minutes and blocks new task creation with a 500 in the meantime).
   */
  private releaseTaskRuns(taskId: string): void {
    const prefix = `${taskId}:`;
    for (const key of [...this.activeStepRuns]) {
      if (key.startsWith(prefix)) this.activeStepRuns.delete(key);
    }
  }

  /**
   * Sync input-media files to the running ComfyUI instance via its upload API.
   * Ensures LoadImage nodes can see uploaded images even when ComfyUI uses
   * a custom --input-directory that doesn't include ComfyUI/input/.
   */
  private async syncInputMediaToComfyUI(task: MigrationTask): Promise<void> {
    const apiUrl = await this.getComfyUIApiUrl(task);
    if (!apiUrl) return;

    const inputMediaDir = path.join(task.artifactPath, "input-media");
    let files: string[];
    try {
      files = await fs.readdir(inputMediaDir);
    } catch {
      return; // No input-media dir
    }

    const imageFiles = files.filter((f) =>
      /\.(png|jpe?g|webp|gif|bmp|tiff|mp4|mov|webm)$/i.test(f)
    );

    for (const file of imageFiles) {
      const filePath = path.join(inputMediaDir, file);
      try {
        const url = new URL("/upload/image", apiUrl);
        const args = ["-s", "-X", "POST", "-F", `image=@${filePath}`, "-F", "overwrite=true", url.toString()];
        await new Promise<void>((resolve, reject) => {
          execFile("curl", args, { timeout: 30_000 }, (err, stdout) => {
            if (err) reject(new Error(`curl upload failed: ${err.message}`));
            else resolve();
          });
        });
      } catch (err) {
        console.warn(`[syncInputMedia] Failed to upload ${file} to ComfyUI: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Get the ComfyUI API URL from task's Step 05 completion signals.
   */
  private async getComfyUIApiUrl(task: MigrationTask): Promise<string | undefined> {
    try {
      const statePath = path.join(task.workspacePath, "task-state.json");
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      const apiUrl = state?.steps?.["05"]?.completion_signals?.api_url;
      if (typeof apiUrl === "string" && apiUrl.startsWith("http")) return apiUrl;
    } catch { /* ignore */ }
    return undefined;
  }

  /**
   * Kill ComfyUI processes for a task. Routes to local pgrep or remote SSH kill
   * based on the task's GPU node kind. Used during rerunStep + hard-stop.
   */
  private async killComfyUIForTask(task: MigrationTask): Promise<number> {
    const node = this.lookupTaskNode(task);
    if (node?.kind === "ssh") {
      return this.killRemoteComfyUI(task, node);
    }
    return this.killLocalComfyUI(task);
  }

  /** Backwards-compatible local-only kill; preserved for callers that want local behaviour. */
  private async killComfyUIProcessesForTask(task: MigrationTask): Promise<number> {
    return this.killLocalComfyUI(task);
  }

  private async killLocalComfyUI(task: MigrationTask): Promise<number> {
    return new Promise((resolve) => {
      execFile("pgrep", ["-f", `main.py.*${task.workspacePath}`], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(0);
          return;
        }
        const pids = stdout.trim().split("\n").map(Number).filter((n) => n > 0 && !isNaN(n));
        let killed = 0;
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
            killed++;
          } catch { /* process already gone */ }
        }
        resolve(killed);
      });
    });
  }

  /**
   * SSH to the remote node and kill the ComfyUI process for this task.
   * Matches by port (each task's node has a fixed api_port) to avoid killing
   * unrelated workloads. Returns 0 if no match or SSH failed (best-effort).
   */
  private async killRemoteComfyUI(task: MigrationTask, node: GpuNode): Promise<number> {
    if (!node.ssh) return 0;
    const port = node.api_port;
    const sshTarget = `${node.ssh.user}@${node.ssh.host}`;
    const sshArgs = [
      "-p", String(node.ssh.port ?? 22),
      ...(node.ssh.key_path ? ["-i", node.ssh.key_path] : []),
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      sshTarget,
      `pkill -f 'main.py.*--port ${port}' || true`
    ];
    return new Promise((resolve) => {
      execFile("ssh", sshArgs, { timeout: 30_000 }, (err) => {
        if (err) {
          console.warn(
            `[killRemoteComfyUI] SSH kill failed for task ${task.id} on ${sshTarget}:${port} — ${err.message}`
          );
          resolve(0);
          return;
        }
        resolve(1);
      });
    });
  }

  /**
   * Look up the GpuNode a task is pinned to. Returns undefined for the
   * synthesized-default case (which is always kind=local).
   */
  private lookupTaskNode(task: MigrationTask): GpuNode | undefined {
    try {
      const registry = loadGpuNodes(this.config);
      const node = pickNode(registry, task.gpuNode);
      return node;
    } catch (err) {
      console.warn(`[lookupTaskNode] Failed to load gpu-nodes.json: ${(err as Error).message}`);
      return undefined;
    }
  }
}

function hasPersistedActiveState(task: MigrationTask): boolean {
  return task.status === "running" || task.steps.some((step) => step.status === "running");
}

function isTerminalPhase1Status(status: string): boolean {
  return [
    "completed",
    "waiting_for_human",
    "human_gate",
    "human_gate_reached",
    "failed",
    "hard_stopped",
    "hard_stop",
    "terminated"
  ].includes(status);
}

function normalizeAssetAcquisitionUnresolvedItems(
  job: Record<string, unknown>
): AssetAcquisitionUnresolvedItem[] {
  if (Array.isArray(job.unresolvedItems)) {
    return job.unresolvedItems.filter(isRecord).map((item) => ({
      assetName: stringValue(item.assetName) ?? stringValue(item.asset_name) ?? "unknown asset",
      requestedName:
        stringValue(item.requestedName) ??
        stringValue(item.requested_name) ??
        stringValue(item.assetName) ??
        stringValue(item.asset_name) ??
        "unknown asset",
      kind: stringValue(item.kind) ?? "asset",
      sourceNodeIds: stringArray(item.sourceNodeIds ?? item.source_node_ids),
      sourceContext: stringValue(item.sourceContext) ?? stringValue(item.source_context) ?? "",
      expectedTargetPath: stringValue(item.expectedTargetPath) ?? stringValue(item.expected_target_path),
      targetPath: stringValue(item.targetPath) ?? stringValue(item.target_path),
      candidateCount: numberValue(item.candidateCount) ?? numberValue(item.candidate_count) ?? 0,
      searchIssueCount: numberValue(item.searchIssueCount) ?? numberValue(item.search_issue_count) ?? 0,
      nextAction: stringValue(item.nextAction) ?? stringValue(item.next_action) ?? "Provide exact source or approve a bounded route."
    }));
  }

  const items = Array.isArray(job.items) ? job.items.filter(isRecord) : [];
  return items
    .filter((item) => stringValue(item.status) === "pending_secure_download")
    .map((item) => ({
      assetName: stringValue(item.assetName) ?? "unknown asset",
      requestedName: stringValue(item.requestedName) ?? stringValue(item.assetName) ?? "unknown asset",
      kind: stringValue(item.kind) ?? "asset",
      sourceNodeIds: stringArray(item.sourceNodeIds ?? item.source_node_ids),
      sourceContext: stringValue(item.sourceContext) ?? "",
      expectedTargetPath: stringValue(item.expectedTargetPath),
      targetPath: stringValue(item.targetPath),
      candidateCount: Array.isArray(item.candidates) ? item.candidates.length : 0,
      searchIssueCount: Array.isArray(item.searchIssues) ? item.searchIssues.length : 0,
      nextAction: Array.isArray(item.plannedActions)
        ? item.plannedActions.filter((entry): entry is string => typeof entry === "string").join(" ")
        : "Provide exact source or approve a bounded route."
    }));
}

type Step01AssetRow = Record<string, string>;

interface Step01GateItem {
  assetName: string;
  kind?: string;
  sourceNodeIds: string[];
  expectedTargetPath?: string;
  sourceContext?: string;
}

async function readStep01AssetRows(task: MigrationTask): Promise<Step01AssetRow[]> {
  const assetPath = safeJoin(task.workspacePath, "artifacts/01-assets.csv");
  let content: string;
  try {
    content = await fs.readFile(assetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseCsvRecords(content);
}

async function readStep01GateItems(task: MigrationTask): Promise<Step01GateItem[]> {
  const gatePath = safeJoin(task.workspacePath, "artifacts/01-human-gate.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(gatePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const gate = isRecord(parsed) && isRecord(parsed.human_gate) ? parsed.human_gate : parsed;
  const rows = isRecord(gate) && Array.isArray(gate.unresolved_items) ? gate.unresolved_items.filter(isRecord) : [];
  return rows.map((row) => ({
    assetName:
      stringValue(row.item) ??
      stringValue(row.assetName) ??
      stringValue(row.asset_name) ??
      stringValue(row.requestedName) ??
      stringValue(row.requested_name) ??
      "unknown asset",
    kind: stringValue(row.kind),
    sourceNodeIds: stringArray(row.source_node_ids ?? row.sourceNodeIds),
    expectedTargetPath: stringValue(row.expected_target_path) ?? stringValue(row.expectedTargetPath),
    sourceContext: stringValue(row.source_context) ?? stringValue(row.sourceContext) ?? stringValue(row.current_state)
  }));
}

function enrichAssetAcquisitionUnresolvedItems(
  items: AssetAcquisitionUnresolvedItem[],
  assetRows: Step01AssetRow[],
  gateItems: Step01GateItem[]
): AssetAcquisitionUnresolvedItem[] {
  const rowByKey = new Map<string, Step01AssetRow>();
  for (const row of assetRows) {
    for (const key of assetLookupKeys(row.asset_name, row.requested_name, row.staged_path, row.resolved_path)) {
      if (!rowByKey.has(key)) rowByKey.set(key, row);
    }
  }

  const gateByKey = new Map<string, Step01GateItem>();
  for (const gate of gateItems) {
    for (const key of assetLookupKeys(gate.assetName, gate.expectedTargetPath)) {
      if (!gateByKey.has(key)) gateByKey.set(key, gate);
    }
  }

  return items.map((item) => {
    const keys = assetLookupKeys(item.assetName, item.requestedName, item.expectedTargetPath, item.targetPath);
    const row = keys.map((key) => rowByKey.get(key)).find(Boolean);
    const gate = keys.map((key) => gateByKey.get(key)).find(Boolean);
    const sourceNodeIds = uniqueStrings([
      ...(item.sourceNodeIds ?? []),
      ...(gate?.sourceNodeIds ?? [])
    ]);
    const sourceContext =
      item.sourceContext ||
      rowSourceContext(row) ||
      gate?.sourceContext ||
      (sourceNodeIds.length ? `Source workflow node(s): ${sourceNodeIds.join(", ")}` : "");
    return {
      ...item,
      requestedName: item.requestedName === "unknown asset" ? row?.requested_name ?? item.requestedName : item.requestedName,
      kind: item.kind !== "asset" ? item.kind : gate?.kind ?? inferAssetKind(row, item),
      sourceNodeIds,
      sourceContext,
      expectedTargetPath: item.expectedTargetPath ?? gate?.expectedTargetPath ?? row?.staged_path,
      nextAction:
        sourceNodeIds.length > 0
          ? `Stage the exact source-identical file for source node(s) ${sourceNodeIds.join(", ")} at the expected target path, provide a secure source URL/download approval, approve a bounded route, or stop.`
          : item.nextAction
    };
  });
}

function assetLookupKeys(...values: Array<string | undefined>): string[] {
  return uniqueStrings(
    values
      .flatMap((value) => {
        if (!value) return [];
        return [value, path.basename(value)];
      })
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function rowSourceContext(row: Step01AssetRow | undefined): string {
  if (!row) return "";
  return [
    row.wrapper_source_evidence,
    row.custom_node_repo ? `custom_node_repo: ${row.custom_node_repo}` : "",
    row.source && row.source !== "not found in configured local roots/cache" ? `source: ${row.source}` : "",
    row.gap
  ].filter(Boolean).join("; ");
}

function inferAssetKind(row: Step01AssetRow | undefined, item: AssetAcquisitionUnresolvedItem): string {
  const context = [
    item.sourceContext,
    item.expectedTargetPath,
    item.targetPath,
    row?.wrapper_source_evidence,
    row?.staged_path,
    row?.custom_node_repo
  ].filter(Boolean).join(" ");
  if (/custom_nodes|wrapper|hidden|custom_hf_download|from_pretrained/i.test(context)) {
    return "hidden_runtime_asset";
  }
  if (/models\/|model selector|loras|vae|diffusion_models|checkpoints/i.test(context)) {
    return "model";
  }
  return item.kind || "asset";
}

function parseCsvRecords(content: string): Step01AssetRow[] {
  const lines = content.trimEnd().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = parseCsvRecordLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvRecordLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parseCsvRecordLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function assetAcquisitionGateDetails(items: AssetAcquisitionUnresolvedItem[]): string[] {
  return items.flatMap((item, index) => [
    `${index + 1}. Missing ${item.kind}: ${item.assetName}`,
    `   requested_name: ${item.requestedName}`,
    `   source_node_ids: ${(item.sourceNodeIds ?? []).join(", ") || "not recorded"}`,
    `   source_context: ${item.sourceContext || "not recorded"}`,
    `   expected_target_path: ${item.expectedTargetPath ?? item.targetPath ?? "not recorded"}`,
    `   candidate_sources_found: ${item.candidateCount}; search_issues: ${item.searchIssueCount}`,
    `   human_action: provide the exact file/path or source URL for ${item.assetName}, approve secure download access, approve bounded gaps, or stop.`
  ]);
}

function phase1SyncIntervalMs(): number {
  const parsed = Number(process.env.MIGRATION_AGENT_PHASE1_SYNC_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10_000;
}

function phase1ContextBudgetEvent(
  taskId: string,
  event: unknown,
  semanticProgress?: string
): Omit<AgentEvent, "id" | "createdAt"> | undefined {
  return sdkEventToContextBudgetEvent(taskId, event, semanticProgress);
}

function normalizeHumanQuestionEvent(
  event: Omit<AgentEvent, "id" | "createdAt">
): Omit<AgentEvent, "id" | "createdAt"> {
  if (event.type !== "human_question") return event;
  const data = isRecord(event.data) ? event.data : {};
  const question = stringValue(data.question) ?? event.message;
  const choices = stringArray(data.choices);
  const blockingReason = humanQuestionBlockingReason(data.blockingReason, event.stepId);
  const allowFreeform = typeof data.allowFreeform === "boolean" ? data.allowFreeform : true;
  const normalizedChoices =
    choices.length > 0 ? choices : ["Provide requested input", "Stop at this gate"];
  return {
    ...event,
    data: {
      ...data,
      question,
      choices: normalizedChoices,
      allowFreeform,
      blockingReason,
      decisionContext: normalizeDecisionContext({
        existing: data.decisionContext,
        stepId: event.stepId,
        question,
        choices: normalizedChoices,
        blockingReason,
        fallbackBackground: event.message,
        details: stringArray(data.details),
        claimBoundaryImpact: data.claimBoundaryImpact
      })
    }
  };
}

function normalizeDecisionContext(input: {
  existing: unknown;
  stepId?: string;
  question: string;
  choices: string[];
  blockingReason: HumanQuestion["blockingReason"];
  fallbackBackground: string;
  details: string[];
  claimBoundaryImpact?: unknown;
}): HumanDecisionContext {
  const existing = isRecord(input.existing) ? input.existing : undefined;
  const existingBackground =
    stringValue(existing?.backgroundReasonScene) ?? stringValue(existing?.background_reason_scene);
  const existingTerms = normalizeTerms(existing?.terminology);
  const existingConsequences = normalizeConsequences(
    existing?.consequencesAndFollowUp ?? existing?.consequences_and_follow_up
  );
  const background =
    existingBackground ??
    [
      input.fallbackBackground,
      input.details.length ? `Known details: ${input.details.slice(0, 4).join("; ")}.` : "",
      input.stepId ? `This decision blocks Step ${input.stepId} until an operator chooses a safe edge.` : ""
    ]
      .filter(Boolean)
      .join(" ");
  return {
    formatVersion: "human-gate-v1",
    backgroundReasonScene: background,
    terminology: dedupeTerms([...existingTerms, ...defaultHumanGateTerms(input.blockingReason)]),
    consequencesAndFollowUp:
      existingConsequences.length > 0
        ? existingConsequences
        : input.choices.map((choice) =>
            consequenceForChoice(choice, input.blockingReason, input.claimBoundaryImpact)
          )
  };
}

function defaultHumanGateTerms(reason: HumanQuestion["blockingReason"]): HumanDecisionContext["terminology"] {
  const common = [
    {
      term: "claim boundary",
      explanation:
        "The exact scope the agent is allowed to claim after the decision, such as smoke-only, full-size, source-identical, GUI-accepted, or customer-ready."
    },
    {
      term: "human gate",
      explanation:
        "A pause where the agent cannot safely choose between valid routes because the choice changes risk, evidence, credentials, cost, or delivery claims."
    }
  ];
  if (reason === "missing_asset") {
    return [
      {
        term: "source-identical asset",
        explanation:
          "The exact model, LoRA, input, or custom-node source requested by the workflow; similar filenames or replacements are not treated as identical evidence."
      },
      {
        term: "substitute or alias",
        explanation:
          "A different local file or source used only after human approval; it downgrades fidelity claims unless later source-identical evidence is supplied."
      },
      {
        term: "bounded smoke-only follow-up",
        explanation:
          "A limited continuation to test basic load/runtime behavior while explicitly avoiding source-identical, full-size, or customer-ready claims."
      },
      ...common
    ];
  }
  if (reason === "capacity_policy") {
    return [
      {
        term: "full-size",
        explanation:
          "A run at the original workflow resolution/duration/settings rather than a reduced runtime-policy validation path."
      },
      {
        term: "cache-assisted",
        explanation:
          "A pass that reused already-computed outputs or loaded state; it is weaker evidence than a cold full run."
      },
      ...common
    ];
  }
  if (reason === "permission") {
    return [
      {
        term: "approve once",
        explanation:
          "Allow this single tool or SDK permission request only for the current operation; it is not a permanent grant."
      },
      {
        term: "reject",
        explanation:
          "Deny the requested operation, which may pause, fail, or route the step to a safer alternative."
      },
      ...common
    ];
  }
  if (reason === "quality_review") {
    return [
      {
        term: "GUI/manual acceptance",
        explanation:
          "A human-run validation in ComfyUI Web with recorded outputs/logs/signoff; preparation artifacts alone do not count."
      },
      {
        term: "customer-ready",
        explanation:
          "A stronger delivery claim that requires evidence matching the requested fidelity, runtime scope, and acceptance criteria."
      },
      ...common
    ];
  }
  return common;
}

function consequenceForChoice(
  choice: string,
  reason: HumanQuestion["blockingReason"],
  claimBoundaryImpact: unknown
): HumanDecisionContext["consequencesAndFollowUp"][number] {
  const normalized = choice.toLowerCase();
  if (normalized.includes("stop") || normalized.includes("reject")) {
    return {
      choice,
      consequence: "The agent will not continue along the blocked path.",
      followUp: "Record the gate decision and leave the step stopped, rejected, hard-stopped, or awaiting a revised route."
    };
  }
  if (normalized.includes("exact") || normalized.includes("source-identical") || normalized.includes("provide")) {
    return {
      choice,
      consequence: "The agent can retry only the affected resolution or validation work with the supplied evidence.",
      followUp:
        reason === "missing_asset"
          ? "Stage/verify the provided paths or source records, update ledgers, then rerun the next dependent step."
          : "Record the supplied context, update artifacts, and continue only if the evidence closes the gate."
    };
  }
  if (normalized.includes("bounded") || normalized.includes("smoke") || normalized.includes("documented risk")) {
    return {
      choice,
      consequence:
        "The workflow may continue, but downstream success claims remain downgraded to the documented bounded route.",
      followUp: `Persist the downgrade in task-state/artifacts and carry it into later reports.${
        claimBoundaryImpact ? ` Claim impact: ${String(claimBoundaryImpact)}` : ""
      }`
    };
  }
  if (normalized.includes("approve")) {
    return {
      choice,
      consequence: "The agent may perform the approved operation for this gate only.",
      followUp: "Record the approval, execute the requested continuation edge, and keep all claim-boundary limits visible."
    };
  }
  return {
    choice,
    consequence: "The selected route determines whether the step can continue, retry, or stop.",
    followUp: "The agent records the answer, updates task-state, and resumes only along the matching safe edge."
  };
}

function normalizeTerms(value: unknown): HumanDecisionContext["terminology"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      term: stringValue(item.term) ?? "",
      explanation: stringValue(item.explanation) ?? ""
    }))
    .filter((item) => item.term && item.explanation);
}

function normalizeConsequences(value: unknown): HumanDecisionContext["consequencesAndFollowUp"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      choice: stringValue(item.choice) ?? "",
      consequence: stringValue(item.consequence) ?? "",
      followUp: stringValue(item.followUp) ?? stringValue(item.follow_up) ?? ""
    }))
    .filter((item) => item.choice && item.consequence && item.followUp);
}

function dedupeTerms(terms: HumanDecisionContext["terminology"]): HumanDecisionContext["terminology"] {
  const seen = new Set<string>();
  const result: HumanDecisionContext["terminology"] = [];
  for (const term of terms) {
    const key = term.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
  }
  return result.slice(0, 8);
}

function humanQuestionBlockingReason(
  value: unknown,
  stepId?: string
): HumanQuestion["blockingReason"] {
  const allowed: HumanQuestion["blockingReason"][] = [
    "schema_change",
    "missing_asset",
    "hard_stop",
    "quality_review",
    "capacity_policy",
    "permission",
    "other"
  ];
  return allowed.includes(value as HumanQuestion["blockingReason"])
    ? (value as HumanQuestion["blockingReason"])
    : phase1BlockingReasonForStep(stepId ?? "");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildStep00QuestionData(
  task: MigrationTask,
  intake: {
    artifactPath: string;
    hardStops: string[];
    modelRows: Array<{ requestedAsset: string; state: string; humanAction: string }>;
    customNodeRows: Array<{ nodeType: string; state: string; humanAction: string }>;
  }
): QuestionEventData {
  const details = [
    ...intake.hardStops.slice(0, 8),
    ...intake.modelRows
      .filter((row) => row.state !== "staged")
      .slice(0, 8)
      .map((row) => `${row.requestedAsset}: ${row.state}; ${row.humanAction}`),
    ...intake.customNodeRows
      .filter((row) => row.state !== "source known")
      .slice(0, 5)
      .map((row) => `${row.nodeType}: ${row.state}; ${row.humanAction}`)
  ];
  const uniqueDetails = [...new Set(details)];
  return {
    question:
      `Step 00 found ${uniqueDetails.length || "blocking"} dependency-source gap(s) before feasibility analysis. Review the details, then provide exact source-identical files/source notes, approve bounded smoke-only follow-up, or stop migration.`,
    choices: [
      "Provide missing source-identical assets before Step 01",
      "Approve bounded smoke-only follow-up with documented gaps",
      "Stop migration at Step 00"
    ],
    allowFreeform: true,
    blockingReason: "missing_asset",
    artifactPath: path.relative(task.workspacePath, intake.artifactPath),
    details: uniqueDetails.length
      ? uniqueDetails
      : ["See artifacts/00-intake-preflight.md for dependency-source details."]
  };
}

function step00DetailsFromArtifact(content: string): string[] {
  const details: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const hardStops = line.match(/^hard_stops:\s*(.+)$/i)?.[1];
    if (hardStops && hardStops !== "none") {
      details.push(...hardStops.split(";").map((item) => item.trim()).filter(Boolean));
    }
    const blockingModels = line.match(/^\|\s*Blocking model\/input gaps\s*\|\s*(.+?)\s*\|$/i)?.[1];
    if (blockingModels && blockingModels !== "none") details.push(`Blocking model/input gaps: ${blockingModels}`);
    const blockingCustomNodes = line.match(/^\|\s*Blocking custom-node gaps\s*\|\s*(.+?)\s*\|$/i)?.[1];
    if (blockingCustomNodes && blockingCustomNodes !== "none") {
      details.push(`Blocking custom-node gaps: ${blockingCustomNodes}`);
    }
  }
  return [...new Set(details)].slice(0, 10);
}

function isActionableSourceContext(answer: string): boolean {
  const normalized = answer.toLowerCase();
  return (
    /(^|\s)\/[\w./@+-]+/.test(answer) ||
    /https?:\/\//i.test(answer) ||
    /\b(ssh|scp|rsync|remote|hf_endpoint|huggingface|hf-mirror|civitai|proxy|custom[-\s]?node|model root|hf_models|weights|models)\b/i.test(
      normalized
    )
  );
}

function isActionableGateContext(answer: string, wasFreeform: boolean): boolean {
  const trimmed = answer.trim();
  if (!trimmed || isStopDecision(trimmed) || isBareChoice(trimmed)) return false;
  if (isActionableSourceContext(trimmed)) return true;
  return wasFreeform && trimmed.length >= 16 && /[\p{L}\p{N}]/u.test(trimmed);
}

function isBareChoice(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return [
    "provide missing context before continuing",
    "provide missing source-identical assets before feasibility",
    "provide missing source-identical assets before step 05"
  ].includes(normalized);
}

/**
 * Blocking reasons that can be auto-approved when a prior human already
 * accepted the same category of risk at an earlier step.
 * "hard_stop" and "schema_change" always require fresh human input —
 * they represent genuinely new critical issues not covered by earlier approvals.
 */
function isAutoApprovableCategory(blockingReason: string): boolean {
  return blockingReason === "quality_review" ||
    blockingReason === "missing_asset" ||
    blockingReason === "capacity_policy";
}

function isStopDecision(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (/\b(do not|don't|dont|not)\s+stop\b/.test(normalized)) return false;
  return (
    normalized === "stop" ||
    normalized.startsWith("stop ") ||
    normalized.includes("stop migration") ||
    normalized.includes("stop at this gate") ||
    normalized.includes("停止")
  );
}

function isContinueDecision(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (/\b(do not|don't|dont|not)\s+(approve|continue)\b/.test(normalized)) return false;
  return (
    normalized.includes("approve") ||
    normalized.includes("smoke") ||
    normalized.includes("continue") ||
    normalized.includes("继续") ||
    normalized.includes("批准") ||
    normalized.includes("同意")
  );
}

function isContextBudgetResumeDecision(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || isStopDecision(normalized)) return false;
  return (
    normalized.includes("resume phase 1") ||
    normalized.includes("resume phase1") ||
    normalized.includes("compact checkpoint") ||
    normalized.includes("fresh sdk session") ||
    normalized.includes("restart from") ||
    normalized.includes("继续")
  );
}

async function phase1HumanGateFromStep(
  step: Phase1StepState,
  task: MigrationTask
): Promise<
  | {
      gateId: string;
      problemSummary: string;
      question: string;
      choices: string[];
      artifactPaths: string[];
      claimBoundaryImpact?: unknown;
      decisionContext: HumanDecisionContext;
    }
  | undefined
> {
  const decision =
    step.completion_decision && typeof step.completion_decision === "object"
      ? step.completion_decision
      : {};
  const gate = decision.human_gate;
  const gateRecord =
    gate && typeof gate === "object" ? (gate as Record<string, unknown>) : undefined;
  const promptRecord =
    decision.human_gate_prompt && typeof decision.human_gate_prompt === "object"
      ? (decision.human_gate_prompt as Record<string, unknown>)
      : undefined;
  const recommendation =
    decision.next_step_recommendation && typeof decision.next_step_recommendation === "object"
      ? (decision.next_step_recommendation as Record<string, unknown>)
      : undefined;
  const isGateLike =
    gateRecord ||
    promptRecord ||
    step.status === "waiting_for_human" ||
    step.status === "human_gate" ||
    step.status === "human_gate_reached" ||
    decision.status === "human_gate_reached" ||
    decision.status === "waiting_for_human" ||
    decision.status === "human_gate" ||
    decision.result === "human_gate" ||
    recommendation?.edge_type === "human_gate" ||
    typeof decision.human_gate_prompt === "string";
  if (!isGateLike) return undefined;
  const blockedBy = Array.isArray(recommendation?.blocked_by)
    ? recommendation.blocked_by.filter((item): item is string => typeof item === "string")
    : [];
  const effectiveGateRecord = await phase1GateRecordForStep(
    task,
    step,
    gateRecord ?? promptRecord,
    decision
  );
  const gateId =
    stringValue(effectiveGateRecord?.question_event_id) ??
    stringValue(effectiveGateRecord?.gate_id) ??
    blockedBy[0] ??
    `phase1-step-${step.id}-human-gate`;
  const problemSummary =
    stringValue(effectiveGateRecord?.problem_summary) ??
    stringValue(decision.human_gate_prompt) ??
    step.summary ??
    `Step ${step.id} is waiting for a Phase 1 human decision.`;
  const choices = effectiveGateRecord ? phase1HumanGateChoices(effectiveGateRecord) : [];
  const artifactPaths = phase1ArtifactPathList(decision);
  return {
    gateId,
    problemSummary,
    question: `${problemSummary}\n\nReply with one of the listed choices or provide the requested exact context. Phase 1 gate id: ${gateId}.`,
    choices:
      choices.length > 0
        ? choices
        : [
            "Provide missing context before continuing",
            "Continue with documented risk/gaps",
            "Stop at this gate"
          ],
    artifactPaths,
    claimBoundaryImpact: effectiveGateRecord?.claim_boundary_impact ?? blockedBy,
    decisionContext: phase1DecisionContext(step, problemSummary, choices, effectiveGateRecord)
  };
}

function phase1ArtifactPathList(decision: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const key of ["evidence", "evidence_artifacts"]) {
    const value = decision[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") paths.add(item);
    }
  }
  for (const key of ["detail_ref", "artifact_ref"]) {
    const value = decision[key];
    if (typeof value === "string") paths.add(value);
  }
  for (const key of ["human_gate", "human_gate_prompt"]) {
    const value = decision[key];
    if (!isRecord(value)) continue;
    for (const refKey of ["artifact_ref", "decision_context_ref", "detail_ref"]) {
      const ref = value[refKey];
      if (typeof ref === "string") paths.add(ref);
    }
  }
  return [...paths];
}

async function phase1GateRecordForStep(
  task: MigrationTask,
  step: Phase1StepState,
  gateRecord: Record<string, unknown> | undefined,
  decision: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const explicitRef =
    stringValue(gateRecord?.artifact_ref) ??
    stringValue(gateRecord?.decision_context_ref) ??
    stringValue(gateRecord?.detail_ref);
  if (explicitRef) {
    const hydrated = await readPhase1GateArtifact(task, explicitRef, true);
    return hydrated ? { ...gateRecord, ...hydrated, artifact_ref: explicitRef } : gateRecord;
  }

  const inferredRef = [
    ...phase1ArtifactPathList(decision),
    ...(step.artifacts ?? [])
  ].find((artifactPath) => /(^|\/)\d{2}-human-gate\.json$/.test(artifactPath));
  if (!inferredRef) return gateRecord;

  const hydrated = await readPhase1GateArtifact(task, inferredRef, false);
  return hydrated ? { ...gateRecord, ...hydrated, artifact_ref: inferredRef } : gateRecord;
}

async function readPhase1GateArtifact(
  task: MigrationTask,
  artifactRef: string,
  required: boolean
): Promise<Record<string, unknown> | undefined> {
  const artifactPath = path.isAbsolute(artifactRef)
    ? artifactRef
    : safeJoin(task.workspacePath, artifactRef);
  let content: string;
  try {
    content = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
    throw error;
  }
  const parsed = JSON.parse(content) as unknown;
  const gate = isRecord(parsed) && isRecord(parsed.human_gate) ? parsed.human_gate : parsed;
  if (!isRecord(gate)) {
    throw new Error(`Invalid Phase 1 human gate artifact: ${artifactPath}`);
  }
  return gate;
}

function phase1HumanGateChoices(gateRecord: Record<string, unknown>): string[] {
  const allowed = gateRecord.allowed_decisions;
  if (!Array.isArray(allowed)) return [];
  return allowed
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const choice = stringValue(record.choice);
      const label = stringValue(record.label);
      const aliasPath = stringValue(record.alias_path);
      return [choice, label, aliasPath ? `(${aliasPath})` : undefined].filter(Boolean).join(" ");
    })
    .filter((item): item is string => Boolean(item));
}

function phase1DecisionContext(
  step: Phase1StepState,
  problemSummary: string,
  choices: string[],
  gateRecord?: Record<string, unknown>
): HumanDecisionContext {
  if (
    gateRecord?.decision_context ||
    gateRecord?.background_reason_scene ||
    gateRecord?.consequences_and_follow_up
  ) {
    return normalizeDecisionContext({
      existing: gateRecord.decision_context ?? gateRecord,
      stepId: step.id,
      question: problemSummary,
      choices,
      blockingReason: phase1BlockingReasonForStep(step.id),
      fallbackBackground: problemSummary,
      details: [],
      claimBoundaryImpact: gateRecord.claim_boundary_impact
    });
  }
  const why = stringArray(gateRecord?.why_agent_cannot_decide);
  const unresolvedItems = Array.isArray(gateRecord?.unresolved_items)
    ? gateRecord.unresolved_items.filter(isRecord)
    : [];
  const itemSummaries = unresolvedItems.slice(0, 3).map((item) => {
    const kind = stringValue(item.kind) ?? "item";
    const state = stringValue(item.current_state) ?? stringValue(item.blocker) ?? "requires human decision";
    const nodes = Array.isArray(item.source_node_ids) ? item.source_node_ids.join(", ") : undefined;
    return `${kind}${nodes ? ` on node(s) ${nodes}` : ""}: ${state}`;
  });
  const allowed = Array.isArray(gateRecord?.allowed_decisions)
    ? gateRecord.allowed_decisions.filter(isRecord)
    : [];
  const consequences =
    allowed.length > 0
      ? allowed.map((item) => {
          const choice = [stringValue(item.choice), stringValue(item.label)].filter(Boolean).join(" ");
          return {
            choice: choice || "Unnamed decision",
            consequence:
              stringValue(item.claim_boundary) ??
              stringValue(gateRecord?.claim_boundary_impact) ??
              "This choice changes whether the migration continues, retries, or stops.",
            followUp:
              stringValue(item.continuation_edge) ??
              "Record the answer, update task-state, and continue only along the matching safe edge."
          };
        })
      : choices.map((choice) =>
          consequenceForChoice(choice, phase1BlockingReasonForStep(step.id), gateRecord?.claim_boundary_impact)
        );
  return {
    formatVersion: "human-gate-v1",
    backgroundReasonScene: [problemSummary, ...why, ...itemSummaries].filter(Boolean).join(" "),
    terminology: dedupeTerms([
      ...defaultHumanGateTerms(phase1BlockingReasonForStep(step.id)),
      {
        term: "continuation edge",
        explanation:
          "The next safe route the agent will execute after the human answer, such as retrying an item, continuing with downgraded claims, or stopping."
      }
    ]),
    consequencesAndFollowUp: consequences
  };
}

function phase1BlockingReasonForStep(stepId: string): HumanQuestion["blockingReason"] {
  if (stepId === "00" || stepId === "01" || stepId === "05") return "missing_asset";
  if (stepId === "12") return "quality_review";
  if (stepId === "13") return "quality_review";
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// §G.wire helpers — decide which gate decisions become feedback events
// ─────────────────────────────────────────────────────────────────────────────

/** Short affirmations that don't carry corrective signal — skip recording. */
const ROUTINE_APPROVALS = new Set([
  "yes", "y", "ok", "okay", "continue", "approve", "approved",
  "proceed", "go", "1", "true", "confirm", "confirmed"
]);

function isRoutineApproval(answer: string): boolean {
  return ROUTINE_APPROVALS.has(answer.trim().toLowerCase());
}

/**
 * Heuristic severity for a non-routine decision answer. Looks for stop/abort
 * language first, then downgrade language, else default to nit.
 */
function severityForDecision(answer: string): "blocker" | "degrade" | "nit" {
  const lower = answer.toLowerCase();
  if (/\b(stop|abort|cancel|wrong|incorrect|broken|bug|fail|hard.?stop)\b/.test(lower)) {
    return "blocker";
  }
  if (/\b(instead|override|prefer|rather|change|swap|replace|use)\b/.test(lower)) {
    return "degrade";
  }
  return "nit";
}

/** Truncate long freeform answers so the JSONL line stays manageable. */
function trimMessage(s: string, max = 800): string {
  return s.length <= max ? s : `${s.slice(0, max - 20)}… [truncated]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(hf_)[A-Za-z0-9]{12,}/g, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret|password|pwd)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(export\s+)?(HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|HF_MIRROR_TOKEN|HF_ACCESS_TOKEN|CIVITAI_TOKEN|CIVITAI_API_TOKEN|GITHUB_TOKEN|GH_TOKEN|TOKEN|PASSWORD|PASSWD|PWD)\s*=\s*[^\s]+/gi, (_match, exportPrefix = "", name) => `${exportPrefix}${name}=[REDACTED]`)
    .replace(/\b(pwd|password|passwd|token|secret|api[_-]?key)\s*[:=]?\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
}
