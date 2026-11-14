import { getEffectiveKeys, getStore, saveStore } from "../../store";
import { enforceToolPolicyAsync } from "../../security/asyncToolPolicy";
import {
  Attachment,
  ChannelType,
  ChatMessage,
  Citation,
  StructuredCardData,
  ToolActionSummary,
} from "../../types";
import { ingestDocumentOrUrl, queryVectorDocuments } from "../../tools/documentStore";
import { addMemoryFactAsync, listMemoryFactsAsync } from "../../tools/memoryStore";
import { getNodeTenantRepositoryContext } from "../../storage/currentTenantRepository";
import { generateImageWithProvider } from "../../tools/multimodal";
import { buildTravelPlan } from "../../tools/travelService";
import { performWebSearch } from "../../tools/webSearch";
import { delegateBrowserTaskToBlud } from "../../tools/bludBridge";
import {
  createCalendarEvent,
  createReminder,
  draftOrSendEmail,
  listCalendarEvents,
  listEmails,
  listReminders,
  organizeEmail,
} from "../../tools/workspaceService";
export interface ToolExecutionBundle {
  toolActions: ToolActionSummary[];
  citations: Citation[];
  generatedImage?: { dataUrl: string; prompt: string };
  structuredCard?: StructuredCardData;
}

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  channel: ChannelType,
  bundle: ToolExecutionBundle,
  userHandle?: string
): Promise<Record<string, any>> {
  const { repository, tenantId } = getNodeTenantRepositoryContext();
  const policy = await enforceToolPolicyAsync(repository, tenantId, name, args);
  if (!policy.allowed) {
    bundle.toolActions.push({
      tool: name,
      label: "Awaiting confirmation",
      status: "pending",
      details: policy.reason,
    });
    return {
      requiresConfirmation: true,
      tool: name,
      reason: policy.reason,
      instruction: "Ask the owner to confirm in their next message; do not retry in this turn.",
    };
  }

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
        label: `Semantic search across ${res.documents.length} doc(s)`,
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
        label: `Indexed "${doc.name}" into tenant document store`,
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
      const res = await organizeEmail({
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
        dueAt: String(args.dueAt || new Date(Date.now() + 60 * 60 * 1000).toISOString()),
        channel,
        recipient: channel === "imessage" ? userHandle : undefined,
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
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const mem = await addMemoryFactAsync(repository, tenantId, {
        fact: String(args.fact || ""),
        category: args.category,
      });
      bundle.toolActions.push({
        tool: "remember_user_fact",
        label: `Saved to Velnor Long-Term Memory (${mem.category})`,
        status: "success",
        details: mem.fact,
      });
      return { memory: mem };
    }
    case "recall_user_facts": {
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const memories = await listMemoryFactsAsync(
        repository,
        tenantId,
        args.query ? String(args.query) : undefined
      );
      bundle.toolActions.push({
        tool: "recall_user_facts",
        label: `Recalled ${memories.length} personal memory fact(s)`,
        status: "info",
      });
      return { memories };
    }
    case "delegate_browser_task": {
      const task = String(args.task || "");
      const startUrl = args.startUrl ? String(args.startUrl) : undefined;
      const res = await delegateBrowserTaskToBlud({ task, startUrl });
      bundle.toolActions.push({
        tool: "delegate_browser_task",
        label: `Blud Browser Task: ${res.status.toUpperCase()}`,
        status: res.status === "success" ? "success" : res.status === "offline" ? "info" : "error",
        details: res.summary,
      });
      return { browserResult: res };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
