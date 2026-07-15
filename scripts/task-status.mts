/**
 * task-status.mts — print a migration task's step statuses.
 *
 * Replaces the inline `node -e` one-liners that kept crashing on bash history
 * expansion (the `!` in `['running',...].includes(...)`). Use this instead of
 * hand-writing a status query.
 *
 * Usage:
 *   npx tsx scripts/task-status.mts <taskId> [--api http://127.0.0.1:3001] [--json]
 *   npx tsx scripts/task-status.mts --list        # list all tasks
 */
const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const asJson = process.argv.includes("--json");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--list")) {
    const { tasks } = (await (await fetch(`${API}/api/tasks`)).json()) as { tasks: Array<{ id: string; status: string; name: string }> };
    if (asJson) { console.log(JSON.stringify(tasks, null, 2)); return; }
    if (!tasks.length) { console.log("(no tasks)"); return; }
    for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(18)} ${t.name}`);
    return;
  }
  const taskId = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!taskId) { console.error("usage: task-status.mts <taskId> [--api URL] [--json] | --list"); process.exit(2); }

  const res = await fetch(`${API}/api/tasks/${taskId}`);
  if (!res.ok) { console.error(`task ${taskId} -> HTTP ${res.status}`); process.exit(1); }
  const { task } = (await res.json()) as {
    task: { id: string; name: string; status: string; steps: Array<{ id: string; status: string; error?: string }> };
  };
  if (asJson) { console.log(JSON.stringify(task, null, 2)); return; }

  const BLOCKING = ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"];
  let highest = "--";
  console.log(`task ${task.id}  (${task.name})  status=${task.status}`);
  for (const s of task.steps) {
    if (s.status === "pending") continue;
    console.log(`  ${s.id}  ${s.status}${s.error ? "  err: " + s.error.slice(0, 90) : ""}`);
    if (s.status === "completed") highest = s.id;
  }
  const blocking = task.steps.find((s) => BLOCKING.includes(s.status));
  console.log(`highest completed: ${highest}${blocking ? ` | blocking: ${blocking.id}:${blocking.status}` : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
