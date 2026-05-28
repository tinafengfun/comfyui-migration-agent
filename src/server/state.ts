import crypto from "node:crypto";
import path from "node:path";
import type {
  AgentEvent,
  ArtifactRecord,
  HumanDecision,
  MigrationStepDefinition,
  MigrationTask,
  StepStatus
} from "../shared/types";
import type { AppConfig } from "./config";
import { ensureDir, readJson, writeJson } from "./fsUtils";

interface PersistedState {
  tasks: MigrationTask[];
  events: AgentEvent[];
  artifacts: ArtifactRecord[];
  decisions: HumanDecision[];
}

const emptyState: PersistedState = {
  tasks: [],
  events: [],
  artifacts: [],
  decisions: []
};

export class StateStore {
  private readonly statePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AppConfig) {
    this.statePath = path.join(config.stateRoot, "state.json");
  }

  async initialize(): Promise<void> {
    await ensureDir(this.config.stateRoot);
    await ensureDir(this.config.workspaceRoot);
    await this.save(await this.load());
  }

  async load(): Promise<PersistedState> {
    const state = await readJson<PersistedState>(this.statePath, emptyState);
    return {
      ...emptyState,
      ...state,
      decisions: state.decisions ?? []
    };
  }

  async save(state: PersistedState): Promise<void> {
    await writeJson(this.statePath, state);
  }

  async listTasks(): Promise<MigrationTask[]> {
    return (await this.load()).tasks;
  }

  async getTask(taskId: string): Promise<MigrationTask | undefined> {
    return (await this.load()).tasks.find((task) => task.id === taskId);
  }

  async deleteTask(taskId: string): Promise<MigrationTask | undefined> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return undefined;
      state.tasks = state.tasks.filter((item) => item.id !== taskId);
      state.events = state.events.filter((event) => event.taskId !== taskId);
      state.artifacts = state.artifacts.filter((artifact) => artifact.taskId !== taskId);
      state.decisions = state.decisions.filter((decision) => decision.taskId !== taskId);
      await this.save(state);
      return task;
    });
  }

  async terminateActiveTaskState(
    taskId: string,
    reason: string
  ): Promise<MigrationTask | undefined> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return undefined;

      const now = new Date().toISOString();
      let changed = false;
      for (const step of task.steps) {
        if (step.status === "running") {
          step.status = "terminated";
          step.completedAt = now;
          step.error = reason;
          changed = true;
        }
      }

      if (changed) {
        task.status = "terminated";
        task.updatedAt = now;
        await this.save(state);
      }
      return task;
    });
  }

  async createTask(input: {
    id?: string;
    name: string;
    workflowPath: string;
    workspacePath: string;
    artifactPath: string;
    steps: MigrationStepDefinition[];
  }): Promise<MigrationTask> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const now = new Date().toISOString();
      const task: MigrationTask = {
        id: input.id ?? crypto.randomUUID(),
        name: input.name,
        status: "pending",
        workflowPath: input.workflowPath,
        workspacePath: input.workspacePath,
        artifactPath: input.artifactPath,
        createdAt: now,
        updatedAt: now,
        steps: input.steps.map((step) => ({ id: step.id, status: "pending" }))
      };
      state.tasks.push(task);
      await this.save(state);
      return task;
    });
  }

  async updateStep(
    taskId: string,
    stepId: string,
    status: StepStatus,
    patch: Partial<Pick<MigrationTask["steps"][number], "summary" | "error">> = {}
  ): Promise<MigrationTask> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const step = task.steps.find((item) => item.id === stepId);
      if (!step) {
        throw new Error(`Step not found: ${stepId}`);
      }
      const now = new Date().toISOString();
      step.status = status;
      if (Object.prototype.hasOwnProperty.call(patch, "summary")) {
        step.summary = patch.summary;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "error")) {
        step.error = patch.error;
      }
      if (status === "running" && !step.startedAt) {
        step.startedAt = now;
      }
      if (status === "running") {
        step.completedAt = undefined;
        step.error = undefined;
        if (!Object.prototype.hasOwnProperty.call(patch, "summary")) {
          step.summary = undefined;
        }
      }
      if (["completed", "failed", "hard_stopped", "terminated"].includes(status)) {
        step.completedAt = now;
      }
      task.status = status === "completed" ? deriveTaskStatus(task) : status;
      task.updatedAt = now;
      await this.save(state);
      return task;
    });
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await this.withWriteLock(async () => {
      const state = await this.load();
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      task.status = status as StepStatus;
      task.updatedAt = new Date().toISOString();
      await this.save(state);
    });
  }

  async appendEvent(event: Omit<AgentEvent, "id" | "createdAt">): Promise<AgentEvent> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const record: AgentEvent = {
        ...event,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString()
      };
      state.events.push(record);
      await this.save(state);
      return record;
    });
  }

  async listEvents(taskId: string): Promise<AgentEvent[]> {
    return (await this.load()).events.filter((event) => event.taskId === taskId);
  }

  async appendArtifact(
    artifact: Omit<ArtifactRecord, "id" | "createdAt">
  ): Promise<ArtifactRecord> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      const record: ArtifactRecord = {
        ...artifact,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString()
      };
      state.artifacts.push(record);
      await this.save(state);
      return record;
    });
  }

  async listArtifacts(taskId: string): Promise<ArtifactRecord[]> {
    return (await this.load()).artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  async appendDecision(decision: HumanDecision): Promise<HumanDecision> {
    return this.withWriteLock(async () => {
      const state = await this.load();
      state.decisions.push(decision);
      await this.save(state);
      return decision;
    });
  }

  async listDecisions(taskId: string): Promise<HumanDecision[]> {
    return (await this.load()).decisions.filter((decision) => decision.taskId === taskId);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}

function deriveTaskStatus(task: MigrationTask): StepStatus {
  if (task.steps.every((step) => step.status === "completed")) {
    return "completed";
  }
  if (task.steps.some((step) => step.status === "running")) {
    return "running";
  }
  if (task.steps.some((step) => step.status === "waiting_for_human")) {
    return "waiting_for_human";
  }
  return "pending";
}
