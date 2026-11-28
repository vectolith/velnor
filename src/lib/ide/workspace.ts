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

export type IdeLanguage = "html" | "css" | "javascript" | "typescript" | "json" | "markdown" | "python" | "php" | "java" | "c" | "cpp" | "csharp" | "go" | "rust" | "sql" | "yaml" | "xml" | "shell" | "dockerfile" | "toml" | "plaintext";

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
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".php")) return "php";
  if (name.endsWith(".java")) return "java";
  if (name.endsWith(".c")) return "c";
  if (name.endsWith(".h")) return "c";
  if (name.endsWith(".cpp") || name.endsWith(".cc") || name.endsWith(".cxx")) return "cpp";
  if (name.endsWith(".cs")) return "csharp";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rs")) return "rust";
  if (name.endsWith(".sql")) return "sql";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".sh") || name.endsWith(".bash")) return "shell";
  if (name === "dockerfile" || name.endsWith("/dockerfile")) return "dockerfile";
  if (name.endsWith(".toml")) return "toml";
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

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Velnor workspace</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="card">
      <h1>Hello from the Velnor IDE</h1>
      <p id="clock">Loading…</p>
      <button id="ping">Ping the console</button>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`;

const STYLES_CSS = `:root {
  color-scheme: dark;
  --ink: #e6edf3;
  --muted: #8b98a5;
  --accent: #7aa2f7;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 20% 20%, #1b2430, #0b0f14 70%);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

.card {
  padding: 2.5rem;
  border-radius: 16px;
  border: 1px solid #243042;
  background: rgba(16, 22, 30, 0.85);
  max-width: 32rem;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
}

p {
  color: var(--muted);
  margin: 0 0 1.5rem;
}

button {
  appearance: none;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  padding: 0.6rem 1rem;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}

button:hover {
  background: rgba(122, 162, 247, 0.12);
}
`;

const APP_JS = `const clock = document.getElementById("clock");
const ping = document.getElementById("ping");

function tick() {
  if (clock) clock.textContent = new Date().toLocaleTimeString();
}

tick();
setInterval(tick, 1000);

ping?.addEventListener("click", () => {
  console.log("pong at", new Date().toISOString());
});
`;

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
  "<script>
" +
  "(function () {
" +
  "  var send = function (level, args) {
" +
  "    try {
" +
  "      parent.postMessage({
" +
  "        source: \"velnor-ide-console\",
" +
  "        level: level,
" +
  "        text: Array.prototype.map.call(args, function (value) {
" +
  "          if (typeof value === \"string\") return value;
" +
  "          try { return JSON.stringify(value); } catch (e) { return String(value); }
" +
  "        }).join(\" \")
" +
  "      }, \"*\");
" +
  "    } catch (e) {}
" +
  "  };
" +
  "  [\"log\", \"info\", \"warn\", \"error\", \"debug\"].forEach(function (level) {
" +
  "    var original = console[level] ? console[level].bind(console) : function () {};
" +
  "    console[level] = function () {
" +
  "      send(level, arguments);
" +
  "      original.apply(console, arguments);
" +
  "    };
" +
  "  });
" +
  "  window.addEventListener(\"error\", function (event) {
" +
  "    send(\"error\", [event.message + (event.lineno ? \" (line \" + event.lineno + \")\" : \"\")]);
" +
  "  });
" +
  "})();
" +
  "</script>";

function resolvePreviewAsset(entryPath: string, reference: string): string | null {
  const ref = reference.trim();
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("#")) return null;
  const clean = ref.split(/[?#]/, 1)[0].replace(/^\//, "");
  const base = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/") + 1) : "";
  try { return normalizePath(base + clean); } catch { return null; }
}

function inlineStyles(document: string, files: IdeFile[], entryPath: string): string {
  return document.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href: string) => {
    const resolved = resolvePreviewAsset(entryPath, String(href));
    const target = resolved ? files.find((file) => file.path === resolved) : undefined;
    if (!target) return match;
    return "<style>
" + target.content + "
</style>";
  });
}

function inlineScripts(document: string, files: IdeFile[], entryPath: string): string {
  return document.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi,
    (match, src: string) => {
      const resolved = resolvePreviewAsset(entryPath, String(src));
      const target = resolved ? files.find((file) => file.path === resolved) : undefined;
      if (!target) return match;
      const safe = target.content.replace(/<\/script/gi, "<\\/script");
      return "<script>
" + safe + "
</script>";
    }
  );
}

export function buildPreviewDocument(files: IdeFile[]): string {
  const entry = entryFile(files);
  if (!entry) {
    throw new WorkspaceError("Add an index.html file to see a preview.");
  }
  const withStyles = inlineStyles(entry.content, files, entry.path);
  const withScripts = inlineScripts(withStyles, files, entry.path);
  // Preview executes workspace code in an opaque-origin sandbox and applies a
  // restrictive CSP. Workspace scripts cannot make network requests or load
  // arbitrary remote assets; only inline scripts/styles and data/blob media.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
  if (/<head[^>]*>/i.test(withScripts)) {
    return withScripts.replace(/<head([^>]*)>/i, (match) => match + "\
" + csp + "\
" + CONSOLE_BRIDGE);
  }
  return csp + "\
" + CONSOLE_BRIDGE + "\
" + withScripts;
}

export function sortFiles(files: IdeFile[]): IdeFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
}

export type ProposedFileChange = { path: string; content: string };
/** Extract explicit path-labelled code blocks from assistant output for review. */
export function parseProposedFileChanges(reply: string): ProposedFileChange[] {
  const changes: ProposedFileChange[] = [];
  const pattern = /^\s*```(?:[\w.+-]+)?\s+([^
]+)
([\s\S]*?)^\s*```\s*$/gm;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(reply)) !== null) {
    const rawPath = match[1].trim();
    if (!rawPath || rawPath.startsWith("//") || rawPath.startsWith("#")) continue;
    let path: string;
    try { path = normalizePath(rawPath); } catch { continue; }
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ path, content: match[2].replace(/
$/, "") });
  }
  return changes;
}
