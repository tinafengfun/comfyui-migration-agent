/**
 * drive-migration.mts — drive a workflow through the migration pipeline via the API.
 *
 * Consolidates the throwaway drive-wf / resume-wf / auto-wf2 scripts. Create a task
 * from a workflow + gpu-node, run-until-gate, and at each human gate either:
 *   --answers <file>  json map { "<stepId>": "answer text", ... } (freeform)
 *   --auto            pick a "proceed/continue/approve" choice, else print + stop
 *   (neither)         print the gate question+choices and STOP for manual handling
 *
 * Answers ONLY the latest unanswered question per step (re-answering an earlier one
 * trips reconcileStaleActiveTasks). Polls to completion / hard-stop / failure.
 *
 * Usage:
 *   npx tsx scripts/drive-migration.mts --workflow <path.json> --node <gpu-node> \
 *     [--answers answers.json] [--auto] [--api http://127.0.0.1:3001] \
 *     [--until 13] [--budget-min 180]
 */
import fs from "node:fs";

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const workflow = argValue("--workflow");
const node = argValue("--node");
const answersFile = argValue("--answers");
const auto = process.argv.includes("--auto");
const until = argValue("--until") ?? "13";
const budgetMin = Number(argValue("--budget-min") ?? "180");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PREF = ["proceed", "continue", "approve", "yes to all", "confirm", "skip these items and continue"];

interface Step { id: string; status: string; error?: string }
interface Task { id: string; name: string; status: string; steps: Step[] }
interface Ev { id: string; type: string; stepId?: string; data?: { question?: string; choices?: string[] }; message?: string }

async function getTask(id: string): Promise<Task> {
  return ((await (await fetch(`${API}/api/tasks/${id}`)).json()) as { task: Task }).task;
}
async function events(id: string): Promise<Ev[]> {
  return ((await (await fetch(`${API}/api/tasks/${id}/events`)).json()) as { events: Ev[] }).events ?? [];
}
async function runUntilGate(id: string): Promise<void> {
  await fetch(`${API}/api/tasks/${id}/run-until-gate`, { method: "POST" });
}

function pickAnswer(stepId: string, q: Ev, answers: Record<string, string>): { answer: string; freeform: boolean } | null {
  if (answers[stepId]) return { answer: answers[stepId], freeform: true };
  const choices = q.data?.choices ?? [];
  if (auto) {
    for (const p of PREF) { const m = choices.find((c) => c.toLowerCase().includes(p)); if (m) return { answer: m, freeform: false }; }
    const nonStop = choices.find((c) => !c.toLowerCase().includes("stop"));
    if (nonStop) return { answer: nonStop, freeform: false };
    return { answer: "Approve and continue.", freeform: true };
  }
  return null; // manual: caller prints + stops
}

async function main() {
  if (!workflow || !node) { console.error("usage: drive-migration.mts --workflow <path> --node <gpu-node> [--answers f] [--auto]"); process.exit(2); }
  const answers: Record<string, string> = answersFile ? JSON.parse(fs.readFileSync(answersFile, "utf8")) : {};
  const wf = JSON.parse(fs.readFileSync(workflow, "utf8"));
  const create = await fetch(`${API}/api/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflowFileName: workflow.split("/").pop(), workflowJson: wf, gpuNode: node })
  });
  if (create.status !== 201) { console.error("create failed", create.status, await create.text()); process.exit(1); }
  const task = ((await create.json()) as { task: Task }).task;
  console.log(`TASK ${task.id}  node=${node}  until=Step ${until}`);
  const answered = new Set<string>();
  await runUntilGate(task.id);

  const deadline = Date.now() + budgetMin * 60_000;
  while (Date.now() < deadline) {
    await sleep(8000);
    const t = await getTask(task.id);
    const done = t.steps.filter((s) => s.status === "completed").map((s) => s.id);
    const run = t.steps.find((s) => s.status === "running");
    const b = t.steps.find((s) => ["waiting_for_human", "failed", "hard_stopped", "terminated"].includes(s.status));

    if (done.includes(until)) { console.log(`\n=== reached Step ${until} (done: ${done.join(",")}) ===`); return; }
    if (t.status === "completed" || t.steps.every((s) => s.status === "completed")) { console.log(`\n=== PASS: pipeline completed ===`); return; }

    if (b?.status === "waiting_for_human") {
      const qs = (await events(task.id)).filter((e) => e.type === "human_question" && e.stepId === b.id && !answered.has(e.id));
      const q = qs[qs.length - 1];
      if (q) {
        const choice = pickAnswer(b.id, q, answers);
        if (!choice) {
          console.log(`\n=== GATE Step ${b.id} (manual) ===\n${(q.data?.question || q.message || "").slice(0, 700)}`);
          (q.data?.choices || []).forEach((c, i) => console.log(`  [${i}] ${c}`));
          console.log(`\n(held; answer via UI or re-run with --answers/--auto)`);
          return;
        }
        await fetch(`${API}/api/tasks/${task.id}/human-decisions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionEventId: q.id, answer: choice.answer, wasFreeform: choice.freeform })
        });
        answered.add(q.id);
        console.log(`[gate ${b.id}] answered: ${choice.answer.slice(0, 70)}`);
        await sleep(3000);
        await runUntilGate(task.id);
      }
    } else if (b && ["failed", "hard_stopped", "terminated"].includes(b.status)) {
      console.log(`\n=== STOPPED: Step ${b.id} ${b.status}: ${(b.error || "").slice(0, 200)} (done: ${done.join(",")}) ===`);
      return;
    } else {
      console.log(`[${Math.round((Date.now() - (deadline - budgetMin * 60_000)) / 1000)}s] running=${run?.id || "-"} done=${done.join(",") || "-"}`);
    }
  }
  console.log("timed out within budget");
}

main().catch((e) => { console.error(e); process.exit(1); });
