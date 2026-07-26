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

// Real bug this closes: task-state/artifact refresh used to require every
// event TYPE that could possibly change visible state to be enumerated in an
// allowlist here (shouldRefreshTaskState used to check only
// step_started/step_completed/.../a couple of specific "progress" message
// patterns). Every new backend feature that emits its own "progress" events
// (Step 05's docker-sync/recipe-drift checks, Step 12's GUI-workflow sync,
// Step 13's whole draft/verify/fix/merge/push/deploy pipeline, ...) silently
// fell outside that allowlist, so its status changes only ever became
// visible after a manual page reload -- indistinguishable from "the UI is
// frozen." Fixed by refreshing on EVERY event instead of matching specific
// types, with a leading+trailing throttle so a bursty SDK tool-calling
// session doesn't turn into a refetch storm: the first event after a quiet
// period refreshes immediately, then updates are capped at one per
// REFRESH_THROTTLE_MS during a burst, with one final trailing refresh to
// catch the last state once the burst ends.
const REFRESH_THROTTLE_MS = 600;

function makeThrottledSignal(bump: () => void) {
  let lastFire = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    const now = Date.now();
    const elapsed = now - lastFire;
    if (elapsed >= REFRESH_THROTTLE_MS) {
      lastFire = now;
      bump();
    } else {
      if (trailingTimer) clearTimeout(trailingTimer);
      trailingTimer = setTimeout(() => {
        lastFire = Date.now();
        bump();
      }, REFRESH_THROTTLE_MS - elapsed);
    }
  };
}

/** Message substring the Step 13 push/deploy gate emits right before spawning the detached redeploy process (see orchestrator.ts's applyPushDeployDecision). */
const DEPLOY_TRIGGERED_MARKER = "Deploy triggered";

export type ConnectionState = "connected" | "reconnecting";

// Base reconnect delay when the browser gives up retrying on its own
// (EventSource readyState === CLOSED). Backs off up to a cap so a genuinely
// down backend doesn't spam reconnect attempts forever.
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// Safety net: if the disconnect/reconnect signals are somehow missed (the
// deploy script fails before killing the old process, or the browser's own
// EventSource retry is fast enough that "reconnecting" never visibly
// renders), don't leave the "deploying" banner stuck forever.
const DEPLOY_PENDING_TIMEOUT_MS = 120_000;

export function useEventStream(taskId: string | undefined) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activities, setActivities] = useState<Map<string, ActivityLine[]>>(new Map());
  const [needsRefresh, setNeedsRefresh] = useState(0);
  const [needsArtifactRefresh, setNeedsArtifactRefresh] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connected");
  const [deployPending, setDeployPending] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    if (!taskId) return;
    setEvents([]);
    setActivities(new Map());
    setConnectionState("connected");
    setDeployPending(false);

    let stopped = false;
    let source: EventSource | undefined;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let hasConnectedBefore = false;
    let sawDisconnectSinceDeploy = false;
    let deployTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const bumpRefresh = makeThrottledSignal(() => setNeedsRefresh((n) => n + 1));
    const bumpArtifactRefresh = makeThrottledSignal(() => setNeedsArtifactRefresh((n) => n + 1));

    const clearDeployPending = () => {
      if (deployTimeoutTimer) clearTimeout(deployTimeoutTimer);
      sawDisconnectSinceDeploy = false;
      setDeployPending(false);
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/tasks/${taskId}/events/stream?limit=80`);

      source.onopen = () => {
        reconnectAttempt = 0;
        setConnectionState("connected");
        // Force a fresh pull of task/step + artifact state on (re)connect --
        // events emitted by the backend while it was down (e.g. during a
        // deploy-triggered restart) are simply lost, not buffered/replayed,
        // so the UI must not wait for the NEXT event to notice anything
        // changed while disconnected.
        if (hasConnectedBefore) {
          setNeedsRefresh((n) => n + 1);
          setNeedsArtifactRefresh((n) => n + 1);
        }
        hasConnectedBefore = true;
        if (sawDisconnectSinceDeploy) {
          clearDeployPending();
        }
      };

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

        if (event.message.includes(DEPLOY_TRIGGERED_MARKER)) {
          setDeployPending(true);
          if (deployTimeoutTimer) clearTimeout(deployTimeoutTimer);
          deployTimeoutTimer = setTimeout(clearDeployPending, DEPLOY_PENDING_TIMEOUT_MS);
        }

        // Any event can mean visible state changed somewhere (step status,
        // artifacts, decisions, narrative) -- see the comment above
        // REFRESH_THROTTLE_MS for why this used to be an allowlist and why
        // that was the actual bug. Throttled so a bursty SDK session doesn't
        // turn into a refetch storm.
        bumpRefresh();
        bumpArtifactRefresh();
      };

      source.onerror = () => {
        if (stopped) return;
        setConnectionState("reconnecting");
        sawDisconnectSinceDeploy = true;
        // EventSource retries on its own for a transient drop, but when the
        // browser gives up (readyState CLOSED -- e.g. the server rejected
        // the connection outright) it will never retry by itself, so we
        // must recreate it manually with backoff.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (deployTimeoutTimer) clearTimeout(deployTimeoutTimer);
      source?.close();
    };
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

  return { events, activities, pendingQuestions, needsRefresh, needsArtifactRefresh, connectionState, deployPending };
}
