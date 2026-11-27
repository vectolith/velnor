export type IdeFile = {
  id: string;
  path: string;
  content: string;
};

export type Workspace = {
  files: IdeFile[];
  entry: string;
  activeId: string;
};

export type IdeLanguage = "html" | "css" | "javascript" | "typescript" | "json" | "markdown" | "plaintext";

const MAX_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function normalizePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed) throw new WorkspaceError("A file needs a name.");
  if (trimmed.length > 200) throw new WorkspaceError("That file name is too long.");
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    const piece = segment.trim();
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (!parts.length) throw new WorkspaceError("Paths cannot escape the workspace root.");
      parts.pop();
      continue;
    }
    if (piece.indexOf("\u0000") !== -1) throw new WorkspaceError("That file name has an invalid character.");
    parts.push(piece);
  }
  if (!parts.length) throw new WorkspaceError("A file needs a name.");
  return parts.join("/");
}

export function detectLanguage(path: string): IdeLanguage {
  const name = path.toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "typescript";
  if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs")) return "javascript";
  return "plaintext";
}

export function languageLabel(language: IdeLanguage): string {
  switch (language) {
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "javascript":
      return "JavaScript";
    case "typescript":
      return "TypeScript";
    case "json":
      return "JSON";
    case "markdown":
      return "Markdown";
    default:
      return "Plain text";
  }
}

const INDEX_HTML = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Velnor workspace</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <main class="card">\n      <h1>Hello from the Velnor IDE</h1>\n      <p id="clock">Loading…</p>\n      <button id="ping">Ping the console</button>\n    </main>\n    <script src="app.js"></script>\n  </body>\n</html>\n';

const STYLES_CSS = ':root {\n  color-scheme: dark;\n  --ink: #e6edf3;\n  --muted: #8b98a5;\n  --accent: #7aa2f7;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  background: radial-gradient(circle at 20% 20%, #1b2430, #0b0f14 70%);\n  color: var(--ink);\n  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;\n}\n\n.card {\n  padding: 2.5rem;\n  border-radius: 16px;\n  border: 1px solid #243042;\n  background: rgba(16, 22, 30, 0.85);\n  max-width: 32rem;\n}\n\nh1 {\n  margin: 0 0 0.75rem;\n  font-size: 1.5rem;\n}\n\np {\n  color: var(--muted);\n  margin: 0 0 1.5rem;\n}\n\nbutton {\n  appearance: none;\n  border: 1px solid var(--accent);\n  background: transparent;\n  color: var(--accent);\n  padding: 0.6rem 1rem;\n  border-radius: 8px;\n  font: inherit;\n  cursor: pointer;\n}\n\nbutton:hover {\n  background: rgba(122, 162, 247, 0.12);\n}\n';

const APP_JS = 'const clock = document.getElementById("clock");\nconst ping = document.getElementById("ping");\n\nfunction tick() {\n  if (clock) clock.textContent = new Date().toLocaleTimeString();\n}\n\ntick();\nsetInterval(tick, 1000);\n\nping?.addEventListener("click", () => {\n  console.log("pong at", new Date().toISOString());\n});\n';

function defaultEntryFiles(): IdeFile[] {
  return [
    { id: "file-index", path: "index.html", content: INDEX_HTML },
    { id: "file-styles", path: "styles.css", content: STYLES_CSS },
    { id: "file-app", path: "app.js", content: APP_JS },
  ];
}

export function createDefaultWorkspace(): Workspace {
  const files = defaultEntryFiles();
  return { files, entry: "index.html", activeId: files[0].id };
}

export function makeFileId(existing: IdeFile[]): string {
  let n = existing.length + 1;
  const used = new Set(existing.map((file) => file.id));
  while (used.has("file-" + String(n))) n += 1;
  return "file-" + String(n);
}

function assertCapacity(files: IdeFile[]) {
  if (files.length >= MAX_FILES) {
    throw new WorkspaceError("A workspace holds at most " + String(MAX_FILES) + " files.");
  }
}

function assertSize(content: string) {
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError("That file is larger than 512 KB.");
  }
}

export function uniquePath(files: IdeFile[], desired: string, ignoreId?: string): string {
  const taken = new Set(
    files.filter((file) => file.id !== ignoreId).map((file) => file.path.toLowerCase())
  );
  if (!taken.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let n = 2; n < 500; n += 1) {
    const candidate = stem + "-" + String(n) + ext;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new WorkspaceError("Too many files share that name.");
}

export function addFile(files: IdeFile[], rawPath: string, content = ""): IdeFile {
  assertCapacity(files);
  assertSize(content);
  const path = uniquePath(files, normalizePath(rawPath));
  return { id: makeFileId(files), path, content };
}

export function renameFile(files: IdeFile[], id: string, rawPath: string): IdeFile[] {
  const path = uniquePath(files, normalizePath(rawPath), id);
  return files.map((file) => (file.id === id ? { ...file, path } : file));
}

export function removeFile(files: IdeFile[], id: string): IdeFile[] {
  return files.filter((file) => file.id !== id);
}

export function updateContent(files: IdeFile[], id: string, content: string): IdeFile[] {
  assertSize(content);
  return files.map((file) => (file.id === id ? { ...file, content } : file));
}

export function findFile(files: IdeFile[], id: string): IdeFile | undefined {
  return files.find((file) => file.id === id);
}

export function entryFile(files: IdeFile[]): IdeFile | undefined {
  return (
    files.find((file) => file.path.toLowerCase() === "index.html") ??
    files.find((file) => file.path.toLowerCase().endsWith(".html"))
  );
}

export const CONSOLE_BRIDGE =
  "<script>\n" +
  "(function () {\n" +
  "  var send = function (level, args) {\n" +
  "    try {\n" +
  "      parent.postMessage({\n" +
  "        source: \"velnor-ide-console\",\n" +
  "        level: level,\n" +
  "        text: Array.prototype.map.call(args, function (value) {\n" +
  "          if (typeof value === \"string\") return value;\n" +
  "          try { return JSON.stringify(value); } catch (e) { return String(value); }\n" +
  "        }).join(\" \")\n" +
  "      }, \"*\");\n" +
  "    } catch (e) {}\n" +
  "  };\n" +
  "  [\"log\", \"info\", \"warn\", \"error\", \"debug\"].forEach(function (level) {\n" +
  "    var original = console[level] ? console[level].bind(console) : function () {};\n" +
  "    console[level] = function () {\n" +
  "      send(level, arguments);\n" +
  "      original.apply(console, arguments);\n" +
  "    };\n" +
  "  });\n" +
  "  window.addEventListener(\"error\", function (event) {\n" +
  "    send(\"error\", [event.message + (event.lineno ? \" (line \" + event.lineno + \")\" : \"\")]);\n" +
  "  });\n" +
  "})();\n" +
  "</script>";

function inlineStyles(document: string, files: IdeFile[]): string {
  return document.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href: string) => {
    const target = files.find((file) => file.path === String(href).replace(/^\.?\//, ""));
    if (!target) return match;
    return "<style>\n" + target.content + "\n</style>";
  });
}

function inlineScripts(document: string, files: IdeFile[]): string {
  return document.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi,
    (match, src: string) => {
      const target = files.find((file) => file.path === String(src).replace(/^\.?\//, ""));
      if (!target) return match;
      const safe = target.content.replace(/<\/script/gi, "<\\/script");
      return "<script>\n" + safe + "\n</script>";
    }
  );
}

export function buildPreviewDocument(files: IdeFile[]): string {
  const entry = entryFile(files);
  if (!entry) {
    throw new WorkspaceError("Add an index.html file to see a preview.");
  }
  const withStyles = inlineStyles(entry.content, files);
  const withScripts = inlineScripts(withStyles, files);
  // Preview executes workspace code in an opaque-origin sandbox and applies a
  // restrictive CSP. Workspace scripts cannot make network requests or load
  // arbitrary remote assets; only inline scripts/styles and data/blob media.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
  if (/<head[^>]*>/i.test(withScripts)) {
    return withScripts.replace(/<head([^>]*)>/i, (match) => match + "\\n" + csp + "\\n" + CONSOLE_BRIDGE);
  }
  return csp + "\\n" + CONSOLE_BRIDGE + "\\n" + withScripts;
}

export function sortFiles(files: IdeFile[]): IdeFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
}
