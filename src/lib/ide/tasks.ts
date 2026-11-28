export type TaskStatus = "queued" | "planning" | "executing" | "validating" | "completed" | "blocked" | "cancelled";
export type ValidationCheck = { name: string; passed: boolean; detail?: string };
export type ValidationEvidence = { at: string; checks: ValidationCheck[]; summary?: string };
export type TaskEvent = { type: "created" | "status" | "note" | "validation"; at: string; detail: string; status?: TaskStatus; evidence?: ValidationEvidence };
export type IdeTask = { id: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string; events: TaskEvent[] };

export const TASK_EVENT_LIMIT = 100;
export const TASK_TITLE_LIMIT = 500;
export const TASK_NOTE_LIMIT = 1_000;
export const TASK_EVENT_DETAIL_LIMIT = 1_000;
export const TASK_VALIDATION_CHECK_LIMIT = 20;
export const TASK_CHECK_NAME_LIMIT = 200;
export const TASK_CHECK_DETAIL_LIMIT = 500;
export const TASK_VALIDATION_SUMMARY_LIMIT = 500;

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "cancelled"], planning: ["executing", "blocked", "cancelled"],
  executing: ["validating", "blocked", "cancelled"], validating: ["executing", "blocked", "cancelled"],
  completed: [], blocked: ["planning", "executing", "cancelled"], cancelled: [],
};

export function retainTaskEvents(events: TaskEvent[]): TaskEvent[] { return events.slice(-TASK_EVENT_LIMIT); }

export function createTask(id: string, title: string, at: string): IdeTask {
  const clean = title.trim();
  if (!id.trim() || !clean) throw new Error("Task id and title are required.");
  if (clean.length > TASK_TITLE_LIMIT) throw new Error("Task titles are limited to 500 characters.");
  return { id, title: clean, status: "queued", createdAt: at, updatedAt: at, events: [{ type: "created", at, detail: clean, status: "queued" }] };
}

export function transitionTask(task: IdeTask, next: TaskStatus, at: string, detail?: string): IdeTask {
  if (task.status === next) return task;
  if (!transitions[task.status].includes(next)) throw new Error("Invalid task transition: " + task.status + " → " + next);
  const note = detail?.trim() || ("Status changed to " + next);
  if (note.length > TASK_EVENT_DETAIL_LIMIT) throw new Error("Task event details are limited to 1,000 characters.");
  return { ...task, status: next, updatedAt: at, events: retainTaskEvents([...task.events, { type: "status", at, detail: note, status: next }]) };
}

export function completeTask(task: IdeTask, evidence: ValidationEvidence): IdeTask {
  if (task.status !== "validating") throw new Error("Tasks must be validating before completion.");
  if (!evidence.checks.length || evidence.checks.length > TASK_VALIDATION_CHECK_LIMIT || evidence.checks.some((check) => !check.name.trim() || check.name.length > TASK_CHECK_NAME_LIMIT || !check.passed || (check.detail?.length ?? 0) > TASK_CHECK_DETAIL_LIMIT)) throw new Error("Completion requires 1–20 named, passing validation checks; each name and detail must be within the configured limits.");
  if ((evidence.summary?.length ?? 0) > TASK_VALIDATION_SUMMARY_LIMIT) throw new Error("Validation summaries are limited to 1,000 characters.");
  const detail = evidence.summary?.trim() || "All recorded validation checks passed.";
  return { ...task, status: "completed", updatedAt: evidence.at, events: retainTaskEvents([...task.events, { type: "validation", at: evidence.at, detail, status: "completed", evidence }]) };
}

export function addTaskNote(task: IdeTask, detail: string, at: string): IdeTask {
  const note = detail.trim();
  if (!note) throw new Error("Task notes cannot be empty.");
  if (note.length > TASK_NOTE_LIMIT) throw new Error("Task notes are limited to 1,000 characters.");
  return { ...task, updatedAt: at, events: retainTaskEvents([...task.events, { type: "note", at, detail: note }]) };
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean { return transitions[from].includes(to); }
