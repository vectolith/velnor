import type { IdeFile } from "./workspace";

export type ProjectInventory = {
  fileCount: number;
  totalBytes: number;
  languages: Array<{ language: string; files: number }>;
  entrypoints: string[];
  dependencyNames: string[];
  observations: Array<{ severity: "info" | "warning"; code: string; message: string; files?: string[] }>;
};

const sourceExtensions: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript/React", ".js": "JavaScript",
  ".jsx": "JavaScript/React", ".mjs": "JavaScript", ".css": "CSS",
  ".html": "HTML", ".json": "JSON", ".md": "Markdown",
  ".py": "Python", ".php": "PHP", ".java": "Java", ".c": "C", ".h": "C/header", ".cpp": "C++", ".cc": "C++", ".cs": "C#", ".go": "Go", ".rs": "Rust", ".sql": "SQL", ".yaml": "YAML", ".yml": "YAML", ".xml": "XML", ".sh": "Shell", ".toml": "TOML",
};

function extension(path: string): string {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

export function analyzeWorkspace(files: IdeFile[]): ProjectInventory {
  const languageCounts = new Map<string, number>();
  const entrypoints: string[] = [];
  const observations: ProjectInventory["observations"] = [];
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += new TextEncoder().encode(file.content).byteLength;
    const ext = extension(file.path);
    const language = sourceExtensions[ext] ?? "Other";
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    const path = file.path.toLowerCase();
    if (["index.html", "src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "src/main.js", "src/main.jsx", "app.ts", "app.tsx", "app.js", "app.jsx"].includes(path)) entrypoints.push(file.path);
  }
  const packageFiles = files.filter((f) => f.path.toLowerCase() === "package.json");
  const dependencies = new Set<string>();
  for (const file of packageFiles) {
    try {
      const parsed = JSON.parse(file.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      for (const name of Object.keys(parsed.dependencies ?? {})) dependencies.add(name);
      for (const name of Object.keys(parsed.devDependencies ?? {})) dependencies.add(name);
    } catch {
      observations.push({ severity: "warning", code: "invalid-package-json", message: "package.json could not be parsed.", files: [file.path] });
    }
  }
  const secretsPattern = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i;
  const secretFiles = files.filter((f) => secretsPattern.test(f.content));
  if (secretFiles.length) observations.push({ severity: "warning", code: "possible-secret", message: "Possible embedded credential detected. Review these files; this heuristic may produce false positives.", files: secretFiles.map((f) => f.path) });
  const remoteScripts = files.filter((f) => /<script[^>]+src=["']https?:\/\//i.test(f.content));
  if (remoteScripts.length) observations.push({ severity: "warning", code: "remote-script", message: "HTML references remote script sources.", files: remoteScripts.map((f) => f.path) });
  if (!entrypoints.length && files.length) observations.push({ severity: "info", code: "no-recognized-entrypoint", message: "No common project entrypoint was detected; inventory is based on the file set." });
  return {
    fileCount: files.length,
    totalBytes,
    languages: [...languageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([language, count]) => ({ language, files: count })),
    entrypoints: entrypoints.sort(),
    dependencyNames: [...dependencies].sort(),
    observations,
  };
}

/** Build a bounded, file-aware assistant context. Never silently cut a file mid-content. */
export function buildAssistantWorkspaceContext(files: IdeFile[], activePath?: string | null, maxChars = 48_000): string {
  const inventory = analyzeWorkspace(files);
  const header = "Workspace inventory (heuristic, not a build):\
" + JSON.stringify(inventory, null, 2) + "\
\
Files:\
";
  if (header.length >= maxChars) return header.slice(0, maxChars);
  const ordered = [...files].sort((a, b) => {
    const priority = (file: IdeFile) => file.path === activePath ? 0 : file.path.toLowerCase() === "package.json" ? 1 : 2;
    return priority(a) - priority(b) || a.path.localeCompare(b.path);
  });
  let output = header;
  let omitted = 0;
  for (const file of ordered) {
    const section = "\
--- " + file.path + " ---\
" + file.content + "\
";
    if (output.length + section.length <= maxChars) output += section;
    else omitted += 1;
  }
  if (omitted) output += "\
[Context budget reached; " + omitted + " file(s) omitted whole. Ask to inspect specific files.]";
  return output;
}
