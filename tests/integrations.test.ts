import assert from "node:assert/strict";
import test from "node:test";
import { getStore, saveStore, withVelnorUser } from "../src/lib/store";
import { sendSendblueMessage } from "../src/lib/channels/sendblue";
import { sendLoopMessage } from "../src/lib/channels/loopmessage";

process.env.VELNOR_SECRET_KEY ||= "test-secret-key-for-integration-suite-32-bytes";
import {
  createCalendarEvent,
  draftOrSendEmail,
  organizeEmail,
} from "../src/lib/tools/workspaceService";

async function withFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>
) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("Gmail drafts use the Gmail drafts API and require OAuth", async () => {
  await withVelnorUser("gmail-draft-contract", async () => {
    const state = getStore();
    state.config.googleAccessToken = "test-access-token";
    saveStore(state);
    await withFetchMock(async (input, init) => {
      assert.match(String(input), /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts$/);
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ id: "draft-123" }), { status: 200 });
    }, async () => {
      const draft = await draftOrSendEmail({
        to: "person@example.com",
        subject: "Contract test",
        body: "Draft body",
        sendImmediately: false,
      });
      assert.equal(draft.status, "draft");
    });
  });

  await withVelnorUser("gmail-no-token", async () => {
    await assert.rejects(
      draftOrSendEmail({ to: "person@example.com", subject: "No token", body: "Must fail" }),
      /OAuth connection/
    );
  });
});

test("Gmail sends fail closed when the provider rejects the request", async () => {
  await withVelnorUser("gmail-send-contract", async () => {
    const state = getStore();
    state.config.googleAccessToken = "test-access-token";
    saveStore(state);
    await withFetchMock(async (input) => {
      assert.match(String(input), /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/);
      return new Response("unauthorized", { status: 401 });
    }, async () => {
      await assert.rejects(
        draftOrSendEmail({
          to: "person@example.com",
          subject: "Provider failure",
          body: "Must not be reported as sent",
          sendImmediately: true,
        }),
        /Gmail rejected the send/
      );
    });
    assert.equal(getStore().emails.some((email) => email.subject === "Provider failure"), false);
  });
});

test("Google Calendar creation requires OAuth and provider acceptance", async () => {
  await withVelnorUser("calendar-no-token", async () => {
    await assert.rejects(
      createCalendarEvent({ title: "No token", date: "2026-11-12", startTime: "10:00" }),
      /OAuth connection/
    );
  });

  await withVelnorUser("calendar-provider-failure", async () => {
    const state = getStore();
    state.config.googleAccessToken = "test-access-token";
    saveStore(state);
    await withFetchMock(async (input) => {
      assert.match(String(input), /googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/);
      return new Response("forbidden", { status: 403 });
    }, async () => {
      await assert.rejects(
        createCalendarEvent({ title: "Provider failure", date: "2026-11-12", startTime: "10:00" }),
        /Google Calendar rejected the event/
      );
    });
    assert.equal(getStore().calendarEvents.some((event) => event.title === "Provider failure"), false);
  });
});

test("Gmail organization uses the provider modify endpoint", async () => {
  await withVelnorUser("gmail-organize-contract", async () => {
    const state = getStore();
    state.config.googleAccessToken = "test-access-token";
    saveStore(state);
    const urls: string[] = [];
    await withFetchMock(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "message-123" }] }), { status: 200 });
      }
      if (url.includes("/messages/message-123/modify")) {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.removeLabelIds, ["INBOX"]);
        return new Response(JSON.stringify({ id: "message-123" }), { status: 200 });
      }
      throw new Error("Unexpected Gmail endpoint: " + url);
    }, async () => {
      const result = await organizeEmail({ query: "from:reports@example.com", action: "archive" });
      assert.equal(result.updatedCount, 1);
    });
    assert.equal(urls.length, 2);
  });
});

test("Sendblue uses the documented send-message contract and sender line", async () => {
  await withFetchMock(async (input, init) => {
    assert.equal(String(input), "https://api.sendblue.co/api/send-message");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.number, "+15551234567");
    assert.equal(body.from_number, "+15557654321");
    assert.equal(body.content, "Hello");
    assert.equal((init?.headers as Record<string, string>)["sb-api-key-id"], "key-id");
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "sendblue-handle" }), { status: 200 });
  }, async () => {
    const result = await sendSendblueMessage({
      apiKeyId: "key-id",
      apiSecretKey: "secret",
      number: "+15551234567",
      fromNumber: "+15557654321",
      content: "Hello",
    });
    assert.equal(result.ok, true);
    assert.match(result.detail || "", /sendblue-handle/);
  });
});

test("LoopMessage uses its documented host, Authorization header, and contact field", async () => {
  await withFetchMock(async (input, init) => {
    assert.equal(String(input), "https://a.loopmessage.com/api/v1/message/send/");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.contact, "+15551234567");
    assert.equal(body.text, "Hello");
    assert.equal((init?.headers as Record<string, string>).Authorization, "loop-api-key");
    assert.equal("Loop-Secret-Key" in (init?.headers as Record<string, string>), false);
    return new Response(JSON.stringify({ success: true, message_id: "loop-message-123" }), { status: 200 });
  }, async () => {
    const result = await sendLoopMessage({ authKey: "loop-api-key", recipient: "+15551234567", text: "Hello" });
    assert.equal(result.ok, true);
    assert.match(result.detail || "", /loop-message-123/);
  });
});
