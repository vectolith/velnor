import { createTask, type IdeTask } from "./tasks";

export const TASK_LEDGER_SCHEMA = 1;
export const TASK_LEDGER_LIMIT = 50;

export type TaskLedger = { schemaVersion: 1; tasks: IdeTask[] };

export function emptyTaskLedger(): TaskLedger {
  return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: [] };
}

export function parseTaskLedger(raw: string): TaskLedger {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Task ledger must be an object.");
  const value = parsed as { schemaVersion?: unknown; tasks?: unknown };
  if (value.schemaVersion !== TASK_LEDGER_SCHEMA || !Array.isArray(value.tasks)) throw new Error("Unsupported or invalid task ledger format.");
  const tasks = value.tasks.slice(0, TASK_LEDGER_LIMIT);
  const ids = new Set<string>();
  for (const item of tasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid task record.");
    const task = item as IdeTask;
    if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id)) throw new Error("Task ids must be non-empty and unique.");
    if (typeof task.title !== "string" || !task.title.trim()) throw new Error("Task titles are required.");
    if (!["queued", "planning", "executing", "validating", "completed", "blocked", "cancelled"].includes(task.status)) throw new Error("Invalid task status.");
    if (typeof task.createdAt !== "string" || typeof task.updatedAt !== "string" || !Array.isArray(task.events)) throw new Error("Invalid task metadata.");
    for (const event of task.events) {
      if (!event || typeof event !== "object" || typeof event.at !== "string" || typeof event.detail !== "string") throw new Error("Invalid task event.");
      if (!["created", "status", "note", "validation"].includes(event.type)) throw new Error("Invalid task event type.");
      if (event.evidence && (!Array.isArray(event.evidence.checks) || event.evidence.checks.some((check) => typeof check.name !== "string" || typeof check.passed !== "boolean"))) throw new Error("Invalid validation evidence.");
    }
    ids.add(task.id);
  }
  return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: tasks as IdeTask[] };
}

export function addLedgerTask(ledger: TaskLedger, id: string, title: string, at: string): TaskLedger {
  if (ledger.tasks.some((task) => task.id === id)) throw new Error("A task with that id already exists.");
  return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: [createTask(id, title, at), ...ledger.tasks].slice(0, TASK_LEDGER_LIMIT) };
}

export function replaceLedgerTask(ledger: TaskLedger, task: IdeTask): TaskLedger {
  if (!ledger.tasks.some((item) => item.id === task.id)) throw new Error("Task not found.");
  return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: ledger.tasks.map((item) => item.id === task.id ? task : item) };
}
