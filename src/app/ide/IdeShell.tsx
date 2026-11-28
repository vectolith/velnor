"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  GitBranch,
  Upload,
  History,
  FilePlus2,
  PanelLeft,
  Play,
  Save,
  Search,
  Sparkles,
  Terminal,
  ChevronDown,
  Settings,
  Eye,
} from "lucide-react";
import EditorPane from "./EditorPane";
import FileTree from "./FileTree";
import PreviewPane, { type ConsoleLine } from "./PreviewPane";
import AiPanel from "./AiPanel";
import TaskPanel from "./TaskPanel";
import GitHubPanel from "./GitHubPanel";
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
import { buildAssistantWorkspaceContext } from "@/lib/ide/inventory";

const WORKSPACE_KEY = "velnor.ide.workspace.v1";
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
  const [githubOpen, setGithubOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);

  useEffect(() => {
    setWorkspace(readWorkspace());
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

  const importWorkspaceFiles = useCallback(async (selected: FileList | null) => {
    if (!selected?.length) return;
    try {
      const incoming = await Promise.all(Array.from(selected).map(async (file) => {
        const text = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          try {
            const parsed = JSON.parse(text) as { files?: Array<{ path?: unknown; content?: unknown }>; entry?: unknown };
            if (Array.isArray(parsed.files)) {
              return {
                files: parsed.files.map((item) => ({ path: String(item.path ?? ""), content: String(item.content ?? "") })),
                entry: typeof parsed.entry === "string" ? parsed.entry : null,
              };
            }
          } catch { /* treat non-bundle JSON as a normal file */ }
        }
        return { files: [{ path: file.name, content: text }], entry: null };
      }));
      const flattened = incoming.flatMap((bundle) => bundle.files).filter((item) => item.path.trim());
      if (!flattened.length) throw new WorkspaceError("The selected import contains no usable files.");
      setWorkspace((current) => {
        // Stage the entire import before committing so a capacity/path/size error
        // cannot leave a partially imported workspace.
        let files = [...current.files];
        for (const item of flattened) files = [...files, addFile(files, item.path, item.content)];
        const requestedEntry = incoming.find((bundle) => bundle.entry)?.entry;
        const entry = requestedEntry ? normalizePath(requestedEntry) : current.entry;
        const next = { ...current, files, entry, activeId: files.at(-1)?.id ?? current.activeId };
        persist(next);
        return next;
      });
      notify("Imported " + flattened.length + " file(s).");
    } catch (error) {
      notify(error instanceof WorkspaceError ? error.message : "Import failed. Check the file format and workspace limits.", "error");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [notify, persist]);

  const updateToken = useCallback((value: string) => setToken(value), []);

  const insertReply = useCallback(
    (reply: string) => {
      if (!active) {
        notify("Open a file before inserting a reply.", "error");
        return;
      }
      const next = active.content ? active.content.replace(/\s*$/, "\n\n") + reply : reply;
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
      { id: "import", label: "Import files", run: () => importInputRef.current?.click() },
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
    [addNewFile, checkpoint, deleteCurrent, exportWorkspace, importWorkspaceFiles, renameCurrent, restoreCheckpoint, run, save]
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
        <span className="ide-brand">velnor</span>
        <nav className="ide-menu-bar" aria-label="Application menus">
          <details className="ide-menu"><summary>File <ChevronDown size={12}/></summary><div className="ide-menu-popover"><button onClick={addNewFile}><FilePlus2/>New file</button><button onClick={() => importInputRef.current?.click()}><Upload/>Import files</button><button onClick={save}><Save/>Save workspace <kbd>⌘S</kbd></button><button onClick={renameCurrent}>Rename file</button><button onClick={deleteCurrent}>Delete file</button><button onClick={exportWorkspace}><Download/>Export workspace</button><button onClick={checkpoint}><History/>Create checkpoint</button><button onClick={restoreCheckpoint}><History/>Restore checkpoint</button></div></details>
          <details className="ide-menu"><summary>View <ChevronDown size={12}/></summary><div className="ide-menu-popover"><button onClick={() => setSidebarOpen(v=>!v)}><PanelLeft/>Toggle Explorer</button><button onClick={() => setPaletteOpen(true)}><Search/>Search / Commands <kbd>⌘K</kbd></button><button onClick={() => setAiOpen(v=>!v)}><Sparkles/>Toggle Assistant</button><button onClick={() => setReloadKey(v=>v+1)}><Eye/>Refresh preview</button><button onClick={() => setConsoleLines([])}><Terminal/>Clear console</button></div></details>
          <details className="ide-menu"><summary>Settings <ChevronDown size={12}/></summary><div className="ide-menu-popover"><button onClick={() => setAiOpen(true)}><Settings/>Assistant panel</button><button onClick={() => setPaletteOpen(true)}><Settings/>Commands and shortcuts</button></div></details>
        </nav>
        <span className="ide-path">{active ? active.path : "no file open"}</span>
        {dirtyIds.size > 0 ? <span className="ide-dirty">unsaved</span> : null}
        <input ref={importInputRef} type="file" multiple hidden accept=".json,.html,.htm,.css,.js,.jsx,.ts,.tsx,.md,.txt,.svg,.xml,.csv" onChange={(event) => void importWorkspaceFiles(event.target.files)} />
        <div className="ide-topbar-actions"><span className="ide-topbar-status">Workspace</span></div>
      </header>

      <div className={"ide-body" + (sidebarOpen ? "" : " is-collapsed")}>
        <nav className="ide-activity-rail" aria-label="IDE activity">
          <button type="button" className={"ide-rail-button"+(sidebarOpen ? " is-active":"")} onClick={() => setSidebarOpen(v => !v)} aria-label="Explorer" title="Explorer"><PanelLeft size={18}/></button>
          <button type="button" className="ide-rail-button" onClick={() => setPaletteOpen(true)} aria-label="Search" title="Search"><Search size={18}/></button>
          <button type="button" className="ide-rail-button" onClick={() => setGithubOpen(true)} aria-label="Source control and GitHub" title="Source control"><GitBranch size={18}/></button>
          <div className="ide-rail-divider"/>
          <button type="button" className="ide-rail-button ide-rail-run" onClick={run} aria-label="Run project" title="Run"><Play size={18}/></button>
          <div className="ide-rail-spacer"/>
          <button type="button" className={"ide-rail-button"+(aiOpen ? " is-active":"")} onClick={() => setAiOpen(v => !v)} aria-label="Assistant" title="Assistant"><Sparkles size={18}/></button>
        </nav>
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

        {tasksOpen ? <TaskPanel onClose={() => setTasksOpen(false)} /> : null}

        {aiOpen ? (
          <AiPanel
            token={token}
            onTokenChange={updateToken}
            contextPath={active ? active.path : null}
            workspaceContext={buildAssistantWorkspaceContext(workspace.files, active?.path)}
            onInsertReply={insertReply}
          />
        ) : null}
      </div>

      {githubOpen ? <GitHubPanel workspaceFiles={workspace.files} onClose={() => setGithubOpen(false)} onImport={(remoteFiles) => { try { setWorkspace(current => { let staged=[...current.files]; for(const file of remoteFiles) staged=[...staged,addFile(staged,file.path,file.content)]; const next={...current,files:staged,activeId:staged.at(-1)?.id??current.activeId}; persist(next); setDirtyIds(new Set(next.files.map(f=>f.id))); return next; }); notify("Imported repository files."); } catch(e) { notify(e instanceof WorkspaceError ? e.message : "Repository import failed.","error"); } }} /> : null}
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
