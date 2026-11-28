export type PreviewConsoleLine = { level: "log" | "info" | "warn" | "error" | "debug"; text: string };

const allowedLevels = new Set<PreviewConsoleLine["level"]>(["log", "info", "warn", "error", "debug"]);
const MAX_PREVIEW_CONSOLE_TEXT = 8_000;

/** Validate and bound the iframe console bridge payload before it reaches the IDE UI. */
export function parsePreviewConsoleMessage(data: unknown, sourceWindowMatches: boolean): PreviewConsoleLine | null {
  if (!sourceWindowMatches || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const payload = data as Record<string, unknown>;
  if (payload.source !== "velnor-ide-console") return null;
  const level = allowedLevels.has(payload.level as PreviewConsoleLine["level"])
    ? payload.level as PreviewConsoleLine["level"]
    : "log";
  const text = typeof payload.text === "string" ? payload.text : payload.text == null ? "" : String(payload.text);
  return { level, text: text.slice(0, MAX_PREVIEW_CONSOLE_TEXT) };
}
