export type AIProviderId = "gemini" | "openai" | "anthropic" | "auto";

export type ChannelType = "imessage" | "slack" | "sms";

export interface Citation {
  title: string;
  url: string;
  snippet?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  type: "image" | "document" | "audio";
  dataUrl?: string;
  textContent?: string;
  size?: number;
}

export interface ToolActionSummary {
  tool: string;
  label: string;
  status: "success" | "info";
  details?: string;
  data?: Record<string, unknown>;
}

export interface MemoryFact {
  id: string;
  category: "preference" | "contact" | "travel" | "work";
  fact: string;
  createdAt: string;
}

export interface StructuredCardData {
  type: "travel" | "calendar" | "email_draft" | "weather";
  title: string;
  subtitle?: string;
  metadata?: Record<string, any>;
}

export interface ChatMessage {
  id: string;
  channel: ChannelType;
  sender: "user" | "olli";
  userHandle?: string; // e.g. +1 (555) 019-2834 or @alex
  text: string;
  timestamp: string;
  providerUsed?: string;
  modelUsed?: string;
  interactionId?: string;
  attachments?: Attachment[];
  generatedImage?: {
    dataUrl: string;
    prompt: string;
  };
  citations?: Citation[];
  toolActions?: ToolActionSummary[];
  structuredCard?: StructuredCardData;
  reactions?: string[];
}

export interface ReminderItem {
  id: string;
  text: string;
  dueAt: string;
  channel: ChannelType;
  recipient?: string;
  completed: boolean;
  createdAt: string;
}

export interface CalendarEventItem {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  attendees: string[];
  location?: string;
  description?: string;
  source: "local" | "google_calendar";
}

export interface EmailItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  date: string;
  unread: boolean;
  archived: boolean;
  labels: string[];
  status: "inbox" | "sent" | "draft";
}

export interface DocumentChunk {
  id: string;
  docId: string;
  docName: string;
  content: string;
  tokens: string[];
  embedding?: number[];
}

export interface IndexedDocument {
  id: string;
  name: string;
  sourceType: "file" | "url";
  url?: string;
  summary: string;
  chunkCount: number;
  wordCount: number;
  createdAt: string;
}

export interface ProviderConfig {
  activeProvider: AIProviderId;
  geminiApiKey?: string;
  geminiModel: string;
  geminiImageModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  sendblueApiKey?: string;
  sendblueApiSecret?: string;
  loopMessageAuthKey?: string;
  loopMessageSecretKey?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleAccessToken?: string;
  googleRefreshToken?: string;
  googleConnectedEmail?: string;
}

