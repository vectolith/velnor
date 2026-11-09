// Plain-text formatting for SMS / iMessage / Slack destinations.
// These channels have no markdown renderer: bold/italic/code markers and
// heading hashes leak through as literal characters, so strip them.

const MARKDOWN_PATTERNS: Array<[RegExp, string]> = [
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/\*([^*\n]+)\*/g, "$1"],
  [/_([^_\n]+)_/g, "$1"],
  [/\`\`\`[a-z]*\n?/g, ""],
  [/\`([^\`]+)\`/g, "$1"],
  [/^#{1,6}\s+/gm, ""],
  [/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"],
  [/^\s*[-*]\s+/gm, "- "],
  [/^\s*>\s?/gm, ""],
];

/** Strip channel-hostile formatting while leaving readable structure. */
export function toPlainText(input: string): string {
  let out = input ?? "";
  for (const [pattern, replacement] of MARKDOWN_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

export const SMS_SAFE_LENGTH = 1500;

/**
 * Split a reply into channel-sized parts. Ideal for carriers that break long
 * iMessage/SMS bodies or drop them entirely.
 */
export function splitForSms(input: string, max = SMS_SAFE_LENGTH, maxParts = 4): string[] {
  const text = toPlainText(input);
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < maxParts) {
    if (rest.length <= max) {
      parts.push(rest.trim());
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && parts.length > 0) {
    parts[parts.length - 1] = parts[parts.length - 1] + "…";
  }
  return parts;
}
