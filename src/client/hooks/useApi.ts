import { useCallback } from "react";
import type {
  MigrationStepDefinition,
  MigrationTask,
  ArtifactRecord,
  HumanDecision,
  SubJob,
  ProgressNarrative
} from "../../shared/types";

export type ArtifactListItem = Pick<ArtifactRecord, "relativePath" | "kind" | "path">;

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

  const createTask = useCallback(async (file: File): Promise<MigrationTask> => {
    const form = new FormData();
    form.append("workflowJson", file);
    form.append("workflowFileName", file.name);
    const res = await fetch("/api/tasks", { method: "POST", body: form });
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

  const hardStop = useCallback(async (taskId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${taskId}/hard-stop`, { method: "POST" });
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

  return {
    fetchSteps, fetchTasks, createTask, deleteTask,
    runUntilGate, runStep, resumeStep, hardStop,
    answerQuestion, fetchArtifacts, fetchArtifactContent,
    fetchDecisions, fetchSubJobs, fetchProgressNarrative,
    fetchHealth, runPreflight, generateRunReport
  };
}
