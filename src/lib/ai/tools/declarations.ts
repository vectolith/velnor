import { ToolSpec } from "../providers/types";

export const VELNOR_FUNCTION_DECLARATIONS = [
  {
    type: "function" as const,
    name: "delegate_browser_task",
    description: "Delegate a multi-step browser automation or web interaction task to Blud's Kernel coordinator (form submission, interactive scraping, button clicking, multi-page workflows).",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear instructions of what to perform in the browser" },
        startUrl: { type: "string", description: "Initial URL to navigate to" },
      },
      required: ["task"],
    },
  },
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

/** Same declarations, in the provider-neutral shape the loop consumes. */
export const VELNOR_TOOLS: ToolSpec[] = VELNOR_FUNCTION_DECLARATIONS.map(
  (fn) => ({ name: fn.name, description: fn.description, parameters: fn.parameters as Record<string, any> })
);
