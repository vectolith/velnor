import { randomUUID } from "node:crypto";
import { getSqliteDb } from "../sqliteDb";
import type { ChannelType } from "../types";

export type ExecutionTaskStatus =
  | "queued" | "running" | "cancel_requested" | "succeeded"
  | "failed" | "cancelled" | "interrupted";

export interface ExecutionTask {
  id: string;
  tenantId: string;
  channel: ChannelType;
  userHandle: string | null;
  status: ExecutionTaskStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  retryOf: string | null;
}

interface TaskRow {
  id: string; tenant_id: string; channel: ChannelType; user_handle: string | null;
  status: ExecutionTaskStatus; error: string | null; created_at: string;
  started_at: string | null; updated_at: string; completed_at: string | null; retry_of: string | null;
}

function database() {
  const db = getSqliteDb();
  if (!db) throw new Error("Durable execution tasks require Node SQLite; refusing ephemeral task state.");
  return db;
}
function validateTenant(tenantId: string) {
  if (!tenantId || tenantId.length > 128 || !/^[A-Za-z0-9._@+-]+$/.test(tenantId)) {
    throw new Error("Invalid execution task tenant.");
  }
}
function fromRow(row: TaskRow): ExecutionTask {
  return {
    id: row.id, tenantId: row.tenant_id, channel: row.channel,
    userHandle: row.user_handle, status: row.status, error: row.error,
    createdAt: row.created_at, startedAt: row.started_at,
    updatedAt: row.updated_at, completedAt: row.completed_at, retryOf: row.retry_of ?? null,
  };
}

export class ExecutionTaskCancelledError extends Error {
  constructor() { super("Execution was cancelled by the user."); this.name = "ExecutionTaskCancelledError"; }
}

export function createExecutionTask(input: {
  tenantId: string; channel: ChannelType; userHandle?: string; retryOfTaskId?: string;
}): ExecutionTask {
  validateTenant(input.tenantId);
  const db = database();
  const now = new Date().toISOString();
  const id = "task_" + randomUUID();
  db.prepare(`
    INSERT INTO execution_tasks
      (id, tenant_id, channel, user_handle, status, error, created_at, started_at, updated_at, completed_at, lease_until, retry_of)
    VALUES (?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, NULL, NULL, ?)
  `).run(id, input.tenantId, input.channel, input.userHandle || null, now, now, input.retryOfTaskId || null);
  const row = db.prepare("SELECT * FROM execution_tasks WHERE id = ? AND tenant_id = ?")
    .get(id, input.tenantId) as TaskRow | undefined;
  if (!row) throw new Error("Execution task was not persisted.");
  return fromRow(row);
}

export function startExecutionTask(tenantId: string, taskId: string): void {
  validateTenant(tenantId);
  const now = new Date();
  const result = database().prepare(`
    UPDATE execution_tasks SET status = 'running', started_at = ?, updated_at = ?, lease_until = ?
    WHERE id = ? AND tenant_id = ? AND status = 'queued'
  `).run(now.toISOString(), now.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString(), taskId, tenantId) as { changes?: number };
  if (Number(result.changes) !== 1) throw new Error("Execution task could not be started.");
}

export function assertExecutionTaskActive(tenantId: string, taskId: string): void {
  validateTenant(tenantId);
  const row = database().prepare("SELECT status FROM execution_tasks WHERE id = ? AND tenant_id = ?")
    .get(taskId, tenantId) as { status?: ExecutionTaskStatus } | undefined;
  if (!row) throw new Error("Execution task was not found.");
  if (row.status === "cancel_requested" || row.status === "cancelled") throw new ExecutionTaskCancelledError();
  if (row.status !== "running") throw new Error("Execution task is no longer active.");
  const now = new Date().toISOString();
  database().prepare("UPDATE execution_tasks SET updated_at = ?, lease_until = ? WHERE id = ? AND tenant_id = ? AND status = 'running'")
    .run(now, new Date(Date.now() + 15 * 60_000).toISOString(), taskId, tenantId);
}

export function finishExecutionTask(
  tenantId: string, taskId: string, outcome: "succeeded" | "failed" | "cancelled", error?: string,
): void {
  validateTenant(tenantId);
  const now = new Date().toISOString();
  const db = database();
  db.prepare(`
    UPDATE execution_tasks
    SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' ELSE ? END,
        error = ?, updated_at = ?, completed_at = ?, lease_until = NULL
    WHERE id = ? AND tenant_id = ? AND status IN ('running', 'cancel_requested')
  `).run(outcome, error ? String(error).slice(0, 1000) : null, now, now, taskId, tenantId);
}

export function requestExecutionTaskCancellation(tenantId: string, taskId: string): boolean {
  validateTenant(tenantId);
  const result = database().prepare(`
    UPDATE execution_tasks SET
      status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
      updated_at = ?, completed_at = CASE WHEN status = 'queued' THEN ? ELSE completed_at END
    WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'running')
  `).run(new Date().toISOString(), new Date().toISOString(), taskId, tenantId) as { changes?: number };
  return Number(result.changes) === 1;
}

export function getExecutionTask(tenantId: string, taskId: string): ExecutionTask | null {
  validateTenant(tenantId);
  const row = database().prepare("SELECT * FROM execution_tasks WHERE id = ? AND tenant_id = ?")
    .get(taskId, tenantId) as TaskRow | undefined;
  return row ? fromRow(row) : null;
}

/** Return the single retry child, if this task has already been retried. */
export function getExecutionTaskRetry(tenantId: string, taskId: string): ExecutionTask | null {
  validateTenant(tenantId);
  const row = database().prepare("SELECT * FROM execution_tasks WHERE tenant_id = ? AND retry_of = ? LIMIT 1")
    .get(tenantId, taskId) as TaskRow | undefined;
  return row ? fromRow(row) : null;
}

export function listExecutionTasks(tenantId: string, limit = 50): ExecutionTask[] {
  validateTenant(tenantId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Task history limit must be between 1 and 100.");
  const db = database();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE execution_tasks SET status = 'interrupted', error = 'Worker lease expired before completion.',
      updated_at = ?, completed_at = ?, lease_until = NULL
    WHERE tenant_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
  `).run(now, now, tenantId, now);
  db.prepare(`
    UPDATE execution_tasks SET status = 'cancelled', error = NULL,
      updated_at = ?, completed_at = ?, lease_until = NULL
    WHERE tenant_id = ? AND status = 'cancel_requested' AND lease_until IS NOT NULL AND lease_until <= ?
  `).run(now, now, tenantId, now);
  const rows = db.prepare("SELECT * FROM execution_tasks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(tenantId, limit) as TaskRow[];
  return rows.map(fromRow);
}
