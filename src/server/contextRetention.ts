import type { AgentEvent } from "../shared/types";

export type ContextRetentionClass =
  | "prompt_required"
  | "prompt_summary"
  | "db_only"
  | "debug_file_only"
  | "drop";

export interface ContextRetentionDecision {
  class: ContextRetentionClass;
  promptBudget: boolean;
  persistApiEvent: boolean;
  persistDebugEvent: boolean;
  persistTranscriptEvent: boolean;
  reason: string;
}

const sdkDropTypes = new Set([
  "assistant.streaming_delta",
  "assistant.message_delta",
  "session.background_tasks_changed",
  "session.usage_info",
  "assistant.usage",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message_start",
  "assistant.intent",
  "assistant.reasoning",
  "permission.requested",
  "permission.completed",
  "hook.start",
  "hook.end",
  "pending_messages.modified"
]);

export function classifySdkEventForRetention(
  event: unknown,
  semanticProgress?: string
): ContextRetentionDecision {
  const eventType = sdkEventType(event);
  if (eventType && /\b(error|failed|failure)\b/i.test(eventType)) {
    return retain("prompt_required", true, true, true, true, "sdk_error_or_failure");
  }
  if (semanticProgress) {
    return retain("prompt_summary", true, true, true, true, "semantic_progress_summary");
  }
  if (!eventType) {
    return retain("debug_file_only", false, false, true, false, "unknown_sdk_event");
  }
  if (sdkDropTypes.has(eventType)) {
    return retain("drop", false, false, false, false, "sdk_noise");
  }
  if (eventType === "assistant.message") {
    return retain("debug_file_only", false, false, true, false, "assistant_message_without_artifact_progress");
  }
  if (eventType.startsWith("tool.")) {
    return retain("db_only", false, false, true, false, "non_semantic_tool_event");
  }
  return retain("debug_file_only", false, false, true, false, "debug_only_sdk_event");
}

export function sdkEventToContextBudgetEvent(
  taskId: string,
  event: unknown,
  semanticProgress?: string
): Omit<AgentEvent, "id" | "createdAt"> | undefined {
  const retention = classifySdkEventForRetention(event, semanticProgress);
  if (!retention.promptBudget) return undefined;
  const summary = summarizeSdkEventForStorage(event, semanticProgress);
  return {
    taskId,
    stepId: "phase1",
    type: "progress",
    message: summary.semanticProgress ?? summary.type ?? "sdk.event",
    data: {
      retentionClass: retention.class,
      retentionReason: retention.reason,
      ...summary
    }
  };
}

export function shouldPersistApiEvent(event: Omit<AgentEvent, "id" | "createdAt">): boolean {
  if (event.type !== "progress") return true;
  const message = event.message.trim();
  if (!message) return false;
  if (message === "Phase 1 task-state sync found no step status changes.") return false;
  if (/^Auto-approved Copilot .* permission for step /.test(message)) return false;
  if (message === "Enabled Copilot SDK approve-all permissions for this migration step.") return false;
  if (/^tool (started|completed): /.test(message)) return false;
  if (/^tool\.execution_complete\b/.test(message)) return false;
  if (/^(hook\.|permission\.|assistant\.|session\.background_tasks_changed|session\.usage_info)/.test(message)) {
    return false;
  }
  const data = isRecord(event.data) ? event.data : undefined;
  const retentionClass = stringValue(data?.retentionClass);
  if (retentionClass === "drop" || retentionClass === "debug_file_only" || retentionClass === "db_only") {
    return false;
  }
  return true;
}

export function summarizeSdkEventForStorage(
  event: unknown,
  semanticProgress?: string
): {
  type?: string;
  semanticProgress?: string;
  toolName?: string;
  success?: boolean;
  contentPreview?: string;
} {
  if (!isRecord(event)) return { semanticProgress };
  const data = isRecord(event.data) ? event.data : undefined;
  const result = data && isRecord(data.result) ? data.result : undefined;
  return {
    type: stringValue(event.type),
    semanticProgress,
    toolName: data ? stringValue(data.toolName) : undefined,
    success: data && typeof data.success === "boolean" ? data.success : undefined,
    contentPreview: data
      ? truncateForProgress(
          stringValue(data.deltaContent) ??
            stringValue(data.content) ??
            stringValue(result?.content) ??
            stringValue(result?.detailedContent) ??
            ""
        ) || undefined
      : undefined
  };
}

function retain(
  retentionClass: ContextRetentionClass,
  promptBudget: boolean,
  persistApiEvent: boolean,
  persistDebugEvent: boolean,
  persistTranscriptEvent: boolean,
  reason: string
): ContextRetentionDecision {
  return {
    class: retentionClass,
    promptBudget,
    persistApiEvent,
    persistDebugEvent,
    persistTranscriptEvent,
    reason
  };
}

function sdkEventType(event: unknown): string | undefined {
  return isRecord(event) ? stringValue(event.type) : undefined;
}

function truncateForProgress(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
