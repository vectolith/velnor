import { createTask, retainTaskEvents, type IdeTask, type TaskStatus, TASK_EVENT_DETAIL_LIMIT, TASK_EVENT_LIMIT, TASK_TITLE_LIMIT, TASK_VALIDATION_CHECK_LIMIT, TASK_CHECK_NAME_LIMIT, TASK_CHECK_DETAIL_LIMIT, TASK_VALIDATION_SUMMARY_LIMIT } from "./tasks";

export const TASK_LEDGER_SCHEMA = 1;
export const TASK_LEDGER_LIMIT = 50;
export const TASK_LEDGER_MAX_BYTES = 1_000_000;
export type TaskLedger = { schemaVersion: 1; tasks: IdeTask[] };
const validStatuses: TaskStatus[] = ["queued", "planning", "executing", "validating", "completed", "blocked", "cancelled"];

export function emptyTaskLedger(): TaskLedger { return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: [] }; }

export function parseTaskLedger(raw: string): TaskLedger {
  if (new TextEncoder().encode(raw).byteLength > TASK_LEDGER_MAX_BYTES) throw new Error("Task ledger backup exceeds the 1 MB limit.");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Task ledger must be an object.");
  const value = parsed as { schemaVersion?: unknown; tasks?: unknown };
  if (value.schemaVersion !== TASK_LEDGER_SCHEMA || !Array.isArray(value.tasks)) throw new Error("Unsupported or invalid task ledger format.");
  const tasks = value.tasks.slice(0, TASK_LEDGER_LIMIT);
  const ids = new Set<string>();
  const normalized: IdeTask[] = [];
  for (const item of tasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid task record.");
    const task = item as IdeTask;
    if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id)) throw new Error("Task ids must be non-empty and unique.");
    if (typeof task.title !== "string" || !task.title.trim() || task.title.length > TASK_TITLE_LIMIT) throw new Error("Task titles are required and limited to 500 characters.");
    if (!validStatuses.includes(task.status)) throw new Error("Invalid task status.");
    if (typeof task.createdAt !== "string" || typeof task.updatedAt !== "string" || !Array.isArray(task.events)) throw new Error("Invalid task metadata.");
    const events = retainTaskEvents(task.events as IdeTask["events"]);
    for (const event of events) {
      if (!event || typeof event !== "object" || typeof event.at !== "string" || typeof event.detail !== "string" || event.detail.length > TASK_EVENT_DETAIL_LIMIT) throw new Error("Invalid or oversized task event.");
      if (!["created", "status", "note", "validation"].includes(event.type)) throw new Error("Invalid task event type.");
      if (event.status !== undefined && !validStatuses.includes(event.status)) throw new Error("Invalid task event status.");
      if (event.evidence) {
        const checks = event.evidence.checks;
        if (typeof event.evidence.at !== "string" || !Array.isArray(checks) || checks.length < 1 || checks.length > TASK_VALIDATION_CHECK_LIMIT || checks.some((check) => typeof check.name !== "string" || !check.name.trim() || check.name.length > TASK_CHECK_NAME_LIMIT || typeof check.passed !== "boolean" || (check.detail !== undefined && (typeof check.detail !== "string" || check.detail.length > TASK_CHECK_DETAIL_LIMIT))) || (event.evidence.summary !== undefined && (typeof event.evidence.summary !== "string" || event.evidence.summary.length > TASK_VALIDATION_SUMMARY_LIMIT))) throw new Error("Invalid validation evidence.");
      }
    }
    let status = task.status;
    if (status === "completed") {
      const validEvidence = events.some((event) => event.type === "validation" && event.evidence && event.evidence.checks.length > 0 && event.evidence.checks.every((check) => check.passed));
      if (!validEvidence) {
        status = "blocked";
        events.push({ type: "status", at: task.updatedAt, detail: "Imported completed status without passing validation evidence; downgraded to blocked.", status: "blocked" });
      }
    }
    normalized.push({ ...task, status, events: retainTaskEvents(events) });
    ids.add(task.id);
  }
  return { schemaVersion: TASK_LEDGER_SCHEMA, tasks: normalized };
}

export function addLedgerTask(ledger: TaskLedger, id: string, title: string, at: string): TaskLedger {
  if (ledger.tasks.some((task) => task.id === id)) throw new Error("A task with that id already exists.");
  return { schemaVersion: 1, tasks: [createTask(id, title, at), ...ledger.tasks].slice(0, TASK_LEDGER_LIMIT) };
}

export function replaceLedgerTask(ledger: TaskLedger, task: IdeTask): TaskLedger {
  if (!ledger.tasks.some((item) => item.id === task.id)) throw new Error("Task not found.");
  return { schemaVersion: 1, tasks: ledger.tasks.map((item) => item.id === task.id ? { ...task, events: retainTaskEvents(task.events) } : item) };
}
