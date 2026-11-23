"use client";

import dynamic from "next/dynamic";
import { detectLanguage } from "../../lib/ide/workspace";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="ide-empty">Loading editor…</div>,
});

type EditorPaneProps = {
  path: string | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

export default function EditorPane({ path, value, onChange, onSave }: EditorPaneProps) {
  if (!path) {
    return <div className="ide-empty">Pick a file to start editing.</div>;
  }

  const language = detectLanguage(path);

  return (
    <div className="ide-editor">
      <MonacoEditor
        path={path}
        language={language === "plaintext" ? "plaintext" : language}
        value={value}
        theme="vs-dark"
        onChange={(next) => onChange(next ?? "")}
        onMount={(editor, monaco) => {
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
        }}
        options={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          minimap: { enabled: false },
          lineNumbersMinChars: 4,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          automaticLayout: true,
          renderLineHighlight: "gutter",
          padding: { top: 8, bottom: 8 },
        }}
      />
    </div>
  );
}
