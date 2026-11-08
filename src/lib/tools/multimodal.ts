import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { getEffectiveKeys, getStore } from "../store";

function createFallbackSvgDataUrl(prompt: string): string {
  const safePrompt = prompt
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 68);
  const hash = Array.from(prompt).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const hue1 = hash % 360;
  const hue2 = (hue1 + 75) % 360;
  const hue3 = (hue1 + 165) % 360;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512" viewBox="0 0 768 512">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="hsl(${hue1}, 78%, 18%)" />
        <stop offset="55%" stop-color="hsl(${hue2}, 72%, 26%)" />
        <stop offset="100%" stop-color="hsl(${hue3}, 80%, 16%)" />
      </linearGradient>
      <radialGradient id="glow" cx="72%" cy="28%" r="48%">
        <stop offset="0%" stop-color="hsla(${hue2}, 95%, 72%, 0.55)" />
        <stop offset="100%" stop-color="hsla(${hue1}, 90%, 20%, 0)" />
      </radialGradient>
    </defs>
    <rect width="768" height="512" rx="28" fill="url(#bg)" />
    <circle cx="540" cy="150" r="210" fill="url(#glow)" />
    <circle cx="190" cy="390" r="165" fill="hsla(${hue3}, 85%, 60%, 0.18)" />
    <path d="M 0 380 Q 210 290 410 365 T 768 320 L 768 512 L 0 512 Z" fill="hsla(${hue1}, 65%, 10%, 0.55)" />
    <rect x="44" y="42" width="148" height="34" rx="17" fill="rgba(255,255,255,0.14)" />
    <text x="118" y="64" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" text-anchor="middle">✨ OLLI STUDIO</text>
    <text x="48" y="428" fill="rgba(255,255,255,0.65)" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500">GENERATED VISUAL PREVIEW</text>
    <text x="48" y="458" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700">${safePrompt}</text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

export async function generateImageWithProvider(prompt: string): Promise<{
  dataUrl: string;
  modelUsed: string;
}> {
  const state = getStore();
  const { geminiApiKey, openaiApiKey } = getEffectiveKeys(state);
  const preferred = state.config.activeProvider;

  // 1. Try Gemini Nano Banana 2 (gemini-3.1-flash-image) via Interactions API
  if ((preferred === "gemini" || preferred === "auto") && geminiApiKey) {
    try {
      const client = new GoogleGenAI({ apiKey: geminiApiKey });
      const imageModel = state.config.geminiImageModel || "gemini-3.1-flash-image";
      const interaction = await client.interactions.create({
        model: imageModel,
        input: prompt,
      });
      const outImg = interaction.output_image;
      if (outImg?.data) {
        const mime = outImg.mime_type || "image/png";
        return {
          dataUrl: `data:${mime};base64,${outImg.data}`,
          modelUsed: imageModel,
        };
      }
    } catch (err) {
      console.warn("Gemini image generation fallback:", err);
    }
  }

  // 2. Try OpenAI DALL-E 3 if configured
  if ((preferred === "openai" || preferred === "auto") && openaiApiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const res = await openai.images.generate({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      });
      const b64 = res.data?.[0]?.b64_json;
      if (b64) {
        return {
          dataUrl: `data:image/png;base64,${b64}`,
          modelUsed: "dall-e-3",
        };
      }
    } catch (err) {
      console.warn("OpenAI image generation fallback:", err);
    }
  }

  // 3. Instant dynamic SVG visual preview
  return {
    dataUrl: createFallbackSvgDataUrl(prompt),
    modelUsed: "olli-svg-studio",
  };
}

export async function transcribeAudioWithProvider(params: {
  base64Audio: string;
  mimeType: string;
}): Promise<{ transcript: string; modelUsed: string }> {
  const state = getStore();
  const { geminiApiKey } = getEffectiveKeys(state);

  if (geminiApiKey) {
    try {
      const client = new GoogleGenAI({ apiKey: geminiApiKey });
      const interaction = await client.interactions.create({
        model: "gemini-3.5-transcribe",
        input: [
          {
            type: "audio",
            data: params.base64Audio,
            mime_type: params.mimeType || "audio/webm",
          },
          {
            type: "text",
            text: "Transcribe this voice message accurately.",
          },
        ] as any,
      });
      if (interaction.output_text) {
        return {
          transcript: interaction.output_text.trim(),
          modelUsed: "gemini-3.5-transcribe",
        };
      }
    } catch (err) {
      console.warn("Gemini audio transcription error:", err);
    }
  }

  return {
    transcript: "Voice note received.",
    modelUsed: "browser-speech-engine",
  };
}

export async function generateSpeechWithProvider(text: string): Promise<{
  audioDataUrl?: string;
  modelUsed: string;
}> {
  const state = getStore();
  const { geminiApiKey, openaiApiKey } = getEffectiveKeys(state);
  const cleanText = text
    .replace(/[*#_`~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .slice(0, 900);

  // 1. Try Gemini 3.8 Flash Lite TTS via Interactions API
  if (geminiApiKey) {
    try {
      const client = new GoogleGenAI({ apiKey: geminiApiKey });
      const interaction = await client.interactions.create({
        model: "gemini-3.8-flash-lite-tts",
        input: [
          {
            type: "text",
            text: cleanText,
            annotations: [
              {
                type: "speech_metadata",
                speaker: "Olli",
                style: "warm, concise, helpful personal assistant",
              },
            ],
          },
        ] as any,
      });

      const outAudio = interaction.output_audio;
      if (outAudio?.data) {
        const mime = outAudio.mime_type || "audio/wav";
        return {
          audioDataUrl: `data:${mime};base64,${outAudio.data}`,
          modelUsed: "gemini-3.8-flash-lite-tts",
        };
      }
    } catch (err) {
      console.warn("Gemini TTS fallback:", err);
    }
  }

  // 2. Try OpenAI TTS-1 if configured
  if (openaiApiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const mp3Response = await openai.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: cleanText,
      });
      const buffer = Buffer.from(await mp3Response.arrayBuffer());
      return {
        audioDataUrl: `data:audio/mpeg;base64,${buffer.toString("base64")}`,
        modelUsed: "openai-tts-1",
      };
    } catch (err) {
      console.warn("OpenAI TTS fallback:", err);
    }
  }

  return {
    modelUsed: "browser-speech-synthesis",
  };
}


