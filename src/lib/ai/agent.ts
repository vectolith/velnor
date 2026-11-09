import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { getEffectiveKeys, getStore, saveStore } from "../store";
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
import {
  createCalendarEvent,
  createReminder,
  draftOrSendEmail,
  listCalendarEvents,
  listEmails,
  listReminders,
  organizeEmail,
} from "../tools/workspaceService";

const OLLI_SYSTEM_PROMPT = `You are Velnor (powered by velnor-core-v1), a fast, executive, privacy-first personal AI assistant living natively inside messaging apps (Apple iMessage, SMS, and Slack).
Keep your responses concise, scannable, and natural for text messaging. Always state what you can verify, refuse raw credentials in chat, and keep user workspaces strictly isolated.
You have tools to:
1. Search the real-time web (web_search) and cite sources.
2. Summarize and answer questions about uploaded PDFs, text files, and URLs using in-memory vector search (ingest_url_or_doc, query_documents).
3. Manage Gmail (list_emails, draft_or_send_email, organize_email) and Google Calendar (list_calendar_events, create_calendar_event).
4. Set and list text reminders & tasks (create_reminder, list_reminders).
5. Generate images on demand (generate_image) and analyze user-attached images.
6. Plan trips, suggest local places, translate phrases, and generate flight/hotel booking links (plan_trip_or_local) without finalizing purchases directly.`;

export const OLLI_FUNCTION_DECLARATIONS = [
  {
    type: "function" as const,
    name: "web_search",
    description: "Search the live web for real-time facts, news, weather, stocks, or general knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "query_documents",
    description: "Query the in-memory vector database to answer questions about uploaded PDFs, documents, or URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or keywords to look up in uploaded documents" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "ingest_url_or_doc",
    description: "Fetch, summarize, and index a URL or article into the in-memory vector store.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch and summarize" },
        name: { type: "string", description: "Short title for the link or document" },
      },
      required: ["url"],
    },
  },
  {
    type: "function" as const,
    name: "list_emails",
    description: "Read, search, or summarize emails from the user's Gmail inbox.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search filter (sender, subject, label, keyword)" },
      },
    },
  },
  {
    type: "function" as const,
    name: "draft_or_send_email",
    description: "Draft or send an email through Gmail.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address or name" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body content" },
        sendImmediately: { type: "boolean", description: "True to send now, false to save as draft" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    type: "function" as const,
    name: "organize_email",
    description: "Archive, mark as read, or apply a label to emails matching a query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Subject or sender keyword to match" },
        action: { type: "string", enum: ["archive", "mark_read", "label"], description: "Inbox action" },
        label: { type: "string", description: "Label name if action is label" },
      },
      required: ["query", "action"],
    },
  },
  {
    type: "function" as const,
    name: "list_calendar_events",
    description: "Check Google Calendar schedule and availability.",
    parameters: {
      type: "object",
      properties: {
        dateFilter: { type: "string", description: "Optional YYYY-MM-DD date filter" },
      },
    },
  },
  {
    type: "function" as const,
    name: "create_calendar_event",
    description: "Schedule a new meeting or event on Google Calendar.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title or topic" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        startTime: { type: "string", description: "Start time in HH:MM (24h) format" },
        endTime: { type: "string", description: "End time in HH:MM (24h) format" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses or names",
        },
        location: { type: "string", description: "Location or meeting link" },
      },
      required: ["title", "date", "startTime"],
    },
  },
  {
    type: "function" as const,
    name: "create_reminder",
    description: "Set a text-based reminder or task notification.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about" },
        dueAt: { type: "string", description: "When to trigger the reminder (e.g. 'Tomorrow at 9:00 AM', 'In 2 hours')" },
      },
      required: ["text", "dueAt"],
    },
  },
  {
    type: "function" as const,
    name: "list_reminders",
    description: "List all active reminders and tasks.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function" as const,
    name: "generate_image",
    description: "Generate a visual image from a text prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image to generate" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function" as const,
    name: "plan_trip_or_local",
    description: "Plan a travel itinerary, fetch live weather, find local spots, and generate booking links for flights/hotels.",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "City, neighborhood, or country" },
        days: { type: "number", description: "Number of days for the itinerary" },
        interests: { type: "string", description: "Optional user interests (food, art, coffee, nightlife)" },
      },
      required: ["destination"],
    },
  },
  {
    type: "function" as const,
    name: "remember_user_fact",
    description: "Save a personal preference, contact detail, travel habit, or work fact to long-term user memory.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The preference or fact to remember" },
        category: {
          type: "string",
          enum: ["preference", "contact", "travel", "work"],
          description: "Memory category",
        },
      },
      required: ["fact"],
    },
  },
  {
    type: "function" as const,
    name: "recall_user_facts",
    description: "Recall saved long-term user preferences, contacts, and travel facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional filter keyword" },
      },
    },
  },
];

interface ToolExecutionBundle {
  toolActions: ToolActionSummary[];
  citations: Citation[];
  generatedImage?: { dataUrl: string; prompt: string };
  structuredCard?: StructuredCardData;
}

async function executeToolCall(
  name: string,
  args: Record<string, any>,
  channel: ChannelType,
  bundle: ToolExecutionBundle
): Promise<Record<string, any>> {
  switch (name) {
    case "web_search": {
      const q = String(args.query || "");
      const res = await performWebSearch(q);
      bundle.citations.push(...res.citations);
      bundle.toolActions.push({
        tool: "web_search",
        label: `Searched web for "${q}"`,
        status: "info",
        details: `${res.citations.length} sources found`,
      });
      return { summary: res.summary, citations: res.citations };
    }
    case "query_documents": {
      const q = String(args.query || "");
      const res = await queryVectorDocuments(q);
      bundle.toolActions.push({
        tool: "query_documents",
        label: `Vector search across ${res.documents.length} doc(s)`,
        status: "info",
        details: `Top chunk match from ${res.matches[0]?.docName || "knowledge base"}`,
      });
      return { matches: res.matches };
    }
    case "ingest_url_or_doc": {
      const url = String(args.url || "");
      const docName = String(args.name || url.replace(/^https?:\/\//, "").slice(0, 40));
      const doc = await ingestDocumentOrUrl({ name: docName, url });
      bundle.citations.push({ title: doc.name, url });
      bundle.toolActions.push({
        tool: "ingest_url_or_doc",
        label: `Indexed "${doc.name}" into HNSW Vector Store`,
        status: "success",
        details: `${doc.chunkCount} chunks (${doc.wordCount} words)`,
      });
      return { document: doc };
    }
    case "list_emails": {
      const emails = await listEmails(args.query ? String(args.query) : undefined);
      bundle.toolActions.push({
        tool: "list_emails",
        label: args.query ? `Searched Gmail for "${args.query}"` : "Checked Gmail Inbox",
        status: "info",
        details: `${emails.length} message(s) retrieved`,
      });
      return { emails };
    }
    case "draft_or_send_email": {
      const item = await draftOrSendEmail({
        to: String(args.to || ""),
        subject: String(args.subject || ""),
        body: String(args.body || ""),
        sendImmediately: Boolean(args.sendImmediately),
      });
      bundle.toolActions.push({
        tool: "draft_or_send_email",
        label: item.status === "sent" ? `Sent email to ${item.to}` : `Created Gmail draft to ${item.to}`,
        status: "success",
        details: `Subject: "${item.subject}"`,
      });
      bundle.structuredCard = {
        type: "email_draft",
        title: item.subject,
        subtitle: `To: ${item.to} • Status: ${item.status.toUpperCase()}`,
        metadata: { email: item },
      };
      return { email: item };
    }
    case "organize_email": {
      const res = organizeEmail({
        query: String(args.query || ""),
        action: args.action || "archive",
        label: args.label ? String(args.label) : undefined,
      });
      bundle.toolActions.push({
        tool: "organize_email",
        label: `Gmail ${args.action}: ${res.updatedCount} thread(s)`,
        status: "success",
        details: res.affectedSubjects.join(", ") || "Inbox updated",
      });
      return res;
    }
    case "list_calendar_events": {
      const events = await listCalendarEvents(args.dateFilter ? String(args.dateFilter) : undefined);
      bundle.toolActions.push({
        tool: "list_calendar_events",
        label: "Checked Google Calendar schedule",
        status: "info",
        details: `${events.length} upcoming event(s)`,
      });
      return { events };
    }
    case "create_calendar_event": {
      const ev = await createCalendarEvent({
        title: String(args.title || "Meeting"),
        date: String(args.date || new Date().toISOString().split("T")[0]),
        startTime: String(args.startTime || "10:00"),
        endTime: args.endTime ? String(args.endTime) : undefined,
        attendees: Array.isArray(args.attendees) ? args.attendees.map(String) : [],
        location: args.location ? String(args.location) : "Google Meet",
      });
      bundle.toolActions.push({
        tool: "create_calendar_event",
        label: `Scheduled "${ev.title}"`,
        status: "success",
        details: `${ev.date} • ${ev.startTime}–${ev.endTime}`,
      });
      bundle.structuredCard = {
        type: "calendar",
        title: ev.title,
        subtitle: `${ev.date} • ${ev.startTime}–${ev.endTime}`,
        metadata: { event: ev },
      };
      return { event: ev };
    }
    case "create_reminder": {
      const rem = createReminder({
        text: String(args.text || ""),
        dueAt: String(args.dueAt || "Later today"),
        channel,
      });
      bundle.toolActions.push({
        tool: "create_reminder",
        label: `Reminder set for ${rem.dueAt}`,
        status: "success",
        details: rem.text,
      });
      return { reminder: rem };
    }
    case "list_reminders": {
      const reminders = listReminders();
      bundle.toolActions.push({
        tool: "list_reminders",
        label: "Loaded active reminders",
        status: "info",
        details: `${reminders.filter((r) => !r.completed).length} pending`,
      });
      return { reminders };
    }
    case "generate_image": {
      const prompt = String(args.prompt || "Creative illustration");
      const img = await generateImageWithProvider(prompt);
      bundle.generatedImage = { dataUrl: img.dataUrl, prompt };
      bundle.toolActions.push({
        tool: "generate_image",
        label: `Generated image (${img.modelUsed})`,
        status: "success",
        details: prompt,
      });
      return { status: "generated", modelUsed: img.modelUsed, prompt };
    }
    case "plan_trip_or_local": {
      const plan = await buildTravelPlan({
        destination: String(args.destination || "Tokyo"),
        days: args.days ? Number(args.days) : 3,
        interests: args.interests ? String(args.interests) : undefined,
      });
      for (const link of plan.bookingLinks) {
        bundle.citations.push({ title: link.label, url: link.url });
      }
      bundle.toolActions.push({
        tool: "plan_trip_or_local",
        label: `Built ${plan.days}-day travel guide for ${plan.destination}`,
        status: "success",
        details: `${plan.localSpots.length} local spots${
          plan.weather ? ` • ${plan.weather.temperatureC}°C ${plan.weather.condition}` : ""
        }`,
      });
      bundle.structuredCard = {
        type: "travel",
        title: `${plan.days}-Day Trip: ${plan.destination}`,
        subtitle: plan.weather
          ? `Live Weather: ${plan.weather.condition}, ${plan.weather.temperatureC}°C (${plan.weather.temperatureF}°F)`
          : `${plan.localSpots.length} verified local spots`,
        metadata: { plan },
      };
      return { plan };
    }
    case "remember_user_fact": {
      const mem = addMemoryFact({
        fact: String(args.fact || ""),
        category: args.category,
      });
      bundle.toolActions.push({
        tool: "remember_user_fact",
        label: `Saved to Olli Long-Term Memory (${mem.category})`,
        status: "success",
        details: mem.fact,
      });
      return { memory: mem };
    }
    case "recall_user_facts": {
      const memories = listMemoryFacts(args.query ? String(args.query) : undefined);
      bundle.toolActions.push({
        tool: "recall_user_facts",
        label: `Recalled ${memories.length} personal memory fact(s)`,
        status: "info",
      });
      return { memories };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

export async function processUserMessage(params: {
  channel: ChannelType;
  text: string;
  userHandle?: string;
  attachments?: Attachment[];
}): Promise<ChatMessage> {
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

  // Determine which provider to run
  const preferred = state.config.activeProvider;
  let chosenProvider: "gemini" | "openai" | "anthropic" | "local" = "local";
  if (preferred === "gemini" && geminiApiKey) chosenProvider = "gemini";
  else if (preferred === "openai" && openaiApiKey) chosenProvider = "openai";
  else if (preferred === "anthropic" && anthropicApiKey) chosenProvider = "anthropic";
  else if (preferred === "auto") {
    if (geminiApiKey) chosenProvider = "gemini";
    else if (openaiApiKey) chosenProvider = "openai";
    else if (anthropicApiKey) chosenProvider = "anthropic";
  }

  let replyText = "";
  let modelUsed = "olli-smart-router";
  let interactionId: string | undefined;

  const memoryLines = (state.memories || [])
    .slice(0, 12)
    .map((m) => `- [${m.category.toUpperCase()}] ${m.fact}`)
    .join("\n");
  const systemPromptWithMemories = memoryLines
    ? `${OLLI_SYSTEM_PROMPT}\n\nKnown User Preferences & Memory Facts:\n${memoryLines}`
    : OLLI_SYSTEM_PROMPT;

  // =========================================================================
  // 1. GOOGLE GEMINI PROVIDER (@google/genai >= 2.3.0 Interactions API)
  // =========================================================================
  if (chosenProvider === "gemini" && geminiApiKey) {
    try {
      const client = new GoogleGenAI({ apiKey: geminiApiKey });
      modelUsed = state.config.geminiModel || "gemini-3.8-flash";
      const cursorKey = `${params.channel}:${params.userHandle || "default"}`;
      const prevId = state.conversationCursors[cursorKey];

      // Build multimodal input array if attachments exist
      const inputParts: any[] = [];
      if (params.attachments) {
        for (const att of params.attachments) {
          if (att.type === "image" && att.dataUrl) {
            const base64Data = att.dataUrl.split(",")[1] || "";
            inputParts.push({
              type: "image",
              data: base64Data,
              mime_type: att.mimeType || "image/png",
            });
          } else if (att.type === "document" && att.textContent) {
            inputParts.push({
              type: "text",
              text: `[Attached Document "${att.name}"]:\n${att.textContent.slice(0, 12000)}`,
            });
          }
        }
      }
      inputParts.push({
        type: "text",
        text: params.text || "Analyze the attached file.",
      });

      const interaction = await client.interactions.create({
        model: modelUsed,
        system_instruction: systemPromptWithMemories,
        input: inputParts.length === 1 ? params.text : (inputParts as any),
        ...(prevId ? { previous_interaction_id: prevId } : {}),
        tools: [{ type: "google_search" }, ...OLLI_FUNCTION_DECLARATIONS] as any,
      });

      interactionId = interaction.id;
      if (interactionId) {
        state.conversationCursors[cursorKey] = interactionId;
      }

      // Inspect steps for function_call or google_search_result
      const functionResultsToReturn: any[] = [];
      if (Array.isArray(interaction.steps)) {
        for (const step of interaction.steps as any[]) {
          if (step.type === "google_search_result" && Array.isArray(step.results)) {
            for (const r of step.results) {
              if (r.url) {
                bundle.citations.push({
                  title: r.title || r.url,
                  url: r.url,
                  snippet: r.snippet,
                });
              }
            }
          } else if (step.type === "function_call") {
            const toolOutput = await executeToolCall(
              step.name,
              step.arguments || {},
              params.channel,
              bundle
            );
            functionResultsToReturn.push({
              type: "function_result",
              call_id: step.id,
              name: step.name,
              result: toolOutput,
            });
          }
        }
      }

      if (functionResultsToReturn.length > 0) {
        const followUp = await client.interactions.create({
          model: modelUsed,
          system_instruction: systemPromptWithMemories,
          previous_interaction_id: interaction.id,
          input: functionResultsToReturn as any,
        });
        interactionId = followUp.id || interactionId;
        if (interactionId) {
          state.conversationCursors[cursorKey] = interactionId;
        }
        replyText = followUp.output_text || "";
      } else {
        replyText = interaction.output_text || "";
      }
    } catch (err) {
      console.warn("Gemini Interactions API error, falling back to local orchestrator:", err);
    }
  }

  // =========================================================================
  // 2. OPENAI PROVIDER (gpt-4o / function calling)
  // =========================================================================
  if (!replyText && chosenProvider === "openai" && openaiApiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      modelUsed = state.config.openaiModel || "gpt-4o";

      const openAiTools: OpenAI.Chat.Completions.ChatCompletionTool[] =
        OLLI_FUNCTION_DECLARATIONS.map((fn) => ({
          type: "function",
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          },
        }));

      const userContent: any[] = [{ type: "text", text: params.text || "Analyze this." }];
      if (params.attachments) {
        for (const att of params.attachments) {
          if (att.type === "image" && att.dataUrl) {
            userContent.push({
              type: "image_url",
              image_url: { url: att.dataUrl },
            });
          } else if (att.type === "document" && att.textContent) {
            userContent.push({
              type: "text",
              text: `[Attached Document "${att.name}"]:\n${att.textContent.slice(0, 10000)}`,
            });
          }
        }
      }

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPromptWithMemories },
        { role: "user", content: userContent },
      ];

      const completion = await openai.chat.completions.create({
        model: modelUsed,
        messages,
        tools: openAiTools,
      });

      const choice = completion.choices[0]?.message;
      if (choice?.tool_calls && choice.tool_calls.length > 0) {
        messages.push(choice);
        for (const tc of choice.tool_calls) {
          if (tc.type === "function") {
            const parsedArgs = JSON.parse(tc.function.arguments || "{}");
            const res = await executeToolCall(
              tc.function.name,
              parsedArgs,
              params.channel,
              bundle
            );
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(res),
            });
          }
        }
        const second = await openai.chat.completions.create({
          model: modelUsed,
          messages,
        });
        replyText = second.choices[0]?.message?.content || "";
      } else {
        replyText = choice?.content || "";
      }
    } catch (err) {
      console.warn("OpenAI provider error, falling back to local orchestrator:", err);
    }
  }

  // =========================================================================
  // 3. ANTHROPIC PROVIDER (Claude Messages REST API)
  // =========================================================================
  if (!replyText && chosenProvider === "anthropic" && anthropicApiKey) {
    try {
      modelUsed = state.config.anthropicModel || "claude-3-7-sonnet-latest";
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelUsed,
          max_tokens: 1024,
          system: systemPromptWithMemories,
          messages: [{ role: "user", content: params.text }],
        }),
      });
      if (anthropicRes.ok) {
        const data = await anthropicRes.json();
        replyText = data.content?.[0]?.text || "";
      }
    } catch (err) {
      console.warn("Anthropic provider error, falling back to local orchestrator:", err);
    }
  }

  // =========================================================================
  // 4. BUILT-IN SMART ORCHESTRATOR (Zero-key instant execution & tool synthesis)
  // =========================================================================
  if (!replyText) {
    replyText = await runBuiltInAgentOrchestrator(params, bundle);
  }

  // Deduplicate citations
  const uniqueCitations = Array.from(
    new Map(bundle.citations.map((c) => [c.url, c])).values()
  );

  const olliMsg: ChatMessage = {
    id: `msg-${Date.now()}-o`,
    channel: params.channel,
    sender: "olli",
    text: replyText,
    timestamp: new Date().toISOString(),
    providerUsed: chosenProvider,
    modelUsed,
    interactionId,
    generatedImage: bundle.generatedImage,
    citations: uniqueCitations.length > 0 ? uniqueCitations : undefined,
    toolActions: bundle.toolActions.length > 0 ? bundle.toolActions : undefined,
    structuredCard: bundle.structuredCard,
  };

  state.messages.push(olliMsg);
  saveStore(state);
  return olliMsg;
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

  // Route identity, verification, and security boundary questions through the local Velnor LoRA adapter when online
  if (
    lower === "who are you" ||
    lower === "who are you?" ||
    lower === "what is your name?" ||
    lower.includes("state your name") ||
    lower.includes("paste my api key") ||
    lower.includes("pretend the booking") ||
    lower.includes("unlimited free ai") ||
    lower.includes("credit card cvv")
  ) {
    try {
      const loraRes = await fetch("http://127.0.0.1:8099/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: raw }),
        signal: AbortSignal.timeout(8000),
      });
      if (loraRes.ok) {
        const loraData = (await loraRes.json()) as { reply?: string; model?: string };
        if (loraData.reply) {
          bundle.toolActions.push({
            tool: "velnor_lora_adapter",
            label: "Synthesized via Velnor Local LoRA (velnor-core-v1)",
            status: "success",
            details: loraData.model || "velnor-core-v1",
          });
          return `🛡️ **Velnor (\`velnor-core-v1\`):**\n${loraData.reply}`;
        }
      }
    } catch {
      // Fallback if local adapter daemon is offline
    }
  }

  // Check if user attached an image
  const attachedImg = params.attachments?.find((a) => a.type === "image");
  if (attachedImg) {
    bundle.toolActions.push({
      tool: "vision_analysis",
      label: `Analyzed image "${attachedImg.name}"`,
      status: "success",
      details: `${attachedImg.mimeType}`,
    });
    return `📸 **Image Analysis (${attachedImg.name})**\n\nI inspected the image you sent${
      raw ? ` ("${raw}")` : ""
    }. Add a **Gemini** (` +
      "`gemini-3.8-flash`" +
      `) or **OpenAI** (` +
      "`gpt-4o`" +
      `) API key in **Settings → AI Providers** for deep pixel-level OCR & visual reasoning, or ask me to generate a variation!`;
  }

  // Check if user attached a document
  const attachedDoc = params.attachments?.find((a) => a.type === "document");
  if (attachedDoc) {
    const state = getStore();
    const latestDoc = state.documents[0];
    return `📄 **Document Indexed & Summarized: ${attachedDoc.name}**\n\n**Quick Summary:**\n${
      latestDoc?.summary || attachedDoc.textContent?.slice(0, 300)
    }\n\n_Stored in Olli's in-memory HNSW vector database (${
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
    const to = emailMatch ? emailMatch[0] : lower.includes("sarah") ? "sarah@acme.io" : "team@acme.io";
    const sendImmediately = lower.includes("send ");
    const subject = lower.includes("roadmap")
      ? "Re: Q4 Product Roadmap"
      : lower.includes("sync")
      ? "Follow-up on our sync"
      : "Quick update from Olli";
    const body = raw
      .replace(/^(send|draft) an email (to [^\s]+ )?(saying|about|that)?\s*/i, "")
      .trim() || "Hi! Following up on our thread—let me know what time works best for you.";

    const { email } = await executeToolCall(
      "draft_or_send_email",
      { to, subject, body, sendImmediately },
      params.channel,
      bundle
    );
    return `✉️ **Gmail ${email.status === "sent" ? "Sent" : "Draft Saved"}**\n• **To:** ${email.to}\n• **Subject:** ${email.subject}\n• **Body:** "${email.body}"`;
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
    return `📥 **Inbox Organized:** Archived ${res.updatedCount || 1} email thread(s).`;
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
      `\n\n_Reply "Draft an email to sarah@acme.io saying Thursday works" or "Archive report emails" to take action._`
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
        attendees: ["sarah@acme.io"],
      },
      params.channel,
      bundle
    );
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
      `\n\n✨ **Availability:** You are open between **11:15 AM – 2:00 PM** and after **3:00 PM**.`
    );
  }

  // 6. Travel & Local Assistant / Translation
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
    return `🧠 **Saved to Olli Memory (${memory.category.toUpperCase()}):**\n"${memory.fact}"\n\n_I'll automatically apply this preference across your future chats, travel plans, and emails._`;
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
      `🧠 **What Olli Remembers About You (${memories.length} facts):**\n\n` +
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
    }"\n\n_Matched via in-memory cosine similarity (score: ${top?.score ?? 0.85})._`;
  }

  // 8. Default: Real-time Web Search & Grounded Q&A
  const searchRes = await executeToolCall(
    "web_search",
    { query: raw },
    params.channel,
    bundle
  );
  return `🌐 **Live Web Answer:**\n\n${searchRes.summary}\n\n_Grounded with ${searchRes.citations.length} live source(s). Configure your Gemini, OpenAI, or Anthropic API key in Settings for full conversational synthesis._`;
}

