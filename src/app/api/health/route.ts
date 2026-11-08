import { NextResponse } from "next/server";
import { getDatabaseEngineStatus } from "@/lib/sqliteDb";
import { getEffectiveKeys, getStore } from "@/lib/store";

const startedAt = Date.now();

export async function GET() {
  const state = getStore();
  const keys = getEffectiveKeys(state);
  const dbStatus = getDatabaseEngineStatus();
  const mem = process.memoryUsage();

  return NextResponse.json(
    {
      status: "healthy",
      service: "olli-assistant",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      database: {
        engine: dbStatus.engine,
        writableDir: dbStatus.writableDir,
        documentsIndexed: state.documents.length,
        vectorChunksCount: state.documentChunks.length,
        memoriesCount: (state.memories || []).length,
      },
      providers: {
        activeProvider: state.config.activeProvider,
        geminiReady: Boolean(keys.geminiApiKey),
        openaiReady: Boolean(keys.openaiApiKey),
        anthropicReady: Boolean(keys.anthropicApiKey),
        builtInFallbackReady: true,
      },
      channels: {
        imessageWebhook: "/api/webhooks/imessage",
        slackWebhook: "/api/webhooks/slack",
        siriShortcut: "/api/siri",
        cronReminders: "/api/cron/reminders",
      },
      memoryUsageMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      },
    },
    { status: 200 }
  );
}
