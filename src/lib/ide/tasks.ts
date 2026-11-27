export type TaskStatus = "queued" | "planning" | "executing" | "validating" | "completed" | "blocked" | "cancelled";
export type TaskEvent = { type: "created" | "status" | "note"; at: string; detail: string; status?: TaskStatus };
export type IdeTask = { id: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string; events: TaskEvent[] };

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["executing", "blocked", "cancelled"],
  executing: ["validating", "blocked", "cancelled"],
  validating: ["executing", "completed", "blocked", "cancelled"],
  completed: [],
  blocked: ["planning", "executing", "cancelled"],
  cancelled: [],
};

export function createTask(id: string, title: string, at: string): IdeTask {
  if (!id.trim() || !title.trim()) throw new Error("Task id and title are required.");
  return { id, title: title.trim(), status: "queued", createdAt: at, updatedAt: at, events: [{ type: "created", at, detail: title.trim(), status: "queued" }] };
}

export function transitionTask(task: IdeTask, next: TaskStatus, at: string, detail?: string): IdeTask {
  if (task.status === next) return task;
  if (!transitions[task.status].includes(next)) throw new Error("Invalid task transition: " + task.status + " → " + next);
  const note = detail?.trim() || ("Status changed to " + next);
  return { ...task, status: next, updatedAt: at, events: [...task.events, { type: "status", at, detail: note, status: next }] };
}

export function addTaskNote(task: IdeTask, detail: string, at: string): IdeTask {
  const note = detail.trim();
  if (!note) throw new Error("Task notes cannot be empty.");
  return { ...task, updatedAt: at, events: [...task.events, { type: "note", at, detail: note }] };
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}
