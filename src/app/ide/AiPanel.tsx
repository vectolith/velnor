"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

type ChatEntry = {
  role: "user" | "assistant" | "error";
  text: string;
};

type AiPanelProps = {
  token: string;
  onTokenChange: (token: string) => void;
  contextPath: string | null;
  onInsertReply: (reply: string) => void;
};

export default function AiPanel({ token, onTokenChange, contextPath, onInsertReply }: AiPanelProps) {
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    setEntries((list) => [...list, { role: "user", text }]);
    try {
      const prompt = contextPath ? "File: " + contextPath + "\n\n" + text : text;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token.trim(),
        },
        body: JSON.stringify({ text: prompt, channel: "imessage" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload.error === "string"
            ? payload.error
            : "The assistant rejected that request (" + String(response.status) + ").";
        setEntries((list) => [...list, { role: "error", text: message }]);
        return;
      }
      const reply = payload && typeof payload.reply === "string" ? payload.reply : "The assistant returned an empty reply.";
      setEntries((list) => [...list, { role: "assistant", text: reply }]);
    } catch (error) {
      setEntries((list) => [
        ...list,
        { role: "error", text: error instanceof Error ? error.message : "The request failed." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="ide-assistant">
      <div className="ide-pane-head">
        <span>Assistant</span>
        <span className="ide-badge">{contextPath ?? "no file"}</span>
      </div>
      <div style={{ padding: "0.5rem" }}>
        <input
          className="ide-input"
          type="password"
          value={token}
          placeholder="API token (stored in this browser)"
          onChange={(event) => onTokenChange(event.target.value)}
        />
      </div>
      <div className="ide-assistant-log" ref={logRef}>
        {entries.length === 0 ? (
          <div className="ide-empty">
            Ask about the workspace, or paste a token to talk to Velnor. Nothing is sent anywhere until you hit send.
          </div>
        ) : null}
        {entries.map((entry, index) => (
          <div key={index} className="ide-message" data-role={entry.role}>
            {entry.text}
            {entry.role === "assistant" ? (
              <div style={{ marginTop: "0.4rem" }}>
                <button className="ide-button" type="button" onClick={() => onInsertReply(entry.text)}>
                  Insert into file
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="ide-assistant-form">
        <textarea
          className="ide-textarea"
          value={draft}
          placeholder="Ask the assistant…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="ide-button" type="button" data-primary="true" disabled={busy || !token.trim()} onClick={() => void send()}>
          <Send size={13} strokeWidth={2} />
          {busy ? "Thinking…" : token.trim() ? "Send" : "Token required"}
        </button>
      </div>
    </aside>
  );
}
