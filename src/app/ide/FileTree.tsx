"use client";

import { FileCode2, FileJson, FileText, FileType2, Plus } from "lucide-react";
import { detectLanguage, sortFiles, type IdeFile } from "../../lib/ide/workspace";

type FileTreeProps = {
  files: IdeFile[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
};

function FileIcon({ path }: { path: string }) {
  const language = detectLanguage(path);
  if (language === "json") return <FileJson size={14} strokeWidth={1.6} />;
  if (language === "html" || language === "css") return <FileCode2 size={14} strokeWidth={1.6} />;
  if (language === "javascript" || language === "typescript") return <FileType2 size={14} strokeWidth={1.6} />;
  return <FileText size={14} strokeWidth={1.6} />;
}

export default function FileTree({ files, activeId, onSelect, onAdd }: FileTreeProps) {
  return (
    <aside className="ide-sidebar">
      <div className="ide-sidebar-head">
        <span>Files</span>
        <button className="ide-button" type="button" onClick={onAdd} aria-label="New file" title="New file">
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="ide-file-list">
        {files.length === 0 ? <div className="ide-empty">No files yet.</div> : null}
        {sortFiles(files).map((file) => (
          <button
            key={file.id}
            type="button"
            className="ide-file"
            data-active={file.id === activeId}
            onClick={() => onSelect(file.id)}
            title={file.path}
          >
            <FileIcon path={file.path} />
            <span className="ide-file-name">{file.path}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
