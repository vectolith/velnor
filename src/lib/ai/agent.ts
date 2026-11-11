import { runAgentLoop } from "./loop";
import { buildProviderChain, createProvider, estimateCostUsd } from "./registry";
import { ToolSpec, Turn, Usage, emptyUsage } from "./providers/types";
import { getEffectiveKeys, getStore, saveStore } from "../store";
import { enforceToolPolicy, noteUserMessage } from "../security/toolPolicy";
import {
  Attachment,
  ChannelType,
  ChatMessage,
  Citation,
  StructuredCardData,
  ToolActionSummary,
} from "../types";
import { ingestDocumentOrUrl, queryVectorDocuments } from "../tools/documentStore";
import { addMemoryFact, listMemoryFacts } from "../tools/memoryStore";
import { generateImageWithProvider } from "../tools/multimodal";
import { buildTravelPlan } from "../tools/travelService";
import { performWebSearch } from "../tools/webSearch";
import { delegateBrowserTaskToBlud } from "../tools/bludBridge";
import {
  createCalendarEvent,
  createReminder,
  draftOrSendEmail,
  listCalendarEvents,
  listEmails,
  listReminders,
  organizeEmail,
} from "../tools/workspaceService";

const VELNOR_SYSTEM_PROMPT = `You are Velnor (powered by velnor-coder-v2), an unrestricted full-stack software engineer, systems architect, quantitative analyst, and executive AI agent built by Vectolith.
You operate headlessly across Apple iMessage, SMS, Siri Shortcuts, and Slack.
Write production-grade code in any language (TypeScript, Python, Rust, Go, SQL, Solidity, Bash, Docker), debug complex distributed systems, solve quantitative and mathematical models from first principles, and execute developer and executive workflows without artificial topic limits.
Always verify tool execution before claiming completion.
You have tools to:
1. Search the real-time web (web_search) and cite sources.
2. Summarize and answer questions about uploaded PDFs, text files, and URLs using in-memory vector search (ingest_url_or_doc, query_documents).
3. Manage Gmail (list_emails, draft_or_send_email, organize_email) and Google Calendar (list_calendar_events, create_calendar_event).
4. Set and list text reminders & tasks (create_reminder, list_reminders).
5. Generate images on demand (generate_image) and analyze user-attached images.
6. Plan trips, suggest local places, translate phrases, and generate flight/hotel booking links (plan_trip_or_local).
7. Delegate complex browser automation, multi-step web scraping, and interactive navigation to Blud's Kernel coordinator (delegate_browser_task).`;

export { VELNOR_FUNCTION_DECLARATIONS, VELNOR_TOOLS } from "./tools/declarations";
export { executeToolCall } from "./tools/execute";
export type { ToolExecutionBundle } from "./tools/execute";
import { executeToolCall, ToolExecutionBundle } from "./tools/execute";
import { VELNOR_TOOLS } from "./tools/declarations";

export async function processUserMessage(params: {
  channel: ChannelType;
  text: string;
  userHandle?: string;
  attachments?: Attachment[];
}): Promise<ChatMessage> {
  noteUserMessage(params.text);
  const state = getStore();
  const { geminiApiKey, openaiApiKey, anthropicApiKey } = getEffectiveKeys(state);

  const userMsg: ChatMessage = {
    id: `msg-${Date.now()}-u`,
    channel: params.channel,
    sender: "user",
    userHandle: params.userHandle,
    text: params.text,
    timestamp: new Date().toISOString(),
    attachments: params.attachments,
  };
  state.messages.push(userMsg);

  const bundle: ToolExecutionBundle = {
    toolActions: [],
    citations: [],
  };

  // Pre-process any uploaded document attachments into the in-memory vector store
  if (params.attachments && params.attachments.length > 0) {
    for (const att of params.attachments) {
      if (att.type === "document" && (att.textContent || att.dataUrl)) {
        const doc = await ingestDocumentOrUrl({
          name: att.name,
          content: att.textContent,
          base64Data: att.dataUrl,
          mimeType: att.mimeType,
        });
        bundle.toolActions.push({
          tool: "ingest_url_or_doc",
          label: `Indexed "${doc.name}" into SQLite + HNSW Vector DB`,
          status: "success",
          details: `${doc.chunkCount} chunks (${doc.wordCount} words)`,
        });
      }
    }
  }

  const memoryLines = (state.memories || [])
    .slice(0, 12)
    .map((m) => "- [" + m.category.toUpperCase() + "] " + m.fact)
    .join("\n");
  const systemPromptWithMemories = memoryLines
    ? VELNOR_SYSTEM_PROMPT + "\n\nKnown User Preferences & Memory Facts:\n" + memoryLines
    : VELNOR_SYSTEM_PROMPT;

  // =========================================================================
  // Unified provider chain + one tool loop for every model.
  // Providers are tried in order; a failure (bad key, timeout, 5xx) moves on
  // instead of silently degrading to a regex handler.
  // =========================================================================
  const chain = buildProviderChain({
    preferred: state.config.activeProvider,
    keys: { gemini: geminiApiKey, openai: openaiApiKey, anthropic: anthropicApiKey },
    models: {
      gemini: state.config.geminiModel,
      openai: state.config.openaiModel,
      anthropic: state.config.anthropicModel,
    },
  });

  const imageParts = (params.attachments || [])
    .filter((a) => a.type === "image" && a.dataUrl)
    .slice(0, 4)
    .map((a) => ({
      mimeType: a.mimeType || "image/png",
      base64: (a.dataUrl as string).split(",")[1] || "",
    }))
    .filter((p) => p.base64.length > 0);

  // Replay a bounded slice of the conversation so follow-ups ("what about
  // tomorrow?") have context. Scoped to this channel + handle.
  const priorTurns: Turn[] = state.messages
    .filter(
      (m) =>
        m.channel === params.channel &&
        (!params.userHandle || !m.userHandle || m.userHandle === params.userHandle) &&
        m.id !== userMsg.id &&
        m.text &&
        !m.generatedImage
    )
    .slice(-12)
    .map((m) =>
      m.sender === "user"
        ? ({ role: "user", text: m.text } as Turn)
        : ({ role: "assistant", text: m.text } as Turn)
    );

  const messages: Turn[] = [
    ...priorTurns,
    {
      role: "user",
      text: params.text || (imageParts.length ? "What is in this image?" : ""),
      images: imageParts.length ? imageParts : undefined,
    },
  ];

  const tools: ToolSpec[] = VELNOR_TOOLS;
  let replyText = "";
  let modelUsed = "builtin-orchestrator";
  let providerUsed: string = "builtin";
  let usage: Usage = emptyUsage();
  const providerFailures: string[] = [];

  for (const slot of chain) {
    try {
      const result = await runAgentLoop({
        provider: createProvider(slot.id, slot.apiKey),
        model: slot.model,
        system: systemPromptWithMemories,
        messages,
        tools,
        maxOutputTokens: Number(process.env.VELNOR_MAX_OUTPUT_TOKENS || 1400),
        executeTool: async (name, args) => ({
          payload: await executeToolCall(name, args, params.channel, bundle),
        }),
      });
      replyText = result.text;
      modelUsed = result.model;
      providerUsed = slot.id;
      usage = result.usage;
      bundle.toolActions.push({
        tool: "agent_loop",
        label: "Answered via " + slot.id,
        status: "info",
        details: result.toolCalls + " tool call(s), " + result.steps + " step(s)",
      });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      providerFailures.push(slot.id + ": " + message);
      console.warn("[velnor] provider " + slot.id + " failed, trying next:", message);
    }
  }

  const costUsd = estimateCostUsd(modelUsed, usage.inputTokens, usage.outputTokens);
  if (usage.inputTokens || usage.outputTokens) {
    state.usage = {
      requests: (state.usage?.requests || 0) + 1,
      inputTokens: (state.usage?.inputTokens || 0) + usage.inputTokens,
      outputTokens: (state.usage?.outputTokens || 0) + usage.outputTokens,
      costUsd: Number(((state.usage?.costUsd || 0) + costUsd).toFixed(6)),
      lastRequestCostUsd: Number(costUsd.toFixed(6)),
      lastProvider: providerUsed,
      lastModel: modelUsed,
    };
  }

  if (!replyText) {
    if (providerFailures.length > 0 && chain.length > 0) {
      bundle.toolActions.push({
        tool: "provider_error",
        label: "All configured providers failed",
        status: "error" as any,
        details: providerFailures.join(" | ").slice(0, 300),
      });
    }
    replyText = await runBuiltInAgentOrchestrator(params, bundle);
  }

  // Deduplicate citations
  const uniqueCitations = Array.from(
    new Map(bundle.citations.map((c) => [c.url, c])).values()
  );

  const velnorMsg: ChatMessage = {
    id: `msg-${Date.now()}-o`,
    channel: params.channel,
    sender: "velnor",
    text: replyText,
    timestamp: new Date().toISOString(),
        providerUsed,
    modelUsed,
    generatedImage: bundle.generatedImage,
    citations: uniqueCitations.length > 0 ? uniqueCitations : undefined,
    toolActions: bundle.toolActions.length > 0 ? bundle.toolActions : undefined,
    structuredCard: bundle.structuredCard,
  };

  state.messages.push(velnorMsg);
  saveStore(state);
  return velnorMsg;
}

async function queryLocalVelnorLora(
  message: string,
  bundle: ToolExecutionBundle,
  context?: string
): Promise<string | null> {
  try {
    const loraRes = await fetch("http://127.0.0.1:8099/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context, max_new_tokens: 256 }),
      signal: AbortSignal.timeout(20000),
    });
    if (loraRes.ok) {
      const loraData = (await loraRes.json()) as { reply?: string; model?: string };
      if (loraData.reply) {
        bundle.toolActions.push({
          tool: "velnor_lora_adapter",
          label: "Synthesized via Velnor Local rsLoRA (velnor-coder-v2)",
          status: "success",
          details: loraData.model || "velnor-coder-v2",
        });
        return `🛡️ **Velnor (\`velnor-coder-v2\`):**\n${loraData.reply}`;
      }
    }
  } catch {
    // Fallback if local adapter daemon is offline
  }
  return null;
}

async function runBuiltInAgentOrchestrator(
  params: {
    channel: ChannelType;
    text: string;
    attachments?: Attachment[];
  },
  bundle: ToolExecutionBundle
): Promise<string> {
  const raw = params.text.trim();
  const lower = raw.toLowerCase();

  // Route identity, quantitative/math, software engineering, strategy, verification, and security prompts through the local Velnor rsLoRA adapter when online
  const isDirectLoraReasoning =
    lower === "who are you" ||
    lower === "who are you?" ||
    lower === "what is your name?" ||
    lower.includes("state your name") ||
    lower.includes("who built you") ||
    lower.includes("vectolith") ||
    lower.includes("web ui") ||
    lower.includes("web dashboard") ||
    lower.includes("paste my api key") ||
    lower.includes("api key") ||
    lower.includes("seed phrase") ||
    lower.includes("credit card") ||
    lower.includes("cvv") ||
    lower.includes("password") ||
    lower.includes("pretend the") ||
    lower.includes("confirmation number") ||
    lower.includes("unlimited free") ||
    lower.includes("captcha") ||
    lower.includes("drop table") ||
    lower.includes("rm -rf") ||
    lower.includes("another user") ||
    lower.includes("burn") ||
    lower.includes("runway") ||
    lower.includes("arr") ||
    lower.includes("mrr") ||
    lower.includes("cagr") ||
    lower.includes("solve for") ||
    lower.includes("hmac") ||
    lower.includes("sql injection") ||
    lower.includes("idempotency") ||
    lower.includes("race condition") ||
    lower.includes("rslora") ||
    lower.includes("microservice") ||
    lower.includes("raise prices") ||
    // Developer & coding capability
    lower.includes("code") ||
    lower.includes("function") ||
    lower.includes("debug") ||
    lower.includes("bug") ||
    lower.includes("refactor") ||
    lower.includes("algorithm") ||
    lower.includes("typescript") ||
    lower.includes("javascript") ||
    lower.includes("python") ||
    lower.includes("rust") ||
    lower.includes("golang") ||
    lower.includes("solidity") ||
    lower.includes("sql") ||
    lower.includes("dockerfile") ||
    lower.includes("regex") ||
    lower.includes("api endpoint") ||
    lower.includes("stack trace") ||
    lower.startsWith("write a ") ||
    lower.startsWith("implement ");

  // The local 135M adapter is opt-in: its own benchmark produced incoherent
  // answers, so it must never silently take over a real request.
  const localLoraEnabled = process.env.VELNOR_LOCAL_LORA === "1";
  if (localLoraEnabled && isDirectLoraReasoning && !params.attachments?.length) {
    const loraReply = await queryLocalVelnorLora(raw, bundle);
    if (loraReply) return loraReply;
  }

  // Check if user attached an image
  const attachedImg = params.attachments?.find((a) => a.type === "image");
  if (attachedImg) {
    bundle.toolActions.push({
      tool: "vision_analysis",
        label: `Image attached: "${attachedImg.name}"`,
      status: "success",
      details: `${attachedImg.mimeType}`,
    });
    return `Image received (${attachedImg.name}), but I cannot actually see it: no vision model is configured. Add a Gemini or OpenAI key in Settings and I will read it properly.`;
  }

  // Check if user attached a document
  const attachedDoc = params.attachments?.find((a) => a.type === "document");
  if (attachedDoc) {
    const state = getStore();
    const latestDoc = state.documents[0];
    return `📄 **Document Indexed & Summarized: ${attachedDoc.name}**\n\n**Quick Summary:**\n${
      latestDoc?.summary || attachedDoc.textContent?.slice(0, 300)
    }\n\n_Stored in Velnor's in-memory HNSW vector database (${
      latestDoc?.chunkCount || 1
    } chunks). Ask me anything about this file!_`;
  }

  // 1. URL ingestion & summarization
  const urlMatch = raw.match(/https?:\/\/[^\s]+/i);
  if (urlMatch && (lower.includes("summar") || lower.includes("read") || lower.includes("tl;dr") || lower.includes("what is"))) {
    const url = urlMatch[0];
    const res = await executeToolCall("ingest_url_or_doc", { url }, params.channel, bundle);
    const doc = res.document;
    return `🔗 **Link Summary (${doc.name})**\n\n${doc.summary}\n\n_Indexed ${doc.chunkCount} chunks into vector memory so you can ask follow-up questions._`;
  }

  // 2. Image generation intent
  if (
    lower.startsWith("generate an image") ||
    lower.startsWith("create an image") ||
    lower.startsWith("draw ") ||
    lower.includes("generate a picture") ||
    lower.includes("make an image") ||
    lower.startsWith("/imagine ")
  ) {
    const prompt = raw
      .replace(/^(\/imagine|generate an image of|create an image of|generate a picture of|make an image of|draw)\s*/i, "")
      .trim() || raw;
    await executeToolCall("generate_image", { prompt }, params.channel, bundle);
    return `🎨 Here's the visual I created for **"${prompt}"**:`;
  }

  // 3. Reminder / Task creation intent
  if (
    lower.startsWith("remind me") ||
    lower.includes("set a reminder") ||
    lower.includes("add a task")
  ) {
    const timeMatch = raw.match(/\b(tomorrow[^,.]*|today[^,.]*|in \d+\s*(?:minutes?|hours?|days?)|at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    const dueAt = timeMatch ? timeMatch[0] : "Today at 5:00 PM";
    const taskText = raw
      .replace(/^(remind me to|remind me|set a reminder to|set a reminder|add a task to)\s*/i, "")
      .replace(dueAt, "")
      .trim() || raw;

    const { reminder } = await executeToolCall(
      "create_reminder",
      { text: taskText, dueAt },
      params.channel,
      bundle
    );
    return `⏰ **Reminder Set!**\n• **Task:** ${reminder.text}\n• **When:** ${reminder.dueAt}\n• **Channel:** ${params.channel.toUpperCase()}`;
  }

  if (lower.includes("my reminders") || lower.includes("list reminders") || lower.includes("show tasks")) {
    const { reminders } = await executeToolCall("list_reminders", {}, params.channel, bundle);
    const active = reminders.filter((r: any) => !r.completed);
    if (active.length === 0) return "✅ You have no pending reminders right now!";
    return (
      `📋 **Your Active Reminders (${active.length}):**\n` +
      active.map((r: any, i: number) => `${i + 1}. **${r.text}** — _${r.dueAt}_`).join("\n")
    );
  }

  // 4. Gmail / Email intents
  if (
    lower.includes("send an email") ||
    lower.includes("draft an email") ||
    lower.includes("email sarah") ||
    lower.includes("reply to ")
  ) {
    const emailMatch = raw.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
    if (!emailMatch) {
      return "I can draft or send that, but I need the recipient's address. Try: draft an email to name@domain.com saying Thursday works.";
    }
    const to = emailMatch[0];
    const sendImmediately = lower.includes("send ");
    const subjectized = raw
      .replace(/^(send|draft) an email (to [^\s]+ )?(saying|about|that)?\s*/i, "")
      .trim();
    const subject =
      subjectized.length > 0
        ? subjectized.slice(0, 70)
        : "Quick update from Velnor";
    const body = raw
      .replace(/^(send|draft) an email (to [^\s]+ )?(saying|about|that)?\s*/i, "")
      .trim() || "Hi! Following up on our thread—let me know what time works best for you.";

    const { email } = await executeToolCall(
      "draft_or_send_email",
      { to, subject, body, sendImmediately },
      params.channel,
      bundle
    );
    if (!email) return "This email action requires confirmation or a connected Gmail account. Nothing was sent.";
    return `✉️ **Gmail ${email.status === "sent" ? "Sent" : "Draft Saved"}\n• **To:** ${email.to}\n• **Subject:** ${email.subject}\n• **Body:** "${email.body}"`;
  }

  if (
    lower.includes("archive ") &&
    (lower.includes("email") || lower.includes("inbox") || lower.includes("messages"))
  ) {
    const res = await executeToolCall(
      "organize_email",
      { query: "report", action: "archive" },
      params.channel,
      bundle
    );
    if (res.requiresConfirmation) return String(res.reason || "Email organization requires confirmation. Nothing was changed.");
    return `📥 **Inbox Organized:** Updated ${res.updatedCount || 0} email thread(s).`;
  }

  if (
    lower.includes("email") ||
    lower.includes("inbox") ||
    lower.includes("gmail") ||
    lower.includes("unread")
  ) {
    const { emails } = await executeToolCall("list_emails", {}, params.channel, bundle);
    return (
      `📬 **Gmail Summary (${emails.length} messages in Inbox):**\n\n` +
      emails
        .map(
          (e: any) =>
            `• ${e.unread ? "🔵 **UNREAD**" : "⚪"} **${e.subject}** — _from ${e.from}_ (${e.date})\n  "${e.snippet}"`
        )
        .join("\n\n") +
      "\n\nReply \"Draft an email to name@domain.com saying Thursday works\" or \"Archive report emails\" to take action."
    );
  }

  // 5. Google Calendar intents
  if (
    lower.includes("schedule a ") ||
    lower.includes("book a meeting") ||
    lower.includes("add to calendar") ||
    lower.includes("create an event")
  ) {
    const timeMatch = raw.match(/\b(\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\b/i);
    const startTime = timeMatch ? timeMatch[0] : "15:00";
    const title = raw
      .replace(/^(schedule a|book a|add to calendar|create an event)\s*/i, "")
      .slice(0, 50) || "Strategy Sync";
    const { event } = await executeToolCall(
      "create_calendar_event",
      {
        title,
        date: new Date().toISOString().split("T")[0],
        startTime,
            attendees: [],
      },
      params.channel,
      bundle
    );
    if (!event) return "Creating this calendar event requires confirmation or a connected Google Calendar account. Nothing was scheduled.";
    return `📅 **Added to Google Calendar:**\n• **Event:** ${event.title}\n• **When:** ${event.date} at ${event.startTime}–${event.endTime}\n• **Location:** ${event.location}`;
  }

  if (
    lower.includes("calendar") ||
    lower.includes("schedule") ||
    lower.includes("meetings") ||
    lower.includes("availability") ||
    lower.includes("free today")
  ) {
    const { events } = await executeToolCall("list_calendar_events", {}, params.channel, bundle);
    return (
      `🗓️ **Your Google Calendar Schedule:**\n\n` +
      events
        .map(
          (ev: any) =>
            `• **${ev.startTime}–${ev.endTime}** — **${ev.title}** (${ev.location || "Google Meet"})\n  _Attendees: ${ev.attendees.join(", ") || "Just you"}_`
        )
        .join("\n\n") +
      `\n\nAvailability has not been calculated; this is an event listing, not a free/busy check.`
    );
  }

  // 6. Travel & Local Agent / Translation
  if (
    lower.includes("plan a trip") ||
    lower.includes("itinerary") ||
    lower.includes("travel to ") ||
    lower.includes("visit ") ||
    lower.includes("flights to ") ||
    lower.includes("hotels in ")
  ) {
    const destMatch = raw.match(/(?:to|in|for|visit)\s+([A-Z][a-zA-Z\s]{2,25})/);
    const destination = destMatch ? destMatch[1].trim() : "Tokyo";
    const daysMatch = raw.match(/(\d+)\s*-?\s*day/i);
    const days = daysMatch ? Number(daysMatch[1]) : 3;

    const { plan } = await executeToolCall(
      "plan_trip_or_local",
      { destination, days },
      params.channel,
      bundle
    );

    const spotsList =
      plan.localSpots.length > 0
        ? `\n\n📍 **Verified Local Spots:**\n` +
          plan.localSpots
            .slice(0, 3)
            .map((s: any) => `• [${s.name}](${s.mapUrl}) — _${s.address.slice(0, 75)}_`)
            .join("\n")
        : "";

    const linksList =
      `\n\n🔗 **Quick Booking Links (Safe Redirects):**\n` +
      plan.bookingLinks.map((b: any) => `• [${b.label}](${b.url})`).join("\n");

    const weatherLine = plan.weather
      ? `\n🌤️ **Live Weather in ${plan.destination}:** ${plan.weather.condition}, **${plan.weather.temperatureC}°C (${plan.weather.temperatureF}°F)** • Wind ${plan.weather.windKmh} km/h\n`
      : "";

    return (
      `✈️ **${plan.days}-Day Travel Plan: ${plan.destination}**\n` +
      weatherLine +
      `\n` +
      plan.highlights.map((h: string) => `• ${h}`).join("\n") +
      spotsList +
      linksList
    );
  }

  // Long-Term User Memory intents
  if (
    lower.startsWith("remember that") ||
    lower.startsWith("remember my") ||
    lower.startsWith("save to memory") ||
    lower.includes("my favorite ") ||
    lower.includes("my home airport is")
  ) {
    const cleanFact = raw
      .replace(/^(remember that|remember|save to memory:?)\s*/i, "")
      .trim() || raw;
    const { memory } = await executeToolCall(
      "remember_user_fact",
      { fact: cleanFact },
      params.channel,
      bundle
    );
    return `🧠 **Saved to Velnor Memory (${memory.category.toUpperCase()}):**\n"${memory.fact}"\n\n_I'll automatically apply this preference across your future chats, travel plans, and emails._`;
  }

  if (
    lower.includes("what do you remember") ||
    lower.includes("my preferences") ||
    lower.includes("show memory") ||
    lower.includes("know about me")
  ) {
    const { memories } = await executeToolCall(
      "recall_user_facts",
      {},
      params.channel,
      bundle
    );
    return (
      `🧠 **What Velnor Remembers About You (${memories.length} facts):**\n\n` +
      memories
        .map((m: any) => `• **[${m.category.toUpperCase()}]** ${m.fact}`)
        .join("\n")
    );
  }

  if (lower.startsWith("translate ") || lower.includes("how do you say")) {
    return `🌐 **Quick Translation Guide:**\n• **Japanese:** ありがとうございます (*Arigatō gozaimasu*)\n• **Spanish:** ¡Muchas gracias! ¿Dónde está la estación?\n• **French:** Merci beaucoup, pourriez-vous m'aider ?\n\n_Tip: Send any menu photo or voice note to translate on the fly!_`;
  }

  // 7. Document / PDF / Vector DB question answering
  if (
    lower.includes("document") ||
    lower.includes("pdf") ||
    lower.includes("brief") ||
    lower.includes("vector") ||
    lower.includes("uploaded")
  ) {
    const { matches } = await executeToolCall(
      "query_documents",
      { query: raw },
      params.channel,
      bundle
    );
    const top = matches[0];
    return `📚 **From Your Uploaded Docs (${top?.docName || "Knowledge Base"}):**\n\n"${
      top?.content || "No matching chunks found."
    }"\n\n_Matched via in-memory cosine similarity (score: ${top?.score ?? 0})._`;
  }

  // 8. Default: Consult local Velnor rsLoRA reasoning model unless user explicitly requests live web search
  const wantsLiveWeb =
    lower.includes("search ") ||
    lower.includes("latest ") ||
    lower.includes("news") ||
    lower.includes("weather") ||
    lower.includes("current ") ||
    lower.includes("today's ");

  if (!wantsLiveWeb && process.env.VELNOR_LOCAL_LORA === "1") {
    const loraReply = await queryLocalVelnorLora(raw, bundle);
    if (loraReply) return loraReply;
  }

  const searchRes = await executeToolCall(
    "web_search",
    { query: raw },
    params.channel,
    bundle
  );
  return `🌐 **Live Web Answer:**\n\n${searchRes.summary}\n\n_Grounded with ${searchRes.citations.length} live source(s)._`;
}


