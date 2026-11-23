"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { buildPreviewDocument, WorkspaceError, type IdeFile } from "../../lib/ide/workspace";

export type ConsoleLine = { level: string; text: string };

type PreviewPaneProps = {
  files: IdeFile[];
  reloadKey: number;
  onConsole: (line: ConsoleLine) => void;
  onClearConsole: () => void;
};

export default function PreviewPane({ files, reloadKey, onConsole, onClearConsole }: PreviewPaneProps) {
  const [nonce, setNonce] = useState(0);
  const onConsoleRef = useRef(onConsole);
  onConsoleRef.current = onConsole;

  const document = useMemo(() => {
    try {
      return { html: buildPreviewDocument(files), error: null as string | null };
    } catch (error) {
      const message = error instanceof WorkspaceError ? error.message : "The preview could not be built.";
      return { html: "", error: message };
    }
  }, [files]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.source !== "velnor-ide-console") return;
      onConsoleRef.current({ level: String(data.level || "log"), text: String(data.text ?? "") });
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div className="ide-pane">
      <div className="ide-pane-head">
        <span>Preview</span>
        <span style={{ display: "inline-flex", gap: "0.35rem" }}>
          <button className="ide-button" type="button" onClick={onClearConsole}>
            Clear console
          </button>
          <button className="ide-button" type="button" onClick={() => setNonce((value) => value + 1)} title="Reload preview">
            <RotateCw size={13} strokeWidth={2} />
          </button>
        </span>
      </div>
      {document.error ? (
        <div className="ide-empty">{document.error}</div>
      ) : (
        <iframe
          key={String(reloadKey) + ":" + String(nonce)}
          className="ide-preview-frame"
          title="Workspace preview"
          sandbox="allow-scripts allow-forms allow-modals"
          srcDoc={document.html}
        />
      )}
    </div>
  );
}
