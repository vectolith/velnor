// End-to-end smoke check for the Velnor IDE. Run against a started server:
//   npm run start & npm run verify
const base = process.env.VELNOR_URL || "http://localhost:3000";

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

async function waitForServer(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(base + "/ide", { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail("server did not answer on " + base + " within " + attempts + "s");
}

await waitForServer();

// Root redirects to the editor.
const root = await fetch(base + "/", { redirect: "manual" });
if (root.status !== 307 && root.status !== 308) fail("expected / to redirect, got " + root.status);
const location = root.headers.get("location") || "";
if (!location.endsWith("/ide")) fail("expected / to redirect to /ide, got " + location);

// The editor page renders server-side with the IDE shell.
const ide = await fetch(base + "/ide");
if (ide.status !== 200) fail("/ide returned " + ide.status);
const html = await ide.text();
for (const marker of ["ide-root", "velnor ide", "ide-topbar"]) {
  if (!html.includes(marker)) fail("/ide HTML is missing marker: " + marker);
}

// The assistant endpoint validates input instead of crashing.
const chat = await fetch(base + "/api/ide/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "" }),
});
if (chat.status !== 400) fail("/api/ide/chat should reject an empty prompt with 400, got " + chat.status);

const malformed = await fetch(base + "/api/ide/chat", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{",
});
if (malformed.status !== 400) fail("assistant endpoint should reject malformed JSON, got " + malformed.status);

const oversized = await fetch(base + "/api/ide/chat", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "x".repeat(24_001) }),
});
if (oversized.status !== 413) fail("assistant endpoint should reject oversized prompts, got " + oversized.status);

const meta = await fetch(base + "/api/ide/chat");
if (!meta.ok) fail("/api/ide/chat GET returned " + meta.status);
const metaBody = await meta.json();
if (typeof metaBody.model !== "string") fail("/api/ide/chat GET is missing the model field");

console.log("OK: root redirect, editor rendering, assistant empty/malformed/oversized-input validation and metadata");
