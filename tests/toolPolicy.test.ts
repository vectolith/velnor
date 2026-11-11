import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceToolPolicy,
  isAffirmation,
  noteUserMessage,
  pendingCount,
  resetToolPolicy,
  SENSITIVE_TOOLS,
} from "../src/lib/security/toolPolicy";

test("read-only tools are never blocked", () => {
  resetToolPolicy();
  assert.deepEqual(enforceToolPolicy("list_emails"), { allowed: true });
  assert.deepEqual(enforceToolPolicy("web_search"), { allowed: true });
});

test("a sensitive tool is blocked until the user says yes", () => {
  resetToolPolicy();
  noteUserMessage("email Aishat about the launch");
  const first = enforceToolPolicy("draft_or_send_email");
  assert.equal(first.allowed, false);
  assert.match(String(first.reason), /confirmation|yes/i);
  assert.equal(pendingCount(), 1);

  noteUserMessage("yes");
  const second = enforceToolPolicy("draft_or_send_email");
  assert.equal(second.allowed, true);
  assert.equal(pendingCount(), 0, "confirmation is consumed");

  const third = enforceToolPolicy("draft_or_send_email");
  assert.equal(third.allowed, false, "the next send needs its own confirmation");
});

test("a non-affirmative reply does not unlock the action", () => {
  resetToolPolicy();
  noteUserMessage("send it");
  assert.equal(enforceToolPolicy("create_calendar_event").allowed, false);
  noteUserMessage("no wait, change the time first");
  assert.equal(enforceToolPolicy("create_calendar_event").allowed, false);
});

test("affirmation detection is strict", () => {
  for (const text of ["yes", "Yes.", "confirm", "go ahead", "send it", "ok"]) {
    assert.equal(isAffirmation(text), true, `${text} should count as confirmation`);
  }
  for (const text of ["", "no", "later maybe", "yes but change the subject to something much longer than sixty characters so it is ignored"]) {
    assert.equal(isAffirmation(text), false, `${text} should not count as confirmation`);
  }
});

test("the sensitive set is exactly the tools that leave the machine", () => {
  assert.deepEqual([...SENSITIVE_TOOLS].sort(), ["create_calendar_event", "delegate_browser_task", "draft_or_send_email", "organize_email"]);
});

test("confirmation is bound to exact arguments", () => {
  resetToolPolicy();
  noteUserMessage("send the draft to a@example.com");
  assert.equal(enforceToolPolicy("draft_or_send_email", { to: "a@example.com", subject: "A", body: "B" }).allowed, false);
  noteUserMessage("yes");
  assert.equal(enforceToolPolicy("draft_or_send_email", { to: "b@example.com", subject: "A", body: "B" }).allowed, false);
  assert.equal(enforceToolPolicy("draft_or_send_email", { to: "a@example.com", subject: "A", body: "B" }).allowed, true);
});

test("one tenant cannot confirm another tenant's pending action", async () => {
  resetToolPolicy();
  await withVelnorUser("policy-tenant-a", () => {
    noteUserMessage("send the approved message");
    assert.equal(enforceToolPolicy("draft_or_send_email", { to: "a@example.com" }).allowed, false);
  });
  await withVelnorUser("policy-tenant-b", () => {
    noteUserMessage("yes");
    assert.equal(enforceToolPolicy("draft_or_send_email", { to: "a@example.com" }).allowed, false);
  });
  await withVelnorUser("policy-tenant-a", () => {
    noteUserMessage("yes");
    assert.equal(enforceToolPolicy("draft_or_send_email", { to: "a@example.com" }).allowed, true);
  });
});
