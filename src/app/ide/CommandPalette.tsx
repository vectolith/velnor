"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
};

export default function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => Math.max(value - 1, 0));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = matches[active];
        if (command) {
          command.run();
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, matches, onClose, open]);

  if (!open) return null;

  return (
    <div className="ide-palette-backdrop" onMouseDown={onClose}>
      <div className="ide-palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="ide-palette-input"
          value={query}
          placeholder="Type a command…"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div className="ide-palette-list">
          {matches.length === 0 ? <div className="ide-empty">No matching command.</div> : null}
          {matches.map((command, index) => (
            <button
              key={command.id}
              type="button"
              className="ide-palette-item"
              data-active={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                command.run();
                onClose();
              }}
            >
              <span>{command.label}</span>
              {command.hint ? <span className="ide-palette-hint">{command.hint}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
