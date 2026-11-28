import { addFile, normalizePath, WorkspaceError, type IdeFile, type Workspace } from "./workspace";

export type WorkspaceBundle = { schemaVersion: 1; files: Array<{ path: string; content: string }>; entry: string };

const MAX_IMPORT_FILES = 40;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Strictly validate a workspace backup before mutating the active workspace. */
export function parseWorkspaceBundle(raw: string): WorkspaceBundle {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new WorkspaceError("Workspace backup is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceError("Workspace backup must be an object.");
  const record = value as Record<string, unknown>;
  if ((record.schemaVersion !== 1 && record.schemaVersion !== undefined) || !Array.isArray(record.files) || typeof record.entry !== "string") throw new WorkspaceError("Unsupported workspace backup format.");
  if (record.files.length < 1 || record.files.length > MAX_IMPORT_FILES) throw new WorkspaceError("Workspace backup must contain 1–40 files.");
  const paths = new Set<string>();
  let total = 0;
  const files = record.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new WorkspaceError("Invalid file record.");
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.content !== "string") throw new WorkspaceError("Each file requires a path and text content.");
    const path = normalizePath(file.path);
    const key = path.toLocaleLowerCase("en");
    if (paths.has(key)) throw new WorkspaceError("Workspace backup contains duplicate paths.");
    paths.add(key);
    const size = new TextEncoder().encode(file.content).byteLength;
    if (size > 512 * 1024) throw new WorkspaceError("A backup file exceeds the 512 KB file limit.");
    total += size;
    return { path, content: file.content };
  });
  if (total > MAX_IMPORT_BYTES) throw new WorkspaceError("Workspace backup exceeds the 8 MB total limit.");
  const entry = normalizePath(record.entry);
  if (!paths.has(entry.toLocaleLowerCase("en"))) throw new WorkspaceError("Workspace entry file is missing from the backup.");
  return { schemaVersion: 1 as const, files, entry };
}

/** Stage import additions atomically, rejecting capacity overflow before applying. */
export function stageWorkspaceImport(existing: IdeFile[], bundle: WorkspaceBundle): IdeFile[] {
  if (existing.length + bundle.files.length > MAX_IMPORT_FILES) throw new WorkspaceError("Import would exceed the 40-file workspace limit.");
  let staged = [...existing];
  for (const file of bundle.files) staged = [...staged, addFile(staged, file.path, file.content)];
  return staged;
}

/** Restore a validated bundle as a complete workspace, preserving its entry path. */
export function createWorkspaceFromBundle(bundle: WorkspaceBundle): Workspace {
  let files: IdeFile[] = [];
  for (const file of bundle.files) files = [...files, addFile(files, file.path, file.content)];
  const entry = normalizePath(bundle.entry);
  const activeId = files.find((file) => file.path.toLowerCase() === entry.toLowerCase())?.id ?? files[0]?.id ?? "";
  return { files, entry, activeId };
}
