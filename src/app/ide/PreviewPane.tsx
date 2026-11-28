"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { buildPreviewDocument, WorkspaceError, type IdeFile } from "../../lib/ide/workspace";\nimport { parsePreviewConsoleMessage } from "../../lib/ide/previewConsole";

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
  const frameRef = useRef<HTMLIFrameElement>(null);
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
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!data || data.source !== "velnor-ide-console") return;
      const allowedLevels = new Set(["log", "info", "warn", "error", "debug"]);
      const level = allowedLevels.has(String(data.level)) ? String(data.level) : "log";
      onConsoleRef.current({ level, text: String(data.text ?? "").slice(0, 8_000) });
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
          ref={frameRef}
          sandbox="allow-scripts"
          srcDoc={document.html}
        />
      )}
    </div>
  );
}
