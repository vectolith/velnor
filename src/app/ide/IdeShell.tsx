"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  History,
  FilePlus2,
  PanelLeft,
  Play,
  Save,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import EditorPane from "./EditorPane";
import FileTree from "./FileTree";
import PreviewPane, { type ConsoleLine } from "./PreviewPane";
import AiPanel from "./AiPanel";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import {
  WorkspaceError,
  addFile,
  createDefaultWorkspace,
  entryFile,
  makeFileId,
  normalizePath,
  removeFile,
  renameFile,
  sortFiles,
  updateContent,
  type IdeFile,
  type Workspace,
} from "@/lib/ide/workspace";
import { createSnapshot, restoreSnapshot, retainSnapshots, type WorkspaceSnapshot } from "@/lib/ide/snapshots";

const WORKSPACE_KEY = "velnor.ide.workspace.v1";
const TOKEN_KEY = "velnor.ide.token.v1";
const SNAPSHOTS_KEY = "velnor.ide.snapshots.v1";

type Toast = { text: string; tone: "info" | "error" };

function readWorkspace(): Workspace {
  if (typeof window === "undefined") return createDefaultWorkspace();
  try {
    const raw = window.localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return createDefaultWorkspace();
    const parsed = JSON.parse(raw) as Workspace;
    if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
      return createDefaultWorkspace();
    }
    const files: IdeFile[] = [];
    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    for (const candidate of parsed.files) {
      if (!candidate || typeof candidate.path !== "string" || typeof candidate.content !== "string") continue;
      if (candidate.content.length > 512 * 1024 || files.length >= 40) continue;
      const path = normalizePath(candidate.path);
      const pathKey = path.toLowerCase();
      if (seenPaths.has(pathKey)) continue;
      let id = typeof candidate.id === "string" && candidate.id ? candidate.id : makeFileId(files);
      if (seenIds.has(id)) id = makeFileId(files);
      seenPaths.add(pathKey);
      seenIds.add(id);
      files.push({ id, path, content: candidate.content });
    }
    if (!files.length) return createDefaultWorkspace();
    const activeId = files.some((file) => file.id === parsed.activeId) ? parsed.activeId : files[0].id;
    const entry = typeof parsed.entry === "string" ? normalizePath(parsed.entry) : "index.html";
    return { files, entry, activeId };
  } catch {
    return createDefaultWorkspace();
  }
}

export function IdeShell() {
  const [workspace, setWorkspace] = useState<Workspace>(() => createDefaultWorkspace());
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(true);
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);

  useEffect(() => {
    setWorkspace(readWorkspace());
    try {
      setToken(window.localStorage.getItem(TOKEN_KEY) ?? "");
    } catch {
      setToken("");
    }
    setReady(true);
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    setToast({ text, tone });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
      } catch {
        notify("Autosave failed: browser storage is full or blocked.", "error");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [ready, workspace, notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const persist = useCallback(
    (next: Workspace) => {
      try {
        window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
        notify("Saved to this browser.");
      } catch {
        notify("Could not save: browser storage is full or blocked.", "error");
      }
    },
    [notify]
  );

  const active = useMemo(
    () => workspace.files.find((file) => file.id === workspace.activeId) ?? null,
    [workspace]
  );

  const orderedFiles = useMemo(() => sortFiles(workspace.files), [workspace.files]);

  const updateActiveContent = useCallback(
    (value: string) => {
      if (!active) return;
      try {
        setWorkspace((current) => ({
          ...current,
          files: updateContent(current.files, current.activeId, value),
        }));
        setDirtyIds((current) => {
          const next = new Set(current);
          next.add(active.id);
          return next;
        });
      } catch (error) {
        notify(error instanceof WorkspaceError ? error.message : "Could not update the file.", "error");
      }
    },
    [active, notify]
  );

  const save = useCallback(() => {
    persist(workspace);
    setDirtyIds(new Set());
  }, [persist, workspace]);

  const run = useCallback(() => {
    setConsoleLines([]);
    setReloadKey((value) => value + 1);
  }, []);

  const addNewFile = useCallback(() => {
    const proposed = window.prompt("New file path", "src/main.js");
    if (proposed === null) return;
    try {
      const file = addFile(workspace.files, proposed);
      setWorkspace((current) => ({
        ...current,
        files: [...current.files, file],
        activeId: file.id,
      }));
      notify("Created " + file.path);
    } catch (error) {
      notify(error instanceof WorkspaceError ? error.message : "Could not create the file.", "error");
    }
  }, [notify, workspace.files]);

  const renameCurrent = useCallback(() => {
    if (!active) {
      notify("Open a file first.", "error");
      return;
    }
    const proposed = window.prompt("Rename " + active.path + " to", active.path);
    if (proposed === null) return;
    try {
      setWorkspace((current) => ({
        ...current,
        files: renameFile(current.files, active.id, proposed),
      }));
      notify("Renamed.");
    } catch (error) {
      notify(error instanceof WorkspaceError ? error.message : "Could not rename the file.", "error");
    }
  }, [active, notify]);

  const deleteCurrent = useCallback(() => {
    if (!active) {
      notify("Open a file first.", "error");
      return;
    }
    if (!window.confirm("Delete " + active.path + "? This cannot be undone.")) return;
    setWorkspace((current) => {
      const files = removeFile(current.files, active.id);
      const next = files.length ? files : createDefaultWorkspace().files;
      return { ...current, files: next, activeId: next[0].id };
    });
    setDirtyIds((current) => {
      const next = new Set(current);
      next.delete(active.id);
      return next;
    });
    notify("Deleted " + active.path);
  }, [active, notify]);

  const exportWorkspace = useCallback(() => {
    const bundle = JSON.stringify({ files: workspace.files, entry: workspace.entry }, null, 2);
    const blob = new Blob([bundle], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "velnor-workspace.json";
    link.click();
    URL.revokeObjectURL(url);
    notify("Exported velnor-workspace.json");
  }, [notify, workspace]);

  const updateToken = useCallback((value: string) => {
    setToken(value);
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked: the token still works for this tab */
    }
  }, []);

  const insertReply = useCallback(
    (reply: string) => {
      if (!active) {
        notify("Open a file before inserting a reply.", "error");
        return;
      }
      const next = active.content ? active.content.replace(/\s*$/, "

") + reply : reply;
      try {
        setWorkspace((current) => ({
          ...current,
          files: updateContent(current.files, current.activeId, next),
        }));
        setDirtyIds((current) => {
          const updated = new Set(current);
          updated.add(active.id);
          return updated;
        });
        notify("Inserted into " + active.path);
      } catch (error) {
        notify(error instanceof WorkspaceError ? error.message : "Could not insert the reply.", "error");
      }
    },
    [active, notify]
  );

  const checkpoint = useCallback(() => {
    try {
      const existing = JSON.parse(window.localStorage.getItem(SNAPSHOTS_KEY) ?? "[]") as WorkspaceSnapshot[];
      const next = createSnapshot(workspace, String(Date.now()), "Checkpoint " + new Date().toLocaleString(), new Date().toISOString());
      const retained = retainSnapshots(existing, next, 20);
      window.localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(retained));
      setSnapshots(retained);
      notify("Workspace checkpoint created.");
    } catch {
      notify("Could not create checkpoint.", "error");
    }
  }, [notify, workspace]);

  const restoreCheckpoint = useCallback(() => {
    try {
      const history = JSON.parse(window.localStorage.getItem(SNAPSHOTS_KEY) ?? "[]") as WorkspaceSnapshot[];
      setSnapshots(history);
      if (!history.length) { notify("No checkpoints available."); return; }
      const choices = history.map((item, index) => index + ": " + item.label + " (" + item.createdAt + ")").join("\n");
      const selected = window.prompt("Choose checkpoint index to restore:\n" + choices, String(history.length - 1));
      if (selected === null) return;
      const index = Number(selected);
      if (!Number.isInteger(index) || index < 0 || index >= history.length) { notify("Invalid checkpoint selection.", "error"); return; }
      if (!window.confirm("Restore this checkpoint? Current workspace changes may be overwritten.")) return;
      const restored = restoreSnapshot(history[index]);
      setWorkspace(restored);
      setDirtyIds(new Set(restored.files.map((file) => file.id)));
      persist(restored);
      setReloadKey((value) => value + 1);
      notify("Checkpoint restored.");
    } catch {
      notify("Could not restore checkpoint.", "error");
    }
  }, [notify, persist]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: "run", label: "Run preview", hint: "Cmd+Enter", run },
      { id: "save", label: "Save workspace", hint: "Cmd+S", run: save },
      { id: "checkpoint", label: "Create workspace checkpoint", run: checkpoint },
      { id: "restore", label: "Restore workspace checkpoint", run: restoreCheckpoint },
      { id: "new", label: "New file", run: addNewFile },
      { id: "rename", label: "Rename current file", run: renameCurrent },
      { id: "delete", label: "Delete current file", run: deleteCurrent },
      { id: "export", label: "Export workspace as JSON", run: exportWorkspace },
      {
        id: "sidebar",
        label: "Toggle file tree",
        run: () => setSidebarOpen((value) => !value),
      },
      {
        id: "assistant",
        label: "Toggle assistant",
        run: () => setAiOpen((value) => !value),
      },
      {
        id: "clear",
        label: "Clear console",
        run: () => setConsoleLines([]),
      },
    ],
    [addNewFile, checkpoint, deleteCurrent, exportWorkspace, renameCurrent, restoreCheckpoint, run, save]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      } else if (meta && event.key === "Enter") {
        event.preventDefault();
        run();
      } else if (meta && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run, save]);

  const entry = entryFile(workspace.files);

  return (
    <div className="ide-root">
      <header className="ide-topbar">
        <button
          type="button"
          className="ide-icon-button"
          onClick={() => setSidebarOpen((value) => !value)}
          aria-label="Toggle file tree"
        >
          <PanelLeft size={16} strokeWidth={1.6} />
        </button>
        <span className="ide-brand">velnor ide</span>
        <span className="ide-path">{active ? active.path : "no file open"}</span>
        {dirtyIds.size > 0 ? <span className="ide-dirty">unsaved</span> : null}
        <div className="ide-topbar-actions">
          <button type="button" className="ide-icon-button" onClick={() => setPaletteOpen(true)} aria-label="Commands">
            <Search size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-icon-button" onClick={addNewFile} aria-label="New file">
            <FilePlus2 size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-icon-button" onClick={save} aria-label="Save workspace">
            <Save size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-icon-button" onClick={checkpoint} aria-label="Create checkpoint" title="Create checkpoint">
            <History size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-icon-button" onClick={restoreCheckpoint} aria-label="Restore checkpoint" title="Restore checkpoint">
            <History size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-icon-button" onClick={exportWorkspace} aria-label="Export workspace">
            <Download size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="ide-run-button" onClick={run}>
            <Play size={14} strokeWidth={1.8} />
            Run
          </button>
          <button
            type="button"
            className="ide-icon-button"
            onClick={() => setAiOpen((value) => !value)}
            aria-label="Toggle assistant"
          >
            <Sparkles size={16} strokeWidth={1.6} />
          </button>
        </div>
      </header>

      <div className={"ide-body" + (sidebarOpen ? "" : " is-collapsed")}>
        {sidebarOpen ? (
          <FileTree
            files={orderedFiles}
            activeId={workspace.activeId}
            onSelect={(id) => setWorkspace((current) => ({ ...current, activeId: id }))}
            onAdd={addNewFile}
          />
        ) : null}

        <main className="ide-main">
          <EditorPane
            path={active ? active.path : null}
            value={active ? active.content : ""}
            onChange={updateActiveContent}
            onSave={save}
          />
          <section className="ide-console">
            <div className="ide-console-head">
              <span className="ide-console-title">
                <Terminal size={14} strokeWidth={1.6} /> console
              </span>
              <button type="button" className="ide-text-button" onClick={() => setConsoleLines([])}>
                clear
              </button>
            </div>
            <div className="ide-console-body">
              {consoleLines.length === 0 ? (
                <p className="ide-console-hint">Press Run to execute {entry ? entry.path : "index.html"}.</p>
              ) : (
                consoleLines.map((line, index) => (
                  <div key={index} className={"ide-console-line is-" + line.level}>
                    <span className="ide-console-level">{line.level}</span>
                    <span>{line.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>

        <PreviewPane
          files={workspace.files}
          reloadKey={reloadKey}
          onConsole={(line) => setConsoleLines((current) => [...current.slice(-199), line])}
          onClearConsole={() => setConsoleLines([])}
        />

        {aiOpen ? (
          <AiPanel
            token={token}
            onTokenChange={updateToken}
            contextPath={active ? active.path : null}
            onInsertReply={insertReply}
          />
        ) : null}
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      {toast ? (
        <div className={"ide-toast" + (toast.tone === "error" ? " is-error" : "")} role="status">
          {toast.text}
        </div>
      ) : null}
      {!ready ? null : null}
    </div>
  );
}

export default IdeShell;
