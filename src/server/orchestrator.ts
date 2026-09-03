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
  MigrationTask,
  StepStatus
} from "../shared/types";
import type { AppConfig } from "./config";
import {
  ensureAssetAcquisitionJob,
  type AssetAcquisitionUnresolvedItem
} from "./assetAcquisition";
import { judgeFuzzyMatch, type FreeformSessionRunner } from "./assetFuzzyMatch";
import { discoverCoreNodeRecipe } from "./coreNodeRecipeDiscovery";
import { verifyCoreNodeRecipe } from "./coreNodeRecipeVerification";
import { ensureAssetPrep } from "./assetPrep";
import { checkRequiredArtifactCompletion, checkRequiredArtifactGate } from "./artifactCompletion";
import { analyzeRunReport } from "./evolutionAnalyzer";
import { computeWorkflowSha256, extractAndSaveRules } from "./workflowKnowledge";
import { generateRunReport } from "./runReport";
import { ensureBranchSmokeAggregate } from "./branchSmokeAggregate";
import {
  CopilotSdkRunner,
  SdkStepTimeoutError,
  isRetryableSdkConnectionError,
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
import { writeTaskStateLedger } from "./taskStateLedger";
import {
  applyCatalogWriteBack,
  applyCatalogWriteBackFromLedger,
  CATALOG_DEPLOY_LEDGER_FILE,
  type CatalogDeployLedger
} from "./xpuCatalogWriteBack";
import type { NodeVerdict } from "./nodeValidationRunner";
import { branchValidatedNodeTypes, mainSmokeValidatedNodeTypes, type PromptGraph } from "./catalogBranchHarvest";
import { synthesizeLedgerNodes, parseWorkflowNodeTypes, type ProvenanceMap, type WorkflowNodeType } from "./deployLedgerSynthesis";
import { catalogEnabled } from "./xpuCatalogClient";
import {
  appendAnswerDefault,
  appendAnswerLog,
  computeQuestionSignature,
  isAutoAnswerEligible,
  isNeverAutoQuestion,
  listAnswerDefaults,
  lookupAnswerDefault,
  summarizeHistory,
  type AnswerDefaultEntry,
  type BlockingReason,
  type QuestionIdentity
} from "./answerDefaults";
import {
  applyItemPatches,
  applyItemStatusUpdates,
  parseApprovalAnswer,
  parsePushDeployAnswer,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementItem
} from "./agentImprovementPatch";
import {
  draftImprovement,
  fixImprovement,
  verifyImprovement,
  mergeImprovement,
  git as improvementGit,
  type FreeformSessionRunner as ImprovementSdkRunner
} from "./agentImprovementPipeline";
import { spawn } from "node:child_process";
import { STEP_OUTPUT_SUBDIR } from "./paths";
import { appendFeedbackEvent, type FeedbackEventInput } from "./feedbackLog";
import { recordRecipeOutcome } from "./analyticsDb";
import { ensureWorkflowInventory } from "./workflowInventory";
import { normalizeWorkflowForApi } from "./workflowNormalize";
import { planNodeLocalization, type LocalizationProposal } from "./nodeLocalization";
import { substituteNodes, type GGraph } from "./graphSubstitute";
import {
  checkComfyUiCoreDrift,
  checkOmniXpuAcceleration,
  checkPortOccupant,
  checkRecipeEnvironmentDrift,
  ensureDockerImageSynced,
  syncComfyUiCoreFromNfs,
  publishComfyUiCoreToNfs,
  syncCustomNodesFromNfs,
  getProcessElapsedSeconds,
  killProcessOnNode,
  loadGpuNodes,
  mergeModelRoots,
  nodeApiUrl,
  pickNode,
  resolveNfsShareRoot,
  type GpuNode
} from "./gpuNodes";
import { ensureComfyUiUp, VRAM_ESCALATION_LADDER } from "./comfyuiLifecycle";
import { resolveProfilePackages, buildProfileDir } from "./profileLaunch";
import { missingClassAWheels, classAHardStopMessage } from "./wheelhouse";
import { extractNodeModelPairs, findMatchingRecipes } from "./recipeInjector";
import { archiveAcceptedWorkflowIfNeeded, archiveTaskSnapshot } from "./workflowArchive";
import { syncGuiWorkflowToComfyUIServer } from "./guiWorkflowSync";
import { checkHiddenAssetPrestageStatus, startHiddenAssetPrestage } from "./hiddenAssetPrestage";

// Real incident: "Could not connect to provider at <url>" (a raw connection
// failure, distinct from SdkStepTimeoutError's no-progress watchdog) used to
// get ZERO retries -- only SdkStepTimeoutError was retried, and only once.
// Read dynamically (not a module-level constant computed once at import
// time) matching MIGRATION_AGENT_STEP_TIMEOUT_MS's own convention elsewhere
// in this project -- lets a max-retry bump happen via env var alone, and
// lets tests override it per-case.
function sdkStepMaxRetries(): number {
  return Number(process.env.MIGRATION_AGENT_SDK_MAX_RETRIES ?? "3");
}
// Backoff before each retry attempt (not just an immediate re-call) -- a
// transient connection failure (proxy blip, provider restart) is more likely
// to have cleared after a few seconds than immediately.
function sdkStepRetryBackoffMs(): number {
  return Number(process.env.MIGRATION_AGENT_SDK_RETRY_BACKOFF_MS ?? "10000");
}

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
  runFreeformSession?: CopilotSdkRunner["runFreeformSession"];
  abortTask?: CopilotSdkRunner["abortTask"];
  runStep(
    job: Parameters<CopilotSdkRunner["runStep"]>[0],
    emit: AgentEventSink,
    waitForDecision?: HumanDecisionWaiter,
    observeSdkEvent?: SdkRawEventObserver
  ): Promise<SdkRunResult>;
}

/**
 * Minimal shape of SubJobManager.startSubJobForSuggestedUrl this orchestrator
 * needs -- kept as an interface (not a direct import of SubJobManager) so
 * this file doesn't take on subJobs.ts's full surface, matching the same
 * loose-coupling style as StepSdkRunner/FreeformSessionRunner above.
 */
export interface SuggestedUrlDownloader {
  startSubJobForSuggestedUrl(task: MigrationTask, assetName: string, url: string): Promise<unknown>;
}

export class MigrationOrchestrator {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sdkRunner: StepSdkRunner;
  private readonly approvalBroker = new HumanApprovalBroker();
  private readonly autorunningTasks = new Set<string>();
  private readonly activeStepRuns = new Set<string>();
  // rerunStep intentionally clears activeStepRuns for its own step before
  // re-invoking runStep (so a legitimately-stuck run-lock doesn't block a
  // real rerun) -- but that means activeStepRuns can't protect against
  // rerunStep itself being called again while a previous rerun is still
  // tearing down/restarting. Confirmed live: a rerun button with no
  // click-feedback let a human click it 3 times in ~8 seconds, each call
  // killing the ComfyUI process the previous call had just started and
  // wiping its artifacts, wasting ~7 minutes of redundant environment
  // rebuild. This tracks in-flight rerunStep calls specifically.
  private readonly activeRerunRequests = new Set<string>();
  // Same class of bug as activeRerunRequests above, on a different button:
  // confirmed live, a Step 13 push/deploy answer with no disabled-after-send
  // state on its Send button landed 5 identical POSTs to
  // /api/tasks/:taskId/human-decisions for the same questionEventId. With no
  // guard here, all 5 raced into applyPushDeployDecision concurrently,
  // running `git merge`/tsc/vitest against the SAME repoRoot at the same
  // time -- one call's revert-on-failure `git reset --hard` wiped out
  // another's in-flight (and even already-successful) work, and the task
  // finished "completed" having applied none of the 8 approved items. The
  // client-side fix (freeze the button after send) closes this for the
  // normal UI path, but this guard is the actual structural fix: it makes
  // concurrent submissions for the exact same question impossible regardless
  // of client, retries, multiple tabs, or future bugs upstream of this call.
  private readonly activeHumanDecisionSubmissions = new Set<string>();
  // Task IDs that have been hard-stopped/terminated. Their lingering run-locks
  // (held while an in-flight SDK call winds down) must not block new work.
  private readonly hardStoppedTaskIds = new Set<string>();
  private readonly sdkTimeoutRetries = new Map<string, number>();
  /**
   * Per-task VRAM escalation level (index into VRAM_ESCALATION_LADDER). Bumped by
   * the capacity-retry ladder when Step 07/08 hits a capacity OOM: the step is
   * re-run with ComfyUI relaunched under stronger lossless offload flags
   * (--lowvram, then --novram) before the operator is ever asked for the lossy
   * reduced tier. Keyed by taskId; in-memory (resets on restart, like the retry
   * counters above).
   */
  private readonly vramEscalationLevel = new Map<string, number>();
  /**
   * Task IDs whose XPU should be `xpu-smi --reset` on the NEXT forced relaunch,
   * because the previous Step 07/08 run hit a capacity OOM / DEVICE_LOST that can
   * wedge the `xe` driver (VM worker -12 / engine resets) — a plain relaunch frees
   * VRAM but not the driver. Set when the capacity ladder escalates; consumed
   * (and cleared) by the pre-step ComfyUI launch. In-memory (resets on restart).
   */
  private readonly xpuResetPending = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly steps: MigrationStepDefinition[],
    sdkRunner?: StepSdkRunner,
    private readonly suggestedUrlDownloader?: SuggestedUrlDownloader
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

  /**
   * Per-step-flow-only wrapper around `store.updateStep`: persists the step
   * transition to the task store as before, then deterministically rebuilds
   * `task-state.json` from that authoritative state (see taskStateLedger.ts).
   * This replaces the old design where every per-step Copilot SDK session
   * hand-maintained task-state.json itself with no backend writer at all.
   *
   * Deliberately NOT used by Phase 1 monolithic-driver call sites (those
   * keep writing their own richer Phase1TaskState schema to the same file
   * path via phase1Agent.ts) -- that mode is unreachable from the UI today,
   * but wrapping its call sites here would clobber its schema mid-session.
   */
  private async updateStepAndPersist(
    taskId: string,
    stepId: string,
    status: StepStatus,
    patch: Partial<Pick<MigrationTask["steps"][number], "summary" | "error">> = {}
  ): Promise<MigrationTask> {
    const task = await this.store.updateStep(taskId, stepId, status, patch);
    const decisions = await this.store.listDecisions(taskId);
    await writeTaskStateLedger(task, decisions);
    if ((stepId === "11" || stepId === "12b") && status === "completed") {
      // FINAL-DELIVERY consistency guard: the bundle is assembled by now; make sure
      // every runnable prompt in it carries the validated reduced-tier config before
      // it can be archived/handed off. Best-effort; never breaks step completion.
      const hardStopped = await this.enforceReducedDeliveryConsistency(task, stepId).catch((err) => {
        void this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Delivery-consistency guard errored (non-fatal, delivery left as-is): ${err instanceof Error ? err.message : String(err)}`,
          data: { deliveryConsistency: "guard_error" }
        });
        return false;
      });
      // Only archive Step 12b's accepted bundle if the guard did NOT hard-stop it
      // (never publish a bundle that still ships a full-size runnable prompt).
      if (stepId === "12b" && !hardStopped) {
        await this.archiveWorkflowIfAccepted(task);
      }
    }
    // XPU-SUPPORT CATALOG validate + write-back (plan B): after Step 07 branch smoke
    // (post Step-06 device policy, nodes executed in-context), precisely validate the
    // newly-deployed custom nodes and fold results into the shared catalog so the next
    // migration reuses trusted nodes. Best-effort; no-op unless XPU_CATALOG_ENABLED;
    // never throws into step completion.
    if (stepId === "07" && status === "completed") {
      await this.catalogValidateAndWriteBack(task).catch((err) => {
        void this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Catalog validate+write-back errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          data: { catalogWriteBack: "error" }
        });
      });
    }
    // Second, later chance to archive: by Step 13 (the last step)
    // completing, the whole 00-13 pipeline is known to have finished. This
    // is a safety net, not the primary trigger -- archiveAcceptedWorkflowIfNeeded's
    // own marker-file idempotency check makes it a no-op if Step 12b's own
    // trigger above already archived this task. Confirmed live: a real
    // task's GUI acceptance never made it into manual_result in time (a
    // since-fixed resumeStep bug), the Step 12b trigger never fired, and by
    // the time anyone noticed, the task's workspace had already been wiped
    // by a later task's creation -- this narrows that window.
    //
    // The primary trigger was moved here from Step 12 (rather than left on
    // Step 12's own completion) because Step 12b was inserted between 12 and
    // 13 to render the richer, docker-oriented final deployment guide -- if
    // archival still fired at bare Step 12 completion, the NFS-archived
    // bundle would ship without 12b's content, and this Step 13 safety net's
    // marker-file check would then treat the task as already archived and
    // skip re-archiving it.
    if (stepId === "13" && status === "completed") {
      await this.archiveWorkflowIfAccepted(task);
      await this.publishComfyUiCoreAfterMigration(task);
    }
    if (stepId === "12" && status === "waiting_for_human") {
      await this.syncGuiWorkflowForAcceptance(task);
    }
    return task;
  }

  /**
   * Best-effort: once a whole migration finishes (Step 13 completed), publish
   * any ComfyUI-core patches this run applied on the node's local core back to
   * the /nfs_share master (the "sync new patches back" half of the NFS-master
   * loop; see publishComfyUiCoreToNfs). Serialized by an flock in the publish
   * script. Never affects task status -- a soft failure (dirty local tree, no
   * new commits, or a merge conflict) is durable evidence only. No-ops when the
   * node isn't a real configured GPU node or its local core already matches the
   * master.
   */
  private async publishComfyUiCoreAfterMigration(task: MigrationTask): Promise<void> {
    const hasRealGpuNodesConfig = await fs.access(this.config.gpuNodesPath).then(() => true).catch(() => false);
    if (!hasRealGpuNodesConfig) return;
    const node = this.lookupTaskNode(task);
    if (!node) return;
    // Only publish when the local core is actually ahead of / diverged from the
    // master; if already in sync there's nothing new to push.
    const drift = await checkComfyUiCoreDrift(node).catch(() => ({ inSync: true, detail: "drift check failed" }));
    if (drift.inSync) return;
    const result = await publishComfyUiCoreToNfs(node, this.config).catch((err) => ({
      ok: false,
      detail: `core publish threw: ${err instanceof Error ? err.message : String(err)}`
    }));
    await this.emit({
      taskId: task.id,
      stepId: "13",
      type: "progress",
      message: result.ok
        ? `Published this run's ComfyUI-core patches back to the /nfs_share master: ${result.detail}`
        : `Did not publish ComfyUI-core patches to the /nfs_share master (non-fatal): ${result.detail}`,
      data: { drift, publish: result }
    });
  }

  /**
   * Best-effort: as soon as Step 12 pauses for the human GUI-acceptance gate,
   * push its prepared workflow JSON into the running ComfyUI server's own
   * Workflows sidebar (see guiWorkflowSync.ts for why this beats a plain
   * filesystem copy). Never blocks or fails Step 12's own human gate --
   * a sync failure just means the operator falls back to manual import.
   */
  private async syncGuiWorkflowForAcceptance(task: MigrationTask): Promise<void> {
    const node = this.lookupTaskNode(task);
    if (!node) return;
    const result = await syncGuiWorkflowToComfyUIServer({ task, node });
    await this.emit({
      taskId: task.id,
      stepId: "12",
      type: "progress",
      message: result.synced
        ? `Pushed the GUI-acceptance workflow into the running ComfyUI server's Workflows sidebar as "${result.destination}" -- no manual file import needed.`
        : `Could not auto-push the GUI-acceptance workflow into the ComfyUI server's Workflows sidebar (non-fatal, fall back to manual import): ${result.reason}`,
      data: result
    });
  }

  /**
   * Best-effort: publish the delivery bundle to the shared NFS archive once
   * Step 12 GUI acceptance records manual_result=accepted and Step 12b's own
   * final delivery guide has been generated. Never affects Step 12b's own
   * completion or task status — archiveAcceptedWorkflowIfNeeded() itself
   * never throws.
   */
  private async archiveWorkflowIfAccepted(task: MigrationTask): Promise<void> {
    const result = await archiveAcceptedWorkflowIfNeeded({
      task,
      nfsArchiveRoot: this.config.workflowArchiveRoot
    });
    // Real incident this closes: the non-archived branches (manual_result not
    // "accepted", missing summary/delivery bundle, already-archived) used to
    // be completely silent -- no event at all. A real task's manual_result
    // never matched the expected "accepted" string (the skill doc mentioned
    // the field name but not its exact enum), the archive silently no-opped
    // every time it was called, and nobody noticed until the task's whole
    // workspace had already been wiped by a later task's creation. Always
    // emit now, even for the routine "already archived" case, so a genuine
    // mismatch is visible in the task's own event log while there's still
    // time to fix it -- not discovered only in hindsight.
    if (result.archived) {
      await this.emit({
        taskId: task.id,
        stepId: "12b",
        type: "artifact_created",
        message: `Archived accepted delivery bundle to shared NFS: ${result.destination}`,
        data: { destination: result.destination }
      });
    } else {
      await this.emit({
        taskId: task.id,
        stepId: "12b",
        type: "progress",
        message: `Delivery bundle not archived to shared NFS: ${result.reason}`,
        data: { reason: result.reason }
      });
    }
  }

  async runStep(
    taskId: string,
    stepId: string,
    resumeContext?: Record<string, unknown>,
    options: { pauseOnHumanGate?: boolean; forceRerun?: boolean } = {}
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
    // Confirmed live: if a step's SDK session is lost while paused
    // waiting_for_human (e.g. a backend restart) and the human answers after
    // the fact, resumeStep() re-invokes runStep() with the recorded answers
    // in resumeContext.humanDecisions so a fresh SDK session can act on them
    // (they're threaded through into the compiled StepJob's own
    // resumeContext field). But most steps write their required-output
    // artifact *before* reaching the human gate within the same run, so that
    // artifact already exists on disk by the time resume happens -- the
    // fast-path check below would then declare the step "complete" without
    // ever starting the SDK session that was supposed to process the human's
    // actual answer. A real human "passed the test looks good" was silently
    // discarded this way: manual_result stayed "not_performed", the NFS
    // archive never fired, and the task advanced past a step whose own
    // reflection said next_step_allowed=false. Skip the fast path entirely
    // whenever there are pending resume decisions -- the SDK must be given
    // the chance to consume them.
    const pendingResumeDecisions = Array.isArray(resumeContext?.humanDecisions)
      ? (resumeContext.humanDecisions as unknown[])
      : [];
    const preRunArtifactCompletion =
      pendingResumeDecisions.length > 0
        ? {
            complete: false,
            reason: `Resuming with ${pendingResumeDecisions.length} pending human decision(s) -- skipping fast-path artifact completion so the SDK can process them.`
          }
        : options.forceRerun
          ? {
              complete: false,
              reason:
                "Capacity-retry ladder re-run -- skipping fast-path artifact completion so the step actually re-runs against ComfyUI relaunched with stronger VRAM offload."
            }
          : await checkRequiredArtifactCompletion(task, step);
    this.activeStepRuns.add(runKey);

    // See the retry branch below and the `finally` block at the end of this
    // function: must be declared here (not inside `catch`) so `finally` --
    // a separate block scope -- can read it.
    let isRetrying = false;
    try {
    await this.updateStepAndPersist(taskId, stepId, "running");
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
        modelRoots: this.resolveModelRoots(task),
        comfyuiRoot: this.resolveComfyuiRoot(task),
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
      await this.updateStepAndPersist(taskId, stepId, "completed", { summary, error: undefined });
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
        modelRoots: this.resolveModelRoots(task),
        comfyuiRoot: this.resolveComfyuiRoot(task),
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
      // Run structured provider search (+ fuzzy query variants and an
      // LLM-judged fuzzy match for ambiguous cases) on THIS first pass,
      // not only after a human answers the gate below -- previously
      // ensureAssetAcquisitionJob only ran from acceptHumanGateContext, so a
      // first-time gap was always reported to the human before the agent's
      // own structured search tool had ever run. Gated on
      // rowsNeedingSearchCount (not gapCount): gapCount deliberately
      // excludes weak local-alias matches (not blocking enough for a hard
      // gate), but a weak alias is exactly the ambiguous case fuzzy/provider
      // search can upgrade to a confident, evidenced match -- gating this on
      // gapCount alone meant that path never ran when local search happened
      // to find any alias, however weak. Empty human context is fine here:
      // the core provider search runs regardless; acceptHumanGateContext's
      // later re-run still supplies the human's actual answer text for its
      // remote-source-hint extraction.
      let acquisitionItems: AssetAcquisitionUnresolvedItem[] = [];
      if (prep.rowsNeedingSearchCount > 0) {
        try {
          const acquisition = await ensureAssetAcquisitionJob({
            task,
            modelRoots: this.resolveModelRoots(task),
            comfyuiRoot: this.resolveComfyuiRoot(task),
            nfsShareRoot: this.resolveNfsShareRootForTask(task),
            assetResolutionLedgerPath: this.config.assetResolutionLedgerPath,
            humanContext: "",
            redactedHumanContext: "",
            stepId,
            fuzzyMatch: this.sdkRunner.runFreeformSession
              ? async ({ requestedName, candidates }) =>
                  judgeFuzzyMatch({
                    requestedName,
                    candidates,
                    runner: this.sdkRunner as FreeformSessionRunner,
                    cwd: task.artifactPath,
                    // Requested names are workflow-author-controlled strings
                    // (Windows-style backslashes, full-width parens, CJK
                    // text) -- the Copilot SDK's session.create rejects
                    // sessionIds containing them outright. Sanitize instead
                    // of embedding requestedName verbatim.
                    sessionId: `${task.id}-01-fuzzy-${sanitizeSessionIdSegment(requestedName)}`
                  })
              : undefined,
            discoverCoreNodeRecipe: this.sdkRunner.runFreeformSession
              ? async ({ nodeType, patchFile }) =>
                  discoverCoreNodeRecipe({
                    nodeType,
                    comfyuiRoot: this.resolveComfyuiRoot(task),
                    taskId: task.id,
                    patchFile,
                    runner: this.sdkRunner as FreeformSessionRunner,
                    cwd: task.artifactPath,
                    sessionId: `${task.id}-01-core-node-${sanitizeSessionIdSegment(nodeType)}`,
                    evidenceArtifact: `${stepId}-acquisition-report.md`
                  })
              : undefined,
            // Verification is plain subprocess work (git/python3), not an SDK
            // session -- runs unconditionally once a draft exists, unlike
            // discovery above which needs sdkRunner.
            verifyCoreNodeRecipe: ({ nodeType, patchTarget, stagedPatchPath }) =>
              verifyCoreNodeRecipe({ nodeType, patchTarget, stagedPatchPath, comfyuiRoot: this.resolveComfyuiRoot(task) })
          });
          acquisitionItems = acquisition.unresolvedItems;
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Step 01 first-pass provider search: ${acquisition.providerCandidateCount} candidate(s) found across ${acquisition.unresolvedCount} unresolved item(s).`,
            data: {
              providerCandidateCount: acquisition.providerCandidateCount,
              unresolvedCount: acquisition.unresolvedCount
            }
          });
        } catch (error) {
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Step 01 first-pass provider search failed (non-fatal; falling back to local-only gap report): ${
              error instanceof Error ? error.message : String(error)
            }`
          });
        }
      }

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
        const gapItems = acquisitionItems.length > 0
          ? acquisitionItems.map((item) => ({
              name: item.assetName,
              kind: item.kind,
              action: item.fuzzyJudgment && item.fuzzyJudgment.confidence !== "none"
                ? `${item.nextAction} Fuzzy match judgment (${item.fuzzyJudgment.confidence} confidence): ${item.fuzzyJudgment.reason}${
                    item.fuzzyJudgment.suggestedUrl ? ` (${item.fuzzyJudgment.suggestedUrl})` : ""
                  }`
                : item.nextAction
            }))
          : prep.gapDetails ?? [];
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
        modelRoots: this.resolveModelRoots(task),
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
      await this.updateStepAndPersist(taskId, stepId, "completed", { summary, error: undefined });
      await this.emit({
        taskId,
        stepId,
        type: "step_completed",
        message: summary,
        data: inventory
      });
      return;
    }

    if (stepId === "03b") {
      // Optional, extensible node-localization step. Detect nodes that need local
      // handling (Phase 0: cloud-API nodes → a local-model subgraph). Fast-pass
      // when nothing matches or the feature is off; otherwise gate for approval —
      // the substitution is applied in applyStep03bLocalizationDecision on approve.
      const artifactPath = path.join(task.artifactPath, "03b-node-localization.md");
      const writeDoc = async (body: string): Promise<void> => {
        await fs.writeFile(artifactPath, body, "utf8");
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: artifactPath,
          relativePath: path.relative(task.workspacePath, artifactPath),
          kind: "markdown"
        });
      };
      const complete = async (summary: string): Promise<void> => {
        await this.updateStepAndPersist(taskId, stepId, "completed", { summary, error: undefined });
        await this.emit({ taskId, stepId, type: "step_completed", message: summary });
      };

      if (process.env.NODE_LOCALIZATION_ENABLED !== "1") {
        await writeDoc("# Step 03b — Node localization\n\nDisabled (set NODE_LOCALIZATION_ENABLED=1 to enable). No changes.\n");
        await complete("Step 03b node localization is disabled (NODE_LOCALIZATION_ENABLED != 1) — no changes.");
        return;
      }

      let proposals: LocalizationProposal[] = [];
      try {
        const graph = JSON.parse(await fs.readFile(task.workflowPath, "utf8")) as GGraph;
        proposals = planNodeLocalization(graph).proposals;
      } catch (e) {
        await writeDoc(`# Step 03b — Node localization\n\nSkipped: could not read/parse the workflow (${(e as Error).message}). No changes.\n`);
        await complete(`Step 03b skipped: ${(e as Error).message}`);
        return;
      }

      if (proposals.length === 0) {
        await writeDoc("# Step 03b — Node localization\n\n✅ Nothing to localize: no cloud-API nodes (or other localizable nodes) found. No changes.\n");
        await complete("Step 03b: nothing to localize — no API/local-substitution nodes found.");
        return;
      }

      // Propose + gate. The substitution is applied on approval.
      const list = proposals
        .map((p) => `  - node ${p.nodeId} \`${p.from}\` → ${p.toNodes.join(" + ")} (${p.model ?? "local model"}); dropped inputs: ${p.droppedInputs.join(", ") || "none"}`)
        .join("\n");
      await fs.writeFile(
        path.join(task.artifactPath, "03b-gate-signal.json"),
        JSON.stringify(
          {
            stepId: "03b",
            gated: true,
            category: "node_substitution",
            trigger: "deterministic",
            reason: `${proposals.length} node(s) call an external API and would be replaced by a local-model subgraph`,
            items: proposals.map((p) => ({ name: p.from, kind: "api_node", action: `substitute with ${p.toNodes.join(" + ")}` }))
          },
          null,
          2
        ),
        "utf8"
      );
      const message = `Step 03b found ${proposals.length} cloud-API node(s) to localize.`;
      await this.updateStepAndPersist(taskId, stepId, "waiting_for_human", { summary: message, error: undefined });
      await this.emit({
        taskId,
        stepId,
        type: "human_question",
        message,
        data: {
          question:
            `Step 03b — the workflow calls external cloud APIs that can't run on the offline XPU. Proposed local substitutions:\n\n${list}\n\n` +
            `Substituting swaps the cloud model for a local one — the OUTPUT MAY DIFFER. Approve to rewrite the graph to run fully offline, or reject to keep these as a human boundary.`,
          choices: ["Approve — substitute with the local model", "Reject — keep the API node (human boundary)"],
          allowFreeform: true,
          blockingReason: "node_substitution",
          proposals
        }
      });
      return;
    }

    if (stepId === "05" && await this.pauseEnvironmentDeploymentOnAssetGaps(task, step)) {
      return;
    }

    if (stepId === "05") {
      // Cheap drift check before every Step 05 run (not just the manual
      // "Sync Docker Image" button): compares the node's local image_id
      // against the NFS manifest and only pays for a full ~14GB reload when
      // they actually differ. Best-effort -- a check failure (unreachable
      // node, manifest missing) must never block Step 05 itself.
      const node = this.lookupTaskNode(task);
      if (node) {
        const syncResult = await ensureDockerImageSynced(node, this.config).catch((err) => ({
          synced: false,
          detail: `docker image sync check failed: ${err instanceof Error ? err.message : String(err)}`
        }));
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: syncResult.synced
            ? `Docker image resynced from NFS before Step 05: ${syncResult.detail}`
            : `Docker image check before Step 05: ${syncResult.detail}`,
          data: syncResult
        });

        // Best-effort: pull in whatever custom nodes already live in the
        // shared /nfs_share/custom_nodes tree before Step 05 needs them, so
        // this task reuses prior migrations' already-acquired/patched nodes
        // instead of Step 01 re-cloning them fresh. Never blocks Step 05.
        const customNodeSyncResult = await syncCustomNodesFromNfs(node, this.config).catch((err) => ({
          ok: false,
          detail: `custom_nodes NFS sync failed: ${err instanceof Error ? err.message : String(err)}`
        }));
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Shared custom_nodes sync before Step 05: ${customNodeSyncResult.detail}`,
          data: customNodeSyncResult
        });

        // Same spirit, different gap: even a correctly-synced environment
        // can have drifted out from under a recipe's own baseVersion
        // assumption (confirmed live: CLIPLoader-qwen-fp8 assumed a
        // comfy_kitchen this environment no longer has -- cost ~10+ minutes
        // of manual bash archaeology to discover, since nothing flagged it
        // automatically). Detection only -- never blocks Step 05.
        try {
          const workflow = JSON.parse(await fs.readFile(task.workflowPath, "utf8"));
          const pairs = extractNodeModelPairs(workflow);
          const recipes = findMatchingRecipes(pairs);
          const drift = await checkRecipeEnvironmentDrift(recipes, node);
          if (drift.drifted.length > 0) {
            await this.emit({
              taskId,
              stepId,
              type: "progress",
              message: `Recipe environment drift detected before Step 05: ${drift.drifted
                .map((d) => `${d.recipeId} assumes ${d.packageName}@${d.expectedRef}, target has ${d.actualVersion}`)
                .join("; ")} -- verify the patch still applies/works before trusting it.`,
              data: drift
            });
          }
        } catch {
          // Best-effort -- a malformed workflow or unreadable env must never block Step 05.
        }

        // Stale-process reclaim + patch-freshness + acceleration-capability
        // visibility -- see assessComfyUIEnvironment's own doc comment for
        // the exact incident this closes.
        const assessment = await this.assessComfyUIEnvironment(task, node).catch((err) => ({
          notes: [`assessComfyUIEnvironment failed: ${err instanceof Error ? err.message : String(err)}`]
        }));
        if (assessment.notes.length > 0) {
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Environment assessment before Step 05: ${assessment.notes.join(" | ")}`,
            data: assessment
          });
        }

        // Detection only, same pattern as the three checks above -- report
        // whether Step02 already kicked off background downloads for hidden
        // runtime model deps, so Step05's own SDK agent can skip re-fetching
        // an in-flight or already-complete multi-GB download. Never blocks:
        // absent status (Step02 never wrote 02-hidden-runtime-assets.json, or
        // ASSET_ACQUISITION_ENABLE_DOWNLOAD wasn't set) just means Step05 falls
        // back to exactly today's behavior.
        const prestageStatus = await checkHiddenAssetPrestageStatus(task).catch(() => []);
        if (prestageStatus.length > 0) {
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Hidden runtime asset pre-stage status before Step 05: ${prestageStatus
              .map((s) => `${s.itemName}/${s.file}: ${s.status}`)
              .join(", ")}`,
            data: { prestageStatus }
          });
        }

        // Detection only, same pattern as the three checks above -- unlike
        // ensureDockerImageSynced, deliberately does NOT auto-sync on drift
        // (see checkComfyUiCoreDrift's own doc comment: a docker image tag
        // only changes via deliberate republish, but ComfyUI core is a live
        // codebase -- silently rewriting it between task runs would make a
        // regression hard to bisect). Written as a durable JSON artifact, not
        // just a progress event, so which core commit a task actually ran
        // against is real, deterministic evidence -- previously only
        // SDK-authored prose in 05-environment.md ever mentioned a commit SHA.
        const coreDrift = await checkComfyUiCoreDrift(node).catch((err) => ({
          inSync: true,
          detail: `comfyui-core drift check failed: ${err instanceof Error ? err.message : String(err)}`
        }));
        const coreDriftPath = path.join(task.artifactPath, "05-comfyui-core-status.json");
        await fs.writeFile(coreDriftPath, `${JSON.stringify(coreDrift, null, 2)}\n`, "utf8");
        await this.store.appendArtifact({
          taskId,
          stepId,
          path: coreDriftPath,
          relativePath: path.relative(task.workspacePath, coreDriftPath),
          kind: "json"
        });
        if (!coreDrift.inSync) {
          // Auto-repair: clone/refresh the node's local core from the /nfs_share
          // master before the migration runs anything (the "clone from NFS to
          // local" half of the NFS-master loop). A `git merge` of the canonical
          // into the local root -- keeps any unpublished local commits, adds the
          // latest master + patches. Best-effort: a sync failure (e.g. dirty
          // local tree) is durable evidence, never a migration-breaking error.
          const synced = await syncComfyUiCoreFromNfs(node, this.config).catch((err) => ({
            ok: false,
            detail: `core auto-sync threw: ${err instanceof Error ? err.message : String(err)}`
          }));
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: synced.ok
              ? `ComfyUI core auto-synced from /nfs_share master before Step 05: ${synced.detail}`
              : `ComfyUI core drift before Step 05 (auto-sync did not apply): ${coreDrift.detail} | ${synced.detail}`,
            data: { coreDrift, synced }
          });
        }
      }
    }

    // Every ComfyUI-RUNNING step (07..12) reconciles the live container to the
    // persisted VRAM policy before running -- not just 07/08/12. This closes the
    // drift where Step 08 escalated the container to --novram (probing full size),
    // the accepted reduced tier pinned --lowvram to disk, but steps 09/10/11 (which
    // used to be outside this guard) reused the stale --novram container. The
    // reconcile is a cheap no-op when the live flags already match; it relaunches
    // only on actual drift (see ensureComfyUiUp's flag-drift branch). Steps 05/06
    // (env deploy + prompt/branch work) keep their own separate handling.
    const comfyStepNum = Number(stepId);
    if (Number.isFinite(comfyStepNum) && comfyStepNum >= 7 && comfyStepNum <= 12) {
      // Automatic, deterministic pre-check -- don't rely on the SDK agent to
      // read a skill doc and improvise the right relaunch command under time
      // pressure. Ensure the endpoint is reachable (reusing an existing
      // healthy server, restarting a stopped one, or launching a fresh one
      // via the one correct pattern) BEFORE the SDK session even starts.
      // Real incident this closes: an ad hoc `docker run` (no --entrypoint)
      // ran the image's own outdated baked-in packages instead of the
      // correctly configured shared venv -- see comfyuiLifecycle.ts's own
      // doc comment. If even the correct launch pattern can't bring it up,
      // hard-stop here instead of letting the SDK session spend time/cost
      // on an environment already known to be broken.
      // Skip entirely when no real gpu-nodes.json is configured (the synthesized
      // "local-xpu" default -- used by dev/test setups with no real GPU
      // infrastructure -- would otherwise make this block waitSec-long on a
      // fake 127.0.0.1:8188 that nothing is ever going to serve).
      const hasRealGpuNodesConfig = await fs.access(this.config.gpuNodesPath).then(() => true).catch(() => false);
      const node = hasRealGpuNodesConfig ? this.lookupTaskNode(task) : undefined;
      if (node) {
        const apiUrl = nodeApiUrl(node);
        const containerName = `comfyui-${taskId}`;
        // Capacity-retry ladder: launch ComfyUI at the current VRAM escalation
        // level for this task. Level 0 = default flags (reuse a healthy server);
        // level > 0 = force a fresh relaunch with stronger lossless offload flags.
        // Effective VRAM level for this task (persisted across restarts via
        // effective-run-config.json; see effectiveVramLevel). This is what makes
        // a lossless offload strategy proven in Step 07/08 CARRY THROUGH to the
        // Step 12 GUI demo instead of the demo relaunching at default flags and
        // OOM-ing where Step 08 succeeded.
        const vramLevel = Math.min(await this.effectiveVramLevel(taskId, task), VRAM_ESCALATION_LADDER.length - 1);
        // Launch with the EXACT persisted flags (the BKC hardened by Step 07/08 +
        // reduced-tier acceptance), not a ladder entry re-indexed from the level.
        // This is what makes the flags proven in the previous step carry through to
        // Step 12 verbatim (fixes the lowvram->novram drift).
        const persistedVramFlags = await this.effectiveVramFlags(taskId, task);
        // Step 12 (the final GUI demo) MUST run against the SAME validated docker
        // container + NFS venv as Steps 05-08 -- which has llama_cpp (the VLM node
        // dependency), the fp8 keep-on-move patch, and the effective VRAM flags --
        // never an agent-improvised local/bare-metal ComfyUI (that env is missing
        // llama_cpp and hangs the VLM node; real incident 2026-08-11). Force a fresh
        // relaunch for Step 12 so a stray/wrong instance on the port can't be
        // silently reused. Every other GPU step passes the persisted flags and lets
        // ensureComfyUiUp relaunch ONLY on drift (carry-through without a needless
        // cold start each step), plus a forced relaunch when the XPU needs a reset.
        {
          const vramFlags = persistedVramFlags;
          // Reset the XPU on this relaunch if a prior capacity OOM/DEVICE_LOST at
          // Step 07/08 flagged the driver as possibly wedged (consume-once).
          const resetXpu = this.xpuResetPending.has(taskId);
          const forceRelaunch = stepId === "12" || resetXpu;
          if (resetXpu) this.xpuResetPending.delete(taskId);
          // Profile-scoped launch (bug-B fix): mount ONLY this workflow's node
          // set at /comfyui/custom_nodes instead of the node's whole accumulated
          // tree (which crashes on duplicate POST routes). Resolve the profile
          // from the Step-05 deploy ledger (or the Step-00 intake artifact before
          // the first ledger exists) + enum closure + infra; build the scoped dir
          // under NFS. If the profile can't be resolved (degraded), fall back to
          // the full-tree mount rather than launch an empty custom_nodes.
          let customNodesDir: string | undefined;
          try {
            const profile = await resolveProfilePackages(task.artifactPath);
            if (!profile.degraded && profile.packages.length) {
              customNodesDir = await buildProfileDir({
                node,
                taskId,
                packages: profile.packages,
                log: (msg) => void this.emit({ taskId, stepId, type: "progress", message: msg })
              });
              await this.emit({
                taskId,
                stepId,
                type: "progress",
                message: `Profile-scoped custom_nodes for Step ${stepId} (${profile.origin}, ${profile.packages.length} packages): ${profile.packages.join(", ")}`
              });
              // Builder/Worker enforcement (Phase 2): on the offline worker-local
              // venv, a Class-A dependency (flash-attn/xformers/…) with no prebuilt
              // wheel cannot be compiled on the worker — route it to the Builder
              // instead of failing opaquely at container start. Only enforced when
              // worker_local_venv is on (the offline path); a best-effort early
              // signal (the offline pip failure would also catch it, more loudly).
              if (node.worker_local_venv && customNodesDir) {
                const missingWheels = await missingClassAWheels({
                  packages: profile.packages,
                  customNodesRoot: customNodesDir
                }).catch(() => [] as string[]);
                if (missingWheels.length) {
                  await this.terminateWithHardStop({
                    taskId,
                    stepId,
                    reason: classAHardStopMessage(missingWheels),
                    improvementStrategy:
                      "Build the missing Class-A wheels with scripts/build-wheel.mts (in the base image, --sycl if needed) so they land in /nfs_share/wheelhouse; then resume. Workers never compile Class-A."
                  });
                  return;
                }
              }
            } else {
              await this.emit({
                taskId,
                stepId,
                type: "progress",
                message: `Profile not resolvable (${profile.origin}); launching with the full custom_nodes tree for Step ${stepId}.`
              });
            }
          } catch (err) {
            // A profile-build failure must never block the launch — fall back to
            // the full-tree mount (legacy behavior).
            customNodesDir = undefined;
            await this.emit({
              taskId,
              stepId,
              type: "progress",
              message: `Profile-scoped launch skipped (${err instanceof Error ? err.message : String(err)}); using the full custom_nodes tree.`
            });
          }
          const ensureResult = await ensureComfyUiUp({
            node,
            apiUrl,
            container: containerName,
            waitSec: 150,
            vramFlags,
            forceRelaunch,
            resetXpu,
            customNodesDir
          }).catch((err) => ({
            ok: false as const,
            action: "failed" as const,
            detail: `ensureComfyUiUp threw: ${err instanceof Error ? err.message : String(err)}`
          }));
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message:
              vramLevel > 0
                ? `ComfyUI launch before Step ${stepId} at VRAM escalation level ${vramLevel} (${persistedVramFlags.join(" ")}, proven in the capacity ladder): ${ensureResult.detail} (${ensureResult.action})`
                : `ComfyUI reachability check before Step ${stepId}: ${ensureResult.detail} (${ensureResult.action})`,
            data: ensureResult
          });
          if (!ensureResult.ok) {
            await this.terminateWithHardStop({
              taskId,
              stepId,
              reason: `ComfyUI endpoint could not be reached before Step ${stepId}, even after an automatic relaunch attempt via the correct launch pattern: ${ensureResult.detail}. This is an infrastructure hard stop, not a workflow/capacity issue -- do not retry with an ad hoc docker/bare-metal command; check the pinned GPU node's docker image, shared venv, and NFS mount health first.`,
              improvementStrategy: "Check the pinned GPU node's docker image, shared venv (--system-site-packages inheritance from the image), and NFS mount health; once fixed, resume this step."
            });
            return;
          }
        }
      }
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
        comfyuiRoot: this.resolveComfyuiRoot(task)
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

    // Step 12 must never auto-complete on artifact presence alone: it requires
    // an explicit human GUI-acceptance result (Pass/Not pass/Not validated).
    // This pauses when 12-gui-acceptance-summary.json's manual_result is not
    // yet "accepted", re-surfacing the gate on resume/restart too.
    if (stepId === "12" && (await this.pauseIfStep12AcceptanceGate(task, step))) return;

    // Step 08 full-size capacity gate: re-surface the reduced/insufficient
    // capacity decision panel on resume/restart, and never auto-complete past it.
    // Skipped on a capacity-retry ladder re-run (forceRerun) -- the stale summary
    // must not gate before the escalated re-run actually happens.
    if (stepId === "08" && !options.forceRerun && (await this.pauseIfStep08CapacityGate(task, step))) return;

    if (preRunArtifactCompletion.complete) {
      const summary = `Step ${stepId} completed from existing required artifact. ${preRunArtifactCompletion.reason}`;
      await this.updateStepAndPersist(taskId, stepId, "completed", { summary, error: undefined });
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
        await this.updateStepAndPersist(taskId, stepId, "waiting_for_human");
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
          await this.updateStepAndPersist(taskId, stepId, "running");
          return replayResult;
        }
        // Answer defaults: auto-answer a recurring structured question the
        // operator saved a tier:"auto" default for (never for the push/deploy
        // or hard-stop safety floor -- see answerDefaults.isNeverAutoQuestion).
        const autoDecision = await this.tryAutoAnswerFromDefault(event);
        if (autoDecision) {
          await this.updateStepAndPersist(taskId, stepId, "running");
          return autoDecision;
        }
        if (options.pauseOnHumanGate) {
          // All steps support multi-round human-agent interaction.
          // Keep the SDK session alive so the agent can process the answer
          // and continue or write final artifacts.
          const decision = await this.approvalBroker.waitForDecision(event);
          await this.updateStepAndPersist(taskId, stepId, "running");
          return decision;
        }
        const decision = await this.approvalBroker.waitForDecision(event);
        await this.updateStepAndPersist(taskId, stepId, "running");
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
      if (stepId === "13" && (await this.pauseIfAgentImprovementApprovalNeeded(task, step))) return;
      if (stepId === "12" && (await this.pauseIfStep12AcceptanceGate(task, step))) return;
      // Capacity-retry ladder (auto lossless VRAM offload) BEFORE the human gate:
      // if Step 07/08 hit an XPU capacity OOM, relaunch ComfyUI with stronger
      // lossless offload flags (--lowvram, then --novram) and re-run the step.
      // Only when the ladder is exhausted does the operator get asked for the
      // lossy reduced tier (Step 08 gate) / does Step 07 hard-stop.
      if (stepId === "07" || stepId === "08") {
        if (await this.capacitySignalForStep(task, stepId)) {
          const level = this.vramEscalationLevel.get(taskId) ?? 0;
          if (level < VRAM_ESCALATION_LADDER.length - 1) {
            const nextLevel = level + 1;
            this.vramEscalationLevel.set(taskId, nextLevel);
            // The OOM/DEVICE_LOST may have wedged the xe driver — reset the XPU on
            // the escalated relaunch (a plain relaunch frees VRAM but not the driver).
            this.xpuResetPending.add(taskId);
            // Harden to disk so Step 12 (GUI demo) + delivery use the proven flags,
            // and the level survives a backend restart.
            await this.persistVramLevel(task, nextLevel, `capacity OOM at Step ${stepId}`);
            const nextFlags = VRAM_ESCALATION_LADDER[nextLevel].join(" ");
            await this.emit({
              taskId,
              stepId,
              type: "progress",
              message: `Capacity OOM at Step ${stepId} — resetting the XPU (xpu-smi --reset) and auto-retrying with stronger lossless VRAM offload (level ${nextLevel}: ${nextFlags}) before asking for a reduced tier.`
            });
            await this.updateStepAndPersist(taskId, stepId, "running");
            this.activeStepRuns.delete(runKey);
            isRetrying = true;
            return this.runStep(taskId, stepId, undefined, { ...options, forceRerun: true });
          }
          if (stepId === "07") {
            // Branch smoke still OOMs after exhausting lossless offload -> genuine
            // capacity limit even at reduced smoke settings.
            await this.terminateWithHardStop({
              taskId,
              stepId,
              reason:
                "Step 07 branch smoke still hit an XPU capacity limit after exhausting lossless VRAM offload (--lowvram, --novram). The workflow is too large for this GPU even at reduced smoke settings; a reduced-fidelity tier (lower resolution/frames) or a larger/multi-GPU node is required.",
              improvementStrategy:
                "Reduce resolution/frame count for a restricted tier, or escalate to a larger/multi-GPU node."
            });
            return;
          }
          // Step 08 ladder exhausted -> fall through to the capacity decision gate.
        }
      }
      // Never let a Step 08 capacity hard stop silently complete: if the 08 summary
      // classifies full-size capacity as reduced/insufficient, present the operator
      // decision panel instead of marking the step completed.
      if (stepId === "08" && (await this.pauseIfStep08CapacityGate(task, step))) return;
      await this.updateStepAndPersist(taskId, stepId, "completed", { summary });
      // §H: record recipe outcome for analytics (fire-and-forget).
      recordRecipeOutcome(taskId, stepId, "success");
      // Real incident: hidden runtime model deps (e.g. IndexTTS2Run's ~14GB
      // suite, loaded dynamically from Python code, invisible to Step00/01's
      // static workflow-JSON scan) used to sit undownloaded until Step05's own
      // SDK session fetched them live, inline -- that's what made Step05 slow
      // enough to risk an SDK-session timeout. Step02 is where this class of
      // dependency actually gets discovered (its SDK agent can read custom-node
      // source); if it wrote a human-approved 02-hidden-runtime-assets.json,
      // kick the download off now, in the background, so it's already done (or
      // well underway) by the time Step05 runs. Deliberately not awaited --
      // must never delay Step02's own completion or count against its session
      // budget. Best-effort: absent/malformed file is a silent no-op, and
      // Step05 (see its preamble below) falls back to downloading it itself if
      // this never happened.
      if (stepId === "02") {
        startHiddenAssetPrestage(task, this.resolveModelRoots(task), this.resolveComfyuiRoot(task));
      }
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
      const isSdkTimeout = error instanceof SdkStepTimeoutError;
      const isRetryableConnectionError = isRetryableSdkConnectionError(error);
      if (isSdkTimeout || isRetryableConnectionError) {
        // Retry on SDK timeout OR a raw provider-connection failure (e.g.
        // "Could not connect to provider..." -- confirmed live: previously
        // only SdkStepTimeoutError was retried, so this exact error class got
        // zero retries and failed the step outright on one transient network
        // hiccup). Backoff before retrying gives a transient issue (proxy
        // blip, provider restart) time to actually clear.
        const maxRetries = sdkStepMaxRetries();
        const backoffMs = sdkStepRetryBackoffMs();
        const retryCount = this.sdkTimeoutRetries.get(runKey) ?? 0;
        if (retryCount < maxRetries) {
          this.sdkTimeoutRetries.set(runKey, retryCount + 1);
          this.activeStepRuns.delete(runKey);
          await this.updateStepAndPersist(taskId, stepId, "running");
          const reasonLabel = isSdkTimeout ? "SDK timeout (LLM API unresponsive)" : `SDK connection error (${message})`;
          await this.emit({
            taskId,
            stepId,
            type: "progress",
            message: `Step ${stepId} ${reasonLabel}. Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${retryCount + 1}/${maxRetries})...`
          });
          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
          isRetrying = true;
          return this.runStep(taskId, stepId, undefined, options);
        }
        this.sdkTimeoutRetries.delete(runKey);
        if (await this.pauseIfArtifactHumanGate(task, step, message)) return;
        const artifactCompletion = await checkRequiredArtifactCompletion(task, step);
        if (artifactCompletion.complete) {
          const summary = `Step ${stepId} completed by required artifact after SDK ${isSdkTimeout ? "watchdog timeout" : "connection retries exhausted"}. ${artifactCompletion.reason}`;
          await this.updateStepAndPersist(taskId, stepId, "completed", { summary });
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
        await this.updateStepAndPersist(taskId, stepId, "waiting_for_human", { error: message });
        await this.emit({
          taskId,
          stepId,
          type: "progress",
          message: `Step ${stepId} paused for human input: ${message}`
        });
      } else if (error instanceof SdkStepTimeoutError) {
        // Deliberately `instanceof SdkStepTimeoutError` only, not the broader
        // isRetryableSdkConnectionError check above -- a raw connection
        // failure means the SDK never had a live session to begin with, so
        // there's nothing to "resume"; once its retries are exhausted it
        // correctly falls through to the plain `failed` branch below instead.
        // SDK watchdog timed out but the underlying SDK session may still be
        // alive — keep the step in `paused` so the user can resume without
        // losing prior agent context. rerunStep remains available as the
        // heavier "start over" option.
        await this.updateStepAndPersist(taskId, stepId, "paused", { error: message });
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
        await this.updateStepAndPersist(taskId, stepId, "failed", { error: message });
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
      if (!isRetrying) {
        this.sdkTimeoutRetries.delete(runKey);
      }
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
        async (event) => (await this.tryAutoAnswerFromDefault(event)) ?? this.approvalBroker.waitForDecision(event),
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
    // Check-and-set must happen with no `await` in between -- see
    // activeRerunRequests' comment above for why (the same race, closed the
    // same way). Scoped to questionEventId, not taskId/stepId, so unrelated
    // concurrent decisions elsewhere are never blocked by this.
    if (this.activeHumanDecisionSubmissions.has(input.questionEventId)) {
      throw new Error(`This question is already being answered (questionEventId=${input.questionEventId}); ignoring duplicate submission.`);
    }
    this.activeHumanDecisionSubmissions.add(input.questionEventId);
    try {
      const rawDecision: HumanDecision = {
        ...input,
        decidedAt: new Date().toISOString()
      };
      const decision: HumanDecision = {
        ...rawDecision,
        answer: redactSensitiveText(rawDecision.answer)
      };
      await this.store.appendDecision(decision);
      // Cross-task answer log: record EVERY human answer to the shared NFS
      // log (answerDefaults.ts) so "you always answer this the same way" can
      // be detected past per-task state.json wipes. Best-effort; never blocks
      // the decision. Uses the redacted answer -- the log is durable/shared.
      await this.recordAnswerToLog(input.questionEventId, input.taskId, input.stepId, decision.answer, input.wasFreeform, "human").catch(
        (err) => console.warn(`[answer-log] record failed: ${err instanceof Error ? err.message : String(err)}`)
      );
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
    } finally {
      this.activeHumanDecisionSubmissions.delete(input.questionEventId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Answer defaults (answerDefaults.ts): record every answer cross-task, and
  // auto-answer / pre-fill recurring gate-questions without muting the agent.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Derive the stable question identity (stepId + blockingReason + choices,
   * plus the step-13 pipeline_phase discriminator) from a human_question
   * event. Returns undefined if the event isn't a well-formed question.
   */
  async questionIdentityFromEvent(event: Pick<AgentEvent, "stepId" | "taskId" | "data">): Promise<QuestionIdentity | undefined> {
    const q = event.data as HumanQuestion | undefined;
    if (!q || typeof q.blockingReason !== "string") return undefined;
    let phase: string | undefined;
    if (event.stepId === "13") {
      // Step-13's approve-improvements and push/deploy gates share
      // blockingReason "quality_review"; only pipeline_phase tells them apart.
      const task = await this.store.getTask(event.taskId);
      if (task) {
        const state = await readAgentImprovementFile(path.join(task.artifactPath, "13-agent-improvement.json")).catch(() => undefined);
        phase = state?.pipeline_phase ?? undefined;
      }
    }
    return {
      stepId: event.stepId,
      blockingReason: q.blockingReason as BlockingReason,
      choices: q.choices,
      phase
    };
  }

  /** Append one answer to the cross-task answer log (best-effort). */
  private async recordAnswerToLog(
    questionEventId: string,
    taskId: string,
    stepId: string | undefined,
    answer: string,
    wasFreeform: boolean,
    source: "human" | "auto-default"
  ): Promise<void> {
    if (!this.config.answerDefaultsEnabled) return;
    const events = await this.store.listEvents(taskId);
    const questionEvent = events.find((e) => e.id === questionEventId);
    if (!questionEvent) return;
    const identity = await this.questionIdentityFromEvent(questionEvent);
    if (!identity) return;
    const task = await this.store.getTask(taskId);
    await appendAnswerLog(this.config.answerLogPath, {
      ...identity,
      signature: computeQuestionSignature(identity),
      answer,
      wasFreeform,
      source,
      workflowName: task?.name ?? "unknown",
      taskId,
      decidedAt: new Date().toISOString()
    });
  }

  /**
   * At a gate-wait chokepoint, before parking on the broker: if the operator
   * saved a `tier:"auto"` default for this exact (structured, enumerated)
   * question and it isn't on the never-auto safety floor, answer it
   * immediately from the template. Records the decision + the answer-log entry
   * (source "auto-default") and emits a visible progress event so the timeline
   * shows the question was asked AND auto-answered. Returns the decision, or
   * undefined to fall through to a normal human wait.
   */
  private async tryAutoAnswerFromDefault(event: AgentEvent): Promise<HumanDecision | undefined> {
    if (!this.config.answerDefaultsEnabled) return undefined;
    const identity = await this.questionIdentityFromEvent(event).catch(() => undefined);
    if (!identity) return undefined;
    if (isNeverAutoQuestion(identity) || !isAutoAnswerEligible(identity)) return undefined;
    const template = await lookupAnswerDefault(this.config.answerDefaultsPath, computeQuestionSignature(identity)).catch(() => undefined);
    if (!template || !template.enabled || template.tier !== "auto") return undefined;
    const decision: HumanDecision = {
      taskId: event.taskId,
      stepId: event.stepId,
      questionEventId: event.id,
      answer: template.defaultAnswer,
      wasFreeform: false,
      decidedAt: new Date().toISOString()
    };
    await this.store.appendDecision(decision);
    await this.recordAnswerToLog(event.id, event.taskId, event.stepId, template.defaultAnswer, false, "auto-default").catch(() => undefined);
    await this.emit({
      taskId: event.taskId,
      stepId: event.stepId,
      type: "progress",
      message: `Auto-answered per your saved default: "${template.defaultAnswer}" (you can disable this default in the answer-defaults panel).`,
      data: { questionEventId: event.id, answer: template.defaultAnswer, source: "auto-default", signature: template.signature }
    });
    return decision;
  }

  /**
   * Tier-B surfacing: for a pending question, return its saved default (if any)
   * and cross-task answer history, so the UI can pre-fill/pre-select the likely
   * answer for one-click confirmation. `neverAuto` tells the UI to never
   * pre-submit (push/deploy + hard-stop safety floor).
   */
  async getAnswerSuggestion(taskId: string, questionEventId: string): Promise<{
    signature?: string;
    neverAuto: boolean;
    default?: { answer: string; tier: "confirm" | "auto"; enabled: boolean };
    history: { count: number; lastAnswer?: string; allSame: boolean };
  }> {
    const events = await this.store.listEvents(taskId);
    const questionEvent = events.find((e) => e.id === questionEventId);
    const identity = questionEvent ? await this.questionIdentityFromEvent(questionEvent) : undefined;
    if (!identity) return { neverAuto: false, history: { count: 0, allSame: false } };
    const signature = computeQuestionSignature(identity);
    const [template, history] = await Promise.all([
      lookupAnswerDefault(this.config.answerDefaultsPath, signature).catch(() => undefined),
      summarizeHistory(this.config.answerLogPath, signature).catch(
        () => ({ count: 0, allSame: false }) as Awaited<ReturnType<typeof summarizeHistory>>
      )
    ]);
    return {
      signature,
      neverAuto: isNeverAutoQuestion(identity),
      default: template ? { answer: template.defaultAnswer, tier: template.tier, enabled: template.enabled } : undefined,
      history: { count: history.count, lastAnswer: history.lastAnswer, allSame: history.allSame }
    };
  }

  /**
   * Save/upsert a default-answer template from a question the operator just
   * answered. Derives the answer from the recorded decision. Rejects the
   * never-auto safety floor for tier:"auto", and rejects tier:"auto" for
   * freeform-only (unstructured) questions.
   */
  async saveAnswerDefault(taskId: string, questionEventId: string, tier: "confirm" | "auto"): Promise<AnswerDefaultEntry> {
    const events = await this.store.listEvents(taskId);
    const questionEvent = events.find((e) => e.id === questionEventId);
    if (!questionEvent) throw new Error(`Question event not found: ${questionEventId}`);
    const identity = await this.questionIdentityFromEvent(questionEvent);
    if (!identity) throw new Error(`Event ${questionEventId} is not a well-formed question`);
    if (tier === "auto" && (isNeverAutoQuestion(identity) || !isAutoAnswerEligible(identity))) {
      throw new Error("This question cannot be set to fully-auto (it's on the never-auto safety floor or is a freeform question); use tier \"confirm\" instead.");
    }
    const decision = (await this.store.listDecisions(taskId)).filter((d) => d.questionEventId === questionEventId).at(-1);
    if (!decision) throw new Error(`No recorded answer to save as a default for ${questionEventId}`);
    const signature = computeQuestionSignature(identity);
    const existing = await lookupAnswerDefault(this.config.answerDefaultsPath, signature).catch(() => undefined);
    const now = new Date().toISOString();
    const entry: AnswerDefaultEntry = {
      ...identity,
      signature,
      label: (questionEvent.data as HumanQuestion | undefined)?.question ?? questionEvent.message,
      defaultAnswer: decision.answer,
      tier,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await appendAnswerDefault(this.config.answerDefaultsPath, entry);
    return entry;
  }

  async listAnswerDefaultTemplates(): Promise<AnswerDefaultEntry[]> {
    return listAnswerDefaults(this.config.answerDefaultsPath);
  }

  /** Toggle enabled / tombstone-delete an existing template (append-only). */
  async updateAnswerDefault(
    signature: string,
    change: { enabled?: boolean; deleted?: boolean }
  ): Promise<AnswerDefaultEntry | undefined> {
    const existing = (await listAnswerDefaults(this.config.answerDefaultsPath)).find((e) => e.signature === signature)
      ?? (await lookupAnswerDefault(this.config.answerDefaultsPath, signature).catch(() => undefined));
    if (!existing) return undefined;
    const updated: AnswerDefaultEntry = {
      ...existing,
      enabled: change.enabled ?? existing.enabled,
      deleted: change.deleted ?? existing.deleted,
      updatedAt: new Date().toISOString()
    };
    await appendAnswerDefault(this.config.answerDefaultsPath, updated);
    return updated.deleted ? undefined : updated;
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
    // This used to fire regardless of whether Step 01 was already
    // "completed" (specifically to catch the legacy Phase 1 monolithic
    // driver self-reporting completion while leaving unresolved gaps -- see
    // updateStepAndPersist's own comment: that driver mode is unreachable
    // from the UI today). Real bug this caused: this function is invoked on
    // every /events, /progress, and -- critically -- every SSE
    // /events/stream (re)connect (see index.ts), so once Step 01 genuinely
    // completed through the normal path (which already re-checks gaps via
    // pauseIfArtifactHumanGate before ever letting "completed" stick), the
    // very next page load or SSE reconnect would re-read this function's OWN
    // separate data source (01-acquisition-job.json's own status field,
    // which nothing clears when the step resolves through a DIFFERENT path)
    // and re-emit the exact same "still needs exact files" human_question --
    // confirmed live: a fresh human_question landed 119ms after the
    // step_completed event for the same task, and the stale question then
    // rendered as a persistent "Missing Assets" panel all the way into
    // Step 02, because nothing else about the step's own state ever
    // resolved it. Since the legacy driver mode this guarded against isn't
    // reachable from the UI, stop re-litigating a step that's already done.
    // Matches this codebase's own terminal-status convention (see the
    // `terminal` set a few thousand lines down at the resumeStep fast-path
    // check) -- hard_stopped is reachable here too: answering this exact
    // gate with "Stop migration at Step 01" sets the step to hard_stopped
    // (not completed), and without this it fell through the same stale
    // 01-acquisition-job.json re-read and re-emitted the identical question
    // right after the operator explicitly stopped the migration.
    if (!step || step.status === "completed" || step.status === "failed" || step.status === "terminated" || step.status === "hard_stopped")
      return false;

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
    // Check-and-set must happen with no `await` in between -- otherwise two
    // near-simultaneous calls can both race past the check before either
    // sets the flag (confirmed necessary: an earlier version checked this
    // after `await this.store.getTask(...)`, which reopened exactly the
    // race this guard exists to close).
    const runKey = this.stepRunKey(taskId, stepId);
    if (this.activeRerunRequests.has(runKey)) {
      throw new Error(`Step ${stepId} is already being re-run; ignoring duplicate request.`);
    }
    this.activeRerunRequests.add(runKey);
    try {
      const task = await this.store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const step = this.steps.find((s) => s.id === stepId);
      if (!step) throw new Error(`Step not found: ${stepId}`);
      await this.rerunStepInternal(task, stepId, runKey);
    } finally {
      this.activeRerunRequests.delete(runKey);
    }
  }

  private async rerunStepInternal(task: MigrationTask, stepId: string, runKey: string): Promise<void> {
    const taskId = task.id;
    // 0. Cancel any active SDK session / waiting broker for this step
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
    await this.updateStepAndPersist(taskId, stepId, "pending", { summary: undefined, error: undefined });

    // 2. Clean artifacts produced by this step
    await this.cleanStepArtifacts(task.artifactPath, stepId);

    // 3. Also reset any downstream steps that depend on this step's output
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    for (let i = stepIndex + 1; i < this.steps.length; i++) {
      const ds = this.steps[i];
      const dsState = task.steps.find((s) => s.id === ds.id);
      if (dsState && dsState.status !== "pending") {
        await this.updateStepAndPersist(taskId, ds.id, "pending", { summary: undefined, error: undefined });
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

    if (decision.stepId === "13" && (await this.applyAgentImprovementApprovalDecision({ task, decision }))) {
      return true;
    }

    if (decision.stepId === "13" && (await this.applyPushDeployDecision({ task, decision }))) {
      return true;
    }

    if (decision.stepId === "12" && (await this.applyStep12AcceptanceDecision({ task, decision }))) {
      return true;
    }

    if (decision.stepId === "08" && (await this.applyStep08CapacityDecision({ task, decision }))) {
      return true;
    }

    if (decision.stepId === "03b" && (await this.applyStep03bLocalizationDecision({ task, decision }))) {
      return true;
    }

    if (decision.stepId !== "00") {
      const artifactGate = await checkRequiredArtifactGate(task, stepDefinition);
      if (!artifactGate.gated) {
        // Gate was already resolved (e.g., by file upload that deleted gate-signal).
        // If the decision is a continue/approve, complete the step directly.
        if (isContinueDecision(decision.answer)) {
          const summary = `Step ${decision.stepId} completed; gate was already resolved (assets provided).`;
          await this.updateStepAndPersist(decision.taskId, decision.stepId, "completed", {
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
      await this.updateStepAndPersist(decision.taskId, decision.stepId, "hard_stopped", {
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
      await this.updateStepAndPersist(decision.taskId, decision.stepId, "completed", {
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
      await this.updateStepAndPersist(decision.taskId, decision.stepId, "waiting_for_human", {
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
    await this.updateStepAndPersist(input.task.id, input.stepId, "running", { summary });
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

  /**
   * Fast path for a Step-01 human answer that pastes exact source URLs: route
   * each URL, matched by BASENAME to a still-unresolved acquisition item, to an
   * async download sub-job (startSubJobForSuggestedUrl) and return to the gate
   * promptly. This replaces two prior failure modes (confirmed field incident):
   *   - the old auto-download only fired for exactly 1 URL + 1 unresolved item,
   *     so a real multi-URL answer was ignored and fell to a matcher that
   *     couldn't associate a bare-basename URL with a subfolder-prefixed asset;
   *   - re-running the full (minutes-long) synchronous provider search on every
   *     answer wedged the step at "running" if the backend restarted mid-run.
   * Returns true if it handled the answer (≥1 URL routed to a download); false
   * to fall through to the legacy full-re-acquisition path (no URL matched a
   * model item, e.g. a custom-node-repo-only or documented-risk answer).
   */
  /**
   * Match human-provided URLs to still-unresolved acquisition items and start
   * one async download sub-job per match. Matching: (1) by basename (an asset
   * requested as `SD1.5/vae….safetensors` matches a bare `resolve/main/vae….safetensors`
   * URL); (2) position fallback for the unambiguous 1-URL/1-item case, honoring
   * an operator who says "use this URL for that asset" even when the URL's
   * filename differs from the requested name (a renamed source). Returns the
   * routed/ambiguous/unmatched breakdown; does not touch step status or emit.
   */
  private startHumanUrlDownloads(
    task: MigrationTask,
    stepId: string,
    urls: string[],
    unresolved: AssetAcquisitionUnresolvedItem[]
  ): { routed: string[]; ambiguous: string[]; unmatched: string[]; stillUnresolved: string[] } {
    const routed: string[] = [];
    const routedAssets = new Set<string>();
    const ambiguous: string[] = [];
    const unmatched: string[] = [];
    const basenameOf = (name: string): string => {
      try {
        return decodeURIComponent(path.basename(new URL(name).pathname));
      } catch {
        return path.basename(name.split(/[?#]/)[0]);
      }
    };
    const start = (assetName: string, url: string): void => {
      routed.push(`${assetName} ← ${url}`);
      routedAssets.add(assetName);
      void this.suggestedUrlDownloader!.startSubJobForSuggestedUrl(task, assetName, url).catch((error) => {
        void this.emit({
          taskId: task.id,
          stepId,
          type: "progress",
          message: `Auto-triggered download of the human-provided source for ${assetName} failed to start: ${error instanceof Error ? error.message : error}`
        });
      });
    };
    for (const url of urls) {
      const urlBase = basenameOf(url);
      const matches = unresolved.filter((it) => path.basename(it.requestedName || it.assetName) === urlBase);
      if (matches.length === 1) start(matches[0].assetName, url);
      else if (matches.length > 1) ambiguous.push(url);
      else unmatched.push(url);
    }
    // Position fallback: exactly one URL, exactly one unresolved item, no
    // basename match -> the operator clearly means "use this URL for that one".
    if (routed.length === 0 && urls.length === 1 && unresolved.length === 1) {
      start(unresolved[0].assetName, urls[0]);
      unmatched.length = 0;
    }
    const stillUnresolved = unresolved.filter((it) => !routedAssets.has(it.assetName)).map((it) => it.assetName);
    return { routed, ambiguous, unmatched, stillUnresolved };
  }

  private async tryFastPathHumanUrlDownloads(task: MigrationTask, decision: HumanDecision): Promise<boolean> {
    if (!this.suggestedUrlDownloader) return false;
    const urls = extractHttpUrls(decision.answer);
    if (urls.length === 0) return false;
    const stepId = decision.stepId ?? "01";

    // Read the prior acquisition job's still-unresolved items (do NOT re-run the
    // heavy provider search).
    let unresolved: AssetAcquisitionUnresolvedItem[] = [];
    try {
      const raw = await fs.readFile(path.join(task.artifactPath, "01-acquisition-job.json"), "utf8");
      unresolved = (JSON.parse(raw).unresolvedItems ?? []) as AssetAcquisitionUnresolvedItem[];
    } catch {
      return false; // no prior job to map against -> let the full path run
    }
    if (unresolved.length === 0) return false;

    const { routed, ambiguous, unmatched, stillUnresolved } = this.startHumanUrlDownloads(task, stepId, urls, unresolved);
    if (routed.length === 0) return false; // nothing mapped -> legacy path (handles custom-node clones / documented risk)

    await this.emit({
      taskId: task.id,
      stepId,
      type: "progress",
      message:
        `Started ${routed.length} background download(s) from your links: ${routed.join("; ")}.` +
        (ambiguous.length ? ` Ambiguous (basename matched >1 asset, left for you): ${ambiguous.join(", ")}.` : "") +
        (unmatched.length ? ` No matching unresolved asset by filename (e.g. custom-node repos): ${unmatched.join(", ")}.` : ""),
      data: { routed, ambiguous, unmatched, stillUnresolved }
    });

    const summary = `Step 01 started ${routed.length} background download(s) from operator-provided links; the gate re-evaluates as each completes. Still unresolved until then: ${stillUnresolved.join(", ") || "none"}.`;
    await this.store.updateStep(task.id, stepId, "waiting_for_human", { summary, error: undefined });
    await this.emit({
      taskId: task.id,
      stepId,
      type: "human_question",
      message: summary,
      data: {
        question:
          `Downloads started for: ${routed.map((r) => r.split(" ← ")[0]).join(", ")}. Watch the sub-jobs panel; once they finish the gate clears. For anything still unresolved (${stillUnresolved.join(", ") || "none"}), provide more source URLs/local paths, approve continuing with documented gaps, or stop.`,
        choices: [
          "Provide more source URLs / local paths",
          "Approve bounded smoke-only follow-up with documented gaps",
          "Stop migration at Step 01"
        ],
        allowFreeform: true,
        blockingReason: "missing_asset"
      }
    });
    return true;
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
    // Fast path (Fix 2/3): if the operator pasted exact source URLs, route them
    // to async download sub-jobs by basename and return to the gate promptly --
    // instead of a minutes-long synchronous provider re-search that could wedge
    // the step at "running" on a backend restart.
    if (stepId === "01" && (await this.tryFastPathHumanUrlDownloads(task, decision))) {
      return;
    }
    let step01Acquisition:
      | Awaited<ReturnType<typeof ensureAssetAcquisitionJob>>
      | undefined;
    if (stepId === "01") {
      step01Acquisition = await ensureAssetAcquisitionJob({
        task,
        modelRoots: this.resolveModelRoots(task),
        comfyuiRoot: this.resolveComfyuiRoot(task),
        nfsShareRoot: this.resolveNfsShareRootForTask(task),
        assetResolutionLedgerPath: this.config.assetResolutionLedgerPath,
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
    // The operator-URL fast path (tryFastPathHumanUrlDownloads) already ran and
    // returned false, meaning there was no prior acquisition job on disk to map
    // against (edge/first-time). Now that this heavy re-run produced a fresh
    // job, route any pasted URLs to async downloads using the same matcher, so
    // the "operator provided a source URL" case still triggers a real download.
    if (this.suggestedUrlDownloader && step01Acquisition.status === "waiting_for_secure_download") {
      const urls = extractHttpUrls(decision.answer);
      if (urls.length > 0 && step01Acquisition.unresolvedItems.length > 0) {
        const { routed, ambiguous, unmatched, stillUnresolved } = this.startHumanUrlDownloads(
          task,
          stepId,
          urls,
          step01Acquisition.unresolvedItems
        );
        if (routed.length > 0) {
          await this.emit({
            taskId: decision.taskId,
            stepId,
            type: "progress",
            message:
              `Started ${routed.length} background download(s) from operator-provided links: ${routed.join("; ")}.` +
              (ambiguous.length ? ` Ambiguous: ${ambiguous.join(", ")}.` : "") +
              (unmatched.length ? ` Unmatched by filename: ${unmatched.join(", ")}.` : ""),
            data: { routed, ambiguous, unmatched, stillUnresolved }
          });
        }
      }
    }
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
      await this.updateStepAndPersist(input.taskId, input.stepId, "hard_stopped", {
        error: input.reason
      });
    }
    await this.store.updateTaskStatus(input.taskId, "hard_stopped");
    // Free the one-run-per-process lock now (don't wait for the in-flight SDK
    // call to wind down), so new tasks can be created immediately. Also flag the
    // task so any lock the winding-down run re-acquires is ignored.
    this.hardStoppedTaskIds.add(input.taskId);
    this.releaseTaskRuns(input.taskId);
    // Actually terminate the in-flight SDK client too, not just orchestrator
    // bookkeeping -- previously a hard-stopped task's CLI subprocess kept
    // running unsupervised (confirmed live: a wedged session kept burning CPU
    // for 20+ minutes after this endpoint reported success). Best-effort: a
    // task with no SDK step in flight (or already finished) has nothing to abort.
    await this.sdkRunner.abortTask?.(input.taskId).catch(() => undefined);
    // Tear down this task's ComfyUI container/process so it stops holding the
    // GPU's port and VRAM. Killing/hard-stopping a task previously left
    // comfyui-<taskId> running with the XPU still full -- a fresh task then
    // reused that stale server (or OOM'd immediately). Best-effort, never throws.
    await this.teardownComfyUiForTask(task);
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
    await this.updateStepAndPersist(task.id, step.id, "waiting_for_human", {
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

  /**
   * Step 12 GUI-acceptance human gate (Pass / Not pass / Not validated).
   *
   * Real regression this restores: gating is authoritative only via a
   * deterministic per-step signal, and Step 12 never had a writer, so it
   * silently completed the moment 12-gui-acceptance.md existed -- the operator
   * was never asked to sign off the generated outputs. This hook re-adds that
   * decision point, keyed on 12-gui-acceptance-summary.json's `manual_result`
   * (so it re-fires correctly on resume/restart, no gate-signal file needed),
   * and hands the UI a clickable ComfyUI verification URL + a concise test
   * checklist (structured, not buried in the markdown). Returns true when it
   * paused (result not yet "accepted"), false when the step may complete.
   */
  private async pauseIfStep12AcceptanceGate(
    task: MigrationTask,
    step: MigrationStepDefinition
  ): Promise<boolean> {
    const summary = await this.readStep12Summary(task);
    if (summary?.manual_result === "accepted") return false;

    const url = this.resolveStep12VerificationUrl(task, summary);
    const workflowName = path.basename(task.workflowPath).replace(/\.json$/i, "");
    const verificationSteps = [
      url ? `Open the ComfyUI verification link above (\`${url}\`) in a browser the tester can see.` : "Open the running ComfyUI GUI for this task in a tester-visible browser.",
      "Load / confirm the migrated workflow is present (it is pushed into the ComfyUI *Workflows* sidebar automatically).",
      "Run the workflow end-to-end and wait for it to finish without errors.",
      "Compare the generated output(s) against the expected result for this workflow.",
      "Choose a result: **Pass** if the outputs are correct; **Not pass** if they are wrong (the step will let you fix and re-run); **Not validated** if you did not / could not verify (delivery continues but is flagged NOT customer-ready). You can add notes in the text box."
    ];

    const question =
      `**Step 12 — manual GUI acceptance for \`${workflowName}\`.**\n\n` +
      (url ? `Verification link: ${url}\n\n` : "") +
      `Please verify the migrated workflow in the ComfyUI GUI, then record the result:\n\n` +
      verificationSteps.map((line, i) => `${i + 1}. ${line}`).join("\n");

    await this.updateStepAndPersist(task.id, step.id, "waiting_for_human", {
      summary: `Step 12 is waiting for manual GUI acceptance${url ? ` at ${url}` : ""}. Choose Pass / Not pass / Not validated.`,
      error: undefined
    });

    const data: QuestionEventData = {
      question,
      choices: [
        "Pass — outputs verified correct",
        "Not pass — outputs are wrong",
        "Not validated — did not verify"
      ],
      allowFreeform: true,
      blockingReason: "quality_review",
      verificationSteps,
      ...(url ? { verificationUrl: url } : {})
    };

    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "human_question",
      message: `Step 12 GUI acceptance: verify the workflow${url ? ` at ${url}` : ""} and record Pass / Not pass / Not validated.`,
      data
    });
    return true;
  }

  private async readStep12Summary(task: MigrationTask): Promise<{ manual_result?: string; service?: { api_url?: string } } | undefined> {
    const summaryPath = path.join(task.artifactPath, "12-gui-acceptance-summary.json");
    try {
      return JSON.parse(await fs.readFile(summaryPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private resolveStep12VerificationUrl(
    task: MigrationTask,
    summary: { service?: { api_url?: string } } | undefined
  ): string | undefined {
    const fromSummary = summary?.service?.api_url;
    if (typeof fromSummary === "string" && fromSummary.trim()) return fromSummary.trim();
    const node = this.lookupTaskNode(task);
    return node ? nodeApiUrl(node) : undefined;
  }

  /**
   * Applies the operator's Step-12 GUI-acceptance answer. Returns false (fall
   * through to generic gate handling) if the answer doesn't classify as one of
   * the three verification results, so any unrelated Step-12 decision still
   * works. Patches `manual_result` in 12-gui-acceptance-summary.json so the
   * gate above (and downstream archival, which only fires on "accepted") sees
   * the operator's decision.
   */
  private async applyStep12AcceptanceDecision(input: {
    task: MigrationTask;
    decision: HumanDecision;
  }): Promise<boolean> {
    const { task, decision } = input;
    const raw = decision.answer ?? "";
    // Classify on the FIRST line only (the chosen result); any following lines
    // are operator notes and must not sway classification (e.g. a note that
    // says "couldn't fully validate" under a Pass click).
    const firstLine = raw.split("\n")[0];
    const answer = firstLine.toLowerCase();
    // Order matters: check the negatives before the bare "pass" substring
    // (which is contained in neither, but "not pass" must not be read as pass).
    let result: "accepted" | "rejected" | "not_validated" | undefined;
    if (/not\s*validat|didn'?t\s*validat|could\s*not\s*validat|skip\s*validat|unvalidat/.test(answer)) {
      result = "not_validated";
    } else if (/not\s*pass|fail|reject|wrong|incorrect|bad\s*output/.test(answer)) {
      result = "rejected";
    } else if (/\bpass\b|verified\s*correct|accept|looks?\s*good|approve/.test(answer)) {
      result = "accepted";
    }
    if (!result) return false;

    const noteBody = raw.slice(firstLine.length).trim();
    const notes = redactSensitiveText(noteBody || firstLine);
    await this.patchStep12ManualResult(task, result, notes);

    if (result === "accepted") {
      const summary = `Step 12 GUI acceptance: operator PASSED. Outputs verified correct in the ComfyUI GUI.`;
      await this.updateStepAndPersist(task.id, "12", "completed", { summary, error: undefined });
      await this.emit({
        taskId: task.id,
        stepId: "12",
        type: "step_completed",
        message: summary,
        data: { manual_result: result, notes }
      });
      return true;
    }

    if (result === "not_validated") {
      const summary = `Step 12 completed WITHOUT GUI validation (operator chose "Not validated"). NOT customer-ready / not GUI-accepted; delivery continues with a downgraded claim boundary.`;
      await this.updateStepAndPersist(task.id, "12", "completed", { summary, error: undefined });
      await this.emit({
        taskId: task.id,
        stepId: "12",
        type: "step_completed",
        message: summary,
        data: { manual_result: result, notes, boundary: "not customer-ready; not GUI-accepted" }
      });
      return true;
    }

    // rejected -> reject and allow re-run in place (paused surfaces the Re-run
    // button; rerunStep regenerates the outputs and re-gates).
    const summary = `Step 12 REJECTED by operator (outputs are wrong). Fix the workflow/environment and re-run Step 12. ${notes ? `Notes: ${notes}` : ""}`.trim();
    await this.updateStepAndPersist(task.id, "12", "paused", { summary, error: undefined });
    await this.emit({
      taskId: task.id,
      stepId: "12",
      type: "progress",
      message: summary,
      data: { manual_result: result, notes }
    });
    return true;
  }

  private async patchStep12ManualResult(
    task: MigrationTask,
    manualResult: "accepted" | "rejected" | "not_validated",
    notes: string
  ): Promise<void> {
    const summaryPath = path.join(task.artifactPath, "12-gui-acceptance-summary.json");
    let summary: Record<string, unknown> = {};
    try {
      summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    } catch {
      summary = {};
    }
    summary.manual_result = manualResult;
    summary.manual_decision = {
      result: manualResult,
      notes,
      decided_at: new Date().toISOString()
    };
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  private async readStep08Summary(
    task: MigrationTask
  ): Promise<Record<string, any> | undefined> {
    const summaryPath = path.join(task.artifactPath, "08-full-validation-summary.json");
    try {
      return JSON.parse(await fs.readFile(summaryPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  /**
   * True if this Step 07/08 run hit a hard XPU capacity OOM (not merely a
   * tight/over-budget completion). Drives the lossless VRAM-escalation ladder.
   *   Step 08: completion_decision.capacity_tier === "insufficient" (a hard
   *            capacity error/crash; "reduced"/"tight" are handled by the gate).
   *   Step 07: 07-branch-smoke-summary.json capacity_suspected === true.
   */
  private async capacitySignalForStep(task: MigrationTask, stepId: string): Promise<boolean> {
    if (stepId === "08") {
      const summary = await this.readStep08Summary(task);
      const tier = summary?.completion_decision?.capacity_tier ?? summary?.capacity_classification?.capacity_tier;
      return tier === "insufficient";
    }
    if (stepId === "07") {
      try {
        const raw = await fs.readFile(path.join(task.artifactPath, "07-branch-smoke-summary.json"), "utf8");
        const summary = JSON.parse(raw) as Record<string, any>;
        return summary.capacity_suspected === true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * The effective VRAM escalation level for a task, PERSISTED across restarts via
   * `effective-run-config.json` (the in-memory `vramEscalationLevel` map is only a
   * warm cache and is lost on restart). Returns the max of the two so a level that
   * the capacity ladder proved in Step 07/08 is still applied at Step 12 (the GUI
   * demo) and after a backend restart -- i.e. the successful strategy is hardened
   * into the delivered run, not just the mid-run in-memory state.
   */
  private async effectiveVramLevel(taskId: string, task: MigrationTask): Promise<number> {
    // The persisted effective-run-config.json is the SINGLE SOURCE OF TRUTH for the
    // launch level. It is kept in sync on every escalation (persistVramLevel writes
    // the file BEFORE the re-launch) and on reduced-tier acceptance, so once it
    // exists it always reflects the currently-intended level. Using it directly
    // (instead of Math.max with the in-memory map) fixes a real drift: the in-memory
    // map could still hold L2 (--novram) from an earlier full-size OOM escalation
    // while the file had been written down to L1 (--lowvram) for the reduced tier,
    // and the old Math.max let the stale in-memory L2 win -> Step 12 relaunched at
    // --novram while the file said --lowvram (real incident 2026-08-12).
    let persisted: number | undefined;
    try {
      const cfg = JSON.parse(await fs.readFile(path.join(task.artifactPath, "effective-run-config.json"), "utf8"));
      if (typeof cfg.vram_level === "number") persisted = cfg.vram_level;
    } catch {
      // no persisted config yet
    }
    if (typeof persisted === "number") {
      this.vramEscalationLevel.set(taskId, persisted); // keep the in-memory cache aligned to the file
      return persisted;
    }
    // No persisted config yet (early steps before any escalation): fall back to the
    // in-memory map, which the live escalation loop bumps before it first persists.
    return this.vramEscalationLevel.get(taskId) ?? 0;
  }

  /**
   * The exact launch flags to use for this task, read from the persisted
   * effective-run-config.json (the hardened BKC) so the container is (re)launched
   * with EXACTLY the flags proven in Step 07/08 -- not re-derived from a level index
   * that could disagree with the file. Falls back to the ladder entry for the
   * effective level when no flags are persisted yet.
   */
  private async effectiveVramFlags(taskId: string, task: MigrationTask): Promise<string[]> {
    try {
      const cfg = JSON.parse(await fs.readFile(path.join(task.artifactPath, "effective-run-config.json"), "utf8"));
      if (Array.isArray(cfg.vram_flags) && cfg.vram_flags.every((f: unknown) => typeof f === "string")) {
        return cfg.vram_flags as string[];
      }
    } catch {
      // no persisted config yet
    }
    const level = Math.min(await this.effectiveVramLevel(taskId, task), VRAM_ESCALATION_LADDER.length - 1);
    return [...VRAM_ESCALATION_LADDER[level]];
  }

  /**
   * Harden the effective VRAM launch policy to disk so it survives restarts and is
   * consumed by Step 12 (GUI demo) + the delivery handoff. Written whenever the
   * capacity ladder escalates. Lossless: these flags change placement only, so the
   * delivered output is identical -- just launched with the memory strategy that
   * was proven to fit on this GPU.
   */
  /** Read-merge-write the hardened effective-run-config.json (best-effort). */
  private async mergeEffectiveRunConfig(task: MigrationTask, patch: Record<string, unknown>): Promise<void> {
    const configPath = path.join(task.artifactPath, "effective-run-config.json");
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      cfg = {};
    }
    const merged = {
      note:
        "Effective runtime policy hardened from the Step 07/08 capacity ladder + reduced-tier decision. Step 12 (GUI demo), any relaunch, and the delivery handoff must reuse it so the delivered run matches what was proven to fit on this GPU: launch with vram_flags, and if reduced_tier is true run at recommended_reduced_setting. VRAM flags are lossless (placement only); the reduced tier is the human-approved lossy fidelity downgrade.",
      ...cfg,
      ...patch,
      updated_at: new Date().toISOString()
    };
    try {
      await fs.writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch {
      // best-effort; the in-memory level still carries within this process
    }
  }

  private async persistVramLevel(task: MigrationTask, level: number, reason: string): Promise<void> {
    const flags = VRAM_ESCALATION_LADDER[Math.min(level, VRAM_ESCALATION_LADDER.length - 1)];
    await this.mergeEffectiveRunConfig(task, {
      vram_level: level,
      vram_flags: [...flags],
      vram_reason: reason
    });
  }

  /**
   * Deterministically apply the reduced-tier node edits (from Step 08's
   * recommended_reduced_setting.changes) to the Step 06 runtime-policy API prompt,
   * producing reduced-runtime-policy-prompt.json. This replaces the unreliable
   * "Step 12 agent hand-edits the workflow" path: the reduction is a mechanical
   * transform applied the moment the operator accepts the tier. Returns the reduced
   * prompt path, or undefined if it couldn't be produced (Step 12 then falls back to
   * the agent path). Each change is `{node_id, input, new}`.
   */
  private async generateReducedWorkflow(
    task: MigrationTask,
    changes: Array<{ node_id: string | number; input: string; new: unknown }> | undefined
  ): Promise<string | undefined> {
    if (!Array.isArray(changes) || changes.length === 0) return undefined;
    // Locate the runtime-policy API prompt (Step 06 variant).
    let promptPath: string | undefined;
    try {
      const s06 = JSON.parse(await fs.readFile(path.join(task.artifactPath, "06-prompt-validation-summary.json"), "utf8"));
      if (typeof s06?.variant_prompt_path === "string") promptPath = s06.variant_prompt_path;
    } catch {
      // fall through to the default artifact name
    }
    const candidates = [promptPath, path.join(task.artifactPath, "06b-runtime-policy-prompt.json")].filter(
      (p): p is string => Boolean(p)
    );
    let raw: string | undefined;
    for (const p of candidates) {
      try {
        raw = await fs.readFile(p, "utf8");
        break;
      } catch {
        // try next candidate
      }
    }
    if (!raw) return undefined;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const prompt = obj && typeof obj === "object" && obj.prompt && typeof obj.prompt === "object" ? obj.prompt : obj;
    const { applied } = applyReducedChangesToPrompt(prompt, changes);
    if (applied === 0) return undefined;
    const outPath = path.join(task.artifactPath, "reduced-runtime-policy-prompt.json");
    try {
      await fs.writeFile(outPath, JSON.stringify({ prompt }, null, 2) + "\n", "utf8");
    } catch {
      return undefined;
    }
    return outPath;
  }

  /**
   * FINAL-DELIVERY consistency guard. After the delivery bundle is assembled (Step 11
   * packaging + Step 12b final delivery), guarantee every RUNNABLE API-format prompt in
   * the bundle carries the reduced-tier drivers -- the same config validated at Step
   * 08->12 -- so a customer never runs a full-size prompt and OOMs. This closes a real
   * gap: Step 11 shipped a file literally named `reduced-tier-prompt.json` that was
   * actually full-size (ref_max_size=1280, length=81) (task 0804a33f, 2026-08-16).
   *
   * Auto-corrects a drifted runnable prompt to the reduced values (reusing the same
   * deterministic apply as generateReducedWorkflow); HARD-STOPS the step if a full-size
   * runnable prompt survives (never ship it). Reference-only files (basename matching
   * /source/i) and non-API-format shapes are left untouched. GUI-format workflows are
   * already reduced by guiWorkflowSync at Step 12. Returns true iff it hard-stopped.
   * Best-effort: no-op when there is no bundle, no effective-run-config, or no reduced tier.
   */
  /**
   * Plan B: precisely validate newly-deployed custom nodes and fold results into the
   * XPU catalog. Reads the Step-05 deploy ledger (05-catalog-deploy-ledger.json),
   * drives the isolated harness per node (best-effort), composes + writes. Falls back
   * to the agent-emitted catalog-writeback.json when no ledger exists. Flag-gated.
   */
  private async catalogValidateAndWriteBack(task: MigrationTask): Promise<void> {
    if (!catalogEnabled()) return;
    let ledger: CatalogDeployLedger | undefined;
    try {
      ledger = JSON.parse(await fs.readFile(path.join(task.artifactPath, CATALOG_DEPLOY_LEDGER_FILE), "utf8")) as CatalogDeployLedger;
    } catch {
      ledger = undefined;
    }
    // Hard-layer fallback: the Step-05 AGENT sometimes skips emitting the deploy
    // ledger (soft layer), which would zero the whole loop. Reconstruct it
    // deterministically from object_info + registry + real container git provenance
    // so a successful migration still teaches the catalog. Only provenance-known
    // nodes are synthesized; the branch-harvest gate below still decides what enters.
    if (!ledger || !Array.isArray(ledger.nodes) || ledger.nodes.length === 0) {
      const synthesized = await this.synthesizeDeployLedger(task).catch(() => undefined);
      if (synthesized && synthesized.ledger.nodes.length > 0) {
        ledger = synthesized.ledger;
        await this.emit({
          taskId: task.id,
          stepId: "07",
          type: "progress",
          message:
            `XPU catalog: Step-05 deploy ledger missing — synthesized ${synthesized.ledger.nodes.length} ` +
            `provenance-known custom node(s) from object_info + registry + container git` +
            (synthesized.unattributed.length ? `; ${synthesized.unattributed.length} unattributed (skipped: ${synthesized.unattributed.join(", ")})` : ""),
          data: { synthesizedLedger: synthesized.ledger.nodes.map((n) => n.nodeType), unattributed: synthesized.unattributed }
        }).catch(() => undefined);
      }
    }
    let summary;
    if (ledger && Array.isArray(ledger.nodes) && ledger.nodes.length > 0) {
      // Option B: harvest which custom nodes executed FRESH on a SUCCESSFUL Step-07
      // output branch, and record ONLY those (strict "truly tested before complete"
      // gate). No isolated per-node run → avoids ComfyUI's prompt_no_outputs.
      const freshTypes = await this.harvestFreshValidatedTypes(task);
      const now = new Date().toISOString();
      const verdicts: NodeVerdict[] = ledger.nodes
        .filter((n) => n.nodeType && freshTypes.has(n.nodeType))
        .map((n) => ({ nodeType: n.nodeType, passed: true, historyResult: "success", passedAt: now }));
      summary = await applyCatalogWriteBackFromLedger(ledger, verdicts, { taskId: task.id, workflowName: task.name });
    } else {
      summary = await applyCatalogWriteBack(task.artifactPath, { taskId: task.id, workflowName: task.name });
    }
    if (summary.enabled && (summary.created.length || summary.validated.length)) {
      await this.emit({
        taskId: task.id,
        stepId: "07",
        type: "progress",
        message: `XPU catalog updated: ${summary.created.length} new, ${summary.validated.length} validated`,
        data: { catalogWriteBack: summary }
      });
    }
  }

  /**
   * Option B: the custom-node class_types that executed FRESH on a SUCCESSFUL Step-07
   * output branch (the DB-entry gate). Reads 07-branch-smoke-summary.json + the
   * Step-06 runtime-policy prompt (id→class_type). Empty set when either is missing.
   */
  private async harvestFreshValidatedTypes(task: MigrationTask): Promise<Set<string>> {
    const graph = await this.loadPromptGraph(task);
    try {
      const step07 = JSON.parse(await fs.readFile(path.join(task.artifactPath, "07-branch-smoke-summary.json"), "utf8"));
      return branchValidatedNodeTypes(step07 as never, graph);
    } catch {
      // Single-output workflows run one whole-graph "main smoke" and emit
      // 07-main-smoke-evidence.json instead of a branch summary → harvest that so the
      // catalog loop still turns (the multi-branch WAN2.2 path always had a summary,
      // which hid this gap until a single-output workflow was migrated).
      try {
        const ev = JSON.parse(await fs.readFile(path.join(task.artifactPath, "07-main-smoke-evidence.json"), "utf8"));
        return mainSmokeValidatedNodeTypes(ev as never, graph);
      } catch {
        return new Set();
      }
    }
  }

  /** Load the workflow API graph (id→class_type) from the Step-06 runtime-policy prompt. */
  private async loadPromptGraph(task: MigrationTask): Promise<PromptGraph> {
    let variantPromptPath: string | undefined;
    try {
      const s06 = JSON.parse(
        await fs.readFile(path.join(task.artifactPath, "06-prompt-validation-summary.json"), "utf8")
      );
      if (typeof s06?.variant_prompt_path === "string") variantPromptPath = s06.variant_prompt_path;
    } catch {
      // fall through to the default artifact name
    }
    // Prefer the runtime-policy prompt; fall back to the source-preserving prompt and
    // finally the actual smoke prompt. A simple/single-output workflow's pipeline emits
    // 06-source-preserving-prompt.json + 07-main-smoke-prompt.json rather than the
    // 06b-runtime-policy-prompt.json a full WAN2.2 run produces, so without these
    // fallbacks the graph would be empty and the catalog harvest would find nothing.
    const candidates = [
      variantPromptPath,
      path.join(task.artifactPath, "06b-runtime-policy-prompt.json"),
      path.join(task.artifactPath, "06-source-preserving-prompt.json"),
      path.join(task.artifactPath, "07-main-smoke-prompt.json")
    ].filter((p): p is string => Boolean(p));
    for (const p of candidates) {
      try {
        const doc = JSON.parse(await fs.readFile(p, "utf8"));
        return (doc?.prompt ?? doc ?? {}) as PromptGraph;
      } catch {
        // try next candidate
      }
    }
    return {};
  }

  /**
   * Hard-layer deploy-ledger synthesis: reconstruct `05-catalog-deploy-ledger.json`
   * from artifacts + ground truth the orchestrator controls, for the case where the
   * Step-05 agent didn't emit one. Sources: `05-object_info_workflow_nodes.json`
   * (class_type → python_module, i.e. which nodes are custom + their dir) + the
   * static registry + real git provenance harvested from the deployed container.
   * Best-effort; returns undefined when object_info is unreadable.
   */
  private async synthesizeDeployLedger(
    task: MigrationTask
  ): Promise<{ ledger: CatalogDeployLedger; unattributed: string[] } | undefined> {
    let types: WorkflowNodeType[] | undefined;
    try {
      const objectInfo = JSON.parse(
        await fs.readFile(path.join(task.artifactPath, "05-object_info_workflow_nodes.json"), "utf8")
      );
      types = parseWorkflowNodeTypes(objectInfo);
    } catch {
      // Simpler pipelines don't emit the aggregated object_info file; derive the
      // workflow's class_types straight from the API graph instead — registry
      // attribution (llama_cpp/VHS) matches on the class_type alone, so python_module
      // isn't required for those. (Nodes needing git-provenance attribution still fall
      // through to harvestContainerGitProvenance below.)
      const graph = await this.loadPromptGraph(task);
      const seen = new Set<string>();
      types = [];
      for (const node of Object.values(graph)) {
        const ct = node?.class_type;
        if (ct && !seen.has(ct)) {
          seen.add(ct);
          types.push({ nodeType: ct });
        }
      }
    }
    if (!types.length) return undefined;
    const provenance = await this.harvestContainerGitProvenance(task).catch(() => ({}) as ProvenanceMap);
    const { nodes, unattributed } = synthesizeLedgerNodes(types, provenance);
    return { ledger: { nodes }, unattributed };
  }

  /**
   * Best-effort: harvest `remote.origin.url` + HEAD for every `custom_nodes/<dir>`
   * that has a git checkout in the deployed per-task container. Only runtime=docker
   * kind=local is supported (a `docker exec`); other node kinds return {} → the
   * synthesizer then relies on the static registry alone. Never throws.
   */
  private async harvestContainerGitProvenance(task: MigrationTask): Promise<ProvenanceMap> {
    const node = this.lookupTaskNode(task);
    if (!(node?.runtime === "docker" && node.kind !== "ssh")) return {};
    const container = MigrationOrchestrator.dockerContainerName(task);
    const root = "/comfyui"; // the docker launch flow always mounts the core at /comfyui
    // For each custom_nodes dir with a remote: emit "<dir>\t<url>\t<sha>".
    const script =
      `for d in ${root}/custom_nodes/*/; do ` +
      `u=$(git -C "$d" config --get remote.origin.url 2>/dev/null); ` +
      `[ -n "$u" ] && printf '%s\\t%s\\t%s\\n' "$(basename "$d")" "$u" "$(git -C "$d" rev-parse HEAD 2>/dev/null)"; ` +
      `done`;
    const stdout = await new Promise<string>((resolve) => {
      execFile("docker", ["exec", container, "sh", "-c", script], { timeout: 30_000 }, (err, out) => {
        resolve(err ? "" : out);
      });
    });
    const map: ProvenanceMap = {};
    for (const line of stdout.split("\n")) {
      const [dir, url, sha] = line.split("\t");
      if (dir && url) map[dir] = { repository: url.trim(), ...(sha?.trim() ? { commit: sha.trim() } : {}) };
    }
    return map;
  }

  private async enforceReducedDeliveryConsistency(task: MigrationTask, stepId: string): Promise<boolean> {
    let cfg: any;
    try {
      cfg = JSON.parse(await fs.readFile(path.join(task.artifactPath, "effective-run-config.json"), "utf8"));
    } catch {
      return false; // no effective-run-config -> nothing to enforce
    }
    if (cfg?.reduced_tier !== true) return false; // full-size delivery is legitimate
    const changes = cfg?.recommended_reduced_setting?.changes;
    const vramFlags: string[] = Array.isArray(cfg?.vram_flags) ? cfg.vram_flags.map(String) : [];
    if (!Array.isArray(changes) || changes.length === 0) {
      await this.emit({
        taskId: task.id,
        stepId,
        type: "progress",
        message:
          "Delivery-consistency guard: reduced tier but no structured recommended_reduced_setting.changes -- " +
          "cannot verify/repair bundled prompts here (Step 08's own never-ship guard covers the upstream case).",
        data: { deliveryConsistency: "no_structured_changes" }
      });
      return false;
    }

    const bundleDirs = ["11-delivery", "12b-final-delivery"].map((d) => path.join(task.artifactPath, d));
    const isReferenceOnly = (name: string) => /source/i.test(name);
    const graphOf = (obj: any) =>
      obj && typeof obj === "object" && obj.prompt && typeof obj.prompt === "object" ? obj.prompt : obj;
    const looksLikeApiPrompt = (graph: any) =>
      graph &&
      typeof graph === "object" &&
      !Array.isArray(graph) &&
      Object.values(graph).some((n: any) => n && typeof n === "object" && typeof n.class_type === "string");

    // Collect all *.json under the bundle dirs (recursive).
    const jsonFiles: string[] = [];
    for (const dir of bundleDirs) {
      let entries: string[] = [];
      try {
        entries = (await fs.readdir(dir, { recursive: true })) as unknown as string[];
      } catch {
        continue; // dir may not exist for this step yet
      }
      for (const e of entries) {
        const full = path.join(dir, String(e));
        if (full.endsWith(".json")) jsonFiles.push(full);
      }
    }

    // Pass 1: auto-correct drifted runnable prompts.
    const repaired: string[] = [];
    for (const file of jsonFiles) {
      if (isReferenceOnly(path.basename(file))) continue;
      let obj: any;
      try {
        obj = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      const graph = graphOf(obj);
      if (!looksLikeApiPrompt(graph)) continue;
      const { applied, drifted } = applyReducedChangesToPrompt(graph, changes);
      if (applied > 0 && drifted > 0) {
        try {
          await fs.writeFile(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
          repaired.push(path.relative(task.artifactPath, file));
        } catch {
          // couldn't write -> the verify pass below hard-stops if still drifted
        }
      }
    }

    // Pass 2: verify no runnable prompt still ships a full-size driver.
    const stillFullSize: string[] = [];
    for (const file of jsonFiles) {
      if (isReferenceOnly(path.basename(file))) continue;
      let obj: any;
      try {
        obj = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      const graph = graphOf(obj);
      if (!looksLikeApiPrompt(graph)) continue;
      const probe = JSON.parse(JSON.stringify(graph));
      const { drifted } = applyReducedChangesToPrompt(probe, changes);
      if (drifted > 0) stillFullSize.push(path.relative(task.artifactPath, file));
    }

    if (repaired.length > 0) {
      await this.emit({
        taskId: task.id,
        stepId,
        type: "progress",
        message:
          `Delivery-consistency guard: auto-corrected ${repaired.length} bundled runnable prompt(s) to the ` +
          `reduced tier (${changes.map((c: any) => `${c.input}->${c.new}`).join(", ")}): ${repaired.join(", ")}.`,
        data: { deliveryConsistency: "repaired", files: repaired, changes }
      });
    }

    if (stillFullSize.length > 0) {
      const reason =
        `Delivery-consistency HARD STOP: the reduced-tier delivery bundle still contains full-size runnable ` +
        `prompt(s) that would OOM a customer run: ${stillFullSize.join(", ")}. Expected the reduced drivers ` +
        `(${changes.map((c: any) => `${c.input}=${c.new}`).join(", ")}) but a full-size value survived ` +
        `auto-correction (likely a file-write failure). Rebuild the bundle from reduced-runtime-policy-prompt.json.`;
      // Use the low-level store update (NOT updateStepAndPersist) to avoid re-entering
      // this same completion hook. Store state is authoritative; the emit records it.
      await this.store.updateStep(task.id, stepId, "hard_stopped", { summary: reason, error: reason });
      await this.emit({
        taskId: task.id,
        stepId,
        type: "hard_stop",
        message: reason,
        data: { deliveryConsistency: "full_size_survived", files: stillFullSize }
      });
      return true;
    }

    // Advisory: runnable launch scripts / deployment guide should mention the delivery
    // flags. Prose is NOT auto-rewritten (the 12b tool renders these from config); this
    // only surfaces a regression where a customer might launch without offload and OOM.
    const offloadFlags = vramFlags.filter((f) => f.startsWith("--") && f !== "--reserve-vram");
    if (offloadFlags.length > 0) {
      for (const dir of bundleDirs) {
        let entries: string[] = [];
        try {
          entries = (await fs.readdir(dir, { recursive: true })) as unknown as string[];
        } catch {
          continue;
        }
        for (const e of entries) {
          const name = String(e);
          if (!name.endsWith(".sh") && !/deployment-guide\.md$/i.test(name)) continue;
          const full = path.join(dir, name);
          let text = "";
          try {
            text = await fs.readFile(full, "utf8");
          } catch {
            continue;
          }
          const missing = offloadFlags.filter((f) => !text.includes(f));
          if (missing.length > 0) {
            await this.emit({
              taskId: task.id,
              stepId,
              type: "progress",
              message:
                `Delivery-consistency WARNING: ${path.relative(task.artifactPath, full)} does not mention delivery ` +
                `flag(s) ${missing.join(" ")} -- a customer following it may launch without offload and OOM. ` +
                `(Advisory; prose not auto-rewritten.)`,
              data: { deliveryConsistency: "flags_missing_in_doc", file: path.relative(task.artifactPath, full), missing }
            });
          }
        }
      }
    }

    return false;
  }

  /**
   * Step 08 full-size capacity decision gate. The step08 tool classifies full-size
   * capacity (capacity_tier) from a full-resolution probe; when it is 'reduced' or
   * 'insufficient', full size does not fit reliably on this GPU and the operator
   * must choose. Deterministic (mirrors pauseIfStep12AcceptanceGate) so the panel
   * is system-controlled and cannot be skipped by SDK-agent behavior -- the real
   * bug this closes: the agent wrote a capacity hard-stop into the 08 summary but
   * neither called ask_user nor triggered a hard_stop, so the step silently
   * completed and advanced past the capacity limit.
   */
  private async pauseIfStep08CapacityGate(
    task: MigrationTask,
    step: MigrationStepDefinition
  ): Promise<boolean> {
    const summary = await this.readStep08Summary(task);
    if (!summary) return false;
    // Re-gate guard: don't re-present once the operator has decided.
    if (summary.capacity_decision) return false;

    const decision = (summary.completion_decision ?? {}) as Record<string, any>;
    const capacity = (decision.capacity ?? summary.capacity_classification ?? {}) as Record<string, any>;
    const tier = decision.capacity_tier ?? capacity.capacity_tier;
    if (tier !== "reduced" && tier !== "insufficient") return false;

    const ratio =
      typeof capacity.peak_memory_budget_ratio === "number"
        ? capacity.peak_memory_budget_ratio
        : summary.memory_runtime?.peak_memory_budget_ratio;
    const signature = capacity.capacity_error_signature;
    const recommended =
      capacity.recommended_reduced_setting ??
      summary.step12_context?.recommended_reduced_setting ??
      "halve spatial dims and/or frames (e.g. 480x832 x 49 frames)";
    const workflowName = path.basename(task.workflowPath).replace(/\.json$/i, "");
    const ratioPct = typeof ratio === "number" ? `${Math.round(ratio * 100)}%` : undefined;

    // The reduced config was actually RUN by Step 08's reduced-validation probe --
    // surface that verdict so the operator accepts evidence-backed, not a guess.
    const rv = (capacity.reduced_validation ?? summary.step12_context?.reduced_validation) as
      | Record<string, any>
      | undefined;
    let validationLine = "";
    if (rv) {
      const rvRatioPct =
        typeof rv.reduced_peak_memory_budget_ratio === "number"
          ? `${Math.round(rv.reduced_peak_memory_budget_ratio * 100)}%`
          : undefined;
      if (rv.validated === true) {
        validationLine =
          `\n\n✅ **Reduced config validated:** Step 08 ran the reduced setting and it cleared OOM` +
          (rvRatioPct ? ` (reduced peak ≈ ${rvRatioPct} of budget)` : "") +
          ` — safe to accept.`;
      } else if (rv.validated === false) {
        validationLine =
          `\n\n⚠️ **Reduced config did NOT clear cleanly** when Step 08 ran it` +
          (rvRatioPct ? ` (reduced peak ≈ ${rvRatioPct} of budget)` : "") +
          `${rv.capacity_error_signature ? `, ${rv.capacity_error_signature}` : ""} — accepting it may still OOM at Step 12; consider reducing frames further or a larger node.`;
      }
    }

    const choices = [
      "Accept reduced tier — run GUI acceptance at the recommended reduced setting",
      "Hardware escalation — full size needs a larger / multi-GPU node",
      "Hard stop — stop the migration here"
    ];
    const question =
      `**Step 08 — full-size capacity decision for \`${workflowName}\`.**\n\n` +
      `The full-size capacity probe classified this workflow as **\`${tier}\`** on this GPU` +
      (ratioPct ? ` (peak VRAM ≈ ${ratioPct} of usable budget${signature ? `, ${signature}` : ""})` : "") +
      `.\n\nFull size does not fit reliably here. Choose how to proceed:\n\n` +
      `1. **Accept reduced tier** — Step 12 GUI acceptance runs at the recommended reduced setting (${recommended}); delivered as reduced-tier, **NOT full-size customer-ready**.\n` +
      `2. **Hardware escalation** — stop here; full-size customer-ready needs a larger / multi-GPU node.\n` +
      `3. **Hard stop** — stop the migration.` +
      validationLine;

    await this.updateStepAndPersist(task.id, step.id, "waiting_for_human", {
      summary: `Step 08 full-size capacity is '${tier}'. Choose: accept reduced tier / hardware escalation / hard stop.`,
      error: undefined
    });

    const data: QuestionEventData = {
      question,
      choices,
      allowFreeform: true,
      blockingReason: "capacity_policy",
      capacityTier: tier,
      ...(typeof ratio === "number" ? { peakMemoryBudgetRatio: ratio } : {}),
      ...(recommended ? { recommendedReducedSetting: recommended } : {})
    };
    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "human_question",
      message: `Step 08 capacity decision: full size is '${tier}' on this GPU — choose reduced tier / hardware escalation / hard stop.`,
      data
    });
    return true;
  }

  private async patchStep08CapacityDecision(
    task: MigrationTask,
    outcome: "reduced" | "escalation" | "hard_stop",
    notes: string
  ): Promise<void> {
    const summaryPath = path.join(task.artifactPath, "08-full-validation-summary.json");
    let summary: Record<string, unknown> = {};
    try {
      summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    } catch {
      summary = {};
    }
    summary.capacity_decision = {
      outcome,
      notes,
      decided_at: new Date().toISOString()
    };
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  /**
   * Routes the operator's Step 08 capacity decision. Reduced-tier acceptance
   * completes Step 08 and lets the migration proceed (Step 12 runs the reduced
   * tier via 08's step12_context); hardware escalation / hard stop terminate the
   * task as a classified capacity hard stop. Mirrors applyStep12AcceptanceDecision.
   */
  /**
   * Step 03b node-localization resume: on approve, apply the (deterministic,
   * re-derived) substitution plan to the GUI graph, overwrite task.workflowPath so
   * Steps 05–12 execute the localized graph, and record provenance. On reject,
   * leave the graph unchanged and record the API nodes as a human boundary. Either
   * way the step completes (it is optional and never blocks task completion).
   */
  private async applyStep03bLocalizationDecision(input: {
    task: MigrationTask;
    decision: HumanDecision;
  }): Promise<boolean> {
    const { task, decision } = input;
    const answer = (decision.answer ?? "").toLowerCase();
    const approved = /approve|substitut|localiz|yes|proceed|accept|ok\b/.test(answer) && !/reject|keep|decline|no\b/.test(answer);
    const rejected = /reject|keep the api|keep it|decline|boundary|do not|don'?t/.test(answer);
    if (!approved && !rejected) return false; // not a decision this handler owns

    const artifactPath = path.join(task.artifactPath, "03b-node-localization.md");
    const provenancePath = path.join(task.artifactPath, "03b-node-localization.json");
    const finish = async (md: string, summary: string): Promise<void> => {
      await fs.writeFile(artifactPath, md, "utf8");
      await this.store.appendArtifact({
        taskId: task.id,
        stepId: "03b",
        path: artifactPath,
        relativePath: path.relative(task.workspacePath, artifactPath),
        kind: "markdown"
      });
      // Clear the gate so a resume doesn't re-pause.
      await fs.writeFile(
        path.join(task.artifactPath, "03b-gate-signal.json"),
        JSON.stringify({ stepId: "03b", gated: false }, null, 2),
        "utf8"
      );
      await this.updateStepAndPersist(task.id, "03b", "completed", { summary, error: undefined });
      await this.emit({ taskId: task.id, stepId: "03b", type: "step_completed", message: summary });
    };

    let graph: GGraph;
    try {
      graph = JSON.parse(await fs.readFile(task.workflowPath, "utf8")) as GGraph;
    } catch (e) {
      await finish(`# Step 03b — Node localization\n\nCould not read the workflow (${(e as Error).message}); no changes.\n`, `Step 03b: could not read workflow (${(e as Error).message}).`);
      return true;
    }
    const { plans, proposals } = planNodeLocalization(graph);

    if (rejected || plans.length === 0) {
      const md =
        `# Step 03b — Node localization (REJECTED)\n\nThe human declined the substitution. The following cloud-API node(s) remain and are a human boundary (cannot run offline on the XPU):\n\n` +
        proposals.map((p) => `- node ${p.nodeId} \`${p.from}\``).join("\n") +
        "\n";
      await finish(md, `Step 03b: substitution rejected — ${proposals.length} API node(s) remain as a human boundary.`);
      return true;
    }

    // Approve → apply the substitution to the GUI graph.
    const { workflow, report } = substituteNodes(graph, plans);
    const backup = task.workflowPath.replace(/\.json$/i, "") + ".gui-original-preloc.json";
    await fs.copyFile(task.workflowPath, backup).catch(() => {});
    await fs.writeFile(task.workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
    await fs.writeFile(provenancePath, `${JSON.stringify({ substituted: report.substituted, isDag: report.isDag, warnings: report.warnings }, null, 2)}\n`, "utf8");
    await this.store.appendArtifact({
      taskId: task.id,
      stepId: "03b",
      path: provenancePath,
      relativePath: path.relative(task.workspacePath, provenancePath),
      kind: "json"
    });
    const md =
      `# Step 03b — Node localization (APPLIED)\n\nReplaced ${report.substituted.length} cloud-API node(s) with local-model subgraph(s) so the workflow runs fully offline on the XPU. GUI original backed up to \`${path.basename(backup)}\`.\n\n` +
      report.substituted
        .map((s) => `- node ${s.fromId} \`${s.from}\` → ${s.toNodes.join(" + ")} (${s.model ?? "local model"}); dropped inputs: ${s.droppedInputs.join(", ") || "none"}. **Output may differ from the cloud model.**`)
        .join("\n") +
      `\n\nGraph is a DAG: ${report.isDag}.${report.warnings.length ? " Warnings: " + report.warnings.join("; ") : ""}\n`;
    await finish(md, `Step 03b: substituted ${report.substituted.length} API node(s) with local models (DAG=${report.isDag}).`);
    return true;
  }

  private async applyStep08CapacityDecision(input: {
    task: MigrationTask;
    decision: HumanDecision;
  }): Promise<boolean> {
    const { task, decision } = input;
    const raw = decision.answer ?? "";
    const firstLine = raw.split("\n")[0];
    const answer = firstLine.toLowerCase();
    // Order matters: escalation/stop before the bare "reduced/accept" so a
    // "escalate to bigger node" note isn't misread as acceptance.
    let outcome: "reduced" | "escalation" | "hard_stop" | undefined;
    if (/escalat|larger|multi.?gpu|bigger|hardware|more\s*vram/.test(answer)) {
      outcome = "escalation";
    } else if (/hard\s*stop|\bstop\b|abort|halt|cancel/.test(answer)) {
      outcome = "hard_stop";
    } else if (/reduced|accept|proceed|480|lower|smaller/.test(answer)) {
      outcome = "reduced";
    }
    if (!outcome) return false;

    const noteBody = raw.slice(firstLine.length).trim();
    const notes = redactSensitiveText(noteBody || firstLine);
    await this.patchStep08CapacityDecision(task, outcome, notes);

    if (outcome === "reduced") {
      // Harden the reduced (lossy) tier alongside the lossless VRAM flags so Step 12
      // runs the demo at the low resolution/frames the operator approved -- avoiding
      // the OOM at full size -- and the delivery handoff records it.
      const s08 = await this.readStep08Summary(task);
      const recommended =
        s08?.completion_decision?.capacity?.recommended_reduced_setting ??
        s08?.step12_context?.recommended_reduced_setting ??
        "halve spatial dims and/or frame count (e.g. 480x832 x 49 frames)";
      const recommendedObj = recommended && typeof recommended === "object" ? (recommended as Record<string, any>) : undefined;
      const recommendedLabel = recommendedObj
        ? `${recommendedObj.resolution ?? "reduced"} x ${recommendedObj.frames ?? recommendedObj.length ?? "?"} frames`
        : String(recommended);
      // DETERMINISTICALLY apply the recommended node edits to the runtime-policy
      // workflow NOW (do not leave it to the Step 12 agent -- that hand-editing has
      // proven unreliable). Produces reduced-runtime-policy-prompt.json for Step 12
      // to run + deliver, so the demo is genuinely reduced, not full-size.
      const reducedPromptPath = await this.generateReducedWorkflow(task, recommendedObj?.changes);
      // SAFETY NET (real incident 2026-08-13, task 051acd0a): NEVER ship a full-size
      // workflow under a `reduced_tier` flag. If no structured reduced changes were
      // produced (recommended_reduced_setting is a text string, or generateReducedWorkflow
      // applied nothing), reducedPromptPath is undefined -> the Step 12 sidebar would be
      // FULL-SIZE and OOM. This happens when the Step 08 capacity-probe crashed the XPU
      // (DEVICE_LOST) and never wrote the structured setting. Hard-stop with a clear,
      // actionable error instead of silently delivering the full-size graph.
      if (!reducedPromptPath) {
        const reason =
          "Step 08 reduced tier was accepted but NO reduced workflow could be generated: the Step 08 " +
          "summary has no structured `recommended_reduced_setting.changes` (only a text fallback). This " +
          "means the capacity-probe likely DEVICE_LOST'd the XPU before writing the structured setting. " +
          "Shipping the reduced tier now would push the FULL-SIZE workflow to Step 12 and OOM. Re-run Step " +
          "08 (the backend resets the XPU on the retry) so the capacity-probe emits " +
          "`recommended_reduced_setting.changes`; if the full-size probe keeps crashing, reset the XPU " +
          "(`xpu-smi config -d 0 --reset`) and run `step08_full_validation.py --run-level reduced-validation` " +
          "to produce + validate the reduced config, then accept again.";
        await this.updateStepAndPersist(task.id, "08", "hard_stopped", { summary: reason, error: reason });
        await this.emit({
          taskId: task.id,
          stepId: "08",
          type: "hard_stop",
          message: reason,
          data: { capacity_decision: "reduced_no_structured_changes" }
        });
        return true;
      }
      // The full-size capacity ladder may have escalated to --novram (level 2),
      // which streams the whole model every step (~6 min/step). The REDUCED
      // workflow is much smaller and must NOT inherit that: cap it at --lowvram
      // (level 1) so the demo runs at a practical speed. If the reduced workflow
      // still doesn't fit at --lowvram, the ladder re-escalates from there.
      const REDUCED_TIER_VRAM_LEVEL = 1;
      // The reduced tier launches at EXACTLY --lowvram (level 1). Do NOT compute this
      // as Math.min(inMemory ?? 0, 1): after a backend restart the in-memory map is
      // empty, so `?? 0` collapsed the level to 0 (no offload) and the file was
      // written down to vram_level:0 -- a silent drift BELOW the intended lowvram
      // (real incident 2026-08-12). The reduced tier is a fixed floor+cap at L1; if
      // the reduced workflow still OOMs there, the live ladder re-escalates from L1.
      const cappedLevel = REDUCED_TIER_VRAM_LEVEL;
      this.vramEscalationLevel.set(task.id, cappedLevel);
      await this.mergeEffectiveRunConfig(task, {
        reduced_tier: true,
        recommended_reduced_setting: recommended,
        reduced_prompt_path: reducedPromptPath,
        reduced_tier_notes: notes || undefined,
        vram_level: cappedLevel,
        vram_flags: [...VRAM_ESCALATION_LADDER[cappedLevel]],
        vram_reason: "capped at --lowvram for the reduced tier (full-size --novram would be needlessly slow)"
      });
      const summary =
        `Step 08 capacity: operator ACCEPTED the reduced tier. ` +
        (reducedPromptPath
          ? `A reduced workflow (${recommendedLabel}) was generated deterministically at ${reducedPromptPath}; Step 12 runs/delivers THAT. `
          : `Step 12 must run GUI acceptance at the recommended reduced setting (${recommendedLabel}). `) +
        `Effective VRAM flags apply; delivery is reduced-tier, NOT full-size customer-ready.` +
        (notes ? ` Notes: ${notes}` : "");
      await this.updateStepAndPersist(task.id, "08", "completed", { summary, error: undefined });
      await this.emit({
        taskId: task.id,
        stepId: "08",
        type: "step_completed",
        message: summary,
        data: { capacity_decision: outcome, notes, boundary: "reduced-tier; not full-size customer-ready" }
      });
      return true;
    }

    const reason =
      outcome === "escalation"
        ? `Step 08 capacity HARD STOP: operator chose hardware escalation. Full-size customer-ready requires a larger / multi-GPU node.${notes ? ` Notes: ${notes}` : ""}`
        : `Step 08 capacity HARD STOP: operator stopped the migration.${notes ? ` Notes: ${notes}` : ""}`;
    await this.updateStepAndPersist(task.id, "08", "hard_stopped", { summary: reason, error: reason });
    await this.emit({
      taskId: task.id,
      stepId: "08",
      type: "hard_stop",
      message: reason,
      data: { capacity_decision: outcome, notes }
    });
    return true;
  }

  /**
   * Human-gated apply pipeline for Step 13's proposed improvements (see
   * agentImprovementPatch.ts). Step 13 already produces a well-structured
   * `13-agent-improvement.json` with each item's apply_status starting at
   * `patch_plan_only` -- previously nothing ever consumed that field, so
   * every proposal sat unused forever. This gate makes Step 13 pause for
   * explicit human approval (opt-in per item) before completing; approved
   * items are later applied by `scripts/apply-agent-improvements.mts` in an
   * isolated git worktree, never automatically and never merged to main by
   * the agent itself.
   */
  private async pauseIfAgentImprovementApprovalNeeded(
    task: MigrationTask,
    step: MigrationStepDefinition
  ): Promise<boolean> {
    const filePath = path.join(task.artifactPath, "13-agent-improvement.json");
    const state = await readAgentImprovementFile(filePath);
    if (!state || state.improvements.length === 0) return false;
    const pending = state.improvements.filter((item) => item.apply_status === "patch_plan_only");
    if (pending.length === 0) return false;

    const { state: marked } = applyItemStatusUpdates(
      state,
      Object.fromEntries(pending.map((item) => [item.id, "waiting_for_human_approval"]))
    );
    await writeAgentImprovementFile(filePath, marked);

    const message = `Step 13 proposed ${pending.length} improvement(s) to the agent's own prompts/skills/scripts. Human approval is required before any of them can be applied.`;
    await this.updateStepAndPersist(task.id, step.id, "waiting_for_human", { summary: message });

    const itemLines = pending
      .map((item) => {
        const detail = (item.root_cause ?? item.proposed_change ?? "").toString().slice(0, 200);
        return `  - ${item.id} [${item.risk_tier ?? "unknown risk"}]: ${detail}`;
      })
      .join("\n");

    await this.emit({
      taskId: task.id,
      stepId: step.id,
      type: "human_question",
      message,
      data: {
        question:
          `${message}\n\n${itemLines}\n\n` +
          `Which should be approved to apply? Answer "approve: <ids>" (e.g. "approve: I02,I05"), "approve: all", or "approve: none". ` +
          `Nothing is ever applied automatically or merged to main by the agent itself -- approved items still require a manual git review/merge.`,
        choices: ["approve: all", "approve: none"],
        allowFreeform: true,
        blockingReason: "quality_review",
        artifactPath: filePath
      }
    });
    return true;
  }

  /**
   * Handles the human's answer to the gate above. Returns false (falls
   * through to generic gate handling) if Step 13 isn't actually waiting on
   * this specific approval gate, so unrelated Step 13 decisions still work.
   *
   * If nothing was approved, Step 13 completes immediately (nothing to do)
   * exactly as before. If anything was approved, Step 13 does NOT complete
   * here -- it moves to `pipeline_phase: "processing"` and kicks off
   * runImprovementPipelineAsync in the background (fire-and-forget, mirrors
   * the existing runUntilGate/resumeStep call-site pattern in index.ts),
   * which will pause again with a NEW question once draft/verify/fix has
   * run for every approved item.
   */
  private async applyAgentImprovementApprovalDecision(input: {
    task: MigrationTask;
    decision: HumanDecision;
  }): Promise<boolean> {
    const { task, decision } = input;
    const filePath = path.join(task.artifactPath, "13-agent-improvement.json");
    const state = await readAgentImprovementFile(filePath);
    if (!state) return false;
    if (state.pipeline_phase && state.pipeline_phase !== "awaiting_approval") return false;
    const pendingIds = state.improvements
      .filter((item) => item.apply_status === "waiting_for_human_approval")
      .map((item) => item.id);
    if (pendingIds.length === 0) return false;

    const { decisions, unrecognizedTokens } = parseApprovalAnswer(decision.answer, pendingIds);
    const { state: afterApproval, unmatchedIds } = applyItemStatusUpdates(state, decisions);
    const approvedCount = Object.values(decisions).filter((value) => value === "approved_to_apply").length;

    if (approvedCount === 0) {
      await writeAgentImprovementFile(filePath, { ...afterApproval, pipeline_phase: "done" });
      const summary = `Step 13 improvement approval recorded: 0/${pendingIds.length} item(s) approved. Nothing to apply.`;
      await this.updateStepAndPersist(task.id, "13", "completed", { summary });
      await this.emit({
        taskId: task.id,
        stepId: "13",
        type: "step_completed",
        message: summary,
        data: { decisions, ...(unrecognizedTokens.length > 0 ? { unrecognizedTokens } : {}), ...(unmatchedIds.length > 0 ? { unmatchedIds } : {}) }
      });
      return true;
    }

    await writeAgentImprovementFile(filePath, { ...afterApproval, pipeline_phase: "processing" });
    const summary = `Step 13 improvement approval recorded: ${approvedCount}/${pendingIds.length} item(s) approved. Drafting and verifying now (this can take a while)...`;
    await this.updateStepAndPersist(task.id, "13", "running", { summary });
    await this.emit({
      taskId: task.id,
      stepId: "13",
      type: "progress",
      message: summary,
      data: { decisions, ...(unrecognizedTokens.length > 0 ? { unrecognizedTokens } : {}), ...(unmatchedIds.length > 0 ? { unmatchedIds } : {}) }
    });
    void this.runImprovementPipelineAsync(task.id).catch((error) => {
      console.error(`[step13-pipeline] ${task.id} failed:`, error instanceof Error ? error.message : error);
    });
    return true;
  }

  /**
   * Background draft -> verify -> (bounded fix retries) -> summarize pass
   * for every item approved at the gate above. Runs entirely against
   * `this.config.agentSelfImprovementRepoRoot` (the canonical
   * comfyui-migration-agent checkout) -- NEVER `this.config.projectRoot`,
   * which for a live agent-demo deployment can be a stale subtree of a
   * completely different repo (confirmed live this session). Never touches
   * the live task's own StateStore beyond this task's own
   * 13-agent-improvement.json and step status.
   */
  private async runImprovementPipelineAsync(taskId: string): Promise<void> {
    const MAX_FIX_ATTEMPTS = 2;
    const task = await this.store.getTask(taskId);
    if (!task) return;
    const filePath = path.join(task.artifactPath, "13-agent-improvement.json");
    const repoRoot = this.config.agentSelfImprovementRepoRoot;
    const log = (message: string) => {
      void this.emit({ taskId, stepId: "13", type: "progress", message });
    };

    if (!repoRoot) {
      const error =
        "AGENT_SELF_IMPROVEMENT_REPO_ROOT is not configured -- cannot draft/verify/merge agent improvements automatically. " +
        "Set it in env and restart, or apply approved items manually via scripts/apply-agent-improvements.mts with --api pointed at a canonical checkout.";
      await this.updateStepAndPersist(taskId, "13", "failed", { error });
      await this.emit({ taskId, stepId: "13", type: "progress", message: error });
      return;
    }

    const state = (await readAgentImprovementFile(filePath))!;
    const approved = state.improvements.filter((item) => item.apply_status === "approved_to_apply");
    const sdkRunner = this.sdkRunner as unknown as ImprovementSdkRunner;
    const outcomes: Array<{ id: string; verified: boolean; reason?: string }> = [];

    for (const original of approved) {
      let item: AgentImprovementItem = original;
      try {
        log(`Drafting ${item.id}...`);
        const draftResult = await draftImprovement({
          repoRoot,
          sdkRunner,
          item,
          sourceTaskArtifactPath: task.artifactPath,
          log
        });
        item = {
          ...item,
          apply_status: draftResult.madeChanges ? "drafted" : "verification_failed",
          ...(draftResult.madeChanges && draftResult.commitSha
            ? { draft: { branch: draftResult.branch, worktreePath: draftResult.worktreePath, commitSha: draftResult.commitSha } }
            : {})
        };
        await this.patchImprovementItem(filePath, item.id, item);

        let verified = false;
        let attempts = 0;
        while (item.draft) {
          log(`Verifying ${item.id}...`);
          const { verification, passed } = await verifyImprovement({
            item: item as AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> },
            sourceTaskId: taskId,
            api: `http://127.0.0.1:${this.config.port}`,
            attemptReplay: false,
            log
          });
          item = { ...item, apply_status: passed ? "verified" : "verification_failed", verification };
          await this.patchImprovementItem(filePath, item.id, item);
          verified = passed;
          if (passed || attempts >= MAX_FIX_ATTEMPTS) break;
          attempts += 1;
          log(`Verification failed for ${item.id} -- attempting fix ${attempts}/${MAX_FIX_ATTEMPTS}...`);
          const fixResult = await fixImprovement({
            repoRoot,
            sdkRunner,
            item: item as AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> },
            sourceTaskArtifactPath: task.artifactPath,
            log
          });
          item = {
            ...item,
            apply_status: fixResult.madeChanges ? "drafted" : "verification_failed",
            ...(fixResult.madeChanges && fixResult.commitSha
              ? { draft: { branch: fixResult.branch, worktreePath: fixResult.worktreePath, commitSha: fixResult.commitSha } }
              : {})
          };
          await this.patchImprovementItem(filePath, item.id, item);
          if (!fixResult.madeChanges) break; // no-op fix -- stop retrying, report as failed
        }
        outcomes.push({ id: item.id, verified, reason: verified ? undefined : "still failing after fix attempts -- see item.verification" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`${item.id} pipeline error: ${reason}`);
        await this.patchImprovementItem(filePath, item.id, { apply_status: "verification_failed" });
        outcomes.push({ id: item.id, verified: false, reason });
      }
    }

    const verifiedIds = outcomes.filter((o) => o.verified).map((o) => o.id);
    const failedLines = outcomes
      .filter((o) => !o.verified)
      .map((o) => `  - ${o.id}: ${o.reason}`)
      .join("\n");
    const summary =
      `Step 13 pipeline finished: ${verifiedIds.length}/${outcomes.length} item(s) verified.` +
      (failedLines ? `\n\nStill failing after retries:\n${failedLines}` : "");

    const current = (await readAgentImprovementFile(filePath))!;
    await writeAgentImprovementFile(filePath, { ...current, pipeline_phase: "awaiting_push_deploy_decision" });
    await this.updateStepAndPersist(taskId, "13", "waiting_for_human", { summary });
    await this.emit({
      taskId,
      stepId: "13",
      type: "human_question",
      message: summary,
      data: {
        question:
          `${summary}\n\n` +
          `Which verified item(s) should be pushed to GitHub? Answer "push: <ids>" (e.g. "push: I02,I05"), "push: all", or "push: none". ` +
          `Add " deploy" (e.g. "push: all deploy") to also sync the latest code to agent-demo and restart the backend after a successful push.`,
        choices: verifiedIds.length > 0 ? ["push: all deploy", "push: none"] : ["push: none"],
        allowFreeform: true,
        blockingReason: "quality_review",
        artifactPath: filePath
      }
    });
  }

  /** Safe read-modify-write of a single item, used throughout the pipeline above. */
  private async patchImprovementItem(filePath: string, itemId: string, patch: Partial<AgentImprovementItem>): Promise<void> {
    const current = (await readAgentImprovementFile(filePath))!;
    const { state: updated } = applyItemPatches(current, { [itemId]: patch });
    await writeAgentImprovementFile(filePath, updated);
  }

  /**
   * Handles the human's answer to the push/deploy gate above. Returns false
   * (falls through to generic gate handling) if Step 13 isn't waiting on
   * this specific gate. For each selected item: local merge --no-ff + a
   * full tsc/vitest re-check (mergeImprovement already auto-reverts on
   * failure), marking successes "applied". A SINGLE `git push origin HEAD`
   * follows if anything merged. Deploy (sync + restart agent-demo) only
   * fires if explicitly requested AND the push succeeded -- via a fully
   * DETACHED child process, since the deploy script kills and relaunches
   * this very Node process; letting it detach means this handler can finish
   * persisting state and responding before that happens.
   */
  private async applyPushDeployDecision(input: { task: MigrationTask; decision: HumanDecision }): Promise<boolean> {
    const { task, decision } = input;
    const filePath = path.join(task.artifactPath, "13-agent-improvement.json");
    const state = await readAgentImprovementFile(filePath);
    if (!state || state.pipeline_phase !== "awaiting_push_deploy_decision") return false;

    const repoRoot = this.config.agentSelfImprovementRepoRoot;
    const verifiedIds = state.improvements.filter((item) => item.apply_status === "verified").map((item) => item.id);
    const { pushIds, deploy, unrecognizedTokens } = parsePushDeployAnswer(decision.answer, verifiedIds);

    const notes: string[] = [];
    const mergedIds: string[] = [];
    if (!repoRoot && pushIds.length > 0) {
      notes.push("AGENT_SELF_IMPROVEMENT_REPO_ROOT is not configured -- cannot merge/push. Do this manually.");
    } else if (repoRoot) {
      for (const id of pushIds) {
        const item = state.improvements.find((i) => i.id === id);
        if (!item?.draft) {
          notes.push(`${id}: no draft info, skipped.`);
          continue;
        }
        const result = await mergeImprovement({
          repoRoot,
          item: item as AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> },
          log: (m) => void this.emit({ taskId: task.id, stepId: "13", type: "progress", message: m })
        });
        if (result.ok) {
          await this.patchImprovementItem(filePath, id, { apply_status: "applied" });
          mergedIds.push(id);
          notes.push(`${id}: merged locally as ${result.mergeSha}.`);
        } else {
          notes.push(`${id}: merge failed and was reverted -- ${result.reason}. Left at "verified".`);
        }
      }
    }

    let pushed = false;
    if (repoRoot && mergedIds.length > 0) {
      try {
        await improvementGit(repoRoot, ["push", "origin", "HEAD"]);
        pushed = true;
        notes.push(`Pushed ${mergedIds.length} merge(s) to origin main.`);
      } catch (error) {
        notes.push(`git push failed: ${error instanceof Error ? error.message : error}. Merged locally only -- push manually when ready.`);
      }
    }

    let deployTriggered = false;
    if (repoRoot && deploy && pushed) {
      const deployScript = path.join(repoRoot, "scripts", "deploy-agent-demo.sh");
      const child = spawn("bash", [deployScript, "--yes"], {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      deployTriggered = true;
      notes.push("Deploy triggered: agent-demo will sync the latest code and restart momentarily (detached from this process).");
    } else if (deploy && !pushed) {
      notes.push("Deploy was requested but nothing was pushed -- skipped.");
    }

    const current = (await readAgentImprovementFile(filePath))!;
    await writeAgentImprovementFile(filePath, { ...current, pipeline_phase: "done" });
    const summary = `Step 13 push/deploy decision recorded.\n\n${notes.join("\n")}`;
    await this.updateStepAndPersist(task.id, "13", "completed", { summary });
    await this.emit({
      taskId: task.id,
      stepId: "13",
      type: "step_completed",
      message: summary,
      data: { pushIds, deploy, deployTriggered, ...(unrecognizedTokens.length > 0 ? { unrecognizedTokens } : {}) }
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
    await this.updateStepAndPersist(task.id, step.id, "waiting_for_human", {
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
      // A step orphaned by a backend restart leaves its ComfyUI container + the
      // in-flight prompt RUNNING (a zombie that holds all the GPU VRAM until it
      // finishes/OOMs). Terminating the task state alone doesn't free the GPU --
      // tear the container down here too (best-effort; no-op if none). Real
      // incident 2026-08-15: a deploy restart orphaned a Step-07 run and its
      // ComfyUI prompt pinned 32.6 GB until manually killed.
      const freeGpu = () => this.teardownComfyUiForTask(refreshedTask).catch(() => 0);
      if (await this.failCompletedButIncompletePhase1Session(refreshedTask, reason, stepIds)) {
        await freeGpu();
        cleaned.push({ id: refreshedTask.id, name: refreshedTask.name, stepIds });
        continue;
      }
      const updated = await this.store.terminateActiveTaskState(refreshedTask.id, reason);
      if (!updated) continue;
      await freeGpu();
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
      // Free each old task's ComfyUI (container + XPU VRAM) before removing it,
      // so starting fresh doesn't inherit a wedged server / full GPU.
      await this.teardownComfyUiForTask(task);
      await archiveTaskSnapshot({ task, taskArchiveRoot: this.config.taskArchiveRoot });
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
    if (node?.runtime === "docker") {
      return node.kind === "ssh"
        ? this.killRemoteDockerComfyUI(task, node)
        : this.killLocalDockerComfyUI(task);
    }
    if (node?.kind === "ssh") {
      return this.killRemoteComfyUI(task, node);
    }
    return this.killLocalComfyUI(task);
  }

  /**
   * Public, best-effort teardown of a task's ComfyUI (container for runtime=docker,
   * process otherwise) so it stops holding the GPU port + VRAM. Called on kill
   * (hard-stop) and on task delete so leftover servers never wedge the next run.
   * Emits a progress line when something was actually torn down; never throws.
   */
  async teardownComfyUiForTask(task: MigrationTask): Promise<number> {
    try {
      const killed = await this.killComfyUIForTask(task);
      if (killed > 0) {
        await this.emit({
          taskId: task.id,
          type: "progress",
          message: `Tore down ComfyUI for task ${task.id} (freed its GPU port + VRAM).`
        }).catch(() => undefined);
      }
      return killed;
    } catch {
      return 0;
    }
  }

  /** Backwards-compatible local-only kill; preserved for callers that want local behaviour. */
  private async killComfyUIProcessesForTask(task: MigrationTask): Promise<number> {
    return this.killLocalComfyUI(task);
  }

  /** Deterministic per-task container name used by Step 05's docker launch flow. */
  private static dockerContainerName(task: MigrationTask): string {
    return `comfyui-${task.id}`;
  }

  /** runtime=docker, kind=local: tear down the per-task container by name. */
  private async killLocalDockerComfyUI(task: MigrationTask): Promise<number> {
    const name = MigrationOrchestrator.dockerContainerName(task);
    return new Promise((resolve) => {
      execFile("docker", ["rm", "-f", name], { timeout: 30_000 }, (err) => {
        if (err) {
          // Not necessarily a failure — container may simply not exist (never launched, or already reaped).
          console.warn(`[killLocalDockerComfyUI] 'docker rm -f ${name}' — ${err.message}`);
          resolve(0);
          return;
        }
        resolve(1);
      });
    });
  }

  /** runtime=docker, kind=ssh: tear down the per-task container by name on the remote node. */
  private async killRemoteDockerComfyUI(task: MigrationTask, node: GpuNode): Promise<number> {
    if (!node.ssh) return 0;
    const name = MigrationOrchestrator.dockerContainerName(task);
    const sshTarget = `${node.ssh.user}@${node.ssh.host}`;
    const sshArgs = [
      "-p", String(node.ssh.port ?? 22),
      ...(node.ssh.key_path ? ["-i", node.ssh.key_path] : []),
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      sshTarget,
      `docker rm -f ${name} || true`
    ];
    return new Promise((resolve) => {
      execFile("ssh", sshArgs, { timeout: 30_000 }, (err) => {
        if (err) {
          console.warn(
            `[killRemoteDockerComfyUI] SSH docker rm failed for task ${task.id} on ${sshTarget} — ${err.message}`
          );
          resolve(0);
          return;
        }
        resolve(1);
      });
    });
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

  /**
   * Model roots for Step 00/01/02's deterministic local filesystem search --
   * the union of the global default and the task's pinned GPU node's own
   * model_roots (see gpuNodes.ts's mergeModelRoots), not just the global
   * default alone. These steps run plain `fs` calls on the orchestrator's
   * own host, so this only makes sense for roots that resolve identically
   * everywhere they're mounted (the same assumption promptSkillCompiler.ts
   * already relies on for Steps 02+). Falls back to the global default if
   * gpu-nodes.json can't be loaded, matching lookupTaskNode's own fallback.
   */
  private resolveModelRoots(task: MigrationTask): string[] {
    const node = this.lookupTaskNode(task);
    return node ? mergeModelRoots(this.config.modelRoots, node.model_roots) : this.config.modelRoots;
  }

  /**
   * ComfyUI root for Step 00/01/04's deterministic local filesystem/git
   * work -- the task's pinned GPU node's own comfyui_root (matching
   * promptSkillCompiler.ts's existing override for Steps 02+), not the
   * global default alone. Real bug this closes: the global default is
   * local-xpu's checkout; a task pinned to a different node (e.g.
   * remote-124-12, whose comfyui_root doesn't even exist on this host) had
   * these deterministic steps silently analyzing the WRONG checkout's
   * custom_nodes/models/input dirs and registered node types -- no crash,
   * just wrong asset-gap/custom-node-presence/core-node-registration
   * results baked into artifacts. Falls back to the global default if
   * gpu-nodes.json can't be loaded, matching lookupTaskNode's own fallback.
   */
  private resolveComfyuiRoot(task: MigrationTask): string {
    const node = this.lookupTaskNode(task);
    return node?.comfyui_root ?? this.config.comfyuiRoot;
  }

  /**
   * The task's pinned GPU node's shared NFS custom_nodes root, if any --
   * used so newly-acquired custom nodes get cloned into the shared tree and
   * symlinked in (reusable by future tasks) instead of cloned directly into
   * the node's own custom_nodes/, same convention install-enum-package.mts
   * already follows. undefined when the node has no shared NFS tree
   * configured (e.g. a bare local node) -- callers fall back to a direct
   * clone in that case.
   */
  private resolveNfsShareRootForTask(task: MigrationTask): string | undefined {
    const node = this.lookupTaskNode(task);
    return node ? resolveNfsShareRoot(node) : undefined;
  }

  /**
   * Deterministic pre-check for Step 05, replacing what used to be pure SDK
   * improvisation. Confirmed live: a docker container was built and launched
   * correctly, but exited on a port conflict with an unrelated bare-metal
   * ComfyUI process left running since an earlier, unrelated task -- the
   * SDK agent then adopted that stale process rather than reclaiming the
   * port, and nobody ever restarted it after a later patch was applied to
   * disk, so several steps' real inference runs executed against unpatched
   * code the whole time. This surfaces (and, only when clearly safe,
   * resolves) exactly that class of gap:
   *
   * 1. Stale-process reclaim: if the node's own api_port is occupied by a
   *    process attributable to a DIFFERENT task that is not currently live
   *    (task deleted, or its own persisted status is terminal), kill it so
   *    a fresh docker launch gets a fair shot. A port occupant that can't be
   *    attributed to any known task, or belongs to a task still considered
   *    active, is deliberately left alone and only flagged -- never killed
   *    on ambiguous evidence.
   * 2. Process-freshness: if bare-metal ends up in play anyway (either the
   *    node isn't runtime=docker, or the occupant couldn't be reclaimed),
   *    compare that process's age against the mtime of any file a matched
   *    recipe's patchTarget names -- flags (never forces) a restart when
   *    the process predates a patch that's since landed on disk.
   * 3. Acceleration visibility: when bare-metal is in play, checks whether
   *    ComfyUI-OmniXPU's omni_xpu_kernel (cute/esimd attention backends,
   *    only ever shipped in the docker image) is actually importable in
   *    this specific environment, so a real capability gap is always
   *    stated up front instead of requiring independent investigation.
   *
   * Detection (and only conservatively-safe reclaim) -- never blocks Step 05,
   * and any check failure degrades to "not checked" rather than throwing.
   */
  private async assessComfyUIEnvironment(
    task: MigrationTask,
    node: GpuNode
  ): Promise<{ notes: string[] }> {
    const notes: string[] = [];
    try {
      const occupant = await checkPortOccupant(node, node.api_port);
      let reclaimed = false;
      if (occupant.occupied && occupant.pid) {
        const uuidMatch = occupant.commandLine?.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        );
        const occupantTaskId = uuidMatch?.[0];
        if (!occupantTaskId) {
          notes.push(
            `Port ${node.api_port} is occupied by PID ${occupant.pid}, not attributable to any known task workspace -- leaving it alone (ambiguous; could be an unrelated process).`
          );
        } else if (occupantTaskId === task.id) {
          // This task's own already-running process (e.g. a prior step already launched it) -- nothing to reclaim.
        } else {
          const occupantTask = await this.store.getTask(occupantTaskId).catch(() => undefined);
          const terminal = new Set(["completed", "failed", "terminated", "hard_stopped"]);
          const staleTask = !occupantTask || terminal.has(occupantTask.status);
          if (staleTask) {
            const killed = await killProcessOnNode(node, occupant.pid);
            reclaimed = killed;
            notes.push(
              killed
                ? `Port ${node.api_port} was occupied by a stale process (task ${occupantTaskId}, status ${occupantTask?.status ?? "deleted"}) -- reclaimed so this task's docker launch gets a fair shot.`
                : `Port ${node.api_port} occupant (task ${occupantTaskId}, status ${occupantTask?.status ?? "deleted"}) looked stale but could not be killed.`
            );
          } else {
            notes.push(
              `Port ${node.api_port} is occupied by task ${occupantTaskId}, which is still active (status ${occupantTask?.status}) -- not reclaiming; this task's docker launch may need to fall back to bare-metal or wait.`
            );
          }
        }
      }

      const bareMetalInPlay = node.runtime !== "docker" || (occupant.occupied && !reclaimed);
      if (bareMetalInPlay && occupant.occupied && occupant.pid) {
        try {
          const workflow = JSON.parse(await fs.readFile(task.workflowPath, "utf8"));
          const pairs = extractNodeModelPairs(workflow);
          const recipes = findMatchingRecipes(pairs).filter((r) => r.patchTarget);
          const elapsed = await getProcessElapsedSeconds(node, occupant.pid);
          if (elapsed !== undefined) {
            const processStartedAt = Date.now() - elapsed * 1000;
            for (const recipe of recipes) {
              const filePath = recipe.patchTarget!.split("::")[0].split(",")[0].trim();
              const stat = await fs.stat(path.join(node.comfyui_root, filePath)).catch(() => undefined);
              if (stat && stat.mtimeMs > processStartedAt) {
                notes.push(
                  `Recipe ${recipe.recipeId}'s patch target ${filePath} was modified after the running server (PID ${occupant.pid}) started -- that process is likely running unpatched code; verify or restart before trusting patch-dependent behavior.`
                );
              }
            }
          }
        } catch {
          // Best-effort -- a malformed workflow or unreadable file must never block Step 05.
        }

        const acceleration = await checkOmniXpuAcceleration(node);
        if (acceleration.omniXpuNodePresent && !acceleration.kernelImportable) {
          notes.push(
            "This bare-metal environment does not have omni_xpu_kernel-based attention acceleration available (ComfyUI-OmniXPU is present, but its compiled kernel only ships in the docker image) -- attention will run on plain PyTorch SDPA."
          );
        }
      }
    } catch (err) {
      notes.push(`assessComfyUIEnvironment check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { notes };
  }
}

function hasPersistedActiveState(task: MigrationTask): boolean {
  return task.status === "running" || task.steps.some((step) => step.status === "running");
}

/**
 * Deterministically apply reduced-tier changes to an API-format prompt graph
 * (a dict of node_id -> { class_type, inputs }). For each {node_id, input, new},
 * set prompt[node_id].inputs[input] = new. Returns how many were applied and how
 * many were DRIFTED (present but not already at `new` -- i.e. a full-size value the
 * bundle would otherwise ship to the customer). Mutates `prompt` in place; pure
 * otherwise. Shared by generateReducedWorkflow (build) and the delivery-consistency
 * guard (repair) so both apply the identical reduction.
 */
function applyReducedChangesToPrompt(
  prompt: any,
  changes: Array<{ node_id: string | number; input: string; new: unknown }>
): { applied: number; drifted: number } {
  let applied = 0;
  let drifted = 0;
  for (const change of changes) {
    const node = prompt?.[String(change.node_id)];
    if (node && node.inputs && typeof node.inputs === "object" && change.input in node.inputs) {
      if (node.inputs[change.input] !== change.new) drifted += 1;
      node.inputs[change.input] = change.new;
      applied += 1;
    }
  }
  return { applied, drifted };
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
  return items.flatMap((item, index) => {
    // Fix 4: an item reaching this gate is unresolved *because* no exact,
    // downloadable source was confirmed -- so any candidate_sources_found are
    // UNVERIFIED GUESSES (provider/fuzzy matches), not ready downloads. Say so
    // plainly, and surface the fuzzy judgment's confidence + any extension
    // mismatch, so the operator doesn't trust a wrong-type guess (e.g. an
    // `.onnx` asset "matched" to a `.pth` file).
    const requestedExt = path.extname(item.requestedName || item.assetName).toLowerCase();
    const fuzzy = item.fuzzyJudgment;
    const confidenceNote = fuzzy
      ? `   candidate_confidence: ${fuzzy.confidence}${fuzzy.urlVerified === false ? " (suggested URL did NOT verify as reachable)" : ""}; reason: ${fuzzy.reason}`
      : undefined;
    const guessWarning =
      item.candidateCount > 0
        ? `   ⚠ the ${item.candidateCount} candidate source(s) are UNVERIFIED guesses, not confirmed downloads -- the agent could not confirm an exact, fetchable ${requestedExt || "file"} for this asset. Prefer providing an exact source URL/local path.`
        : undefined;
    return [
      `${index + 1}. Missing ${item.kind}: ${item.assetName}`,
      `   requested_name: ${item.requestedName}`,
      `   source_node_ids: ${(item.sourceNodeIds ?? []).join(", ") || "not recorded"}`,
      `   source_context: ${item.sourceContext || "not recorded"}`,
      `   expected_target_path: ${item.expectedTargetPath ?? item.targetPath ?? "not recorded"}`,
      `   candidate_sources_found: ${item.candidateCount}; search_issues: ${item.searchIssueCount}`,
      ...(guessWarning ? [guessWarning] : []),
      ...(confidenceNote ? [confidenceNote] : []),
      `   human_action: provide the exact file/path or source URL for ${item.assetName}, approve secure download access, approve bounded gaps, or stop.`
    ];
  });
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

/**
 * Copilot SDK session IDs only accept `[a-zA-Z0-9_-]` -- confirmed by live
 * testing: `.` alone is enough to make session.create reject the request
 * (as are backslashes, full-width punctuation, and CJK text). Workflow-
 * author-controlled strings like requested asset names ("flux2\Klein-大熊
 * 一致性consistency（0.4-1.0）.safetensors") can contain any of that, so
 * never embed one verbatim in a sessionId.
 */
export function sanitizeSessionIdSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return /[a-zA-Z0-9]/.test(sanitized) ? sanitized : "unnamed";
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

/**
 * Real incident this closes: a human answered a missing-asset gate with a
 * corrected source URL via the freeform textarea. acceptHumanGateContext
 * only ever wrote it to 01-human-source-instructions.md (explicitly "does
 * not claim source-identical assets are already staged") and re-ran a
 * LOCAL-ONLY search phase, which obviously found nothing new -- the gate
 * re-asked the identical question every time the human resubmitted, since
 * nothing in that path ever actually downloads anything. The only way to
 * get a real download going was a human manually clicking "Use this
 * source" (tied to the ORIGINAL, possibly-wrong fuzzy-match suggestion) or
 * an operator calling the download API directly. This extracts a plain
 * http(s) URL from the answer so the unambiguous single-URL/single-item
 * case can trigger a real download immediately instead of looping forever.
 */
export function extractHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s`'")]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[),.;，。]+$/g, "")))];
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
  if (stepId === "12b") return "quality_review";
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
