"use client";

import React from "react";
import { StructuredCardData } from "@/lib/types";
import { Calendar, CloudSun, Download, ExternalLink, Mail, MapPin, Plane } from "lucide-react";

function renderInlineFormatting(line: string): React.ReactNode[] {
  // Tokenize links [label](url), bold **text**, inline code `code`, and italic _text_
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  const parts = line.split(pattern);

  return parts.map((part, idx) => {
    if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
      const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m) {
        return (
          <a
            key={idx}
            href={m[2]}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 inline-flex items-center gap-0.5 font-medium"
          >
            <span>{m[1]}</span>
            <ExternalLink className="w-3 h-3 inline shrink-0" />
          </a>
        );
      }
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 rounded bg-black/35 border border-white/10 font-mono text-xs text-amber-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return (
        <em key={idx} className="italic text-slate-300">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function downloadIcsFile(event: {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  location?: string;
  description?: string;
}) {
  const cleanDate = (event.date || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  const cleanStart = (event.startTime || "10:00").replace(":", "") + "00";
  const cleanEnd = (event.endTime || "11:00").replace(":", "") + "00";

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Olli Personal AI//EN",
    "BEGIN:VEVENT",
    `SUMMARY:${event.title}`,
    `DTSTART:${cleanDate}T${cleanStart}`,
    `DTEND:${cleanDate}T${cleanEnd}`,
    `LOCATION:${event.location || "Google Meet"}`,
    `DESCRIPTION:${event.description || "Scheduled via Olli AI Assistant"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${event.title.replace(/\s+/g, "_")}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export function RichMessageRenderer({
  text,
  structuredCard,
}: {
  text: string;
  structuredCard?: StructuredCardData;
}) {
  const lines = text.split("\n");

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {lines.map((line, i) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return <div key={i} className="h-1.5" />;
          }
          if (trimmed.startsWith("• ") || trimmed.startsWith("- ")) {
            return (
              <div key={i} className="flex items-start gap-2 pl-1">
                <span className="text-blue-400 font-bold select-none">•</span>
                <span className="flex-1">{renderInlineFormatting(trimmed.slice(2))}</span>
              </div>
            );
          }
          return <p key={i}>{renderInlineFormatting(line)}</p>;
        })}
      </div>

      {/* Interactive Structured Card */}
      {structuredCard && structuredCard.type === "travel" && structuredCard.metadata?.plan && (
        <div className="mt-3 p-3.5 rounded-xl bg-gradient-to-br from-blue-950/60 via-[#121828] to-[#0f1422] border border-blue-400/25 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Plane className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-bold text-white">{structuredCard.title}</span>
            </div>
            {structuredCard.metadata.plan.weather && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-400/30 text-[11px] text-cyan-200">
                <CloudSun className="w-3 h-3" />
                <span>
                  {structuredCard.metadata.plan.weather.temperatureC}°C (
                  {structuredCard.metadata.plan.weather.temperatureF}°F)
                </span>
              </span>
            )}
          </div>
          {structuredCard.metadata.plan.localSpots?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
              {structuredCard.metadata.plan.localSpots.slice(0, 2).map((spot: any, idx: number) => (
                <a
                  key={idx}
                  href={spot.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-2 text-xs text-slate-200 transition"
                >
                  <MapPin className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span className="truncate">{spot.name}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {structuredCard && structuredCard.type === "calendar" && structuredCard.metadata?.event && (
        <div className="mt-3 p-3 rounded-xl bg-cyan-950/40 border border-cyan-400/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Calendar className="w-4 h-4 text-cyan-400 shrink-0" />
            <div>
              <div className="text-xs font-bold text-white">{structuredCard.title}</div>
              <div className="text-[11px] text-cyan-200">{structuredCard.subtitle}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => downloadIcsFile(structuredCard.metadata!.event)}
            className="px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/35 border border-cyan-400/30 text-[11px] font-medium text-cyan-100 flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <Download className="w-3 h-3" />
            <span>.ics</span>
          </button>
        </div>
      )}

      {structuredCard && structuredCard.type === "email_draft" && structuredCard.metadata?.email && (
        <div className="mt-3 p-3 rounded-xl bg-indigo-950/40 border border-indigo-400/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Mail className="w-4 h-4 text-indigo-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-bold text-white truncate">{structuredCard.title}</div>
              <div className="text-[11px] text-indigo-200 truncate">{structuredCard.subtitle}</div>
            </div>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 shrink-0">
            Ready
          </span>
        </div>
      )}
    </div>
  );
}
