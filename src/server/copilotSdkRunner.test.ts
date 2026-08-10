import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProgressWatchdog,
  getSemanticProgress,
  shouldEmitSdkProgressEvent
} from "./copilotSdkRunner";

describe("Copilot SDK progress watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("distinguishes semantic progress from heartbeat events", () => {
    expect(
      getSemanticProgress({
        type: "assistant.message_delta",
        data: { deltaContent: "writing 06-prompt-validation.json" }
      })
    ).toBeUndefined();
    expect(
      getSemanticProgress({
        type: "assistant.message_delta",
        data: { deltaContent: "I will inspect the workflow next" }
      })
    ).toBeUndefined();
    expect(
      getSemanticProgress({
        type: "assistant.message_delta",
        data: { data: { deltaContent: "creating branch smoke prompt" } }
      })
    ).toBeUndefined();
    expect(
      getSemanticProgress({
        type: "assistant.message",
        data: { content: "wrote 06-prompt-validation.json" }
      })
    ).toContain("wrote 06-prompt-validation.json");
    expect(
      getSemanticProgress({
        type: "tool.execution_start",
        data: { toolName: "bash" }
      })
    ).toBe("tool started: bash");
    expect(getSemanticProgress({ type: "session.usage_info", data: {} })).toBeUndefined();
    expect(
      getSemanticProgress({
        type: "assistant.streaming_delta",
        data: { deltaContent: "" }
      })
    ).toBeUndefined();
  });

  it("keeps a long SDK wait alive while semantic progress continues", async () => {
    vi.useFakeTimers();
    let resolvePromise: (value: string) => void = () => undefined;
    const watchdog = createProgressWatchdog({
      stepId: "06",
      noProgressTimeoutMs: 2_000
    });
    const watched = watchdog.watch(
      new Promise<string>((resolve) => {
        resolvePromise = resolve;
      })
    );

    await vi.advanceTimersByTimeAsync(1_500);
    watchdog.markProgress("tool completed: apply_patch success=true");
    await vi.advanceTimersByTimeAsync(1_500);
    resolvePromise("done");
    await expect(watched).resolves.toBe("done");
  });

  it("trips the stuck detector when the ONLY progress is churn against a dead dependency", async () => {
    vi.useFakeTimers();
    const watchdog = createProgressWatchdog({
      stepId: "07",
      noProgressTimeoutMs: 60_000, // long, so the no-progress timer is NOT what fires
      stuckTimeoutMs: 5_000
    });
    const watched = watchdog.watch(new Promise<string>(() => undefined)); // never resolves
    watched.catch(() => undefined); // avoid unhandled-rejection noise

    // The real 44-min hang: tool calls keep firing (resetting the no-progress
    // timer) but every one is a connection failure to a crashed ComfyUI.
    for (let i = 0; i < 6; i++) {
      watchdog.markProgress("tool completed: curl http://127.0.0.1:8188/system_stats -> connection refused");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await expect(watched).rejects.toThrow(/stuck|no semantic progress/i);
  });

  it("does NOT trip the stuck detector when real progress is interleaved with churn", async () => {
    vi.useFakeTimers();
    let resolveReal: (value: string) => void = () => undefined;
    const watchdog = createProgressWatchdog({
      stepId: "07",
      noProgressTimeoutMs: 60_000,
      stuckTimeoutMs: 5_000
    });
    const watched = watchdog.watch(new Promise<string>((resolve) => { resolveReal = resolve; }));

    for (let i = 0; i < 6; i++) {
      watchdog.markProgress("connection refused"); // churn
      await vi.advanceTimersByTimeAsync(1_000);
      watchdog.markProgress("wrote 07-branch-smoke-summary.json"); // real progress resets churn
      await vi.advanceTimersByTimeAsync(1_000);
    }
    resolveReal("done");
    await expect(watched).resolves.toBe("done");
  });

  it("does not persist raw assistant token stream deltas as API progress events", () => {
    expect(
      shouldEmitSdkProgressEvent({
        type: "assistant.streaming_delta",
        data: { deltaContent: "token chunk" }
      })
    ).toBe(false);
    expect(
      shouldEmitSdkProgressEvent({
        type: "assistant.message_delta",
        data: { deltaContent: "token chunk" }
      })
    ).toBe(false);
    expect(
      shouldEmitSdkProgressEvent({
        type: "tool.execution_start",
        data: { toolName: "bash" }
      })
    ).toBe(true);
    expect(shouldEmitSdkProgressEvent({ type: "session.background_tasks_changed" })).toBe(false);
    expect(shouldEmitSdkProgressEvent({ type: "permission.completed" })).toBe(false);
    expect(shouldEmitSdkProgressEvent({ type: "session.error" })).toBe(true);
  });
});
