import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getDatabaseEngineStatus } from "@/lib/sqliteDb";
import { getEffectiveKeys, getStore, saveStore } from "@/lib/store";
import { ingestDocumentOrUrl } from "@/lib/tools/documentStore";
import { addMemoryFact, deleteMemoryFact } from "@/lib/tools/memoryStore";
import { transcribeAudioWithProvider } from "@/lib/tools/multimodal";
import { readRequestBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import {
  createCalendarEvent,
  createReminder,
  organizeEmail,
  toggleReminder,
} from "@/lib/tools/workspaceService";
import { Attachment, ChannelType } from "@/lib/types";

function isMemoryCategory(value: unknown): value is "preference" | "contact" | "travel" | "work" {
  return value === "preference" || value === "contact" || value === "travel" || value === "work";
}

function isEmailAction(value: unknown): value is "archive" | "mark_read" | "label" {
  return value === "archive" || value === "mark_read" || value === "label";
}

function isChannelType(value: unknown): value is ChannelType {
  return value === "imessage" || value === "slack" || value === "sms";
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.id === "string" &&
    typeof attachment.name === "string" &&
    typeof attachment.mimeType === "string" &&
    (attachment.type === "image" || attachment.type === "document" || attachment.type === "audio")
  );
}

export async function GET() {
  const state = getStore();
  const keys = getEffectiveKeys(state);
  const dbStatus = getDatabaseEngineStatus();

  return NextResponse.json({
    messages: state.messages,
    reminders: state.reminders,
    calendarEvents: state.calendarEvents,
    emails: state.emails.filter((e) => !e.archived),
    documents: state.documents,
    memories: state.memories || [],
    dbStatus,
    providerStatus: {
      activeProvider: state.config.activeProvider,
      geminiConfigured: Boolean(keys.geminiApiKey),
      geminiModel: state.config.geminiModel,
      geminiImageModel: state.config.geminiImageModel,
      openaiConfigured: Boolean(keys.openaiApiKey),
      openaiModel: state.config.openaiModel,
      anthropicConfigured: Boolean(keys.anthropicApiKey),
      anthropicModel: state.config.anthropicModel,
      googleConnectedEmail: state.config.googleConnectedEmail || null,
      slackConfigured: Boolean(state.config.slackBotToken || process.env.SLACK_BOT_TOKEN),
      imessageConfigured: Boolean(
        state.config.twilioAccountSid ||
          state.config.sendblueApiKey ||
          state.config.loopMessageAuthKey
      ),
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await readRequestBody(req, 5 * 1024 * 1024);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return NextResponse.json({ error: "Malformed JSON request body." }, { status: 400 });
      }
      throw error;
    }
    const action = body.action || "message";

    if (action === "toggle_reminder") {
      const updated = toggleReminder(String(body.id));
      return NextResponse.json({ reminder: updated, reminders: getStore().reminders });
    }

    if (action === "add_memory") {
      if (body.category !== undefined && !isMemoryCategory(body.category)) {
        return NextResponse.json({ error: "Invalid memory category." }, { status: 400 });
      }
      const mem = addMemoryFact({
        fact: String(body.fact || ""),
        category: body.category as "preference" | "contact" | "travel" | "work" | undefined,
      });
      return NextResponse.json({ memory: mem, memories: getStore().memories });
    }

    if (action === "delete_memory") {
      const memories = deleteMemoryFact(String(body.id || ""));
      return NextResponse.json({ memories });
    }

    if (action === "organize_email") {
      if (body.emailAction !== undefined && !isEmailAction(body.emailAction)) {
        return NextResponse.json({ error: "Invalid email action." }, { status: 400 });
      }
      organizeEmail({
        emailId: body.emailId ? String(body.emailId) : undefined,
        query: body.query ? String(body.query) : undefined,
        action: body.emailAction as "archive" | "mark_read" | "label" | undefined || "archive",
        label: body.label ? String(body.label) : undefined,
      });
      return NextResponse.json({
        emails: getStore().emails.filter((e) => !e.archived),
      });
    }

    if (action === "toggle_reaction") {
      const state = getStore();
      const msg = state.messages.find((m) => m.id === String(body.messageId));
      const emoji = String(body.emoji || "❤️");
      if (msg) {
        const list = msg.reactions || [];
        msg.reactions = list.includes(emoji)
          ? list.filter((r) => r !== emoji)
          : [...list, emoji];
        saveStore(state);
      }
      return NextResponse.json({ messages: state.messages });
    }

    if (action === "create_reminder") {
      if (body.channel !== undefined && !isChannelType(body.channel)) {
        return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
      }
      const rem = createReminder({
        text: String(body.text || ""),
        dueAt: String(body.dueAt || "Today at 5:00 PM"),
        channel: (body.channel as ChannelType | undefined) || "imessage",
      });
      return NextResponse.json({ reminder: rem, reminders: getStore().reminders });
    }

    if (action === "create_event") {
      const ev = await createCalendarEvent({
        title: String(body.title || "New Event"),
        date: String(body.date || new Date().toISOString().split("T")[0]),
        startTime: String(body.startTime || "10:00"),
        endTime: body.endTime ? String(body.endTime) : undefined,
        attendees: Array.isArray(body.attendees) ? body.attendees : [],
        location: body.location ? String(body.location) : "Google Meet",
      });
      return NextResponse.json({ event: ev, calendarEvents: getStore().calendarEvents });
    }

    if (action === "ingest_document") {
      const doc = await ingestDocumentOrUrl({
        name: String(body.name || "Uploaded_Document.txt"),
        content: body.content ? String(body.content) : undefined,
        base64Data: body.base64Data ? String(body.base64Data) : undefined,
        mimeType: body.mimeType ? String(body.mimeType) : undefined,
        url: body.url ? String(body.url) : undefined,
      });
      return NextResponse.json({ document: doc, documents: getStore().documents });
    }

    if (action === "transcribe_audio") {
      const res = await transcribeAudioWithProvider({
        base64Audio: String(body.base64Audio || ""),
        mimeType: String(body.mimeType || "audio/webm"),
      });
      return NextResponse.json(res);
    }

    if (action === "clear_chat") {
      const state = getStore();
      if (body.channel !== undefined && !isChannelType(body.channel)) {
        return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
      }
      const targetChannel = body.channel as ChannelType | undefined;
      if (targetChannel) {
        state.messages = state.messages.filter((m) => m.channel !== targetChannel);
      } else {
        state.messages = [];
      }
      saveStore(state);
      return NextResponse.json({ messages: state.messages });
    }

    // Default: Process conversational message
    if (body.channel !== undefined && !isChannelType(body.channel)) {
      return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
    }
    if (body.attachments !== undefined && (
      !Array.isArray(body.attachments) || !body.attachments.every(isAttachment)
    )) {
      return NextResponse.json({ error: "Invalid attachments." }, { status: 400 });
    }
    if (body.userHandle !== undefined && typeof body.userHandle !== "string") {
      return NextResponse.json({ error: "Invalid user handle." }, { status: 400 });
    }
    const channel: ChannelType = (body.channel as ChannelType | undefined) || "imessage";
    const text = String(body.text || "");
    const attachments = body.attachments as Attachment[] | undefined;

    const reply = await processUserMessage({
      channel,
      text,
      userHandle: body.userHandle as string | undefined,
      attachments,
    });

    const state = getStore();
    return NextResponse.json({
      reply,
      messages: state.messages,
      reminders: state.reminders,
      calendarEvents: state.calendarEvents,
      emails: state.emails.filter((e) => !e.archived),
      documents: state.documents,
      memories: state.memories || [],
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    return NextResponse.json(
      { error: err instanceof RequestBodyTooLargeError ? err.message : "The request could not be processed." },
      { status: err instanceof RequestBodyTooLargeError ? 413 : 500 }
    );
  }
}

