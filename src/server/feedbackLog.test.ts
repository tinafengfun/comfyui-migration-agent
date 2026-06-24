import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendFeedbackEvent,
  listFeedbackEvents,
  countFeedbackEvents,
  type FeedbackEventInput
} from "./feedbackLog";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "fb-log-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const TASK_ID = "7f5cf9e4-1d1d-4429-8017-12c33b273f08";

const BASE_INPUT: FeedbackEventInput = {
  stepId: "05",
  source: "agent_self",
  type: "comfyui_bug",
  severity: "blocker",
  message: "CLIPLoader segfaults on XPU with fp8 TE"
};

describe("feedbackLog.appendFeedbackEvent", () => {
  it("writes one event and round-trips it", async () => {
    const written = await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    expect(written.id).toMatch(/[0-9a-f-]{36}/);
    expect(written.taskId).toBe(TASK_ID);
    expect(written.status).toBe("open");
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const { events, corrupt } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(corrupt).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "comfyui_bug",
      severity: "blocker",
      source: "agent_self"
    });
  });

  it("auto-creates the feedback directory on first write", async () => {
    await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    // list() should succeed without manual mkdir on the caller side.
    const { events } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(events).toHaveLength(1);
  });

  it("preserves insertion order across multiple appends", async () => {
    for (let i = 0; i < 5; i++) {
      await appendFeedbackEvent(workspaceRoot, TASK_ID, {
        ...BASE_INPUT,
        message: `event ${i}`
      });
    }
    const { events } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(events.map((e) => e.message)).toEqual([
      "event 0",
      "event 1",
      "event 2",
      "event 3",
      "event 4"
    ]);
  });

  it("rejects invalid event before writing (no partial state on disk)", async () => {
    // bad enum value
    await expect(
      appendFeedbackEvent(workspaceRoot, TASK_ID, {
        ...BASE_INPUT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: "quantum" as any
      })
    ).rejects.toThrow(/feedbackEvent/);

    const { events } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(events).toHaveLength(0);
  });

  it("honors optional fields when present", async () => {
    const e = await appendFeedbackEvent(workspaceRoot, TASK_ID, {
      ...BASE_INPUT,
      stateSnapshot: {
        comfyuiSha: "abc123",
        agentCommitSha: "269d584",
        failingArtifactPath: "logs/sdk-session.jsonl"
      },
      proposedAction: "escalate_opencode"
    });
    expect(e.stateSnapshot?.comfyuiSha).toBe("abc123");
    expect(e.proposedAction).toBe("escalate_opencode");
  });

  it("allows overriding taskId inside the event (cross-task bookkeeping)", async () => {
    const otherTask = "00000000-0000-0000-0000-000000000001";
    const e = await appendFeedbackEvent(workspaceRoot, TASK_ID, {
      ...BASE_INPUT,
      taskId: otherTask
    });
    expect(e.taskId).toBe(otherTask);
    // The file lands under the event's taskId, not the function arg.
    const { events } = await listFeedbackEvents(workspaceRoot, otherTask);
    expect(events).toHaveLength(1);
  });
});

describe("feedbackLog.listFeedbackEvents", () => {
  it("returns empty list when the file does not exist yet", async () => {
    const { events, corrupt } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(events).toEqual([]);
    expect(corrupt).toEqual([]);
  });

  it("isolates events by taskId (sibling tasks do not bleed)", async () => {
    const sibling = "11111111-1111-1111-1111-111111111111";
    await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    await appendFeedbackEvent(workspaceRoot, sibling, { ...BASE_INPUT, message: "sibling" });

    const a = await listFeedbackEvents(workspaceRoot, TASK_ID);
    const b = await listFeedbackEvents(workspaceRoot, sibling);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(b.events[0].message).toBe("sibling");
  });

  it("tolerates corrupt lines and reports them separately", async () => {
    // Write two valid events directly, plus a corrupt line between them.
    const e1 = await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    const filePath = path.join(
      workspaceRoot,
      TASK_ID,
      "feedback",
      "feedback-events.jsonl"
    );
    await writeFile(filePath, "{not valid json\n", { flag: "a" });
    const e2 = await appendFeedbackEvent(workspaceRoot, TASK_ID, {
      ...BASE_INPUT,
      message: "second"
    });

    const { events, corrupt } = await listFeedbackEvents(workspaceRoot, TASK_ID);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(e1.id);
    expect(events[1].id).toBe(e2.id);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0].line).toBe(2);
    expect(corrupt[0].reason).toMatch(/JSON\.parse/);
  });
});

describe("feedbackLog.countFeedbackEvents", () => {
  it("returns zero for a fresh task", async () => {
    expect(await countFeedbackEvents(workspaceRoot, TASK_ID)).toBe(0);
  });

  it("counts growing appends", async () => {
    await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    expect(await countFeedbackEvents(workspaceRoot, TASK_ID)).toBe(1);
    await appendFeedbackEvent(workspaceRoot, TASK_ID, BASE_INPUT);
    expect(await countFeedbackEvents(workspaceRoot, TASK_ID)).toBe(2);
  });
});
