import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { withVelnorUser } from "@/lib/store";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { generateSpeechWithProvider } from "@/lib/tools/multimodal";

/**
 * Apple Siri / Apple Watch / iPhone Action Button / CarPlay Endpoint
 * Allows users to invoke Velnor hands-free via Apple Shortcuts ("Hey Siri, Ask Velnor")
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    name: "Ask Velnor (Siri, Apple Watch & CarPlay Shortcut)",
    endpoint: `${origin}/api/siri`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    samplePayload: {
      query: "What's on my schedule today and do I have any unread emails?",
      voiceReply: true,
      device: "Apple Watch Ultra / CarPlay",
    },
    appleShortcutSteps: [
      "1. Open the Apple Shortcuts app on iPhone, Mac, or Apple Watch and tap '+' to create 'Ask Velnor'.",
      "2. Add Action: 'Ask for Input' (Prompt: 'What can Velnor help with?', Input Type: Text/Dictation).",
      `3. Add Action: 'Get Contents of URL' -> URL: ${origin}/api/siri, Method: POST, Request Body: JSON { "query": [Provided Input], "voiceReply": true }.`,
      "4. Add Action: 'Get Dictionary Value' -> Key: 'spokenText' from Contents of URL.",
      "5. Add Action: 'Speak Text' (or 'Show Result') -> [Dictionary Value].",
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const tenant = authorizeChatTenant(req.headers.get("authorization"));
    if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
    const body = await req.json();
    const query = String(body.query || body.text || body.prompt || "").trim();
    if (!query) {
      return NextResponse.json(
        { error: "Provide a 'query' field in the JSON body." },
        { status: 400 }
      );
    }

    const handle = body.device ? "Siri (" + body.device + ")" : "Siri Shortcut";
    const result = await withVelnorUser(tenant.userId, async () => {
      const reply = await processUserMessage({
        channel: "imessage",
        userHandle: handle,
        text: query,
      });

      // Clean markdown for natural Siri / CarPlay spoken output.
      const spokenText = reply.text
        .replace(/[*#_`~]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\n+/g, ". ")
        .trim();

      let audioDataUrl: string | undefined;
      let ttsModel: string | undefined;
      if (body.voiceReply) {
        const tts = await generateSpeechWithProvider(spokenText);
        audioDataUrl = tts.audioDataUrl;
        ttsModel = tts.modelUsed;
      }
      return { reply, spokenText, audioDataUrl, ttsModel };
    });
    const { reply, spokenText, audioDataUrl, ttsModel } = result;

    return NextResponse.json({
      ok: true,
      spokenText,
      displayText: reply.text,
      audioDataUrl,
      ttsModel,
      citations: reply.citations,
      toolActions: reply.toolActions,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Siri request failed" },
      { status: 500 }
    );
  }
}
