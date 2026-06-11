import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
// Enable global proxy for all HTTP/HTTPS requests (including Node.js native fetch)
// so Copilot SDK works behind corporate proxies (e.g. child-prc.intel.com:912).
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyUrl) {
  try {
    const { bootstrap } = await import("global-agent");
    bootstrap();
  } catch { /* ignore */ }
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[proxy] Global proxy enabled: ${proxyUrl}`);
  } catch {
    console.warn(`[proxy] undici not available, native fetch() may not route through proxy`);
  }
}
import type { CreateTaskRequest, MigrationTask } from "../shared/types";
import { classifyArtifact, listArtifactFiles, readArtifactText } from "./artifacts";
import { processUploadedReplacement, FileValidationError } from "./assetReplacement";
import { loadConfig } from "./config";
import { ensureDir, safeJoin } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { readPhase1TaskState } from "./phase1Agent";
import { buildProgressNarrative } from "./progressNarrative";
import { StateStore } from "./state";
import { SubJobManager } from "./subJobs";
import { deleteTaskWorkspace } from "./taskWorkspaces";
import { loadStepDefinitions } from "./workflowLoader";

const config = loadConfig();
const store = new StateStore(config);
await store.initialize();
await ensureDir(config.workspaceRoot);

const steps = await loadStepDefinitions(config);
const orchestrator = new MigrationOrchestrator(config, store, steps);
const subJobs = new SubJobManager();
await orchestrator.reconcileStaleActiveTasks(
  "API server started; active SDK sessions from a previous process cannot be resumed safely."
);

const app = express();
app.use(express.json({ limit: "200mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    workspaceRoot: config.workspaceRoot,
    draftDocRoot: config.draftDocRoot,
    comfyuiRoot: config.comfyuiRoot,
    comfyuiPython: config.comfyuiPython,
    modelRoots: config.modelRoots,
    autoApproveAgentPermissions: config.autoApproveAgentPermissions
  });
});

app.get("/api/agent/preflight", async (_req, res, next) => {
  try {
    res.json(await orchestrator.preflightSdk());
  } catch (error) {
    next(error);
  }
});

app.get("/api/steps", (_req, res) => {
  res.json({ steps });
});

app.get("/api/tasks", async (_req, res, next) => {
  try {
    res.json({ tasks: await store.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks", async (req, res, next) => {
  try {
    const body = req.body as CreateTaskRequest;
    if (!body.workflowFileName || body.workflowJson === undefined) {
      res.status(400).json({ error: "workflowFileName and workflowJson are required" });
      return;
    }
    const task = await orchestrator.createTask({
      name: body.name?.trim() || path.basename(body.workflowFileName, ".json"),
      workflowFileName: sanitizeFileName(body.workflowFileName),
      workflowJson: body.workflowJson
    });
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/tasks/history", async (_req, res, next) => {
  try {
    const tasks = await store.listTasks();
    const historicalTasks = tasks.filter((task) => isDeletableTaskStatus(task.status));
    const deleted = [];
    for (const task of historicalTasks) {
      await deleteTaskWorkspace(config.workspaceRoot, task.workspacePath);
      const deletedTask = await store.deleteTask(task.id);
      if (deletedTask) deleted.push({ id: deletedTask.id, name: deletedTask.name });
    }
    res.json({ deleted, tasks: await store.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/cleanup-stale", async (_req, res, next) => {
  try {
    const cleaned = await orchestrator.reconcileStaleActiveTasks(
      "Manual cleanup requested; no active SDK session is attached in this API process."
    );
    res.json({ cleaned, tasks: await store.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!isDeletableTaskStatus(task.status)) {
      res.status(409).json({
        error: `Task ${task.id} is ${task.status}; stop or complete it before deleting.`
      });
      return;
    }
    await deleteTaskWorkspace(config.workspaceRoot, task.workspacePath);
    const deletedTask = await store.deleteTask(task.id);
    res.json({
      deleted: deletedTask ? { id: deletedTask.id, name: deletedTask.name } : undefined,
      tasks: await store.listTasks()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/steps/:stepId/run", async (req, res, next) => {
  try {
    void orchestrator.runStep(req.params.taskId, req.params.stepId).catch((error) => {
      console.error(`[step-run] ${req.params.taskId} step ${req.params.stepId} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/steps/:stepId/resume", async (req, res, next) => {
  try {
    void orchestrator.resumeStep(req.params.taskId, req.params.stepId).catch((error) => {
      console.error(`[step-resume] ${req.params.taskId} step ${req.params.stepId} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/steps/:stepId/rerun", async (req, res, next) => {
  try {
    void orchestrator.rerunStep(req.params.taskId, req.params.stepId).catch((error) => {
      console.error(`[step-rerun] ${req.params.taskId} step ${req.params.stepId} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/run-until-gate", async (req, res, next) => {
  try {
    void orchestrator.runUntilGate(req.params.taskId).catch((error) => {
      console.error(`[run-until-gate] ${req.params.taskId} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/run-phase1", async (req, res, next) => {
  try {
    void orchestrator.runPhase1Agent(req.params.taskId).catch((error) => {
      console.error(`[run-phase1] ${req.params.taskId} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/replay", async (req, res, next) => {
  try {
    const sourceTask = await store.getTask(req.params.taskId);
    if (!sourceTask) {
      res.status(404).json({ error: "Source task not found" });
      return;
    }
    const body = (req.body ?? {}) as { compareWith?: string; injectDecisions?: boolean };
    const workflowJson = JSON.parse(await fs.readFile(sourceTask.workflowPath, "utf8"));
    const newTask = await orchestrator.createTask({
      name: `${sourceTask.name} (replay)`,
      workflowFileName: `replay-${path.basename(sourceTask.workflowPath)}`,
      workflowJson
    });
    // If injectDecisions, register the source task's decisions for auto-injection.
    // Try artifact file first (survives task deletion), then fall back to state store.
    if (body.injectDecisions !== false) {
      let sourceDecisions;
      const artifactDecisionsPath = path.join(sourceTask.artifactPath, "decisions.json");
      try {
        sourceDecisions = JSON.parse(await fs.readFile(artifactDecisionsPath, "utf8"));
      } catch {
        sourceDecisions = await store.listDecisions(sourceTask.id);
      }
      if (sourceDecisions.length > 0) {
        await fs.writeFile(
          path.join(newTask.artifactPath, "replay-decisions.json"),
          JSON.stringify({ sourceTaskId: sourceTask.id, decisions: sourceDecisions }),
          "utf8"
        );
      }
    }
    // Start running
    void orchestrator.runUntilGate(newTask.id).catch((error) => {
      console.error(`[replay] ${newTask.id} failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ task: newTask, sourceTaskId: sourceTask.id, replaying: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/human-decisions", async (req, res, next) => {
  try {
    const body = req.body as {
      stepId?: string;
      questionEventId?: string;
      answer?: string;
      wasFreeform?: boolean;
    };
    if (!body.questionEventId || !body.answer) {
      res.status(400).json({ error: "questionEventId and answer are required" });
      return;
    }
    // If stepId not provided, resolve it from the question event
    let stepId = body.stepId;
    if (!stepId) {
      const events = await store.listEvents(req.params.taskId);
      const questionEvent = events.find((e) => e.id === body.questionEventId);
      stepId = questionEvent?.stepId;
    }
    const result = await orchestrator.recordHumanDecision({
      taskId: req.params.taskId,
      stepId,
      questionEventId: body.questionEventId,
      answer: body.answer,
      wasFreeform: body.wasFreeform ?? true
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/approval-probe", async (req, res, next) => {
  try {
    const body = req.body as { stepId?: string };
    res.status(202).json({
      event: await orchestrator.startApprovalProbe(req.params.taskId, body.stepId)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/human-decisions", async (req, res, next) => {
  try {
    res.json({ decisions: await store.listDecisions(req.params.taskId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/hard-stop", async (req, res, next) => {
  try {
    const body = req.body as { stepId?: string; reason?: string; improvementStrategy?: string };
    if (!body.reason) {
      res.status(400).json({ error: "reason is required" });
      return;
    }
    res.status(201).json({
      report: await orchestrator.terminateWithHardStop({
        taskId: req.params.taskId,
        stepId: body.stepId,
        reason: body.reason,
        improvementStrategy: body.improvementStrategy
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/reflection", async (req, res, next) => {
  try {
    res.status(201).json(await orchestrator.createReflectionProposal(req.params.taskId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/run-report", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    await orchestrator.generateRunReport(req.params.taskId);
    res.status(201).json({ generated: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/upload-media", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const { filename, contentBase64, targetFilename } = req.body as { filename?: string; contentBase64?: string; targetFilename?: string };
    if (!filename || !contentBase64) {
      res.status(400).json({ error: "filename and contentBase64 are required" });
      return;
    }
    const result = await processUploadedReplacement({
      task,
      filename,
      targetFilename: targetFilename || filename,
      contentBase64,
      comfyuiRoot: config.comfyuiRoot
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof FileValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/tasks/:taskId/events", async (req, res, next) => {
  try {
    await orchestrator.ensurePhase1HumanGateExposed(req.params.taskId);
    res.json({ events: await store.listEvents(req.params.taskId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/progress", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    await orchestrator.ensurePhase1HumanGateExposed(task.id);
    res.json({
      narrative: buildProgressNarrative({
        task,
        steps,
        events: await store.listEvents(task.id),
        artifacts: await store.listArtifacts(task.id),
        decisions: await store.listDecisions(task.id),
        phase1State: await readPhase1TaskStateIfPresent(task)
      })
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/events/stream", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).end();
      return;
    }
    await orchestrator.ensurePhase1HumanGateExposed(task.id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const limit = Number(req.query.limit ?? "80");
    const history = await store.listEvents(task.id);
    const replay = limit > 0 ? history.slice(-limit) : history;
    for (const event of replay) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = orchestrator.subscribe(task.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", unsubscribe);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/artifacts", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const files = await listArtifactFiles(task.workspacePath);
    res.json({
      artifacts: files.map((file) => ({
        path: file,
        relativePath: path.relative(task.workspacePath, file),
        kind: classifyArtifact(file)
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/subjobs", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ subJobs: await subJobs.listTaskSubJobs(task) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/subjobs/:subJobId/start", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.status(202).json({ subJob: await subJobs.startSubJob(task, req.params.subJobId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("disabled")) {
      res.status(409).json({ error: message });
      return;
    }
    next(error);
  }
});

app.get("/api/tasks/:taskId/artifacts/content", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const relativePath = String(req.query.path ?? "");
    res.type("text/plain").send(await readArtifactText(task.workspacePath, relativePath));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/artifacts/raw", async (req, res, next) => {
  try {
    const task = await store.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const relativePath = String(req.query.path ?? "");
    res.sendFile(safeJoin(task.workspacePath, relativePath));
  } catch (error) {
    next(error);
  }
});

app.post("/api/fixtures/zimage", async (_req, res, next) => {
  try {
    const sourcePath = path.resolve(
      config.projectRoot,
      "../Zimage/delivery/workflows/source-workflow.json"
    );
    const task = await orchestrator.createTaskFromWorkflowFile({
      name: "Zimage seeded demo",
      sourcePath
    });
    res.status(201).json({ task, sourcePath });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Migration demo API listening on http://127.0.0.1:${config.port}`);
});

function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_") || "workflow.json";
}

function isDeletableTaskStatus(status: string): boolean {
  return ["completed", "failed", "hard_stopped", "terminated", "pending", "waiting_for_human"].includes(status);
}

async function readPhase1TaskStateIfPresent(task: MigrationTask) {
  try {
    return await readPhase1TaskState(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("task-state.json was not found")) return undefined;
    throw error;
  }
}
