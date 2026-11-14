import crypto from "node:crypto";
import { DEFAULT_STATE, getStore, saveStore, type VelnorState } from "../store";
import type { PersistedTenantState } from "../storage/d1TenantState";
import { getNodeTenantRepositoryContext } from "../storage/currentTenantRepository";
import { getGoogleAccessToken } from "@/lib/auth/googleToken";
import { assertRecipientAllowed, parseAllowlist } from "@/lib/security/recipients";
import { CalendarEventItem, ChannelType, EmailItem, ReminderItem } from "../types";

async function loadWorkspaceState() {
  const context = getNodeTenantRepositoryContext();
  const record = await context.repository.load(context.tenantId);
  if (!record) throw new Error("Authenticated tenant state is not initialized.");
  return { context, state: record.state as unknown as VelnorState };
}

export async function listEmails(query?: string, maxResults = 6): Promise<EmailItem[]> {
  const { state } = await loadWorkspaceState();
  const token = await getGoogleAccessToken();
  if (!token) throw new Error("Gmail inbox access requires a verified Google OAuth connection.");
  const limit = Math.min(Math.max(Math.floor(maxResults), 1), 50);
  const q = query ? "&q=" + encodeURIComponent(query) : "";
  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + limit + q, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10000),
  });
  if (!listRes.ok) throw new Error("Gmail message listing failed (" + listRes.status + ").");
  const listData = await listRes.json();
  const messages = Array.isArray(listData.messages) ? listData.messages.slice(0, limit) : [];
  const fetched: EmailItem[] = [];
  for (const message of messages) {
    const detailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(message.id) + "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!detailRes.ok) throw new Error("Gmail message detail failed (" + detailRes.status + ").");
    const detail = await detailRes.json();
    const headers: Array<{ name: string; value: string }> = detail.payload?.headers || [];
    const getHeader = (name: string) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || "";
    const labels: string[] = Array.isArray(detail.labelIds) ? detail.labelIds : [];
    fetched.push({
      id: detail.id,
      from: getHeader("From") || "Unknown Sender",
      to: getHeader("To") || state.config.googleConnectedEmail || "you",
      subject: getHeader("Subject") || "(No Subject)",
      snippet: detail.snippet || "",
      body: detail.snippet || "",
      date: getHeader("Date") || "Recent",
      unread: labels.includes("UNREAD"),
      archived: !labels.includes("INBOX"),
      labels,
      status: "inbox",
    });
  }
  return fetched;
}

export async function draftOrSendEmail(params: {
  to: string;
  subject: string;
  body: string;
  sendImmediately?: boolean;
}): Promise<EmailItem> {
  const { context, state } = await loadWorkspaceState();
  const token = await getGoogleAccessToken();

  if (params.sendImmediately) {
    assertRecipientAllowed(params.to, parseAllowlist(process.env.VELNOR_EMAIL_ALLOWLIST));
    const mimeMessage = [
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      params.body,
    ].join("\r\n");
    const raw = Buffer.from(mimeMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sendResponse.ok) {
      const detail = await sendResponse.text().catch(() => "");
      throw new Error(`Gmail rejected the send (${sendResponse.status}): ${detail.slice(0, 200)}`);
    }
  } else {
    const mimeMessage = [
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      params.body,
    ].join("\r\n");
    const raw = Buffer.from(mimeMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const draftResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!draftResponse.ok) {
      const detail = await draftResponse.text().catch(() => "");
      throw new Error(`Gmail rejected the draft (${draftResponse.status}): ${detail.slice(0, 200)}`);
    }
  }

  const item: EmailItem = {
    id: `em-${Date.now()}`,
    from: state.config.googleConnectedEmail || "you@velnor.bot",
    to: params.to,
    subject: params.subject,
    snippet: params.body.slice(0, 120),
    body: params.body,
    date: "Just now",
    unread: false,
    archived: false,
    labels: [params.sendImmediately ? "Sent" : "Draft"],
    status: params.sendImmediately ? "sent" : "draft",
  };

  await context.repository.update(
    context.tenantId,
    () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    (draft) => {
      const emails = Array.isArray(draft.emails) ? draft.emails as EmailItem[] : [];
      emails.unshift(item);
      draft.emails = emails;
    }
  );
  return item;
}

export async function organizeEmail(params: {
  emailId?: string;
  query?: string;
  action: "archive" | "mark_read" | "label";
  label?: string;
}): Promise<{ updatedCount: number; affectedSubjects: string[] }> {
  const { state } = await loadWorkspaceState();
  const token = await getGoogleAccessToken();
  if (!token) throw new Error("Gmail organization requires a verified Google OAuth connection.");
  if (!["archive", "mark_read", "label"].includes(params.action)) throw new Error("Unsupported Gmail organization action.");
  if (!params.emailId && !(params.query || "").trim()) throw new Error("Provide a Gmail message ID or search query.");
  if (params.action === "label" && !(params.label || "").trim()) throw new Error("A label name is required for the label action.");

  const ids: string[] = [];
  if (params.emailId) {
    ids.push(params.emailId);
  } else {
    const listResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=" + encodeURIComponent(params.query || ""), {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!listResponse.ok) throw new Error("Gmail search failed (" + listResponse.status + ").");
    const data = await listResponse.json();
    for (const message of data.messages || []) if (typeof message.id === "string") ids.push(message.id);
  }

  if (ids.length === 0) return { updatedCount: 0, affectedSubjects: [] };
  let labelId: string | undefined;
  if (params.action === "label") {
    const labelsResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!labelsResponse.ok) throw new Error("Gmail label lookup failed (" + labelsResponse.status + ").");
    const labelsData = await labelsResponse.json();
    const existing = (labelsData.labels || []).find((item: any) => item.name === params.label);
    if (existing?.id) {
      labelId = existing.id;
    } else {
      const createResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ name: params.label, labelListVisibility: "labelShow", messageListVisibility: "show" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!createResponse.ok) throw new Error("Gmail label creation failed (" + createResponse.status + ").");
      const created = await createResponse.json();
      labelId = created.id;
    }
    if (!labelId) throw new Error("Gmail did not return a label ID.");
  }

  const body = params.action === "archive"
    ? { removeLabelIds: ["INBOX"] }
    : params.action === "mark_read"
      ? { removeLabelIds: ["UNREAD"] }
      : { addLabelIds: [labelId] };
  for (const id of ids) {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(id) + "/modify", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Gmail could not update message " + id + " (" + response.status + ").");
  }
  const affectedSubjects = state.emails.filter((email) => ids.includes(email.id)).map((email) => email.subject);
  return { updatedCount: ids.length, affectedSubjects };
}

export async function listCalendarEvents(dateFilter?: string): Promise<CalendarEventItem[]> {
  await loadWorkspaceState();
  const token = await getGoogleAccessToken();
  if (!token) throw new Error("Google Calendar access requires a verified Google OAuth connection.");
  const start = dateFilter ? new Date(dateFilter + "T00:00:00") : new Date();
  if (!dateFilter) start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=" + encodeURIComponent(start.toISOString()) + "&timeMax=" + encodeURIComponent(end.toISOString()) + "&maxResults=50&singleEvents=true&orderBy=startTime";
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Google Calendar event listing failed (" + response.status + ").");
  const data = await response.json();
  return (Array.isArray(data.items) ? data.items : []).map((event: Record<string, any>) => {
    const startRaw = event.start?.dateTime || event.start?.date || new Date().toISOString();
    const endRaw = event.end?.dateTime || event.end?.date || startRaw;
    return {
      id: event.id,
      title: event.summary || "Untitled Event",
      date: String(startRaw).slice(0, 10),
      startTime: String(startRaw).slice(11, 16) || "09:00",
      endTime: String(endRaw).slice(11, 16) || "10:00",
      attendees: (event.attendees || []).map((attendee: Record<string, string>) => attendee.email),
      location: event.location || "Google Calendar",
      description: event.description || "",
      source: "google_calendar",
    };
  });
}

export async function createCalendarEvent(params: {
  title: string;
  date: string;
  startTime: string;
  endTime?: string;
  attendees?: string[];
  location?: string;
  description?: string;
}): Promise<CalendarEventItem> {
  const { context } = await loadWorkspaceState();
  const computedEnd =
    params.endTime ||
    (() => {
      const [h, m] = (params.startTime || "10:00").split(":").map(Number);
      const nextH = String(((h || 10) + 1) % 24).padStart(2, "0");
      return `${nextH}:${String(m || 0).padStart(2, "0")}`;
    })();

  const token = await getGoogleAccessToken();
  let remoteEventId: string | undefined;
  {
    const calendarResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: params.title,
        location: params.location,
        description: params.description,
        start: { dateTime: `${params.date}T${params.startTime}:00`, timeZone: process.env.VELNOR_TIMEZONE || "UTC" },
        end: { dateTime: `${params.date}T${computedEnd}:00`, timeZone: process.env.VELNOR_TIMEZONE || "UTC" },
        attendees: (params.attendees || []).map((email) => ({ email })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!calendarResponse.ok) {
      const detail = await calendarResponse.text().catch(() => "");
      throw new Error(`Google Calendar rejected the event (${calendarResponse.status}): ${detail.slice(0, 200)}`);
    }
    const remoteEvent = await calendarResponse.json().catch(() => ({}));
    remoteEventId = typeof remoteEvent.id === "string" ? remoteEvent.id : undefined;
    if (!remoteEventId) {
      throw new Error("Google Calendar accepted the request without returning an event ID; refusing to report a confirmed event.");
    }
  }

  const newEvent: CalendarEventItem = {
    id: remoteEventId,
    title: params.title,
    date: params.date || new Date().toISOString().split("T")[0],
    startTime: params.startTime || "10:00",
    endTime: computedEnd,
    attendees: params.attendees || [],
    location: params.location || "Google Meet",
    description: params.description || "",
    source: "google_calendar",
  };

  await context.repository.update(
    context.tenantId,
    () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    (draft) => {
      const events = Array.isArray(draft.calendarEvents) ? draft.calendarEvents as CalendarEventItem[] : [];
      events.push(newEvent);
      draft.calendarEvents = events;
    }
  );
  return newEvent;
}

export async function createReminderAsync(params: {
  text: string;
  dueAt: string;
  channel?: ChannelType;
  recipient?: string;
}): Promise<ReminderItem> {
  const { context } = await loadWorkspaceState();
  const dueDate = params.dueAt ? new Date(params.dueAt) : new Date(Date.now() + 60 * 60 * 1000);
  if (!Number.isFinite(dueDate.getTime())) {
    throw new Error("Reminder dueAt must be a valid ISO 8601 date-time.");
  }
  const reminder: ReminderItem = {
    id: "rem-" + crypto.randomUUID(),
    text: params.text,
    dueAt: dueDate.toISOString(),
    channel: params.channel || "imessage",
    recipient: params.recipient || "",
    completed: false,
    createdAt: new Date().toISOString(),
  };
  await context.repository.update(
    context.tenantId,
    () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    (draft) => {
      const reminders = Array.isArray(draft.reminders) ? draft.reminders as ReminderItem[] : [];
      reminders.unshift(reminder);
      draft.reminders = reminders;
    }
  );
  return reminder;
}

export async function listRemindersAsync(): Promise<ReminderItem[]> {
  const { state } = await loadWorkspaceState();
  return state.reminders;
}

export async function toggleReminderAsync(id: string): Promise<ReminderItem | undefined> {
  const { context } = await loadWorkspaceState();
  let updated: ReminderItem | undefined;
  await context.repository.update(
    context.tenantId,
    () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    (draft) => {
      const reminders = Array.isArray(draft.reminders) ? draft.reminders as ReminderItem[] : [];
      const target = reminders.find((reminder) => reminder.id === id);
      if (target) {
        target.completed = !target.completed;
        updated = structuredClone(target);
        draft.reminders = reminders;
      }
    }
  );
  return updated;
}

/** Legacy synchronous reminder helpers retained for existing scheduler callers. */
export function createReminder(params: {
  text: string;
  dueAt: string;
  channel?: ChannelType;
  recipient?: string;
}): ReminderItem {
  const state = getStore();
  const dueDate = params.dueAt ? new Date(params.dueAt) : new Date(Date.now() + 60 * 60 * 1000);
  if (!Number.isFinite(dueDate.getTime())) throw new Error("Reminder dueAt must be a valid ISO 8601 date-time.");
  const reminder: ReminderItem = {
    id: "rem-" + crypto.randomUUID(),
    text: params.text,
    dueAt: dueDate.toISOString(),
    channel: params.channel || "imessage",
    recipient: params.recipient || "",
    completed: false,
    createdAt: new Date().toISOString(),
  };
  state.reminders.unshift(reminder);
  saveStore(state);
  return reminder;
}

export function listReminders(): ReminderItem[] {
  return getStore().reminders;
}

export function toggleReminder(id: string): ReminderItem | undefined {
  const state = getStore();
  const target = state.reminders.find((r) => r.id === id);
  if (target) {
    target.completed = !target.completed;
    saveStore(state);
  }
  return target;
}

