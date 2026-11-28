import { normalizePath, type IdeFile, type Workspace } from "./workspace";

export type WorkspaceSnapshot = {
  id: string;
  label: string;
  createdAt: string;
  files: IdeFile[];
  entry: string;
  activeId: string;
};

export type SnapshotDiff = { added: string[]; removed: string[]; changed: string[]; unchanged: string[] };

export const SNAPSHOT_HISTORY_LIMIT = 20;
export const SNAPSHOT_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_HISTORY_INPUT_MAX_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_FILE_LIMIT = 40;
const SNAPSHOT_FILE_MAX_BYTES = 512 * 1024;

function byteSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function historySize(history: WorkspaceSnapshot[]): number {
  return byteSize(JSON.stringify(history));
}

function trimHistory(history: WorkspaceSnapshot[], limit: number, maxBytes: number): WorkspaceSnapshot[] {
  const retained = history.slice(-limit);
  while (retained.length && historySize(retained) > maxBytes) retained.shift();
  if (history.length && !retained.length) throw new Error("The newest checkpoint exceeds the 4 MB checkpoint-history limit.");
  return retained;
}

function normalizeSnapshot(value: unknown): WorkspaceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid checkpoint record.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim() || typeof record.label !== "string" || !record.label.trim() || typeof record.createdAt !== "string" || !record.createdAt) {
    throw new Error("Checkpoint metadata is invalid.");
  }
  if (!Array.isArray(record.files) || record.files.length < 1 || record.files.length > SNAPSHOT_FILE_LIMIT) throw new Error("Checkpoint must contain 1–40 files.");
  const fileIds = new Set<string>();
  const paths = new Set<string>();
  const files: IdeFile[] = record.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid checkpoint file.");
    const file = item as Record<string, unknown>;
    if (typeof file.id !== "string" || !file.id.trim() || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Checkpoint file metadata is invalid.");
    if (fileIds.has(file.id)) throw new Error("Checkpoint file ids must be unique.");
    if (byteSize(file.content) > SNAPSHOT_FILE_MAX_BYTES) throw new Error("A checkpoint file exceeds the 512 KB limit.");
    const path = normalizePath(file.path);
    const pathKey = path.toLocaleLowerCase("en");
    if (paths.has(pathKey)) throw new Error("Checkpoint contains duplicate file paths.");
    fileIds.add(file.id);
    paths.add(pathKey);
    return { id: file.id, path, content: file.content };
  });
  if (typeof record.entry !== "string") throw new Error("Checkpoint entry path is invalid.");
  const entry = normalizePath(record.entry);
  if (!paths.has(entry.toLocaleLowerCase("en"))) throw new Error("Checkpoint entry file is missing.");
  const activeId = typeof record.activeId === "string" && fileIds.has(record.activeId) ? record.activeId : files[0].id;
  return { id: record.id, label: record.label.trim(), createdAt: record.createdAt, files, entry, activeId };
}

export function parseSnapshotHistory(raw: string): WorkspaceSnapshot[] {
  if (byteSize(raw) > SNAPSHOT_HISTORY_INPUT_MAX_BYTES) throw new Error("Checkpoint history exceeds the 8 MB recovery-read limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Checkpoint history is not valid JSON."); }
  if (!Array.isArray(parsed)) throw new Error("Checkpoint history must be an array.");
  const recent = parsed.slice(-SNAPSHOT_HISTORY_LIMIT);
  const snapshots = recent.map(normalizeSnapshot);
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    if (ids.has(snapshot.id)) throw new Error("Checkpoint ids must be unique.");
    ids.add(snapshot.id);
  }
  return trimHistory(snapshots, SNAPSHOT_HISTORY_LIMIT, SNAPSHOT_HISTORY_MAX_BYTES);
}

export function createSnapshot(workspace: Workspace, id: string, label: string, at: string): WorkspaceSnapshot {
  if (!id.trim() || !label.trim()) throw new Error("Snapshot id and label are required.");
  return {
    id, label: label.trim(), createdAt: at,
    files: workspace.files.map((file) => ({ ...file, path: normalizePath(file.path) })),
    entry: normalizePath(workspace.entry), activeId: workspace.activeId,
  };
}

export function restoreSnapshot(snapshot: WorkspaceSnapshot): Workspace {
  return {
    files: snapshot.files.map((file) => ({ ...file, path: normalizePath(file.path) })),
    entry: normalizePath(snapshot.entry),
    activeId: snapshot.files.some((file) => file.id === snapshot.activeId) ? snapshot.activeId : snapshot.files[0]?.id ?? "",
  };
}

export function compareSnapshot(snapshot: WorkspaceSnapshot, workspace: Workspace): SnapshotDiff {
  const before = new Map(snapshot.files.map((file) => [file.path, file.content]));
  const after = new Map(workspace.files.map((file) => [file.path, file.content]));
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...before.keys()].filter((path) => after.has(path) && before.get(path) !== after.get(path)).sort();
  const unchanged = [...before.keys()].filter((path) => after.has(path) && before.get(path) === after.get(path)).sort();
  return { added, removed, changed, unchanged };
}

/** Keep checkpoint history bounded by count and serialized browser-storage size. */
export function retainSnapshots(snapshots: WorkspaceSnapshot[], next: WorkspaceSnapshot, limit = SNAPSHOT_HISTORY_LIMIT, maxBytes = SNAPSHOT_HISTORY_MAX_BYTES): WorkspaceSnapshot[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Snapshot limit must be a positive integer.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Snapshot byte limit must be a positive integer.");
  const candidates = [...snapshots.filter((item) => item.id !== next.id), next].slice(-limit);
  return trimHistory(candidates, limit, maxBytes);
}
