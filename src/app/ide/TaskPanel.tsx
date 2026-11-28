"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileText, Plus, RotateCcw, X } from "lucide-react";
import { addTaskNote, completeTask, transitionTask, type IdeTask, type TaskStatus } from "@/lib/ide/tasks";
import { addLedgerTask, emptyTaskLedger, parseTaskLedger, replaceLedgerTask, type TaskLedger, TASK_LEDGER_MAX_BYTES } from "@/lib/ide/taskLedger";

const STORAGE_KEY = "velnor.ide.tasks.v1";
const labels: Record<TaskStatus, string> = { queued: "Queued", planning: "Planning", executing: "Executing", validating: "Validating", completed: "Completed", blocked: "Blocked", cancelled: "Cancelled" };

type Props = { onClose: () => void };

export default function TaskPanel({ onClose }: Props) {
  const [ledger, setLedger] = useState<TaskLedger>(emptyTaskLedger());
  const [ready, setReady] = useState(false);
  const [title, setTitle] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setLedger(parseTaskLedger(raw));
    } catch {
      setLedger(emptyTaskLedger());
      setNotice("Saved task data could not be read. A clean ledger is shown; export/import backups can help recover older data.");
    } finally {
      setReady(true);
    }
  }, []);

  function commit(next: TaskLedger) {
    const raw = JSON.stringify(next);
    if (new TextEncoder().encode(raw).byteLength > TASK_LEDGER_MAX_BYTES) {
      setNotice("Task ledger exceeds the 1 MB limit. Export a backup or remove older tasks/events.");
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, raw);
      setLedger(parseTaskLedger(raw));
      setNotice("Saved in this browser.");
    } catch {
      setNotice("Storage write failed. The change is not persisted; export a backup or free browser storage.");
    }
  }

  function create() {
    const value = title.trim();
    if (!value) return;
    try {
      const at = new Date().toISOString();
      const id = "task-" + at.replace(/[^0-9]/g, "") + "-" + Math.random().toString(36).slice(2, 7);
      const next = addLedgerTask(ledger, id, value, at);
      commit(next);
      setTitle("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task could not be created.");
    }
  }

  function move(task: IdeTask, nextStatus: TaskStatus, detail?: string) {
    try {
      commit(replaceLedgerTask(ledger, transitionTask(task, nextStatus, new Date().toISOString(), detail)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task state could not be changed.");
    }
  }

  function addNote(task: IdeTask) {
    const value = (notes[task.id] ?? "").trim();
    if (!value) return;
    try {
      commit(replaceLedgerTask(ledger, addTaskNote(task, value, new Date().toISOString())));
      setNotes((current) => ({ ...current, [task.id]: "" }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Note could not be saved.");
    }
  }

  function finish(task: IdeTask) {
    const checks = (evidence[task.id] ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
    if (!checks.length || !confirmed[task.id]) {
      setNotice("Enter the validation checks and confirm that each listed check passed.");
      return;
    }
    try {
      const at = new Date().toISOString();
      const next = completeTask(task, { at, checks: checks.map((name) => ({ name, passed: true })), summary: "Checks manually recorded and confirmed in the task ledger." });
      commit(replaceLedgerTask(ledger, next));
      setEvidence((current) => ({ ...current, [task.id]: "" }));
      setConfirmed((current) => ({ ...current, [task.id]: false }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task could not be completed.");
    }
  }

  function exportLedger() {
    const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "velnor-task-ledger.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importLedger(file: File | undefined) {
    if (!file) return;
    if (file.size > TASK_LEDGER_MAX_BYTES) { setNotice("Task ledger backup exceeds the 1 MB limit."); if (importRef.current) importRef.current.value = ""; return; }
    try {
      const next = parseTaskLedger(await file.text());
      commit(next);
      setNotice("Imported task ledger. It remains stored locally in this browser.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task ledger import failed.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  return (
    <aside className="ide-task-panel">
      <div className="ide-task-head">
        <div><FileText size={15} /><span>Task ledger</span><small>browser-local</small></div>
        <button className="ide-icon-button" type="button" onClick={onClose} aria-label="Close task ledger"><X size={15} /></button>
      </div>
      <div className="ide-task-create">
        <form onSubmit={(event) => { event.preventDefault(); create(); }}>
          <input className="ide-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add an engineering task…" aria-label="Task title" maxLength={500} />
          <button className="ide-button" type="submit" disabled={!title.trim()}><Plus size={14} /> Create</button>
        </form>
        <div className="ide-task-tools">
          <button className="ide-button" type="button" onClick={exportLedger}><Download size={13} /> Export backup</button>
          <button className="ide-button" type="button" onClick={() => importRef.current?.click()}>Import backup</button>
          <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={(event) => void importLedger(event.target.files?.[0])} />
        </div>
        <p className="ide-task-local-note">Tasks and notes are stored in this browser only. This is not server backup or cross-device persistence. Completion records checks you confirm; it does not run tests itself.</p>
      </div>
      <div className="ide-task-list">
        {!ready ? <div className="ide-empty">Loading ledger…</div> : ledger.tasks.length === 0 ? <div className="ide-empty">No tasks yet. Create a task to track work and validation evidence.</div> : null}
        {ledger.tasks.map((task) => (
          <article className="ide-task-card" key={task.id}>
            <div className="ide-task-card-title"><strong>{task.title}</strong><span data-status={task.status}>{labels[task.status]}</span></div>
            <small className="ide-task-meta">Updated {new Date(task.updatedAt).toLocaleString()}</small>
            <div className="ide-task-actions">
              {task.status === "queued" ? <button className="ide-button" onClick={() => move(task, "planning")}>Start planning</button> : null}
              {task.status === "planning" ? <button className="ide-button" onClick={() => move(task, "executing")}>Begin execution</button> : null}
              {task.status === "executing" ? <button className="ide-button" onClick={() => move(task, "validating")}>Start validation</button> : null}
              {task.status === "validating" ? <button className="ide-button" onClick={() => move(task, "executing", "Validation did not pass; return to execution.")}><RotateCcw size={13} /> Retry work</button> : null}
              {task.status === "blocked" ? <button className="ide-button" onClick={() => move(task, "planning", "Resume after blocker review.")}>Resume</button> : null}
              {["planning", "executing", "validating"].includes(task.status) ? <button className="ide-button" onClick={() => move(task, "blocked", "Blocked by an unresolved dependency or decision.")}>Mark blocked</button> : null}
              {["queued", "planning", "executing", "validating", "blocked"].includes(task.status) ? <button className="ide-button" onClick={() => move(task, "cancelled", "Cancelled by the user.")}>Cancel</button> : null}
            </div>
            {task.status === "validating" ? (
              <div className="ide-task-evidence">
                <label>Validation checks, one per line</label>
                <textarea className="ide-textarea" rows={3} value={evidence[task.id] ?? ""} onChange={(event) => setEvidence((current) => ({ ...current, [task.id]: event.target.value }))} placeholder="Unit tests passed\nTypecheck passed\nBuild passed" maxLength={4_200} />
                <label className="ide-task-confirm"><input type="checkbox" checked={confirmed[task.id] ?? false} onChange={(event) => setConfirmed((current) => ({ ...current, [task.id]: event.target.checked }))} /> I confirm each listed check passed</label>
                <button className="ide-button" data-primary="true" onClick={() => finish(task)} disabled={!confirmed[task.id] || !(evidence[task.id] ?? "").trim()}><CheckCircle2 size={13} /> Record completion</button>
              </div>
            ) : null}
            <div className="ide-task-note-form">
              <input className="ide-input" value={notes[task.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [task.id]: event.target.value }))} placeholder="Add a note…" maxLength={1_000} />
              <button className="ide-button" onClick={() => addNote(task)} disabled={!(notes[task.id] ?? "").trim()}>Add</button>
            </div>
            <details className="ide-task-events">
              <summary>{task.events.length} event{task.events.length === 1 ? "" : "s"} <span>history</span></summary>
              {task.events.slice().reverse().map((event, index) => <div className="ide-task-event" key={task.id + "-" + index}><small>{new Date(event.at).toLocaleString()}</small><p>{event.detail}</p>{event.evidence ? <ul>{event.evidence.checks.map((check, i) => <li key={i}><CheckCircle2 size={12} /> {check.name} <em>confirmed</em></li>)}</ul> : null}</div>)}
            </details>
          </article>
        ))}
      </div>
      {notice ? <div className="ide-task-notice" role="status"><AlertCircle size={13} />{notice}</div> : null}
    </aside>
  );
}
