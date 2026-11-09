"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AIProviderId,
  Attachment,
  CalendarEventItem,
  ChannelType,
  ChatMessage,
  EmailItem,
  IndexedDocument,
  MemoryFact,
  ReminderItem,
} from "@/lib/types";
import { RichMessageRenderer } from "@/components/RichMessageRenderer";
import {
  Archive,
  Bell,
  Brain,
  Calendar,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Image as ImageIcon,
  Layers,
  Link2,
  Mail,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Plane,
  Plus,
  Send,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  UserPlus,
  Volume2,
  Webhook,
  X,
} from "lucide-react";

const QUICK_PROMPTS = [
  {
    icon: Globe,
    label: "Live Web Search",
    prompt: "What are the latest breakthroughs in solid-state batteries and quantum computing?",
  },
  {
    icon: Mail,
    label: "Triage Gmail Inbox",
    prompt: "Summarize my unread emails in Gmail and tell me what needs a reply first.",
  },
  {
    icon: Calendar,
    label: "Check Calendar & Schedule",
    prompt: "What is on my Google Calendar today and when am I free for a 30-minute call?",
  },
  {
    icon: Bell,
    label: "Set Text Reminder",
    prompt: "Remind me tomorrow at 9:30 AM to send the investor deck to David",
  },
  {
    icon: FileText,
    label: "Chat with Docs (Vector DB)",
    prompt: "Based on my uploaded Olli Product Brief PDF, how does document search work?",
  },
  {
    icon: ImageIcon,
    label: "Generate Image",
    prompt: "Create an image of a futuristic neon ramen shop in Tokyo on a rainy night",
  },
  {
    icon: Plane,
    label: "3-Day Travel Itinerary",
    prompt: "Plan a trip to Tokyo for 3 days with coffee spots, landmarks, and booking links",
  },
];

export default function OlliAppPage() {
  const [activeChannel, setActiveChannel] = useState<ChannelType>("imessage");
  const [viewMode, setViewMode] = useState<"chat" | "webhooks">("chat");
  const [rightTab, setRightTab] = useState<"workspace" | "reminders" | "docs" | "memory">("workspace");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventItem[]>([]);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [newMemoryFact, setNewMemoryFact] = useState("");

  const [inputText, setInputText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Provider & Settings state
  const [activeProvider, setActiveProvider] = useState<AIProviderId>("auto");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3.8-flash");
  const [geminiImageModel, setGeminiImageModel] = useState("gemini-3.1-flash-image");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("claude-3-7-sonnet-latest");

  const [twilioAccountSid, setTwilioAccountSid] = useState("");
  const [twilioAuthToken, setTwilioAuthToken] = useState("");
  const [twilioFromNumber, setTwilioFromNumber] = useState("");
  const [sendblueApiKey, setSendblueApiKey] = useState("");
  const [sendblueApiSecret, setSendblueApiSecret] = useState("");
  const [loopMessageAuthKey, setLoopMessageAuthKey] = useState("");
  const [loopMessageSecretKey, setLoopMessageSecretKey] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleAccessToken, setGoogleAccessToken] = useState("");
  const [googleConnectedEmail, setGoogleConnectedEmail] = useState("");

  const [providerStatus, setProviderStatus] = useState<{
    geminiConfigured?: boolean;
    openaiConfigured?: boolean;
    anthropicConfigured?: boolean;
    googleConnectedEmail?: string | null;
    slackConfigured?: boolean;
    imessageConfigured?: boolean;
  }>({});

  // Quick URL / Document ingest state
  const [newDocUrl, setNewDocUrl] = useState("");
  const [isIngestingUrl, setIsIngestingUrl] = useState(false);

  // Quick Reminder input state
  const [newReminderText, setNewReminderText] = useState("");
  const [newReminderDue, setNewReminderDue] = useState("Tomorrow at 10:00 AM");

  // Webhook Tester state
  const [webhookTarget, setWebhookTarget] = useState<
    "twilio" | "sendblue" | "loopmessage" | "slack_event" | "slack_slash" | "siri"
  >("sendblue");
  const [webhookSampleText, setWebhookSampleText] = useState(
    "What's on my calendar today and do I have any unread emails from Sarah?"
  );
  const [webhookResponseOutput, setWebhookResponseOutput] = useState<string>("");
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [dbEngineLabel, setDbEngineLabel] = useState<string>("node:sqlite (SQLite3 + HNSW Memory)");
  const [slackManifestJson, setSlackManifestJson] = useState<string>("");

  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    fetchInitialData();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeChannel]);

  // Progressive enhancement fallback for <dialog closedby="any"> per modern-web-guidance
  useEffect(() => {
    const dialog = settingsDialogRef.current;
    if (!dialog) return;
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const outside = (e: PointerEvent, d: HTMLDialogElement) => {
        const r = d.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      let pressedOutside = false;
      const onDown = (e: PointerEvent) => {
        pressedOutside = outside(e, dialog);
      };
      const onUp = (e: PointerEvent) => {
        if (pressedOutside && outside(e, dialog)) dialog.close();
      };
      dialog.addEventListener("pointerdown", onDown);
      dialog.addEventListener("pointerup", onUp);
      return () => {
        dialog.removeEventListener("pointerdown", onDown);
        dialog.removeEventListener("pointerup", onUp);
      };
    }
  }, []);

  async function fetchInitialData() {
    try {
      const res = await fetch("/api/chat");
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setReminders(data.reminders || []);
        setCalendarEvents(data.calendarEvents || []);
        setEmails(data.emails || []);
        setDocuments(data.documents || []);
        setMemories(data.memories || []);
        if (data.dbStatus?.engine) {
          setDbEngineLabel(data.dbStatus.engine);
        }
        if (data.providerStatus) {
          setProviderStatus(data.providerStatus);
          setActiveProvider(data.providerStatus.activeProvider || "auto");
          setGeminiModel(data.providerStatus.geminiModel || "gemini-3.8-flash");
          setGeminiImageModel(data.providerStatus.geminiImageModel || "gemini-3.1-flash-image");
          setOpenaiModel(data.providerStatus.openaiModel || "gpt-4o");
          setAnthropicModel(data.providerStatus.anthropicModel || "claude-3-7-sonnet-latest");
          setGoogleConnectedEmail(data.providerStatus.googleConnectedEmail || "");
        }
      }
    } catch (err) {
      console.error("Failed to fetch initial state:", err);
    }
  }

  async function handleSendMessage(customPrompt?: string) {
    const textToSend = (customPrompt !== undefined ? customPrompt : inputText).trim();
    if (!textToSend && pendingAttachments.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    const currentAttachments = [...pendingAttachments];
    if (customPrompt === undefined) {
      setInputText("");
      setPendingAttachments([]);
    }

    // Optimistic UI message
    const tempUserMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      channel: activeChannel,
      sender: "user",
      userHandle: activeChannel === "slack" ? "@you" : "+1 (555) 019-2834",
      text: textToSend || `Attached ${currentAttachments.map((a) => a.name).join(", ")}`,
      timestamp: new Date().toISOString(),
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "message",
          channel: activeChannel,
          text: textToSend,
          userHandle: activeChannel === "slack" ? "@you" : "+1 (555) 019-2834",
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setReminders(data.reminders || []);
        setCalendarEvents(data.calendarEvents || []);
        setEmails(data.emails || []);
        setDocuments(data.documents || []);
        setMemories(data.memories || []);
        if (data.dbStatus?.engine) {
          setDbEngineLabel(data.dbStatus.engine);
        }
      }
    } catch (err) {
      console.error("Send message failed:", err);
    } finally {
      setIsSending(false);
    }
  }

  // IME-safe Enter-to-submit handler following modern-web-guidance
  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      formRef.current?.requestSubmit();
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      const isPdf =
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isImage || isPdf) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.readAsDataURL(file);
        });
        added.push({
          id: `att-${Date.now()}-${file.name}`,
          name: file.name,
          mimeType: file.type || (isPdf ? "application/pdf" : "image/png"),
          type: isImage ? "image" : "document",
          dataUrl,
          size: file.size,
        });
      } else {
        const textContent = await file.text();
        added.push({
          id: `att-${Date.now()}-${file.name}`,
          name: file.name,
          mimeType: file.type || "text/plain",
          type: "document",
          textContent: textContent.slice(0, 25000),
          size: file.size,
        });
      }
    }

    setPendingAttachments((prev) => [...prev, ...added]);
    e.target.value = "";
  }

  function toggleVoiceDictation() {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setInputText((prev) =>
        prev ? `${prev} ` : "Remind me at 6 PM to call Alex about the flight to Tokyo"
      );
      return;
    }

    if (isRecording) {
      setIsRecording(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setIsRecording(true);
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript || "";
      if (transcript) {
        setInputText((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
      setIsRecording(false);
    };
    recognition.onerror = () => setIsRecording(false);
    recognition.onend = () => setIsRecording(false);
    recognition.start();
  }

  async function handleToggleReminder(id: string) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle_reminder", id }),
    });
    if (res.ok) {
      const data = await res.json();
      setReminders(data.reminders || []);
    }
  }

  async function handleAddReminder(e: React.FormEvent) {
    e.preventDefault();
    if (!newReminderText.trim()) return;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_reminder",
        text: newReminderText.trim(),
        dueAt: newReminderDue.trim() || "Later today",
        channel: activeChannel,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setReminders(data.reminders || []);
      setNewReminderText("");
    }
  }

  async function handleIngestUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!newDocUrl.trim() || isIngestingUrl) return;
    setIsIngestingUrl(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ingest_document",
          name: newDocUrl.replace(/^https?:\/\//, "").slice(0, 42),
          url: newDocUrl.trim(),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setNewDocUrl("");
      }
    } finally {
      setIsIngestingUrl(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeProvider,
        geminiApiKey,
        geminiModel,
        geminiImageModel,
        openaiApiKey,
        openaiModel,
        anthropicApiKey,
        anthropicModel,
        twilioAccountSid,
        twilioAuthToken,
        twilioFromNumber,
        sendblueApiKey,
        sendblueApiSecret,
        loopMessageAuthKey,
        loopMessageSecretKey,
        slackBotToken,
        slackSigningSecret,
        googleClientId,
        googleClientSecret,
        googleAccessToken,
        googleConnectedEmail,
      }),
    });
    await fetchInitialData();
    settingsDialogRef.current?.close();
  }

  async function handleSpeakMessage(msg: ChatMessage) {
    if (speakingMsgId === msg.id) {
      window.speechSynthesis?.cancel();
      setSpeakingMsgId(null);
      return;
    }
    setSpeakingMsgId(msg.id);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg.text }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audioDataUrl) {
          const audio = new Audio(data.audioDataUrl);
          audio.onended = () => setSpeakingMsgId(null);
          await audio.play();
          return;
        }
      }
    } catch {
      // Fallback to Web Speech API
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const clean = msg.text.replace(/[*#_`~]/g, "");
      const utter = new SpeechSynthesisUtterance(clean);
      utter.onend = () => setSpeakingMsgId(null);
      window.speechSynthesis.speak(utter);
    } else {
      setSpeakingMsgId(null);
    }
  }

  async function handleDispatchDueReminders() {
    const res = await fetch("/api/cron/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      setReminders(data.reminders || []);
      setMessages(data.messages || []);
    }
  }

  async function handleGenerateSlackManifest() {
    const res = await fetch(
      `/api/webhooks/manifest?baseUrl=${encodeURIComponent(window.location.origin)}`
    );
    if (res.ok) {
      const data = await res.json();
      setSlackManifestJson(JSON.stringify(data.slackManifest, null, 2));
    }
  }

  async function handleAddMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!newMemoryFact.trim()) return;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_memory",
        fact: newMemoryFact.trim(),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setMemories(data.memories || []);
      setNewMemoryFact("");
    }
  }

  async function handleDeleteMemory(id: string) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_memory", id }),
    });
    if (res.ok) {
      const data = await res.json();
      setMemories(data.memories || []);
    }
  }

  async function handleEmailAction(emailId: string, emailAction: "archive" | "mark_read") {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "organize_email", emailId, emailAction }),
    });
    if (res.ok) {
      const data = await res.json();
      setEmails(data.emails || []);
    }
  }

  async function handleToggleReaction(messageId: string, emoji: string) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle_reaction", messageId, emoji }),
    });
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages || []);
    }
  }

  async function handleRunWebhookSimulator() {
    setIsTestingWebhook(true);
    setWebhookResponseOutput("Sending live webhook payload...");
    try {
      let res: Response;
      if (webhookTarget === "twilio") {
        const form = new URLSearchParams({
          From: "+15550192834",
          To: twilioFromNumber || "+18885550199",
          Body: webhookSampleText,
          NumMedia: "0",
        });
        res = await fetch("/api/webhooks/imessage", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
      } else if (webhookTarget === "sendblue") {
        res = await fetch("/api/webhooks/imessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            number: "+1 (555) 019-2834",
            content: webhookSampleText,
            is_outbound: false,
          }),
        });
      } else if (webhookTarget === "loopmessage") {
        res = await fetch("/api/webhooks/imessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alert_type: "message_inbound",
            recipient: "+1 (555) 019-2834",
            text: webhookSampleText,
          }),
        });
      } else if (webhookTarget === "slack_event") {
        res = await fetch("/api/webhooks/slack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-olli-simulator": "true",
          },
          body: JSON.stringify({
            type: "event_callback",
            event: {
              type: "app_mention",
              user: "U0492OLLI",
              text: `<@U0OLLI> ${webhookSampleText}`,
              channel: "C01OLLIBOT",
              ts: `${Date.now() / 1000}`,
            },
          }),
        });
      } else if (webhookTarget === "siri") {
        res = await fetch("/api/siri", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: webhookSampleText,
            voiceReply: true,
            device: "Apple Watch Ultra / CarPlay",
          }),
        });
      } else {
        const form = new URLSearchParams({
          command: "/olli",
          text: webhookSampleText,
          user_name: "founder",
          channel_name: "olli-assistant",
        });
        res = await fetch("/api/webhooks/slack", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-olli-simulator": "true",
          },
          body: form.toString(),
        });
      }

      const rawText = await res.text();
      setWebhookResponseOutput(rawText);
      await fetchInitialData();
    } catch (err) {
      setWebhookResponseOutput(`Error: ${String(err)}`);
    } finally {
      setIsTestingWebhook(false);
    }
  }

  const channelMessages = messages.filter((m) => m.channel === activeChannel);

  return (
    <div className="min-h-screen bg-[#090b10] text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-white/10 bg-[#0d111a]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-blue-500/25 font-bold text-lg text-white">
              V
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base sm:text-lg tracking-tight text-white">
                  Velnor
                </h1>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  velnor-core-v1
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Executive Personal AI inside iMessage, SMS &amp; Slack • Multi-Provider &amp; LoRA Engine
              </p>
            </div>
          </div>

          {/* Center Channel & Mode Switcher */}
          <div className="flex items-center bg-[#141926] p-1 rounded-xl border border-white/10">
            <button
              type="button"
              onClick={() => {
                setViewMode("chat");
                setActiveChannel("imessage");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                viewMode === "chat" && activeChannel === "imessage"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>iMessage / SMS</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode("chat");
                setActiveChannel("slack");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                viewMode === "chat" && activeChannel === "slack"
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Hash className="w-3.5 h-3.5" />
              <span>Slack Bot</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("webhooks")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                viewMode === "webhooks"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Webhook className="w-3.5 h-3.5" />
              <span>Webhooks &amp; API</span>
            </button>
          </div>

          {/* Right Status & Settings Button */}
          <div className="flex items-center gap-2.5">
            <a
              href="/api/vcard"
              download="Olli_AI_Assistant.vcf"
              title="Add Olli to Apple Contacts (.vcf)"
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 text-xs font-medium text-blue-200 transition"
            >
              <UserPlus className="w-3.5 h-3.5 text-blue-400" />
              <span>Add Contact (.vcf)</span>
            </a>
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-300">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>
                Provider:{" "}
                <strong className="text-white uppercase">{activeProvider}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={() => settingsDialogRef.current?.showModal()}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-medium text-white transition cursor-pointer"
            >
              <Settings className="w-4 h-4 text-blue-400" />
              <span>Settings &amp; Keys</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left/Center Column (8 cols): Chat Simulator OR Webhook Tester */}
        <section className="lg:col-span-8 flex flex-col bg-[#111520] border border-white/10 rounded-2xl overflow-hidden shadow-2xl min-h-[720px]">
          {viewMode === "chat" ? (
            <>
              {/* Channel Header */}
              <div
                className={`px-5 py-3.5 border-b border-white/10 flex items-center justify-between ${
                  activeChannel === "imessage"
                    ? "bg-gradient-to-r from-blue-950/50 via-[#131926] to-[#131926]"
                    : "bg-gradient-to-r from-purple-950/50 via-[#181326] to-[#131926]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${
                      activeChannel === "imessage"
                        ? "bg-blue-600 text-white"
                        : "bg-purple-600 text-white"
                    }`}
                  >
                    {activeChannel === "imessage" ? "iM" : "#"}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-white">
                        {activeChannel === "imessage"
                          ? "Olli (+1 888-555-OLLI) • Apple iMessage / SMS"
                          : "#olli-assistant • Slack Workspace Bot"}
                      </h2>
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    </div>
                    <p className="text-xs text-slate-400">
                      {activeChannel === "imessage"
                        ? "Webhook: POST /api/webhooks/imessage (Twilio, Sendblue, LoopMessage)"
                        : "Webhook: POST /api/webhooks/slack (Events API & /olli slash command)"}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch("/api/chat", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "clear_chat", channel: activeChannel }),
                    });
                    if (res.ok) {
                      const d = await res.json();
                      setMessages(d.messages || []);
                    }
                  }}
                  title="Clear conversation"
                  className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-white/5 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Quick Feature Chips */}
              <div className="px-4 py-2.5 bg-[#0d111a] border-b border-white/5 flex items-center gap-2 overflow-x-auto no-scrollbar">
                {QUICK_PROMPTS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => handleSendMessage(item.prompt)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-blue-500/20 border border-white/10 hover:border-blue-500/40 text-xs text-slate-300 hover:text-white whitespace-nowrap transition cursor-pointer"
                    >
                      <Icon className="w-3.5 h-3.5 text-blue-400" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Messages Feed */}
              <div className="flex-1 p-5 overflow-y-auto space-y-4 max-h-[520px]">
                {channelMessages.map((msg) => {
                  const isUser = msg.sender === "user";
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        isUser ? "items-end" : "items-start"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1 px-1">
                        <span className="text-[11px] font-medium text-slate-400">
                          {isUser
                            ? msg.userHandle || "You"
                            : activeChannel === "slack"
                            ? "Olli APP"
                            : "Olli"}
                        </span>
                        {msg.modelUsed && !isUser && (
                          <>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-400 border border-white/10">
                              {msg.modelUsed}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleSpeakMessage(msg)}
                              title="Listen with Voice TTS (Gemini 3.8 TTS / Web Speech)"
                              className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition cursor-pointer ${
                                speakingMsgId === msg.id
                                  ? "bg-blue-500/20 text-blue-300 border-blue-400/40 animate-pulse"
                                  : "bg-white/5 text-slate-400 hover:text-white border-white/10"
                              }`}
                            >
                              <Volume2 className="w-3 h-3" />
                              <span>{speakingMsgId === msg.id ? "Speaking..." : "Speak"}</span>
                            </button>
                          </>
                        )}
                      </div>

                      <div
                        className={`max-w-[85%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-md ${
                          isUser
                            ? activeChannel === "imessage"
                              ? "bg-[#007AFF] text-white rounded-br-xs"
                              : "bg-purple-600 text-white rounded-br-xs"
                            : "bg-[#1a2030] text-slate-100 border border-white/10 rounded-bl-xs"
                        }`}
                      >
                        {/* User Attachments */}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mb-2.5 space-y-2">
                            {msg.attachments.map((att) =>
                              att.type === "image" && att.dataUrl ? (
                                <img
                                  key={att.id}
                                  src={att.dataUrl}
                                  alt={att.name}
                                  className="rounded-xl max-h-56 object-cover border border-white/20"
                                />
                              ) : (
                                <div
                                  key={att.id}
                                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/25 text-xs"
                                >
                                  <FileText className="w-4 h-4 text-blue-300 shrink-0" />
                                  <span className="truncate font-medium">{att.name}</span>
                                </div>
                              )
                            )}
                          </div>
                        )}

                        {/* Tool Execution Badges */}
                        {msg.toolActions && msg.toolActions.length > 0 && (
                          <div className="mb-2.5 flex flex-wrap gap-1.5">
                            {msg.toolActions.map((t, idx) => (
                              <div
                                key={`${t.tool}-${idx}`}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/15 border border-blue-400/30 text-[11px] text-blue-200"
                              >
                                <Sparkles className="w-3 h-3 text-blue-400 shrink-0" />
                                <span className="font-medium">{t.label}</span>
                                {t.details && (
                                  <span className="text-blue-300/75">• {t.details}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Message Body & Structured Cards */}
                        <RichMessageRenderer
                          text={msg.text}
                          structuredCard={msg.structuredCard}
                        />

                        {/* iMessage Tapback Reactions Bar */}
                        <div className="mt-2 pt-1.5 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1">
                            {["❤️", "👍", "‼️"].map((emoji) => {
                              const active = msg.reactions?.includes(emoji);
                              return (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => handleToggleReaction(msg.id, emoji)}
                                  title={`Tapback ${emoji}`}
                                  className={`text-[11px] px-1.5 py-0.5 rounded-full transition cursor-pointer ${
                                    active
                                      ? "bg-white/25 border border-white/40 scale-105"
                                      : "opacity-50 hover:opacity-100 hover:bg-white/10"
                                  }`}
                                >
                                  {emoji}
                                </button>
                              );
                            })}
                          </div>
                          <span className="text-[10px] opacity-60">
                            {new Date(msg.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>

                        {/* Generated Image Output */}
                        {msg.generatedImage && (
                          <div className="mt-3 rounded-xl overflow-hidden border border-white/15 bg-black/30">
                            <img
                              src={msg.generatedImage.dataUrl}
                              alt={msg.generatedImage.prompt}
                              className="w-full max-h-80 object-cover"
                            />
                            <div className="px-3 py-1.5 text-[11px] text-slate-400 flex items-center justify-between">
                              <span className="truncate">
                                Prompt: &ldquo;{msg.generatedImage.prompt}&rdquo;
                              </span>
                              <a
                                href={msg.generatedImage.dataUrl}
                                download={`olli-${Date.now()}.png`}
                                className="text-blue-400 hover:underline ml-2 shrink-0"
                              >
                                Download
                              </a>
                            </div>
                          </div>
                        )}

                        {/* Grounded Citations */}
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-white/10 flex flex-wrap gap-1.5">
                            {msg.citations.map((cit, i) => (
                              <a
                                key={`${cit.url}-${i}`}
                                href={cit.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-cyan-300 transition"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[210px]">{cit.title}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {isSending && (
                  <div className="flex items-center gap-2 text-xs text-slate-400 px-2">
                    <div className="flex space-x-1 bg-[#1a2030] px-3.5 py-2.5 rounded-2xl border border-white/10">
                      <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" />
                      <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
                      <span className="w-2 h-2 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
                    </div>
                    <span>Olli is thinking &amp; running tools...</span>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              {/* Pending Attachments Bar */}
              {pendingAttachments.length > 0 && (
                <div className="px-4 py-2 bg-[#161c2b] border-t border-white/10 flex flex-wrap gap-2">
                  {pendingAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-blue-500/15 border border-blue-400/30 text-xs text-blue-200"
                    >
                      {att.type === "image" ? (
                        <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-blue-400" />
                      )}
                      <span className="truncate max-w-[180px]">{att.name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingAttachments((prev) =>
                            prev.filter((p) => p.id !== att.id)
                          )
                        }
                        aria-label={`Remove ${att.name}`}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Message Composer Form */}
              <form
                ref={formRef}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="p-3.5 bg-[#0d111a] border-t border-white/10 flex items-end gap-2"
              >
                <input
                  ref={fileInputRef}
                  id="olli-file-upload"
                  type="file"
                  multiple
                  accept=".txt,.md,.json,.csv,.pdf,image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach PDF, text document, or image"
                  aria-label="Attach document or image"
                  className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 transition cursor-pointer"
                >
                  <Paperclip className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={toggleVoiceDictation}
                  title="Voice input / audio transcription"
                  aria-label="Voice input"
                  className={`p-2.5 rounded-xl border transition cursor-pointer ${
                    isRecording
                      ? "bg-rose-500/20 border-rose-500 text-rose-300 animate-pulse"
                      : "bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border-white/10"
                  }`}
                >
                  {isRecording ? (
                    <MicOff className="w-4 h-4" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>

                <div className="flex-1">
                  <label htmlFor="olli-chat-input" className="sr-only">
                    Message Olli
                  </label>
                  <textarea
                    id="olli-chat-input"
                    rows={1}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleTextareaKeyDown}
                    placeholder={
                      activeChannel === "imessage"
                        ? "iMessage Olli... (Ask anything, drop a PDF/link, check Gmail/Calendar, or plan a trip)"
                        : "Message #olli-assistant or type /olli..."
                    }
                    className="w-full rounded-xl bg-[#161c2b] border border-white/10 focus:border-blue-500 focus:outline-none px-3.5 py-2.5 text-sm text-white placeholder-slate-500 resize-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSending}
                  aria-label="Send message"
                  className={`px-4 py-2.5 rounded-xl font-medium text-sm flex items-center gap-1.5 transition cursor-pointer ${
                    activeChannel === "imessage"
                      ? "bg-[#007AFF] hover:bg-blue-500 text-white"
                      : "bg-purple-600 hover:bg-purple-500 text-white"
                  } disabled:opacity-50`}
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </form>
            </>
          ) : (
            /* Webhook & API Inspector View */
            <div className="p-6 flex-1 flex flex-col space-y-6 overflow-y-auto">
              <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Terminal className="w-5 h-5 text-emerald-400" />
                    <span>Live SMS / iMessage &amp; Slack Webhook Playground</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Point Twilio, Sendblue, LoopMessage, or Slack Events API directly at these Next.js endpoints—or simulate inbound payloads below.
                  </p>
                </div>
              </div>

              {/* Endpoint Reference Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-[#161c2b] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-400 uppercase">
                      Apple iMessage &amp; SMS Webhook
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                      POST
                    </span>
                  </div>
                  <code className="block text-xs bg-black/40 p-2.5 rounded-lg text-slate-200 font-mono">
                    /api/webhooks/imessage
                  </code>
                  <p className="text-xs text-slate-400">
                    Auto-detects <strong>Twilio SMS/MMS</strong> (`application/x-www-form-urlencoded` → returns TwiML XML), <strong>Sendblue</strong> (`number`, `content`, `media_url`), and <strong>LoopMessage</strong> (`recipient`, `text`).
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-[#161c2b] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-400 uppercase">
                      Slack Events &amp; Slash Command Webhook
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                      POST
                    </span>
                  </div>
                  <code className="block text-xs bg-black/40 p-2.5 rounded-lg text-slate-200 font-mono">
                    /api/webhooks/slack
                  </code>
                  <p className="text-xs text-slate-400">
                    Handles Slack `url_verification` challenge, `app_mention`, DM `message` events, `x-slack-signature` HMAC verification, and `/olli` slash commands with Block Kit responses.
                  </p>
                </div>
              </div>

              {/* Interactive Webhook Simulator */}
              <div className="p-5 rounded-2xl bg-[#161c2b] border border-white/10 space-y-4">
                <h3 className="text-sm font-semibold text-white">
                  Simulate Inbound Webhook Request
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="webhook-protocol-select"
                      className="block text-xs text-slate-400 mb-1.5"
                    >
                      Webhook Protocol Format
                    </label>
                    <select
                      id="webhook-protocol-select"
                      value={webhookTarget}
                      onChange={(e) => setWebhookTarget(e.target.value as any)}
                      className="w-full rounded-xl bg-[#0d111a] border border-white/15 px-3 py-2 text-xs text-white"
                    >
                      <option value="sendblue">
                        Sendblue iMessage JSON (POST /api/webhooks/imessage)
                      </option>
                      <option value="loopmessage">
                        LoopMessage iMessage JSON (POST /api/webhooks/imessage)
                      </option>
                      <option value="twilio">
                        Twilio SMS/MMS Form-Urlencoded → TwiML XML
                      </option>
                      <option value="slack_event">
                        Slack Events API (app_mention JSON)
                      </option>
                      <option value="slack_slash">
                        Slack Slash Command (/olli form-urlencoded)
                      </option>
                      <option value="siri">
                        Apple Siri / Apple Watch / CarPlay Shortcut (POST /api/siri)
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="webhook-message-input"
                      className="block text-xs text-slate-400 mb-1.5"
                    >
                      Inbound User Message Text
                    </label>
                    <input
                      id="webhook-message-input"
                      type="text"
                      value={webhookSampleText}
                      onChange={(e) => setWebhookSampleText(e.target.value)}
                      className="w-full rounded-xl bg-[#0d111a] border border-white/15 px-3 py-2 text-xs text-white"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleRunWebhookSimulator}
                  disabled={isTestingWebhook}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition cursor-pointer"
                >
                  {isTestingWebhook
                    ? "Firing Webhook..."
                    : "Fire Live Webhook Request"}
                </button>

                {webhookResponseOutput && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-slate-400">
                      Raw Webhook HTTP Response:
                    </span>
                    <pre className="p-3.5 rounded-xl bg-black/60 border border-white/10 text-xs text-emerald-300 font-mono overflow-x-auto max-h-64">
                      {webhookResponseOutput}
                    </pre>
                  </div>
                )}
              </div>

              {/* Live Tunnel & Slack App Manifest Generator */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-[#161c2b] border border-white/10 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300">
                      1-Click Slack App Manifest
                    </span>
                    <button
                      type="button"
                      onClick={handleGenerateSlackManifest}
                      className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-[11px] font-medium text-white cursor-pointer"
                    >
                      Generate Manifest JSON
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Paste into <code>api.slack.com/apps → Create New App → From a manifest</code> to configure <code>/olli</code>, <code>app_mention</code>, and DM webhooks automatically.
                  </p>
                  {slackManifestJson && (
                    <pre className="p-2.5 rounded-lg bg-black/50 border border-white/10 text-[11px] text-purple-200 font-mono overflow-x-auto max-h-44">
                      {slackManifestJson}
                    </pre>
                  )}
                </div>

                <div className="p-4 rounded-xl bg-[#161c2b] border border-white/10 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-amber-300">
                      Siri, Apple Watch &amp; Local Tunnel
                    </span>
                    <a
                      href="/api/siri"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-blue-400 hover:underline"
                    >
                      Open Siri Spec →
                    </a>
                  </div>
                  <p className="text-xs text-slate-400">
                    Expose your local Olli server to Twilio, Sendblue, LoopMessage, or Slack in 1 command:
                  </p>
                  <code className="block text-[11px] bg-black/50 p-2 rounded-lg text-amber-200 font-mono">
                    npx cloudflared tunnel --url http://localhost:3000
                  </code>
                  <p className="text-[11px] text-slate-400">
                    Persistence Engine: <strong className="text-emerald-300">{dbEngineLabel}</strong>
                  </p>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right Column (4 cols): Productivity, Workspace & Vector Memory Hub */}
        <aside className="lg:col-span-4 flex flex-col bg-[#111520] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
          {/* Tab Switcher */}
          <div className="grid grid-cols-4 border-b border-white/10 bg-[#0d111a]">
            <button
              type="button"
              onClick={() => setRightTab("workspace")}
              className={`py-3 text-[11px] font-semibold flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
                rightTab === "workspace"
                  ? "border-blue-500 text-white bg-white/5"
                  : "border-transparent text-slate-400 hover:text-white"
              }`}
            >
              <Mail className="w-3.5 h-3.5 text-blue-400" />
              <span>Workspace</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab("reminders")}
              className={`py-3 text-[11px] font-semibold flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
                rightTab === "reminders"
                  ? "border-blue-500 text-white bg-white/5"
                  : "border-transparent text-slate-400 hover:text-white"
              }`}
            >
              <Bell className="w-3.5 h-3.5 text-amber-400" />
              <span>Tasks ({reminders.filter((r) => !r.completed).length})</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab("docs")}
              className={`py-3 text-[11px] font-semibold flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
                rightTab === "docs"
                  ? "border-blue-500 text-white bg-white/5"
                  : "border-transparent text-slate-400 hover:text-white"
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>Docs ({documents.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setRightTab("memory")}
              className={`py-3 text-[11px] font-semibold flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
                rightTab === "memory"
                  ? "border-blue-500 text-white bg-white/5"
                  : "border-transparent text-slate-400 hover:text-white"
              }`}
            >
              <Brain className="w-3.5 h-3.5 text-pink-400" />
              <span>Memory ({memories.length})</span>
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 p-4 overflow-y-auto space-y-5 max-h-[650px]">
            {rightTab === "workspace" && (
              <>
                {/* Google Workspace Connection Banner */}
                <div className="p-3.5 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/25 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <span>Google Workspace</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                        {providerStatus.googleConnectedEmail
                          ? providerStatus.googleConnectedEmail
                          : "Sandbox Sync Active"}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Read, draft &amp; send Gmail + manage Google Calendar via text
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => settingsDialogRef.current?.showModal()}
                    className="px-2.5 py-1.5 rounded-lg bg-blue-600/25 hover:bg-blue-600/40 border border-blue-400/30 text-[11px] font-medium text-blue-200 shrink-0 cursor-pointer"
                  >
                    OAuth Setup
                  </button>
                </div>

                {/* Gmail Inbox Section */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-rose-400" />
                      <span>Gmail Inbox ({emails.length})</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        handleSendMessage("Summarize my Gmail inbox and highlight urgent action items")
                      }
                      className="text-[11px] text-blue-400 hover:underline cursor-pointer"
                    >
                      Ask Olli to Triage →
                    </button>
                  </div>

                  <div className="space-y-2">
                    {emails.slice(0, 4).map((em) => (
                      <div
                        key={em.id}
                        className="p-3 rounded-xl bg-[#161c2b] border border-white/10 hover:border-white/20 transition space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white truncate">
                            {em.unread && (
                              <span className="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1.5" />
                            )}
                            {em.subject}
                          </span>
                          <span className="text-[10px] text-slate-400 shrink-0">
                            {em.date}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate">
                          From: {em.from}
                        </p>
                        <p className="text-xs text-slate-300 line-clamp-2">
                          {em.snippet}
                        </p>
                        <div className="pt-1 flex items-center gap-2">
                          {em.labels.map((lbl) => (
                            <span
                              key={lbl}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-300"
                            >
                              {lbl}
                            </span>
                          ))}
                          <div className="ml-auto flex items-center gap-2">
                            {em.unread && (
                              <button
                                type="button"
                                onClick={() => handleEmailAction(em.id, "mark_read")}
                                className="text-[11px] text-emerald-400 hover:underline cursor-pointer"
                              >
                                Mark Read
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleEmailAction(em.id, "archive")}
                              title="Archive email"
                              className="text-[11px] text-slate-400 hover:text-rose-300 flex items-center gap-0.5 cursor-pointer"
                            >
                              <Archive className="w-3 h-3" />
                              <span>Archive</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleSendMessage(
                                  `Draft a reply to "${em.subject}" confirming I reviewed it`
                                )
                              }
                              className="text-[11px] text-blue-400 hover:underline cursor-pointer"
                            >
                              Reply
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Google Calendar Section */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Google Calendar ({calendarEvents.length})</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        handleSendMessage(
                          "Schedule a 30-minute Product Review meeting at 15:30 today"
                        )
                      }
                      className="text-[11px] text-blue-400 hover:underline cursor-pointer"
                    >
                      + Quick Schedule
                    </button>
                  </div>

                  <div className="space-y-2">
                    {calendarEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="p-3 rounded-xl bg-[#161c2b] border border-white/10 flex items-start justify-between gap-3"
                      >
                        <div>
                          <div className="text-xs font-semibold text-white">
                            {ev.title}
                          </div>
                          <div className="text-[11px] text-cyan-300 mt-0.5">
                            {ev.date} • {ev.startTime} – {ev.endTime}
                          </div>
                          {ev.location && (
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              📍 {ev.location}
                            </div>
                          )}
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 shrink-0">
                          {ev.source === "google_calendar" ? "GCal" : "Local"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {rightTab === "reminders" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/10 border border-amber-500/25">
                  <div className="text-xs text-amber-200">
                    <strong>Proactive Scheduler</strong> (`/api/cron/reminders`)
                  </div>
                  <button
                    type="button"
                    onClick={handleDispatchDueReminders}
                    className="px-2.5 py-1 rounded-lg bg-amber-500/25 hover:bg-amber-500/40 border border-amber-400/30 text-[11px] font-medium text-amber-100 cursor-pointer"
                  >
                    Trigger Due Now
                  </button>
                </div>

                <form onSubmit={handleAddReminder} className="space-y-2.5 p-3.5 rounded-xl bg-[#161c2b] border border-white/10">
                  <label
                    htmlFor="new-reminder-text"
                    className="block text-xs font-semibold text-white"
                  >
                    New Text Reminder / Task
                  </label>
                  <input
                    id="new-reminder-text"
                    type="text"
                    placeholder="e.g. Call Sarah about the Q4 launch"
                    value={newReminderText}
                    onChange={(e) => setNewReminderText(e.target.value)}
                    className="w-full rounded-lg bg-[#0d111a] border border-white/10 px-3 py-2 text-xs text-white"
                  />
                  <div className="flex items-center gap-2">
                    <label htmlFor="new-reminder-due" className="sr-only">
                      When
                    </label>
                    <input
                      id="new-reminder-due"
                      type="text"
                      placeholder="When (e.g. Today at 5:00 PM)"
                      value={newReminderDue}
                      onChange={(e) => setNewReminderDue(e.target.value)}
                      className="flex-1 rounded-lg bg-[#0d111a] border border-white/10 px-3 py-1.5 text-xs text-slate-300"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add</span>
                    </button>
                  </div>
                </form>

                <div className="space-y-2">
                  {reminders.map((rem) => (
                    <div
                      key={rem.id}
                      onClick={() => handleToggleReminder(rem.id)}
                      className={`p-3 rounded-xl border transition flex items-start gap-2.5 cursor-pointer ${
                        rem.completed
                          ? "bg-[#161c2b]/40 border-white/5 opacity-60"
                          : "bg-[#161c2b] border-white/10 hover:border-blue-500/40"
                      }`}
                    >
                      {rem.completed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <Circle className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-xs font-medium ${
                            rem.completed ? "line-through text-slate-400" : "text-white"
                          }`}
                        >
                          {rem.text}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-amber-300/90">
                          <span>⏰ {rem.dueAt}</span>
                          <span className="text-slate-500">•</span>
                          <span className="uppercase text-[10px] text-slate-400">
                            {rem.channel}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {rightTab === "docs" && (
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
                  <div className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    <span>In-Memory HNSW Vector Knowledge Base</span>
                  </div>
                  <p className="text-[11px] text-slate-300 mt-1">
                    Upload PDFs, text files, or paste any URL. Olli chunks and embeds your documents (`gemini-embedding-001` + cosine similarity) for instant Q&amp;A.
                  </p>
                </div>

                {/* Quick URL Indexer */}
                <form
                  onSubmit={handleIngestUrl}
                  className="p-3.5 rounded-xl bg-[#161c2b] border border-white/10 space-y-2"
                >
                  <label
                    htmlFor="ingest-url-input"
                    className="block text-xs font-semibold text-white"
                  >
                    Index Article or Webpage URL
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="ingest-url-input"
                      type="url"
                      placeholder="https://en.wikipedia.org/wiki/Artificial_intelligence"
                      value={newDocUrl}
                      onChange={(e) => setNewDocUrl(e.target.value)}
                      className="flex-1 rounded-lg bg-[#0d111a] border border-white/10 px-3 py-1.5 text-xs text-white"
                    />
                    <button
                      type="submit"
                      disabled={isIngestingUrl}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      <span>{isIngestingUrl ? "..." : "Index"}</span>
                    </button>
                  </div>
                </form>

                {/* Indexed Documents List */}
                <div className="space-y-2.5">
                  {documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="p-3 rounded-xl bg-[#161c2b] border border-white/10 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white flex items-center gap-1.5 truncate">
                          <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span className="truncate">{doc.name}</span>
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-slate-300 shrink-0">
                          {doc.chunkCount} chunks
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-300 line-clamp-3">
                        {doc.summary}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `What are the key takeaways from "${doc.name}"?`
                          )
                        }
                        className="text-[11px] text-emerald-400 hover:underline cursor-pointer"
                      >
                        Ask Olli about this document →
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {rightTab === "memory" && (
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl bg-pink-500/10 border border-pink-500/25">
                  <div className="text-xs font-semibold text-pink-300 flex items-center gap-1.5">
                    <Brain className="w-3.5 h-3.5" />
                    <span>Personal Memory &amp; Context Graph</span>
                  </div>
                  <p className="text-[11px] text-slate-300 mt-1">
                    Olli remembers your preferences, contacts, and travel habits across iMessage, SMS, and Slack—injecting them into every prompt automatically.
                  </p>
                </div>

                <form
                  onSubmit={handleAddMemory}
                  className="p-3.5 rounded-xl bg-[#161c2b] border border-white/10 space-y-2"
                >
                  <label
                    htmlFor="new-memory-input"
                    className="block text-xs font-semibold text-white"
                  >
                    Teach Olli a New Preference or Fact
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="new-memory-input"
                      type="text"
                      placeholder="e.g. Prefer aisle seats and oat milk cortados"
                      value={newMemoryFact}
                      onChange={(e) => setNewMemoryFact(e.target.value)}
                      className="flex-1 rounded-lg bg-[#0d111a] border border-white/10 px-3 py-1.5 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 text-xs font-medium text-white flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </button>
                  </div>
                </form>

                <div className="space-y-2">
                  {memories.map((m) => (
                    <div
                      key={m.id}
                      className="p-3 rounded-xl bg-[#161c2b] border border-white/10 flex items-start justify-between gap-2"
                    >
                      <div className="space-y-1">
                        <span className="inline-block text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-pink-500/15 text-pink-300">
                          {m.category}
                        </span>
                        <p className="text-xs text-slate-200">{m.fact}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteMemory(m.id)}
                        title="Forget this fact"
                        className="p-1 text-slate-500 hover:text-rose-400 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

      {/* Native Modal Dialog for Multi-Provider AI, Messaging Webhooks & Google OAuth */}
      <dialog
        ref={settingsDialogRef}
        id="olli-settings-dialog"
        aria-labelledby="settings-dialog-title"
        closedby="any"
        className="m-auto w-full max-w-2xl rounded-2xl bg-[#121723] text-slate-100 border border-white/15 shadow-2xl p-0 open:flex open:flex-col max-h-[88vh]"
      >
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 id="settings-dialog-title" className="text-base font-bold text-white">
              Olli Configuration — Multi-Provider AI, Messaging &amp; Workspace
            </h2>
            <p className="text-xs text-slate-400">
              Configure Gemini 3.8, OpenAI, or Anthropic models, plus iMessage/SMS, Slack &amp; Google OAuth credentials.
            </p>
          </div>
          <button
            type="button"
            onClick={() => settingsDialogRef.current?.close()}
            aria-label="Close settings dialog"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={handleSaveSettings}
          className="p-6 overflow-y-auto space-y-6 text-xs"
        >
          {/* Section 1: Multi-Provider AI Router */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-blue-400">
              1. Multi-Provider AI Engine
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-provider" className="block text-slate-300 mb-1">
                  Active AI Provider
                </label>
                <select
                  id="cfg-provider"
                  value={activeProvider}
                  onChange={(e) => setActiveProvider(e.target.value as AIProviderId)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                >
                  <option value="auto">Auto (Gemini → OpenAI → Anthropic → Built-in)</option>
                  <option value="gemini">Google Gemini (@google/genai Interactions API)</option>
                  <option value="openai">OpenAI (GPT-4o + DALL-E 3)</option>
                  <option value="anthropic">Anthropic (Claude 3.7 Sonnet)</option>
                </select>
              </div>
              <div>
                <label htmlFor="cfg-gemini-model" className="block text-slate-300 mb-1">
                  Gemini Chat &amp; Agent Model
                </label>
                <input
                  id="cfg-gemini-model"
                  type="text"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="cfg-gemini-key" className="block text-slate-300 mb-1">
                  Gemini API Key {providerStatus.geminiConfigured && "✅"}
                </label>
                <input
                  id="cfg-gemini-key"
                  type="password"
                  placeholder="AIzaSy..."
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-openai-key" className="block text-slate-300 mb-1">
                  OpenAI API Key {providerStatus.openaiConfigured && "✅"}
                </label>
                <input
                  id="cfg-openai-key"
                  type="password"
                  placeholder="sk-..."
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-anthropic-key" className="block text-slate-300 mb-1">
                  Anthropic API Key {providerStatus.anthropicConfigured && "✅"}
                </label>
                <input
                  id="cfg-anthropic-key"
                  type="password"
                  placeholder="sk-ant-..."
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
            </div>
          </div>

          {/* Section 2: SMS & Apple iMessage Providers */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">
              2. Apple iMessage &amp; SMS Webhook Credentials (Twilio / Sendblue / LoopMessage)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-sendblue-key" className="block text-slate-300 mb-1">
                  Sendblue API Key ID
                </label>
                <input
                  id="cfg-sendblue-key"
                  type="password"
                  placeholder="sb-api-key-id"
                  value={sendblueApiKey}
                  onChange={(e) => setSendblueApiKey(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-sendblue-secret" className="block text-slate-300 mb-1">
                  Sendblue API Secret Key
                </label>
                <input
                  id="cfg-sendblue-secret"
                  type="password"
                  placeholder="sb-api-secret-key"
                  value={sendblueApiSecret}
                  onChange={(e) => setSendblueApiSecret(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-loop-auth" className="block text-slate-300 mb-1">
                  LoopMessage Authorization Key
                </label>
                <input
                  id="cfg-loop-auth"
                  type="password"
                  placeholder="LoopMessage Auth Key"
                  value={loopMessageAuthKey}
                  onChange={(e) => setLoopMessageAuthKey(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-twilio-sid" className="block text-slate-300 mb-1">
                  Twilio Account SID (SMS/MMS)
                </label>
                <input
                  id="cfg-twilio-sid"
                  type="text"
                  placeholder="AC..."
                  value={twilioAccountSid}
                  onChange={(e) => setTwilioAccountSid(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Slack Bot */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <h3 className="text-xs font-bold uppercase tracking-wider text-purple-400">
              3. Slack Bot Configuration
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-slack-token" className="block text-slate-300 mb-1">
                  Slack Bot User OAuth Token (xoxb-...)
                </label>
                <input
                  id="cfg-slack-token"
                  type="password"
                  placeholder="xoxb-..."
                  value={slackBotToken}
                  onChange={(e) => setSlackBotToken(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-slack-secret" className="block text-slate-300 mb-1">
                  Slack Signing Secret
                </label>
                <input
                  id="cfg-slack-secret"
                  type="password"
                  placeholder="Signing secret for x-slack-signature"
                  value={slackSigningSecret}
                  onChange={(e) => setSlackSigningSecret(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
            </div>
          </div>

          {/* Section 4: Google Workspace OAuth */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                4. Gmail &amp; Google Calendar OAuth2
              </h3>
              <a
                href="/api/auth/google"
                className="text-xs text-blue-400 hover:underline font-medium"
              >
                Launch Google OAuth Consent Flow →
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-google-id" className="block text-slate-300 mb-1">
                  Google OAuth Client ID
                </label>
                <input
                  id="cfg-google-id"
                  type="text"
                  placeholder="...apps.googleusercontent.com"
                  value={googleClientId}
                  onChange={(e) => setGoogleClientId(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
              <div>
                <label htmlFor="cfg-google-secret" className="block text-slate-300 mb-1">
                  Google OAuth Client Secret
                </label>
                <input
                  id="cfg-google-secret"
                  type="password"
                  placeholder="GOCSPX-..."
                  value={googleClientSecret}
                  onChange={(e) => setGoogleClientSecret(e.target.value)}
                  className="w-full rounded-xl bg-[#0b0e17] border border-white/15 px-3 py-2 text-white"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-white/10 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => settingsDialogRef.current?.close()}
              className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 font-semibold text-white cursor-pointer"
            >
              Save Configuration
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

