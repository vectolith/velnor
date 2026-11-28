import { analyzeWorkspace } from "./inventory";
import { compareSnapshot, type WorkspaceSnapshot } from "./snapshots";
import type { Workspace } from "./workspace";

export type ChangePreflight = {
  added: string[]; removed: string[]; changed: string[]; unchanged: string[];
  entryChanged: boolean; activeChanged: boolean;
  findings: Array<{ severity: "warning" | "info"; message: string; files?: string[] }>;
  totalBytes: number; fileCount: number;
};

/** Compare the current workspace with a saved baseline and surface file-aware observations. */
export function buildChangePreflight(workspace: Workspace, snapshot: WorkspaceSnapshot): ChangePreflight {
  const diff = compareSnapshot(snapshot, workspace);
  const inventory = analyzeWorkspace(workspace.files);
  const changed = new Set([...diff.added, ...diff.changed, ...diff.removed]);
  const findings: ChangePreflight["findings"] = [];
  if (diff.removed.length) findings.push({ severity: "warning", message: "Files were removed; verify imports and references.", files: diff.removed });
  if (diff.changed.length) findings.push({ severity: "info", message: "Modified files require review before execution or release.", files: diff.changed });
  if (diff.added.length) findings.push({ severity: "info", message: "New files require review before execution or release.", files: diff.added });
  const entryChanged = workspace.entry !== snapshot.entry;
  const activeChanged = workspace.activeId !== snapshot.activeId;
  if (entryChanged) findings.push({ severity: "warning", message: "Entry file changed from " + snapshot.entry + " to " + workspace.entry + "." });
  if (activeChanged) findings.push({ severity: "info", message: "The active editor file differs from the saved baseline." });
  for (const observation of inventory.observations) {
    const relevant = observation.files?.filter((path) => changed.has(path));
    if (!observation.files || relevant?.length) findings.push({ severity: observation.severity, message: observation.message, files: relevant });
  }
  return { ...diff, entryChanged, activeChanged, findings, totalBytes: inventory.totalBytes, fileCount: inventory.fileCount };
}
