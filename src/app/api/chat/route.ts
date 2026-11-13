import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getDatabaseEngineStatus } from "@/lib/sqliteDb";
import { getEffectiveKeys, getStore, saveStore, withVelnorUser } from "@/lib/store";
import { ingestDocumentOrUrl } from "@/lib/tools/documentStore";
import { addMemoryFact, deleteMemoryFact } from "@/lib/tools/memoryStore";
import { transcribeAudioWithProvider } from "@/lib/tools/multimodal";
import {
  createCalendarEvent,
  createReminder,
  organizeEmail,
  toggleReminder,
} from "@/lib/tools/workspaceService";
import { Attachment, ChannelType } from "@/lib/types";
import { authorizeChatTenant } from "@/lib/security/tenant";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 403 });
  }
  return withVelnorUser(tenant.userId, () => buildSnapshot());
}

function buildSnapshot() {
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
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // User identity must come exclusively from the verified bearer token.
  // Body fields and legacy tenant headers are untrusted input, never credentials.
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 403 });
  }
  return withVelnorUser(tenant.userId, () => handlePost(body));
}

async function handlePost(body: any) {
  try {
    const action = body.action || "message";

    if (action === "toggle_reminder") {
      const updated = toggleReminder(String(body.id));
      return NextResponse.json({ reminder: updated, reminders: getStore().reminders });
    }

    if (action === "add_memory") {
      const mem = addMemoryFact({
        fact: String(body.fact || ""),
        category: body.category,
      });
      return NextResponse.json({ memory: mem, memories: getStore().memories });
    }

    if (action === "delete_memory") {
      const memories = deleteMemoryFact(String(body.id || ""));
      return NextResponse.json({ memories });
    }

    if (action === "organize_email") {
      await organizeEmail({
        emailId: body.emailId ? String(body.emailId) : undefined,
        query: body.query ? String(body.query) : undefined,
        action: body.emailAction || "archive",
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
      const rem = createReminder({
        text: String(body.text || ""),
        dueAt: String(body.dueAt || "Today at 5:00 PM"),
        channel: (body.channel as ChannelType) || "imessage",
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
    const channel: ChannelType = body.channel || "imessage";
    const text = String(body.text || "");
    const attachments: Attachment[] | undefined = body.attachments;

    const reply = await processUserMessage({
      channel,
      text,
      userHandle: body.userHandle,
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
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 }
    );
  }
}

