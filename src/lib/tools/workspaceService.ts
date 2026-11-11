import { getStore, saveStore } from "../store";
import { assertRecipientAllowed, parseAllowlist } from "@/lib/security/recipients";
import { CalendarEventItem, ChannelType, EmailItem, ReminderItem } from "../types";

export async function listEmails(query?: string, maxResults = 6): Promise<EmailItem[]> {
  const state = getStore();

  // If user has connected live Google OAuth token, fetch from Gmail REST API first
  if (state.config.googleAccessToken) {
    try {
      const qParam = query ? `&q=${encodeURIComponent(query)}` : "";
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}${qParam}`,
        {
          headers: { Authorization: `Bearer ${state.config.googleAccessToken}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const messages = listData.messages || [];
        const fetched: EmailItem[] = [];
        for (const m of messages.slice(0, maxResults)) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
            {
              headers: { Authorization: `Bearer ${state.config.googleAccessToken}` },
            }
          );
          if (detailRes.ok) {
            const d = await detailRes.json();
            const headers: Array<{ name: string; value: string }> = d.payload?.headers || [];
            const getH = (n: string) =>
              headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
            fetched.push({
              id: d.id,
              from: getH("From") || "Unknown Sender",
              to: getH("To") || state.config.googleConnectedEmail || "you",
              subject: getH("Subject") || "(No Subject)",
              snippet: d.snippet || "",
              body: d.snippet || "",
              date: getH("Date") || "Recent",
              unread: Array.isArray(d.labelIds) && d.labelIds.includes("UNREAD"),
              archived: Array.isArray(d.labelIds) && !d.labelIds.includes("INBOX"),
              labels: d.labelIds || ["INBOX"],
              status: "inbox",
            });
          }
        }
        if (fetched.length > 0) return fetched;
      }
    } catch {
      // Fallback to local inbox state
    }
  }

  let items = state.emails.filter((e) => !e.archived);
  if (query && query.trim()) {
    const q = query.toLowerCase();
    items = items.filter(
      (e) =>
        e.subject.toLowerCase().includes(q) ||
        e.from.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.labels.some((l) => l.toLowerCase().includes(q))
    );
  }
  return items.slice(0, maxResults);
}

export async function draftOrSendEmail(params: {
  to: string;
  subject: string;
  body: string;
  sendImmediately?: boolean;
}): Promise<EmailItem> {
  const state = getStore();
  if (!state.config.googleAccessToken) throw new Error("Gmail draft/send requires a verified Google OAuth connection.");

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
        Authorization: `Bearer ${state.config.googleAccessToken}`,
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
        Authorization: `Bearer ${state.config.googleAccessToken}`,
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

  state.emails.unshift(item);
  saveStore(state);
  return item;
}

export async function organizeEmail(params: {
  emailId?: string;
  query?: string;
  action: "archive" | "mark_read" | "label";
  label?: string;
}): Promise<{ updatedCount: number; affectedSubjects: string[] }> {
  const state = getStore();
  const token = state.config.googleAccessToken;
  if (!token) throw new Error("Gmail organization requires a verified Google OAuth connection.");
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
  const state = getStore();

  if (state.config.googleAccessToken) {
    try {
      const timeMin = new Date();
      timeMin.setHours(0, 0, 0, 0);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(
          timeMin.toISOString()
        )}&maxResults=10&singleEvents=true&orderBy=startTime`,
        {
          headers: { Authorization: `Bearer ${state.config.googleAccessToken}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.items) && data.items.length > 0) {
          return data.items.map((ev: Record<string, any>) => {
            const startRaw = ev.start?.dateTime || ev.start?.date || new Date().toISOString();
            const endRaw = ev.end?.dateTime || ev.end?.date || startRaw;
            return {
              id: ev.id,
              title: ev.summary || "Untitled Event",
              date: String(startRaw).slice(0, 10),
              startTime: String(startRaw).slice(11, 16) || "09:00",
              endTime: String(endRaw).slice(11, 16) || "10:00",
              attendees: (ev.attendees || []).map((a: Record<string, string>) => a.email),
              location: ev.location || "Google Calendar",
              description: ev.description || "",
              source: "google_calendar",
            };
          });
        }
      }
    } catch {
      // Fallback to local calendar store
    }
  }

  if (dateFilter) {
    return state.calendarEvents.filter((e) => e.date.includes(dateFilter));
  }
  return state.calendarEvents;
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
  const state = getStore();
  const computedEnd =
    params.endTime ||
    (() => {
      const [h, m] = (params.startTime || "10:00").split(":").map(Number);
      const nextH = String(((h || 10) + 1) % 24).padStart(2, "0");
      return `${nextH}:${String(m || 0).padStart(2, "0")}`;
    })();

  if (!state.config.googleAccessToken) throw new Error("Google Calendar requires a verified OAuth connection.");
  if (state.config.googleAccessToken) {
    const calendarResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.config.googleAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: params.title,
        location: params.location,
        description: params.description,
        start: { dateTime: `${params.date}T${params.startTime}:00` },
        end: { dateTime: `${params.date}T${computedEnd}:00` },
        attendees: (params.attendees || []).map((email) => ({ email })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!calendarResponse.ok) {
      const detail = await calendarResponse.text().catch(() => "");
      throw new Error(`Google Calendar rejected the event (${calendarResponse.status}): ${detail.slice(0, 200)}`);
    }
  }

  const newEvent: CalendarEventItem = {
    id: `evt-${Date.now()}`,
    title: params.title,
    date: params.date || new Date().toISOString().split("T")[0],
    startTime: params.startTime || "10:00",
    endTime: computedEnd,
    attendees: params.attendees || [],
    location: params.location || "Google Meet",
    description: params.description || "",
    source: state.config.googleAccessToken ? "google_calendar" : "local",
  };

  state.calendarEvents.push(newEvent);
  saveStore(state);
  return newEvent;
}

export function createReminder(params: {
  text: string;
  dueAt: string;
  channel?: ChannelType;
  recipient?: string;
}): ReminderItem {
  const state = getStore();
  const reminder: ReminderItem = {
    id: `rem-${Date.now()}`,
    text: params.text,
    dueAt: params.dueAt || "Later today",
    channel: params.channel || "imessage",
    recipient: params.recipient || "+1 (555) 019-2834",
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

