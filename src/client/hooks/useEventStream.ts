import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../../shared/types";

export type ActivityLine = {
  id: string;
  timestamp: string;
  text: string;
  category: "thinking" | "tool" | "system";
};

const ACTIVITY_CAP = 60;
const EVENT_MEMORY_LIMIT = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function extractActivity(event: AgentEvent): ActivityLine | undefined {
  if (event.type !== "progress") return undefined;

  const msg = event.message;
  const sdkType = isRecord(event.data) ? stringValue(event.data.type) : undefined;

  // Skip low-value events
  if (sdkType && ["session.usage_info", "hook.start", "hook.end", "assistant.usage"].includes(sdkType)) {
    return undefined;
  }
  if (msg.includes("Auto-approved Copilot")) {
    return {
      id: event.id,
      timestamp: event.createdAt,
      text: msg,
      category: "system"
    };
  }

  // Agent thinking/output
  if (msg.startsWith("assistant.message") || msg.startsWith("assistant.streaming_delta:")) {
    const text = msg
      .replace(/^assistant\.(message|streaming_delta):\s*/, "")
      .trim();
    if (!text || text.length < 5) return undefined;
    return {
      id: event.id,
      timestamp: event.createdAt,
      text: text.length > 200 ? `${text.slice(0, 197)}...` : text,
      category: "thinking"
    };
  }

  // Tool execution
  if (msg.startsWith("tool started:") || msg.startsWith("tool completed:")) {
    const text = msg.replace(/^tool (started|completed):\s*/, "").trim();
    const isComplete = msg.startsWith("tool completed:");
    return {
      id: event.id,
      timestamp: event.createdAt,
      text: `${isComplete ? "done" : "run"}: ${text || "tool"}`,
      category: "tool"
    };
  }

  return undefined;
}

function shouldRefreshTaskState(event: AgentEvent): boolean {
  if (["step_completed", "step_failed", "hard_stop", "human_question", "step_summary", "reflection_proposed"].includes(event.type)) {
    return true;
  }
  if (event.type !== "progress") return false;
  if (event.message.startsWith("Synced Phase 1")) return true;
  if (isRecord(event.data)) {
    if (Array.isArray(event.data.synced) && event.data.synced.length > 0) return true;
    if (stringValue(event.data.resumeFrom) === "phase1-context") return true;
  }
  return false;
}

export function useEventStream(taskId: string | undefined) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activities, setActivities] = useState<Map<string, ActivityLine[]>>(new Map());
  const [needsRefresh, setNeedsRefresh] = useState(0);
  const [needsArtifactRefresh, setNeedsArtifactRefresh] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    if (!taskId) return;
    setEvents([]);
    setActivities(new Map());

    const source = new EventSource(
      `/api/tasks/${taskId}/events/stream?limit=80`
    );

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;

      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event].slice(-EVENT_MEMORY_LIMIT);
      });

      // Extract activity for agent view
      const activity = extractActivity(event);
      if (activity && event.stepId) {
        setActivities((current) => {
          const next = new Map(current);
          const stepActivities = [...(next.get(event.stepId!) ?? []), activity].slice(-ACTIVITY_CAP);
          next.set(event.stepId!, stepActivities);
          return next;
        });
      }

      if (shouldRefreshTaskState(event)) {
        setNeedsRefresh((n) => n + 1);
      }
      if (["step_completed", "step_failed", "hard_stop", "human_question", "step_summary", "reflection_proposed"].includes(event.type)) {
        setNeedsArtifactRefresh((n) => n + 1);
      }
    };

    return () => source.close();
  }, [taskId]);

  // Pending questions: only the latest unanswered question per step
  const pendingQuestions = (() => {
    const unanswered = events.filter(
      (e) => e.type === "human_question" && !events.some(
        (d) => (d.type === "step_completed" || d.type === "step_failed" || d.type === "hard_stop") && d.stepId === e.stepId && d.createdAt > e.createdAt
      )
    );
    // Deduplicate: keep only the latest per stepId
    const latest = new Map<string, AgentEvent>();
    for (const e of unanswered) {
      const key = e.stepId ?? e.id;
      if (!latest.has(key) || (e.createdAt > (latest.get(key)?.createdAt ?? ""))) {
        latest.set(key, e);
      }
    }
    return [...latest.values()];
  })();

  return { events, activities, pendingQuestions, needsRefresh, needsArtifactRefresh };
}
