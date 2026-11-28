"use client";

import { FileCode2, FileJson, FileText, FileType2, Plus, FileImage, FileSpreadsheet, FileTerminal, FileCog, FileSymlink, FileArchive } from "lucide-react";
import { detectLanguage, sortFiles, type IdeFile } from "../../lib/ide/workspace";

type FileTreeProps = {
  files: IdeFile[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
};

function FileIcon({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const language = detectLanguage(path);
  if (language === "json" || ["json", "jsonc"].includes(ext)) return <FileJson size={15} strokeWidth={1.7} />;
  if (["html", "htm", "css", "scss", "sass", "less"].includes(ext)) return <FileCode2 size={15} strokeWidth={1.7} />;
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return <FileType2 size={15} strokeWidth={1.7} />;
  if (["md", "mdx", "txt", "rst"].includes(ext)) return <FileText size={15} strokeWidth={1.7} />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return <FileImage size={15} strokeWidth={1.7} />;
  if (["csv", "xls", "xlsx"].includes(ext)) return <FileSpreadsheet size={15} strokeWidth={1.7} />;
  if (["sh", "bash", "zsh", "ps1"].includes(ext)) return <FileTerminal size={15} strokeWidth={1.7} />;
  if (["yml", "yaml", "toml", "ini", "env"].includes(ext)) return <FileCog size={15} strokeWidth={1.7} />;
  if (["zip", "gz", "tar", "7z"].includes(ext)) return <FileArchive size={15} strokeWidth={1.7} />;
  if (["lnk"].includes(ext)) return <FileSymlink size={15} strokeWidth={1.7} />;
  return <FileText size={15} strokeWidth={1.7} />;
}

export default function FileTree({ files, activeId, onSelect, onAdd }: FileTreeProps) {
  const ordered = sortFiles(files);
  return (
    <aside className="ide-file-tree" aria-label="File explorer">
      <div className="ide-file-tree-head"><span>EXPLORER</span><button type="button" onClick={onAdd} title="New file" aria-label="New file"><Plus size={15}/></button></div>
      <div className="ide-file-tree-list">
        {ordered.map((file) => (
          <button type="button" key={file.id} className={"ide-file-tree-item"+(file.id===activeId ? " is-active":"")} onClick={() => onSelect(file.id)} title={file.path}>
            <FileIcon path={file.path}/><span>{file.path}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
