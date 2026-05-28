import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Panel, Group, Separator } from "react-resizable-panels";
import type {
  AgentEvent,
  ArtifactRecord,
  HumanDecision,
  HumanQuestion,
  MigrationStepDefinition,
  MigrationTask,
  ProgressNarrative,
  SubJob
} from "../shared/types";
import { useApi, type ArtifactListItem } from "./hooks/useApi";
import { useEventStream, type ActivityLine } from "./hooks/useEventStream";
import "./styles.css";

type ArtifactKindFilter = ArtifactRecord["kind"] | "all";
type HealthStatus = {
  ok: boolean;
  workspaceRoot: string;
  draftDocRoot: string;
  comfyuiRoot: string;
  modelRoots: string[];
  autoApproveAgentPermissions: boolean;
};
type PreflightState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; modelsAvailable: number | null }
  | { status: "error"; error: string };

const maxHumanAnswerLength = 20_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isDeletableTask(task: MigrationTask) {
  return ["completed", "failed", "hard_stopped", "terminated", "pending"].includes(task.status);
}

function App() {
  const api = useApi();

  // Core state
  const [steps, setSteps] = useState<MigrationStepDefinition[]>([]);
  const [tasks, setTasks] = useState<MigrationTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>();

  // Secondary state
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | undefined>();
  const [artifactContent, setArtifactContent] = useState("");
  const [decisions, setDecisions] = useState<HumanDecision[]>([]);
  const [progressNarrative, setProgressNarrative] = useState<ProgressNarrative | undefined>();
  const [health, setHealth] = useState<HealthStatus | undefined>();
  const [preflight, setPreflight] = useState<PreflightState>({ status: "idle" });
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [rightTab, setRightTab] = useState<"detail" | "artifacts">("detail");

  // Event stream
  const { activities, pendingQuestions, needsRefresh, needsArtifactRefresh } =
    useEventStream(selectedTaskId);

  // Derived
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId),
    [selectedTaskId, tasks]
  );
  const activeStep = useMemo(
    () => selectedTask?.steps.find((s) => ["running", "waiting_for_human", "failed"].includes(s.status)),
    [selectedTask]
  );
  const selectedStepIdFinal = selectedStepId ?? activeStep?.id ?? "00";
  const selectedStepDef = useMemo(
    () => steps.find((s) => s.id === selectedStepIdFinal),
    [steps, selectedStepIdFinal]
  );
  const selectedStepState = useMemo(
    () => selectedTask?.steps.find((s) => s.id === selectedStepIdFinal),
    [selectedTask, selectedStepIdFinal]
  );
  const stepStats = useMemo(() => {
    const t = selectedTask;
    const total = t?.steps.length ?? 0;
    const completed = t?.steps.filter((s) => s.status === "completed").length ?? 0;
    return { total, completed, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
  }, [selectedTask]);

  // Auto-select running step
  useEffect(() => {
    if (activeStep && !selectedStepId) {
      setSelectedStepId(activeStep.id);
    }
  }, [activeStep?.id]);

  // Initial load
  useEffect(() => {
    void (async () => {
      const [s, t] = await Promise.all([api.fetchSteps(), api.fetchTasks()]);
      setSteps(s);
      setTasks(t);
      setSelectedTaskId(t[0]?.id);
    })();
    void api.fetchHealth().then((h) => { if (h) setHealth(h as HealthStatus); });
  }, []);

  // Refresh on event stream signal
  useEffect(() => {
    if (needsRefresh === 0 || !selectedTaskId) return;
    void (async () => {
      const [s, t] = await Promise.all([api.fetchSteps(), api.fetchTasks()]);
      setSteps(s);
      setTasks(t);
    })();
  }, [needsRefresh]);

  // Artifact refresh
  useEffect(() => {
    if (needsArtifactRefresh === 0 || !selectedTaskId) return;
    void loadTaskData(selectedTaskId);
  }, [needsArtifactRefresh]);

  // Load data when task selected
  useEffect(() => {
    if (!selectedTaskId) return;
    setArtifacts([]);
    setDecisions([]);
    setProgressNarrative(undefined);
    setSelectedArtifact(undefined);
    setArtifactContent("");
    void loadTaskData(selectedTaskId);
  }, [selectedTaskId]);

  async function loadTaskData(taskId: string) {
    const [arts, decs, narr] = await Promise.all([
      api.fetchArtifacts(taskId),
      api.fetchDecisions(taskId),
      api.fetchProgressNarrative(taskId)
    ]);
    setArtifacts(arts);
    setDecisions(decs);
    if (narr) setProgressNarrative(narr);
  }

  // Actions
  async function handleUpload(file: File) {
    try {
      setUploadError(undefined);
      const task = await api.createTask(file);
      setTasks((t) => [task, ...t]);
      setSelectedTaskId(task.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteTask(task: MigrationTask) {
    if (!isDeletableTask(task)) return;
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    try {
      await api.deleteTask(task.id);
      setTasks((t) => t.filter((x) => x.id !== task.id));
      if (selectedTaskId === task.id) setSelectedTaskId(undefined);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function answerQuestion(event: AgentEvent, answer: string, freeform: boolean) {
    if (!selectedTaskId) return;
    await api.answerQuestion(selectedTaskId, event.id, answer, freeform);
  }

  async function openArtifact(relativePath: string) {
    if (!selectedTaskId) return;
    setSelectedArtifact(relativePath);
    const content = await api.fetchArtifactContent(selectedTaskId, relativePath);
    setArtifactContent(content);
    setRightTab("artifacts");
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-left">
          <h1>XPU Migration Agent</h1>
          <span className={`health-dot ${health?.ok ? "ok" : ""}`} title="API health" />
          {stepStats.total > 0 && (
            <span className="step-progress-label">{stepStats.completed}/{stepStats.total} steps ({stepStats.percent}%)</span>
          )}
        </div>
        <div className="header-actions">
          <UploadButton onUpload={handleUpload} error={uploadError} onClearError={() => setUploadError(undefined)} />
          {selectedTask && (
            <>
              <button className="btn btn-primary" onClick={() => void api.runUntilGate(selectedTask.id)} disabled={activeStep?.status === "running"}>
                Run pipeline
              </button>
              <button className="btn btn-danger" onClick={() => void api.hardStop(selectedTask.id)} disabled={activeStep?.status !== "running"}>
                Stop
              </button>
            </>
          )}
        </div>
      </header>

      <Group orientation="horizontal" className="app-body">
        <Panel defaultSize="28%" minSize="250px" maxSize="40%">
          <div className="left-panel">
            <TaskList
              tasks={tasks}
              selectedId={selectedTaskId}
              onSelect={setSelectedTaskId}
              onDelete={handleDeleteTask}
            />
            <PipelineSteps
              steps={steps}
              task={selectedTask}
              selectedStepId={selectedStepIdFinal}
              onSelectStep={setSelectedStepId}
            />
          </div>
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize="72%" minSize="50%">
          <div className="right-panel">
            {/* Human interaction — always visible at top when active */}
            {pendingQuestions.length > 0 && (
              <HumanInteraction
                questions={pendingQuestions}
                drafts={questionDrafts}
                onDraftChange={(eventId, val) => setQuestionDrafts((d) => ({ ...d, [eventId]: val }))}
                onAnswer={answerQuestion}
                onOpenArtifact={openArtifact}
              />
            )}

            {/* Tab bar */}
            <div className="tab-bar">
              <button className={`tab ${rightTab === "detail" ? "active" : ""}`} onClick={() => setRightTab("detail")}>
                Step Detail
              </button>
              <button className={`tab ${rightTab === "artifacts" ? "active" : ""}`} onClick={() => setRightTab("artifacts")}>
                Artifacts
              </button>
              {selectedArtifact && <span className="tab-info">{selectedArtifact.split("/").pop()}</span>}
            </div>

            {rightTab === "detail" ? (
              <StepDetail
                step={selectedStepDef}
                state={selectedStepState}
                activities={activities.get(selectedStepIdFinal) ?? []}
                narrative={progressNarrative}
                taskId={selectedTaskId}
                onRunStep={(stepId) => selectedTaskId && void api.runStep(selectedTaskId, stepId)}
                onResumeStep={(stepId) => selectedTaskId && void api.resumeStep(selectedTaskId, stepId)}
              />
            ) : (
              <ArtifactBrowser
                artifacts={artifacts}
                selectedPath={selectedArtifact}
                content={artifactContent}
                taskId={selectedTaskId}
                onSelect={openArtifact}
              />
            )}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

/* ── Upload Button ── */
function UploadButton({ onUpload, error, onClearError }: {
  onUpload: (f: File) => void;
  error?: string;
  onClearError: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept=".json" hidden onChange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) onUpload(f);
        e.currentTarget.value = "";
      }} />
      <button className="btn" onClick={() => ref.current?.click()}>Upload workflow</button>
      {error && <div className="error-toast"><span>{error}</span><button onClick={onClearError}>x</button></div>}
    </>
  );
}

/* ── Task List ── */
function TaskList({ tasks, selectedId, onSelect, onDelete }: {
  tasks: MigrationTask[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDelete: (task: MigrationTask) => void;
}) {
  return (
    <div className="task-list">
      <h3>Tasks</h3>
      {tasks.length === 0 && <p className="muted">Upload a workflow JSON to create a task.</p>}
      {tasks.map((task) => (
        <div
          key={task.id}
          className={`task-item ${task.id === selectedId ? "selected" : ""} ${task.status}`}
          onClick={() => onSelect(task.id)}
        >
          <div className="task-item-main">
            <StatusBadge status={task.status} />
            <span className="task-name">{task.name}</span>
          </div>
          {isDeletableTask(task) && (
            <button className="btn-icon" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(task); }}>x</button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Pipeline Steps ── */
function PipelineSteps({ steps, task, selectedStepId, onSelectStep }: {
  steps: MigrationStepDefinition[];
  task?: MigrationTask;
  selectedStepId: string;
  onSelectStep: (id: string) => void;
}) {
  return (
    <div className="pipeline-steps">
      <h3>Pipeline</h3>
      <div className="pipeline-list">
        {steps.map((step, i) => {
          const state = task?.steps.find((s) => s.id === step.id);
          const status = state?.status ?? "pending";
          const isSelected = step.id === selectedStepId;
          const isLast = i === steps.length - 1;
          const duration = getStepDuration(state);
          return (
            <div key={step.id}>
              <div
                className={`pipeline-node ${status} ${isSelected ? "selected" : ""}`}
                onClick={() => onSelectStep(step.id)}
              >
                <div className="node-indicator">
                  <StatusBadge status={status} />
                </div>
                <div className="node-content">
                  <span className="node-id">{step.id}</span>
                  <span className="node-name">{step.name}</span>
                  {duration && <span className="node-duration">{duration}</span>}
                </div>
              </div>
              {!isLast && <div className={`pipeline-connector ${status === "completed" ? "done" : ""}`} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getStepDuration(state?: { startedAt?: string; completedAt?: string; status: string }): string | undefined {
  if (!state?.startedAt) return undefined;
  const end = state.completedAt ? new Date(state.completedAt).getTime() : Date.now();
  const start = new Date(state.startedAt).getTime();
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/* ── Step Detail ── */
function StepDetail({ step, state, activities, narrative, taskId, onRunStep, onResumeStep }: {
  step?: MigrationStepDefinition;
  state?: { status: string; summary?: string; error?: string };
  activities: ActivityLine[];
  narrative?: ProgressNarrative;
  taskId?: string;
  onRunStep: (id: string) => void;
  onResumeStep: (id: string) => void;
}) {
  if (!step) return <div className="step-detail"><p className="muted">Select a step.</p></div>;

  return (
    <div className="step-detail">
      <div className="step-detail-header">
        <div>
          <h2>Step {step.id}: {step.name}</h2>
          <p className="muted">{step.requiredOutput}</p>
        </div>
        <div className="step-detail-actions">
          <StatusBadge status={state?.status ?? "pending"} />
          {state?.status !== "running" && (
            <button className="btn" onClick={() => onRunStep(step.id)}>Run</button>
          )}
          {state?.status === "waiting_for_human" && (
            <button className="btn btn-primary" onClick={() => onResumeStep(step.id)}>Resume</button>
          )}
        </div>
      </div>

      {/* Summary / Error */}
      {state?.error && <div className="step-error">{state.error}</div>}
      {state?.summary && (
        <details className="step-summary" open>
          <summary>Step summary</summary>
          <div className="summary-content">{state.summary}</div>
        </details>
      )}

      {/* Agent Activity */}
      <AgentActivity activities={activities} isRunning={state?.status === "running"} />

      {/* Narrative (compact) */}
      {narrative && (
        <div className="narrative-compact">
          <div className="narrative-headline">{narrative.headline}</div>
          <div className="narrative-action">{narrative.currentAction}</div>
        </div>
      )}
    </div>
  );
}

/* ── Agent Activity ── */
function AgentActivity({ activities, isRunning }: { activities: ActivityLine[]; isRunning: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activities.length]);

  if (activities.length === 0 && !isRunning) return null;

  return (
    <div className="agent-activity">
      <div className="activity-header">
        <h3>Agent Activity</h3>
        {isRunning && <span className="activity-pulse" />}
        <span className="muted">{activities.length} entries</span>
      </div>
      <div className="activity-list">
        {activities.length === 0 && isRunning && <p className="muted">Starting...</p>}
        {activities.map((a) => (
          <div key={a.id} className={`activity-line ${a.category}`}>
            <span className="activity-time">{a.timestamp.slice(11, 19)}</span>
            <span className="activity-icon">{a.category === "thinking" ? "◆" : a.category === "tool" ? "▶" : "●"}</span>
            <span className="activity-text">{a.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/* ── Human Interaction ── */
function HumanInteraction({ questions, drafts, onDraftChange, onAnswer, onOpenArtifact }: {
  questions: AgentEvent[];
  drafts: Record<string, string>;
  onDraftChange: (eventId: string, val: string) => void;
  onAnswer: (event: AgentEvent, answer: string, freeform: boolean) => void;
  onOpenArtifact: (path: string) => void;
}) {
  return (
    <div className="human-interaction">
      {questions.map((event) => {
        const question = event.data as HumanQuestion | undefined;
        const artifactPath = isRecord(event.data) ? stringValue(event.data.artifactPath) : undefined;
        const relPath = artifactPath?.includes("artifacts/")
          ? "artifacts/" + artifactPath.split("artifacts/").pop()
          : artifactPath;

        return (
          <div key={event.id} className="question-card">
            <div className="question-header">
              <span className="question-badge">{question?.blockingReason ?? "question"}</span>
              <span className="muted">{event.stepId ? `Step ${event.stepId}` : ""}</span>
            </div>
            <p className="question-text">{question?.question ?? event.message}</p>
            {question?.decisionContext && (
              <details className="question-context">
                <summary>Decision context</summary>
                <p>{question.decisionContext.backgroundReasonScene}</p>
                {question.decisionContext.consequencesAndFollowUp.map((c) => (
                  <div key={c.choice}><strong>{c.choice}:</strong> {c.consequence}</div>
                ))}
              </details>
            )}
            {relPath && (
              <button className="link-btn" onClick={() => onOpenArtifact(relPath)}>
                Open artifact: {relPath.split("/").pop()}
              </button>
            )}
            <div className="question-actions">
              {(question?.choices ?? ["Approve and continue"]).map((choice) => (
                <button key={choice} className="btn btn-primary" onClick={() => onAnswer(event, choice, false)}>
                  {choice}
                </button>
              ))}
              {question?.allowFreeform !== false && (
                <div className="freeform-row">
                  <textarea
                    rows={2}
                    placeholder="Or type a custom answer..."
                    value={drafts[event.id] ?? ""}
                    onChange={(e) => onDraftChange(event.id, e.currentTarget.value)}
                  />
                  <button className="btn" onClick={() => onAnswer(event, drafts[event.id] ?? "", true)}>
                    Send
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Artifact Browser ── */
function ArtifactBrowser({ artifacts, selectedPath, content, taskId, onSelect }: {
  artifacts: ArtifactListItem[];
  selectedPath?: string;
  content: string;
  taskId?: string;
  onSelect: (path: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, ArtifactListItem[]>();
    for (const a of artifacts) {
      const label = artifactGroupLabel(a.relativePath);
      groups.set(label, [...(groups.get(label) ?? []), a]);
    }
    return [...groups.entries()];
  }, [artifacts]);

  return (
    <div className="artifact-browser">
      <div className="artifact-tree">
        {grouped.map(([label, items]) => (
          <div key={label} className="artifact-group">
            <h4>{label}</h4>
            {items.map((a) => (
              <button
                key={a.relativePath}
                className={`artifact-item ${a.relativePath === selectedPath ? "selected" : ""}`}
                onClick={() => onSelect(a.relativePath)}
              >
                <span className="artifact-kind">{a.kind}</span>
                <span>{a.relativePath.split("/").pop()}</span>
              </button>
            ))}
          </div>
        ))}
        {artifacts.length === 0 && <p className="muted">No artifacts yet.</p>}
      </div>
      {selectedPath && (
        <div className="artifact-preview">
          {taskId && (
            <div className="preview-header">
              <span>{selectedPath.split("/").pop()}</span>
              <a href={`/api/tasks/${taskId}/artifacts/raw?path=${encodeURIComponent(selectedPath)}`} target="_blank" rel="noreferrer">
                Open raw
              </a>
            </div>
          )}
          <pre className="preview-content">{content}</pre>
        </div>
      )}
    </div>
  );
}

function artifactGroupLabel(path: string): string {
  const match = /(?:^|\/)(\d{2})[-_]/.exec(path);
  if (match) return `Step ${match[1]}`;
  if (path.includes("/outputs/") || /\.(png|jpe?g|webp|gif|mp4)$/i.test(path)) return "Media";
  if (path.endsWith(".json")) return "JSON";
  return "Other";
}

/* ── Status Badge ── */
function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    pending: { label: "pending", cls: "badge-pending" },
    running: { label: "running", cls: "badge-running" },
    completed: { label: "done", cls: "badge-done" },
    failed: { label: "failed", cls: "badge-failed" },
    hard_stopped: { label: "stopped", cls: "badge-failed" },
    waiting_for_human: { label: "waiting", cls: "badge-waiting" },
    terminated: { label: "ended", cls: "badge-failed" }
  };
  const c = config[status] ?? { label: status, cls: "badge-pending" };
  return <span className={`status-badge ${c.cls}`}>{c.label}</span>;
}

/* ── Error Boundary ── */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <main className="layout">
          <section className="panel fatal-error">
            <h1>Frontend error</h1>
            <pre>{this.state.error.message}</pre>
            <button onClick={() => window.location.reload()}>Reload</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
