import { useCallback } from "react";
import type {
  MigrationStepDefinition,
  MigrationTask,
  ArtifactRecord,
  HumanDecision,
  SubJob,
  ProgressNarrative,
  GpuNodeWriteRequest,
  GpuNodeVerifyResult
} from "../../shared/types";

export type ArtifactListItem = Pick<ArtifactRecord, "relativePath" | "kind" | "path">;

export type UploadMediaResult = {
  uploaded: boolean;
  filename: string;
  originalName: string;
  resolved: boolean;
  remainingGaps: number;
  placedPaths: string[];
};

export function useApi() {
  const fetchSteps = useCallback(async (): Promise<MigrationStepDefinition[]> => {
    const res = await fetch("/api/steps");
    const data = await res.json();
    return data.steps;
  }, []);

  const fetchTasks = useCallback(async (): Promise<MigrationTask[]> => {
    const res = await fetch("/api/tasks");
    const data = await res.json();
    return data.tasks;
  }, []);

  const createTask = useCallback(async (file: File, gpuNode?: string): Promise<MigrationTask> => {
    const workflowJson = JSON.parse(await file.text());
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowFileName: file.name,
        workflowJson,
        ...(gpuNode ? { gpuNode } : {})
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.task;
  }, []);

  const deleteTask = useCallback(async (taskId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const runUntilGate = useCallback(async (taskId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/run-until-gate`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const runStep = useCallback(async (taskId: string, stepId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/steps/${stepId}/run`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const resumeStep = useCallback(async (taskId: string, stepId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/steps/${stepId}/resume`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const rerunStep = useCallback(async (taskId: string, stepId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/steps/${stepId}/rerun`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const hardStop = useCallback(async (taskId: string, stepId?: string, reason = "Stopped via UI"): Promise<void> => {
    // The endpoint requires a `reason` body and targets the given step. Without
    // a body the call 400s and the migration keeps running (holding the run lock).
    const res = await fetch(`/api/tasks/${taskId}/hard-stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, ...(stepId ? { stepId } : {}) }),
    });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const answerQuestion = useCallback(async (
    taskId: string,
    eventId: string,
    answer: string,
    wasFreeform: boolean
  ): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/human-decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionEventId: eventId,
        answer,
        wasFreeform
      })
    });
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const fetchArtifacts = useCallback(async (taskId: string): Promise<ArtifactListItem[]> => {
    const res = await fetch(`/api/tasks/${taskId}/artifacts`);
    const data = await res.json();
    return data.artifacts ?? [];
  }, []);

  const fetchArtifactContent = useCallback(async (taskId: string, relativePath: string): Promise<string> => {
    const res = await fetch(
      `/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(relativePath)}`
    );
    return res.text();
  }, []);

  const fetchDecisions = useCallback(async (taskId: string): Promise<HumanDecision[]> => {
    const res = await fetch(`/api/tasks/${taskId}/human-decisions`);
    const data = await res.json();
    return data.decisions ?? [];
  }, []);

  const fetchSubJobs = useCallback(async (taskId: string): Promise<SubJob[]> => {
    const res = await fetch(`/api/tasks/${taskId}/subjobs`);
    const data = await res.json();
    return data.subJobs ?? [];
  }, []);

  const startSubJob = useCallback(async (taskId: string, subJobId: string): Promise<SubJob> => {
    const res = await fetch(`/api/tasks/${taskId}/subjobs/${encodeURIComponent(subJobId)}/start`, {
      method: "POST"
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.subJob;
  }, []);

  const fetchProgressNarrative = useCallback(async (taskId: string): Promise<ProgressNarrative | undefined> => {
    const res = await fetch(`/api/tasks/${taskId}/progress`);
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.narrative;
  }, []);

  const fetchHealth = useCallback(async () => {
    const res = await fetch("/api/health");
    if (!res.ok) return undefined;
    return res.json();
  }, []);

  const runPreflight = useCallback(async () => {
    const res = await fetch("/api/agent/preflight", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const generateRunReport = useCallback(async (taskId: string) => {
    const res = await fetch(`/api/tasks/${taskId}/run-report`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  // Must match src/server/assetReplacement.ts's MAX_FILE_SIZE_BYTES (4 GB) --
  // checked client-side so an oversized file fails fast instead of uploading
  // for minutes before the server rejects it.
  const MAX_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024 * 1024;

  const uploadMedia = useCallback((
    taskId: string,
    file: File,
    targetFilename?: string,
    onProgress?: (percent: number) => void
  ): Promise<UploadMediaResult> => {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      const maxGb = MAX_UPLOAD_SIZE_BYTES / (1024 * 1024 * 1024);
      return Promise.reject(
        new Error(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB. Maximum: ${maxGb} GB.`)
      );
    }
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file, file.name);
      if (targetFilename) formData.append("targetFilename", targetFilename);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/tasks/${taskId}/upload-media`);
      xhr.upload.onprogress = (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed as UploadMediaResult);
        } else {
          const message =
            parsed && typeof parsed === "object" && "error" in parsed
              ? String((parsed as { error: unknown }).error)
              : xhr.responseText || `Upload failed (${xhr.status})`;
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.send(formData);
    });
  }, []);

  const fetchGateSignal = useCallback(async (taskId: string, stepId: string): Promise<{
    gated?: boolean;
    category?: string;
    reason?: string;
    items?: Array<{ name: string; kind: string; action: string }>;
  } | null> => {
    const res = await fetch(
      `/api/tasks/${taskId}/artifacts/content?path=artifacts/${stepId}-gate-signal.json`
    );
    if (!res.ok) return null;
    try {
      return JSON.parse(await res.text());
    } catch {
      return null;
    }
  }, []);

  const fetchGpuNodes = useCallback(async (): Promise<{
    default: string;
    nodes: Array<{
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
    }>;
  }> => {
    const res = await fetch("/api/gpu-nodes");
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const createGpuNode = useCallback(async (node: GpuNodeWriteRequest): Promise<Awaited<ReturnType<typeof fetchGpuNodes>>> => {
    const res = await fetch("/api/gpu-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(node)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const updateGpuNode = useCallback(async (name: string, node: GpuNodeWriteRequest): Promise<Awaited<ReturnType<typeof fetchGpuNodes>>> => {
    const res = await fetch(`/api/gpu-nodes/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(node)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const deleteGpuNode = useCallback(async (name: string): Promise<Awaited<ReturnType<typeof fetchGpuNodes>>> => {
    const res = await fetch(`/api/gpu-nodes/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const verifyGpuNode = useCallback(async (input: { name?: string; node?: GpuNodeWriteRequest }): Promise<GpuNodeVerifyResult> => {
    const res = await fetch("/api/gpu-nodes/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const syncGpuNodeDockerImage = useCallback(async (name: string): Promise<GpuNodeVerifyResult> => {
    const res = await fetch(`/api/gpu-nodes/${encodeURIComponent(name)}/sync-docker-image`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  return {
    fetchSteps, fetchTasks, createTask, deleteTask,
    runUntilGate, runStep, resumeStep, rerunStep, hardStop,
    answerQuestion, uploadMedia, fetchArtifacts, fetchArtifactContent,
    fetchDecisions, fetchSubJobs, startSubJob, fetchProgressNarrative,
    fetchHealth, runPreflight, generateRunReport, fetchGateSignal, fetchGpuNodes,
    createGpuNode, updateGpuNode, deleteGpuNode, verifyGpuNode, syncGpuNodeDockerImage
  };
}
