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

type GpuNodeInfo = {
  name: string;
  kind: "local" | "ssh";
  vram_gb?: number;
  comfyui_root: string;
  api_host: string;
  api_port: number;
  model_share?: "nfs_same_path" | "none";
};

const maxHumanAnswerLength = 20_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isDeletableTask(task: MigrationTask) {
  return ["completed", "failed", "paused", "hard_stopped", "terminated", "pending"].includes(task.status);
}

/** Lightweight markdown → HTML for chat messages */
function renderMarkdown(md: string): string {
  let html = md
    // Escape HTML (but preserve what we generate below)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>");
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Headers (## and ### only, within message context)
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  // Unordered list items (- or *)
  html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
  // Ordered list items (1. 2. etc)
  html = html.replace(/^(\s*)\d+\. (.+)$/gm, "$1<li>$2</li>");
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, "<ul>$1</ul>");
  // Line breaks (double newline → paragraph, single newline preserved by pre-wrap)
  html = html.replace(/\n\n/g, "</p><p>");
  return `<p>${html}</p>`;
}

function extractMissingFilename(event: AgentEvent): string | undefined {
  const question = event.data as { question?: string } | undefined;
  const text = question?.question ?? event.message ?? "";
  // Match patterns like "z-image_00006_.png (input media)" or "filename.png"
  const match = text.match(/([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)\s*\(/);
  return match?.[1];
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
  const [subJobs, setSubJobs] = useState<SubJob[]>([]);
  const [startingSubJobId, setStartingSubJobId] = useState<string | undefined>();
  const [progressNarrative, setProgressNarrative] = useState<ProgressNarrative | undefined>();
  const [health, setHealth] = useState<HealthStatus | undefined>();
  const [preflight, setPreflight] = useState<PreflightState>({ status: "idle" });
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploadSuccess, setUploadSuccess] = useState<string | undefined>();
  const [uploadProgress, setUploadProgress] = useState<number | undefined>();
  const [gpuNodes, setGpuNodes] = useState<GpuNodeInfo[]>([]);
  const [defaultGpuNode, setDefaultGpuNode] = useState<string | undefined>();
  const [selectedGpuNode, setSelectedGpuNode] = useState<string | undefined>();
  const [nodeManagerOpen, setNodeManagerOpen] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [rightTab, setRightTab] = useState<"detail" | "artifacts" | "subjobs">("detail");

  // Event stream
  const { events, activities, pendingQuestions, needsRefresh, needsArtifactRefresh, connectionState } =
    useEventStream(selectedTaskId);

  // Derived
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId),
    [selectedTaskId, tasks]
  );
  const activeStep = useMemo(
    () => selectedTask?.steps.find((s) => ["running", "waiting_for_human", "paused", "failed"].includes(s.status)),
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
    void api.fetchGpuNodes().then((reg) => {
      const slim = reg.nodes.map((n) => ({
        name: n.name,
        kind: n.kind,
        vram_gb: n.vram_gb,
        comfyui_root: n.comfyui_root,
        api_host: n.api_host,
        api_port: n.api_port,
        model_share: n.model_share
      }));
      setGpuNodes(slim);
      setDefaultGpuNode(reg.default);
      setSelectedGpuNode(reg.default);
    }).catch(() => { /* gpu-nodes.json optional; silent fallback */ });
  }, []);

  const refreshGpuNodes = useCallback(async () => {
    const reg = await api.fetchGpuNodes();
    const slim = reg.nodes.map((n) => ({
      name: n.name,
      kind: n.kind,
      vram_gb: n.vram_gb,
      comfyui_root: n.comfyui_root,
      api_host: n.api_host,
      api_port: n.api_port,
      model_share: n.model_share
    }));
    setGpuNodes(slim);
    setDefaultGpuNode(reg.default);
    setSelectedGpuNode((cur) => cur ?? reg.default);
  }, [api]);

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
    setSubJobs([]);
    setProgressNarrative(undefined);
    setSelectedArtifact(undefined);
    setArtifactContent("");
    void loadTaskData(selectedTaskId);
  }, [selectedTaskId]);

  async function loadTaskData(taskId: string) {
    const [arts, decs, narr, jobs] = await Promise.all([
      api.fetchArtifacts(taskId),
      api.fetchDecisions(taskId),
      api.fetchProgressNarrative(taskId),
      api.fetchSubJobs(taskId)
    ]);
    setArtifacts(arts);
    setDecisions(decs);
    setSubJobs(jobs);
    if (narr) setProgressNarrative(narr);
  }

  // Actions
  async function handleUpload(file: File) {
    try {
      setUploadError(undefined);
      const task = await api.createTask(file, selectedGpuNode);
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

  async function handleStartSubJob(subJobId: string) {
    if (!selectedTaskId) return;
    setStartingSubJobId(subJobId);
    try {
      const updated = await api.startSubJob(selectedTaskId, subJobId);
      setSubJobs((current) => current.map((j) => (j.id === updated.id ? updated : j)));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to start sub-job");
    } finally {
      setStartingSubJobId(undefined);
    }
  }

  async function uploadMedia(taskId: string, file: File) {
    const missingName = pendingQuestions.length > 0
      ? extractMissingFilename(pendingQuestions[0])
      : undefined;
    try {
      setUploadProgress(0);
      const result = await api.uploadMedia(taskId, file, missingName, setUploadProgress);
      setUploadProgress(undefined);
      setUploadError(undefined);

      if (result.resolved) {
        setUploadSuccess(`File "${result.filename}" uploaded and all gaps resolved. Continuing pipeline...`);
        if (pendingQuestions.length > 0) {
          const event = pendingQuestions[0];
          // Use a predefined choice (wasFreeform=false) so the orchestrator
          // hits isContinueDecision() instead of isActionableGateContext()
          await api.answerQuestion(
            taskId,
            event.id,
            "Continue with documented risk/gaps",
            false
          );
        }
      } else {
        setUploadSuccess(`File "${result.filename}" uploaded. ${result.remainingGaps} item(s) still need resolution.`);
      }
      // Auto-clear success message after 8 seconds
      setTimeout(() => setUploadSuccess(undefined), 8000);
    } catch (err) {
      setUploadProgress(undefined);
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
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
          {selectedTaskId && (
            <span
              className={`health-dot ${connectionState === "connected" ? "ok" : "reconnecting"}`}
              title={connectionState === "connected" ? "Live updates connected" : "Reconnecting to live updates…"}
            />
          )}
          {selectedTaskId && connectionState === "reconnecting" && (
            <span className="step-progress-label reconnecting-label">Reconnecting…</span>
          )}
          {stepStats.total > 0 && (
            <span className="step-progress-label">{stepStats.completed}/{stepStats.total} steps ({stepStats.percent}%)</span>
          )}
        </div>
        <div className="header-actions">
          {gpuNodes.length > 0 && (
            <>
              <select
                className="gpu-node-select"
                title="Target GPU node for the next uploaded workflow"
                value={selectedGpuNode ?? defaultGpuNode ?? ""}
                onChange={(e) => setSelectedGpuNode(e.currentTarget.value)}
              >
                {gpuNodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name} ({n.vram_gb ?? "?"} GB, {n.kind})
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                title="Add, edit, test, or delete GPU nodes"
                onClick={() => setNodeManagerOpen(true)}
              >
                Manage
              </button>
            </>
          )}
          <UploadButton onUpload={handleUpload} error={uploadError} success={uploadSuccess} onClearError={() => setUploadError(undefined)} onClearSuccess={() => setUploadSuccess(undefined)} />
          {selectedTask && (
            <>
              <button className="btn btn-primary" onClick={() => void api.runUntilGate(selectedTask.id)} disabled={activeStep?.status === "running"}>
                Run pipeline
              </button>
              <button className="btn btn-danger" onClick={() => void api.hardStop(selectedTask.id, activeStep?.id)} disabled={activeStep?.status !== "running"}>
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
                onDraftChange={(key, val) => setQuestionDrafts((d) => ({ ...d, [key]: val }))}
                onAnswer={answerQuestion}
                onOpenArtifact={openArtifact}
                onUploadMedia={uploadMedia}
                uploadProgress={uploadProgress}
                decisions={decisions}
                allEvents={events}
                taskId={selectedTaskId}
                api={api}
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
              <button className={`tab ${rightTab === "subjobs" ? "active" : ""}`} onClick={() => setRightTab("subjobs")}>
                Sub-jobs{subJobs.length > 0 ? ` (${subJobs.length})` : ""}
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
                onRerunStep={(stepId) => selectedTaskId && void api.rerunStep(selectedTaskId, stepId)}
              />
            ) : rightTab === "artifacts" ? (
              <ArtifactBrowser
                artifacts={artifacts}
                selectedPath={selectedArtifact}
                content={artifactContent}
                taskId={selectedTaskId}
                onSelect={openArtifact}
              />
            ) : (
              <SubJobList
                subJobs={subJobs}
                startingSubJobId={startingSubJobId}
                onStart={handleStartSubJob}
              />
            )}
          </div>
        </Panel>
      </Group>
      {nodeManagerOpen && (
        <GpuNodeManager
          api={api}
          onClose={() => setNodeManagerOpen(false)}
          onChanged={() => void refreshGpuNodes()}
        />
      )}
    </div>
  );
}

/* ── Upload Button ── */
function UploadButton({ onUpload, error, success, onClearError, onClearSuccess }: {
  onUpload: (f: File) => void;
  error?: string;
  success?: string;
  onClearError: () => void;
  onClearSuccess: () => void;
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
      {success && <div className="success-toast"><span>{success}</span><button onClick={onClearSuccess}>x</button></div>}
    </>
  );
}

/* ── GPU Node Manager (CRUD + verify) ── */
type GpuNodeManagerNode = {
  name: string;
  kind: "local" | "ssh";
  vram_gb?: number;
  comfyui_root: string;
  venv_python: string;
  model_roots: string[];
  api_host: string;
  api_port: number;
  launch_flags?: string[];
  ssh?: { host: string; user: string; port?: number; key_configured: boolean; remote_workspace_root?: string };
  model_share?: "nfs_same_path" | "none";
};

type GpuNodeFormState = {
  name: string;
  kind: "local" | "ssh";
  vram_gb: string;
  comfyui_root: string;
  venv_python: string;
  model_roots: string;        // comma-separated
  api_host: string;
  api_port: string;
  launch_flags: string;       // comma-separated
  ssh_host: string;
  ssh_user: string;
  ssh_port: string;
  ssh_key_path: string;
  ssh_remote_workspace_root: string;
  model_share: "nfs_same_path" | "none";
};

const EMPTY_FORM: GpuNodeFormState = {
  name: "",
  kind: "local",
  vram_gb: "",
  comfyui_root: "",
  venv_python: "",
  model_roots: "/home/intel/hf_models",
  api_host: "127.0.0.1",
  api_port: "8188",
  launch_flags: "--reserve-vram 1",
  ssh_host: "",
  ssh_user: "",
  ssh_port: "22",
  ssh_key_path: "",
  ssh_remote_workspace_root: "",
  model_share: "nfs_same_path"
};

function formFromNode(n: GpuNodeManagerNode): GpuNodeFormState {
  return {
    name: n.name,
    kind: n.kind,
    vram_gb: n.vram_gb !== undefined ? String(n.vram_gb) : "",
    comfyui_root: n.comfyui_root,
    venv_python: n.venv_python,
    model_roots: n.model_roots.join(","),
    api_host: n.api_host,
    api_port: String(n.api_port),
    launch_flags: n.launch_flags?.join(" ") ?? "",
    ssh_host: n.ssh?.host ?? "",
    ssh_user: n.ssh?.user ?? "",
    ssh_port: n.ssh?.port !== undefined ? String(n.ssh.port) : "22",
    ssh_key_path: "", // never echoed back from server
    ssh_remote_workspace_root: n.ssh?.remote_workspace_root ?? "",
    model_share: n.model_share ?? "nfs_same_path"
  };
}

function GpuNodeManager({ api, onClose, onChanged }: {
  api: ReturnType<typeof useApi>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [nodes, setNodes] = useState<GpuNodeManagerNode[]>([]);
  const [defaultName, setDefaultName] = useState<string>("");
  const [editing, setEditing] = useState<GpuNodeFormState | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [verifyResults, setVerifyResults] = useState<Record<string, { ok: boolean; detail: string } | "pending">>({});

  const reload = useCallback(async () => {
    const reg = await api.fetchGpuNodes();
    setNodes(reg.nodes as GpuNodeManagerNode[]);
    setDefaultName(reg.default);
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleSave(form: GpuNodeFormState, originalName: string | null): Promise<void> {
    setError(undefined);
    const model_roots = form.model_roots.split(",").map((s) => s.trim()).filter(Boolean);
    const launch_flags = form.launch_flags.trim().length ? form.launch_flags.trim().split(/\s+/) : undefined;
    const vram_gb = form.vram_gb.trim() ? Number(form.vram_gb) : undefined;
    const api_port = Number(form.api_port) || 8188;
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      ...(vram_gb !== undefined ? { vram_gb } : {}),
      comfyui_root: form.comfyui_root.trim(),
      venv_python: form.venv_python.trim(),
      model_roots,
      api_host: form.api_host.trim(),
      api_port,
      ...(launch_flags ? { launch_flags } : {}),
      ...(form.kind === "ssh" ? {
        ssh: {
          host: form.ssh_host.trim(),
          user: form.ssh_user.trim(),
          port: Number(form.ssh_port) || 22,
          ...(form.ssh_key_path.trim() ? { key_path: form.ssh_key_path.trim() } : {}),
          ...(form.ssh_remote_workspace_root.trim() ? { remote_workspace_root: form.ssh_remote_workspace_root.trim() } : {})
        }
      } : {}),
      model_share: form.model_share
    };
    try {
      if (originalName && originalName !== form.name.trim()) {
        await api.updateGpuNode(originalName, body);
      } else if (originalName) {
        await api.updateGpuNode(originalName, body);
      } else {
        await api.createGpuNode(body);
      }
      await reload();
      onChanged();
      setEditing(null);
      setEditingOriginalName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(name: string): Promise<void> {
    if (!window.confirm(`Delete GPU node "${name}"? This cannot be undone.`)) return;
    setError(undefined);
    try {
      await api.deleteGpuNode(name);
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleVerify(name: string): Promise<void> {
    setVerifyResults((cur) => ({ ...cur, [name]: "pending" }));
    try {
      const result = await api.verifyGpuNode({ name });
      setVerifyResults((cur) => ({ ...cur, [name]: result }));
    } catch (err) {
      setVerifyResults((cur) => ({
        ...cur,
        [name]: { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }));
    }
  }

  async function handleVerifyForm(form: GpuNodeFormState): Promise<void> {
    // Verify-before-save: serialize the form the same way handleSave does.
    const model_roots = form.model_roots.split(",").map((s) => s.trim()).filter(Boolean);
    const node = {
      name: form.name.trim() || "(unsaved)",
      kind: form.kind,
      ...(form.vram_gb.trim() ? { vram_gb: Number(form.vram_gb) } : {}),
      comfyui_root: form.comfyui_root.trim(),
      venv_python: form.venv_python.trim(),
      model_roots,
      api_host: form.api_host.trim(),
      api_port: Number(form.api_port) || 8188,
      ...(form.kind === "ssh" ? {
        ssh: {
          host: form.ssh_host.trim(),
          user: form.ssh_user.trim(),
          port: Number(form.ssh_port) || 22,
          ...(form.ssh_key_path.trim() ? { key_path: form.ssh_key_path.trim() } : {})
        }
      } : {})
    };
    setVerifyResults((cur) => ({ ...cur, [`${form.name}-form`]: "pending" }));
    try {
      const result = await api.verifyGpuNode({ node });
      setVerifyResults((cur) => ({ ...cur, [`${form.name}-form`]: result }));
    } catch (err) {
      setVerifyResults((cur) => ({
        ...cur,
        [`${form.name}-form`]: { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }));
    }
  }

  return (
    <div className="gpu-node-manager-overlay" onClick={onClose}>
      <div className="gpu-node-manager" onClick={(e) => e.stopPropagation()}>
        <div className="gpu-node-manager-header">
          <h2>Manage GPU Nodes</h2>
          <button className="link-btn" onClick={onClose}>✕ Close</button>
        </div>
        {error && <div className="error-toast"><span>{error}</span><button onClick={() => setError(undefined)}>x</button></div>}
        {editing ? (
          <GpuNodeForm
            initial={editing}
            onCancel={() => { setEditing(null); setEditingOriginalName(null); }}
            onSave={(form) => void handleSave(form, editingOriginalName)}
            onVerify={(form) => void handleVerifyForm(form)}
            verifyResult={editing.name ? verifyResults[`${editing.name}-form`] : undefined}
          />
        ) : (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setEditing(EMPTY_FORM); setEditingOriginalName(null); }}
            >
              + Add new node
            </button>
            <div className="gpu-node-list">
              {nodes.length === 0 && <p className="muted">No nodes registered.</p>}
              {nodes.map((n) => {
                const vr = verifyResults[n.name];
                return (
                  <div key={n.name} className={`gpu-node-card ${n.kind}`}>
                    <div className="gpu-node-card-header">
                      <strong>{n.name}</strong>
                      {n.name === defaultName && <span className="tag">default</span>}
                      <span className="muted">{n.kind} · {n.vram_gb ?? "?"} GB · {n.api_host}:{n.api_port}</span>
                    </div>
                    <div className="gpu-node-card-path">{n.comfyui_root}</div>
                    {n.ssh && (
                      <div className="gpu-node-card-path muted">ssh: {n.ssh.user}@{n.ssh.host}:{n.ssh.port ?? 22} (key {n.ssh.key_configured ? "set" : "unset"})</div>
                    )}
                    {n.model_share && <div className="muted">model_share: {n.model_share}</div>}
                    {vr && vr !== "pending" && (
                      <div className={`gpu-node-verify ${vr.ok ? "ok" : "fail"}`}>
                        {vr.ok ? "✓ " : "✗ "}{vr.detail}
                      </div>
                    )}
                    {vr === "pending" && <div className="muted">Verifying…</div>}
                    <div className="gpu-node-card-actions">
                      <button className="btn btn-sm" onClick={() => void handleVerify(n.name)} disabled={vr === "pending"}>Test</button>
                      <button className="btn btn-sm" onClick={() => { setEditing(formFromNode(n)); setEditingOriginalName(n.name); }}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => void handleDelete(n.name)}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="muted gpu-node-tip">
              Tip: for full remote provisioning (ComfyUI install, SSH key, NFS), run
              <code> npx tsx scripts/bootstrap-gpu-node.mts --help </code>
              from the project root — it registers nodes here automatically.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function GpuNodeForm({ initial, onCancel, onSave, onVerify, verifyResult }: {
  initial: GpuNodeFormState;
  onCancel: () => void;
  onSave: (form: GpuNodeFormState) => void;
  onVerify: (form: GpuNodeFormState) => void;
  verifyResult?: { ok: boolean; detail: string } | "pending";
}) {
  const [form, setForm] = useState<GpuNodeFormState>(initial);
  const set = <K extends keyof GpuNodeFormState>(key: K, value: GpuNodeFormState[K]) =>
    setForm((cur) => ({ ...cur, [key]: value }));

  return (
    <div className="gpu-node-form">
      <h3>{initial.name ? "Edit node" : "Add node"}</h3>
      <div className="gpu-node-form-grid">
        <label>name<input type="text" value={form.name} onChange={(e) => set("name", e.currentTarget.value)} /></label>
        <label>kind
          <select value={form.kind} onChange={(e) => set("kind", e.currentTarget.value as "local" | "ssh")}>
            <option value="local">local</option>
            <option value="ssh">ssh</option>
          </select>
        </label>
        <label>vram_gb (optional)<input type="number" step="0.1" value={form.vram_gb} onChange={(e) => set("vram_gb", e.currentTarget.value)} /></label>
        <label>comfyui_root<input type="text" value={form.comfyui_root} onChange={(e) => set("comfyui_root", e.currentTarget.value)} /></label>
        <label>venv_python<input type="text" value={form.venv_python} onChange={(e) => set("venv_python", e.currentTarget.value)} /></label>
        <label>model_roots (comma-separated)<input type="text" value={form.model_roots} onChange={(e) => set("model_roots", e.currentTarget.value)} /></label>
        <label>api_host<input type="text" value={form.api_host} onChange={(e) => set("api_host", e.currentTarget.value)} /></label>
        <label>api_port<input type="number" value={form.api_port} onChange={(e) => set("api_port", e.currentTarget.value)} /></label>
        <label>launch_flags (space-separated)<input type="text" value={form.launch_flags} onChange={(e) => set("launch_flags", e.currentTarget.value)} /></label>
        <label>model_share
          <select value={form.model_share} onChange={(e) => set("model_share", e.currentTarget.value as "nfs_same_path" | "none")}>
            <option value="nfs_same_path">nfs_same_path</option>
            <option value="none">none</option>
          </select>
        </label>
        {form.kind === "ssh" && (
          <>
            <label>ssh.host<input type="text" value={form.ssh_host} onChange={(e) => set("ssh_host", e.currentTarget.value)} /></label>
            <label>ssh.user<input type="text" value={form.ssh_user} onChange={(e) => set("ssh_user", e.currentTarget.value)} /></label>
            <label>ssh.port<input type="number" value={form.ssh_port} onChange={(e) => set("ssh_port", e.currentTarget.value)} /></label>
            <label>ssh.key_path (server-side path; never echoed back)<input type="text" value={form.ssh_key_path} onChange={(e) => set("ssh_key_path", e.currentTarget.value)} /></label>
            <label>ssh.remote_workspace_root (optional)<input type="text" value={form.ssh_remote_workspace_root} onChange={(e) => set("ssh_remote_workspace_root", e.currentTarget.value)} /></label>
          </>
        )}
      </div>
      {verifyResult && verifyResult !== "pending" && (
        <div className={`gpu-node-verify ${verifyResult.ok ? "ok" : "fail"}`}>
          {verifyResult.ok ? "✓ " : "✗ "}{verifyResult.detail}
        </div>
      )}
      <div className="gpu-node-form-actions">
        <button className="btn btn-sm" onClick={() => onVerify(form)} disabled={verifyResult === "pending"}>Test (without saving)</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" onClick={() => onSave(form)} disabled={!form.name.trim() || !form.comfyui_root.trim() || !form.venv_python.trim()}>Save</button>
      </div>
    </div>
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
function StepDetail({ step, state, activities, narrative, taskId, onRunStep, onResumeStep, onRerunStep }: {
  step?: MigrationStepDefinition;
  state?: { status: string; summary?: string; error?: string };
  activities: ActivityLine[];
  narrative?: ProgressNarrative;
  taskId?: string;
  onRunStep: (id: string) => void;
  onResumeStep: (id: string) => void;
  onRerunStep: (id: string) => void;
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
          {state?.status === "pending" && (
            <button className="btn" onClick={() => onRunStep(step.id)}>Run</button>
          )}
          {state?.status === "waiting_for_human" && (
            <button className="btn btn-primary" onClick={() => onResumeStep(step.id)}>Resume</button>
          )}
          {state?.status === "paused" && (
            <>
              <button className="btn btn-primary" onClick={() => onResumeStep(step.id)}>Resume</button>
              <button className="btn" onClick={() => onRerunStep(step.id)}>Re-run</button>
            </>
          )}
          {["completed", "failed", "hard_stopped"].includes(state?.status ?? "") && (
            <button className="btn" onClick={() => onRerunStep(step.id)}>Re-run</button>
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

/* ── Asset Upload Panel (for missing_asset gates) ── */
type GateSignalItem = { name: string; kind: string; action: string };
type ItemStatus = "pending" | "uploading" | "resolved" | "failed";

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || norm;
}

function matchFileToItem(file: File, items: GateSignalItem[]): GateSignalItem | undefined {
  const fileBase = file.name.toLowerCase();
  // 1. Exact basename match
  const exact = items.find((it) => basename(it.name).toLowerCase() === fileBase);
  if (exact) return exact;
  // 2. Item basename contained in filename (handles prefixes/suffixes)
  return items.find((it) => fileBase.includes(basename(it.name).toLowerCase()));
}

function AssetUploadPanel({ event, taskId, api, onAnswer, onResolved }: {
  event: AgentEvent;
  taskId: string;
  api: ReturnType<typeof useApi>;
  onAnswer: (event: AgentEvent, answer: string, freeform: boolean) => void;
  onResolved?: () => void;
}) {
  const stepId = event.stepId ?? "01";
  const [items, setItems] = useState<GateSignalItem[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, ItemStatus>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [unmatched, setUnmatched] = useState<Array<{ file: File; targetItem?: GateSignalItem }>>([]);
  const [bulkMsg, setBulkMsg] = useState<string>("");
  const multiInputRef = useRef<HTMLInputElement>(null);
  const perItemInputRef = useRef<HTMLInputElement>(null);
  const [perItemTarget, setPerItemTarget] = useState<string>("");

  // Fetch gate signal items on mount
  const refreshItems = useCallback(async () => {
    const signal = await api.fetchGateSignal(taskId, stepId);
    if (signal?.items) {
      setItems(signal.items);
      setStatusMap((prev) => {
        const next: Record<string, ItemStatus> = {};
        for (const it of signal.items!) {
          next[it.name] = prev[it.name] ?? "pending";
        }
        return next;
      });
    }
    return signal;
  }, [api, taskId, stepId]);

  useEffect(() => {
    void refreshItems();
  }, [refreshItems]);

  const resolvedCount = Object.values(statusMap).filter((s) => s === "resolved").length;
  const totalCount = items.length || Object.keys(statusMap).length;
  const allResolved = totalCount > 0 && resolvedCount === totalCount;

  // Auto-advance when all resolved
  useEffect(() => {
    if (!allResolved) return;
    const choices = (event.data as any)?.choices as string[] | undefined;
    const continueChoice = choices?.find((c) => /continue/i.test(c));
    if (continueChoice) {
      onAnswer(event, continueChoice, false);
    }
    onResolved?.();
  }, [allResolved, event, onAnswer, onResolved]);

  async function uploadOne(file: File, targetName: string): Promise<boolean> {
    setStatusMap((m) => ({ ...m, [targetName]: "uploading" }));
    setErrorMap((m) => ({ ...m, [targetName]: "" }));
    setProgressMap((m) => ({ ...m, [targetName]: 0 }));
    try {
      const result = await api.uploadMedia(taskId, file, targetName, (percent) =>
        setProgressMap((m) => ({ ...m, [targetName]: percent }))
      );
      if (result.uploaded) {
        setStatusMap((m) => ({ ...m, [targetName]: "resolved" }));
        // Refresh gate signal to sync with backend state
        await refreshItems();
        return true;
      }
      setStatusMap((m) => ({ ...m, [targetName]: "failed" }));
      setErrorMap((m) => ({ ...m, [targetName]: "Upload returned not-resolved" }));
      return false;
    } catch (err) {
      setStatusMap((m) => ({ ...m, [targetName]: "failed" }));
      setErrorMap((m) => ({ ...m, [targetName]: err instanceof Error ? err.message : String(err) }));
      return false;
    } finally {
      setProgressMap((m) => {
        const next = { ...m };
        delete next[targetName];
        return next;
      });
    }
  }

  // Per-item upload via dedicated button
  function handlePerItemClick(itemName: string) {
    setPerItemTarget(itemName);
    perItemInputRef.current?.click();
  }

  async function handlePerItemFile(file: File | undefined) {
    if (!file || !perItemTarget) return;
    await uploadOne(file, perItemTarget);
    setPerItemTarget("");
  }

  // Multi-file upload with smart matching
  async function handleMultiFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    const pendingItems = items.filter((it) => statusMap[it.name] !== "resolved");
    const matched: Array<{ file: File; item: GateSignalItem }> = [];
    const unmatchedFiles: File[] = [];

    for (const file of fileArr) {
      const item = matchFileToItem(file, pendingItems);
      if (item) {
        matched.push({ file, item });
      } else {
        unmatchedFiles.push(file);
      }
    }

    setUnmatched(unmatchedFiles.map((f) => ({ file: f })));
    setBulkMsg("");

    // Upload matched files sequentially (avoids race on CSV writes)
    let okCount = 0;
    for (const { file, item } of matched) {
      const ok = await uploadOne(file, item.name);
      if (ok) okCount++;
    }

    const skipCount = fileArr.length - matched.length - unmatchedFiles.length;
    const parts: string[] = [];
    if (okCount > 0) parts.push(`${okCount} uploaded`);
    if (skipCount > 0) parts.push(`${skipCount} already resolved`);
    if (unmatchedFiles.length > 0) parts.push(`${unmatchedFiles.length} unmatched`);
    setBulkMsg(parts.join(" · ") || "No action");
  }

  // Assign an unmatched file to a specific item
  async function assignUnmatched(file: File, itemName: string) {
    setUnmatched((prev) => prev.filter((u) => u.file !== file));
    await uploadOne(file, itemName);
  }

  return (
    <div className="asset-upload-panel">
      <div className="asset-upload-header">
        <span className="asset-upload-badge">📁 Missing Assets</span>
        <span className="muted">{totalCount > 0 ? `${resolvedCount}/${totalCount} resolved` : "loading…"}</span>
      </div>

      {/* Per-item rows */}
      <div className="asset-item-list">
        {items.map((item) => {
          const status = statusMap[item.name] ?? "pending";
          return (
            <div key={item.name} className={`asset-item-row ${status}`}>
              <span className="asset-item-status-icon">
                {status === "resolved" ? "✅" : status === "uploading" ? "⏳" : status === "failed" ? "❌" : "⬜"}
              </span>
              <div className="asset-item-info">
                <span className="asset-item-name">{basename(item.name)}</span>
                <span className="asset-item-kind">
                  {status === "uploading" && progressMap[item.name] !== undefined
                    ? `uploading… ${progressMap[item.name]}%`
                    : item.kind}
                </span>
              </div>
              {status !== "resolved" && status !== "uploading" && (
                <button className="btn btn-sm" onClick={() => handlePerItemClick(item.name)}>
                  Upload
                </button>
              )}
              {errorMap[item.name] && (
                <span className="asset-item-error">{errorMap[item.name]}</span>
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="muted asset-empty">No gate signal items found. You can still use the choices below.</p>
        )}
      </div>

      {/* Multi-file drop zone */}
      <input
        ref={multiInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void handleMultiFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={perItemInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          void handlePerItemFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="asset-drop-zone" onClick={() => multiInputRef.current?.click()}>
        <span className="asset-drop-icon">📎</span>
        <span>Drop files or click to select <strong>(multiple supported)</strong></span>
      </div>

      {bulkMsg && <div className="asset-bulk-msg">{bulkMsg}</div>}

      {/* Unmatched files needing manual assignment */}
      {unmatched.length > 0 && (
        <div className="asset-unmatched">
          <p className="asset-unmatched-title">Unmatched files — pick target asset:</p>
          {unmatched.map((u, i) => (
            <div key={i} className="asset-unmatched-row">
              <span className="asset-unmatched-name">{u.file.name}</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void assignUnmatched(u.file, e.target.value);
                }}
              >
                <option value="" disabled>Select asset…</option>
                {items.filter((it) => statusMap[it.name] !== "resolved").map((it) => (
                  <option key={it.name} value={it.name}>{basename(it.name)}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* Choice buttons (fallback / partial-upload continue) */}
      <div className="asset-choices">
        {((event.data as any)?.choices ?? []).map((choice: string) => (
          <button
            key={choice}
            className={`btn ${/continue|approve/i.test(choice) ? "btn-primary" : ""}`}
            onClick={() => onAnswer(event, choice, false)}
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Human Interaction ── */
function HumanInteraction({ questions, drafts, onDraftChange, onAnswer, onOpenArtifact, onUploadMedia, uploadProgress, decisions, allEvents, taskId, api }: {
  questions: AgentEvent[];
  drafts: Record<string, string>;
  onDraftChange: (eventId: string, val: string) => void;
  onAnswer: (event: AgentEvent, answer: string, freeform: boolean) => void;
  onOpenArtifact: (path: string) => void;
  onUploadMedia: (taskId: string, file: File) => void;
  uploadProgress?: number;
  decisions: HumanDecision[];
  allEvents: AgentEvent[];
  taskId?: string;
  api: ReturnType<typeof useApi>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadEventId, setUploadEventId] = useState<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const handleFileSelect = (eventId: string) => {
    setUploadEventId(eventId);
    fileInputRef.current?.click();
  };

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [questions, decisions]);

  return (
    <div className="human-interaction">
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && uploadEventId) {
            const event = questions.find((q) => q.id === uploadEventId);
            if (event) onUploadMedia(event.taskId ?? "", file);
          }
          e.target.value = "";
        }}
      />
      {questions.map((event) => {
        const question = event.data as HumanQuestion | undefined;
        const isSdkChat = !question?.choices?.length || (question?.choices?.length === 0 && question?.allowFreeform !== false);
        const hasMissingMedia = question?.blockingReason === "missing_asset";
        const stepId = event.stepId ?? "?";

        // Dedicated multi-file upload panel for missing_asset gates
        if (hasMissingMedia && taskId) {
          return (
            <AssetUploadPanel
              key={event.id}
              event={event}
              taskId={taskId}
              api={api}
              onAnswer={onAnswer}
            />
          );
        }

        if (isSdkChat) {
          // Chat-style interaction for SDK agent questions
          // Key by stepId so component persists across multi-round questions
          // Draft also keyed by stepId to survive question ID changes
          const chatDraftKey = `chat-${stepId}`;
          return (
            <InteractiveChat
              key={chatDraftKey}
              event={event}
              stepId={stepId}
              decisions={decisions}
              allEvents={allEvents}
              draft={drafts[chatDraftKey] ?? ""}
              onDraftChange={(val) => onDraftChange(chatDraftKey, val)}
              onAnswer={(answer) => onAnswer(event, answer, true)}
              onUploadMedia={() => handleFileSelect(event.id)}
              uploadProgress={uploadProgress}
              hasMissingMedia={hasMissingMedia}
              chatEndRef={chatEndRef}
            />
          );
        }

        // Original card-style for deterministic gate questions
        const artifactPath = isRecord(event.data) ? stringValue(event.data.artifactPath) : undefined;
        const relPath = artifactPath?.includes("artifacts/")
          ? "artifacts/" + artifactPath.split("artifacts/").pop()
          : artifactPath;

        return (
          <div key={event.id} className="question-card">
            <div className="question-header">
              <span className="question-badge">{question?.blockingReason ?? "question"}</span>
              <span className="muted">{stepId ? `Step ${stepId}` : ""}</span>
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
              {hasMissingMedia && (
                <button className="btn" onClick={() => handleFileSelect(event.id)}>
                  Upload missing file
                </button>
              )}
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

/* ── Interactive Chat for SDK agent questions ── */
function InteractiveChat({ event, stepId, decisions, allEvents, draft, onDraftChange, onAnswer, onUploadMedia, uploadProgress, hasMissingMedia, chatEndRef }: {
  event: AgentEvent;
  stepId: string;
  decisions: HumanDecision[];
  allEvents: AgentEvent[];
  draft: string;
  onDraftChange: (val: string) => void;
  onAnswer: (answer: string) => void;
  onUploadMedia: () => void;
  uploadProgress?: number;
  hasMissingMedia: boolean;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Build multi-round conversation history from all questions + decisions for this step
  const messages = useMemo(() => {
    const msgs: Array<{ role: "agent" | "human"; text: string; time: string }> = [];

    // Collect all human_question events for this step, sorted chronologically
    const stepQuestions = allEvents
      .filter((e) => e.type === "human_question" && e.stepId === stepId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Collect all decisions for this step
    const stepDecisions = decisions
      .filter((d) => d.stepId === stepId)
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));

    // Interleave questions and decisions chronologically
    const allItems: Array<{ type: "q" | "d"; time: string; text: string }> = [];
    for (const q of stepQuestions) {
      const qData = q.data as HumanQuestion | undefined;
      allItems.push({ type: "q", time: q.createdAt, text: qData?.question ?? q.message });
    }
    for (const d of stepDecisions) {
      allItems.push({ type: "d", time: d.decidedAt, text: d.answer });
    }
    allItems.sort((a, b) => a.time.localeCompare(b.time));

    for (const item of allItems) {
      msgs.push({
        role: item.type === "q" ? "agent" : "human",
        text: item.text,
        time: item.time
      });
    }
    return msgs;
  }, [allEvents, decisions, stepId]);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus input when component mounts or new agent message arrives
  useEffect(() => {
    // Small delay to ensure DOM is updated after render
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [messages.length]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    onAnswer(text);
    onDraftChange("");
    // Keep focus on input after sending
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span className="chat-badge">Interactive Review</span>
        <span className="muted">Step {stepId}</span>
      </div>
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg ${msg.role}`}>
            <div className="chat-msg-role">{msg.role === "agent" ? "Agent" : "You"}</div>
            <div className="chat-msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
            <div className="chat-msg-time">{msg.time.slice(11, 19)}</div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-input-area">
        {hasMissingMedia && (
          <button
            className="btn chat-action-btn"
            onClick={onUploadMedia}
            disabled={uploadProgress !== undefined}
            title="Upload file"
          >
            {uploadProgress !== undefined ? `Uploading… ${uploadProgress}%` : "Attach"}
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={2}
          className="chat-input"
          placeholder="Type your response... (Enter to send, Shift+Enter for new line)"
          value={draft}
          onChange={(e) => onDraftChange(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="btn btn-primary chat-send-btn" onClick={handleSend} disabled={!draft.trim()}>
          Send
        </button>
      </div>
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

function SubJobList({ subJobs, startingSubJobId, onStart }: {
  subJobs: SubJob[];
  startingSubJobId?: string;
  onStart: (subJobId: string) => void;
}) {
  if (subJobs.length === 0) {
    return <p className="muted subjob-empty">No sub-jobs for this task.</p>;
  }
  return (
    <div className="subjob-list">
      {subJobs.map((job) => (
        <div key={job.id} className={`subjob-row subjob-${job.status}`}>
          <div className="subjob-info">
            <span className="subjob-title">{job.title}</span>
            <span className="subjob-meta">
              {job.stepId ? `step ${job.stepId} · ` : ""}
              {job.type}
              {job.candidateCount !== undefined ? ` · ${job.candidateCount} candidate(s)` : ""}
            </span>
            {job.message && <span className="subjob-message">{job.message}</span>}
            {job.progress?.percent !== undefined && (
              <span className="subjob-message">{job.progress.percent}% downloaded</span>
            )}
            {job.error && <span className="subjob-error">{job.error}</span>}
          </div>
          <span className={`subjob-status-badge subjob-status-${job.status}`}>{job.status}</span>
          {job.canStart && (
            <button
              className="btn btn-sm"
              disabled={startingSubJobId === job.id}
              onClick={() => onStart(job.id)}
            >
              {startingSubJobId === job.id ? "Starting…" : "Start"}
            </button>
          )}
        </div>
      ))}
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
    paused: { label: "paused", cls: "badge-waiting" },
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
