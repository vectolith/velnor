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

/** Keep snapshots in a bounded browser-local history; this is not server persistence. */
export function retainSnapshots(snapshots: WorkspaceSnapshot[], next: WorkspaceSnapshot, limit = 20): WorkspaceSnapshot[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Snapshot limit must be a positive integer.");
  return [...snapshots.filter((item) => item.id !== next.id), next].slice(-limit);
}
