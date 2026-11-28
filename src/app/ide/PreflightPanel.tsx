"use client";

import { FileCheck, RefreshCw, X } from "lucide-react";
import { buildChangePreflight } from "@/lib/ide/preflight";
import type { WorkspaceSnapshot } from "@/lib/ide/snapshots";
import type { Workspace } from "@/lib/ide/workspace";

type Props = { workspace: Workspace; snapshots: WorkspaceSnapshot[]; onCreateBaseline: () => void; onClose: () => void };

function ChangeList({ title, files }: { title: string; files: string[] }) {
  if (!files.length) return null;
  return <section className="ide-preflight-section"><h3>{title} <span>{files.length}</span></h3><ul>{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></section>;
}

export default function PreflightPanel({ workspace, snapshots, onCreateBaseline, onClose }: Props) {
  const baseline = snapshots.at(-1);
  const report = baseline ? buildChangePreflight(workspace, baseline) : null;
  const changedCount = report ? report.added.length + report.removed.length + report.changed.length + Number(report.entryChanged) : 0;
  return (
    <aside className="ide-preflight-panel" aria-label="Workspace change preflight">
      <div className="ide-preflight-head"><div><FileCheck size={15}/><span>Change preflight</span><small>workspace analysis</small></div><button className="ide-icon-button" type="button" onClick={onClose} aria-label="Close preflight"><X size={15}/></button></div>
      <div className="ide-preflight-tools"><button className="ide-button" type="button" onClick={onCreateBaseline}><RefreshCw size={13}/>Save new baseline</button><p>Compare the current workspace with the most recent browser-local checkpoint. This is a heuristic report, not a build or security certification.</p></div>
      {!baseline ? <div className="ide-empty ide-preflight-empty">No checkpoint baseline exists. Create one to start comparing workspace changes.</div> : (
        <div className="ide-preflight-content">
          <div className="ide-preflight-baseline"><small>Baseline</small><strong>{baseline.label}</strong><span>{new Date(baseline.createdAt).toLocaleString()}</span></div>
          <div className="ide-preflight-stats"><div><strong>{report?.changed.length ?? 0}</strong><span>Modified</span></div><div><strong>{report?.added.length ?? 0}</strong><span>Added</span></div><div><strong>{report?.removed.length ?? 0}</strong><span>Removed</span></div><div><strong>{report?.fileCount ?? 0}</strong><span>Files</span></div></div>
          <p className="ide-preflight-size">{report ? (report.totalBytes / 1024).toFixed(1) + " KB" : "0 KB"} workspace content</p>
          {report?.findings.length ? <section className="ide-preflight-section"><h3>Findings <span>{report.findings.length}</span></h3>{report.findings.map((finding,index)=><article className={"ide-preflight-finding is-"+finding.severity} key={index}><strong>{finding.severity}</strong><p>{finding.message}</p>{finding.files?.length ? <small>{finding.files.join(", ")}</small> : null}</article>)}</section> : <p className="ide-preflight-clean">No file-aware findings were detected.</p>}
          <ChangeList title="Modified files" files={report?.changed ?? []}/><ChangeList title="Added files" files={report?.added ?? []}/><ChangeList title="Removed files" files={report?.removed ?? []}/>
          {report?.entryChanged ? <section className="ide-preflight-section"><h3>Entry file</h3><p>The workspace entry path differs from the baseline.</p></section> : null}
          {report?.activeChanged ? <p className="ide-preflight-size">Active editor selection differs from the baseline.</p> : null}
          {changedCount === 0 ? <p className="ide-preflight-clean">Workspace files and entry path match the baseline.</p> : null}
        </div>
      )}
    </aside>
  );
}
