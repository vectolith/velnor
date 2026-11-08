import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Olli — Personal AI Assistant for iMessage, SMS & Slack",
  description:
    "Personal AI assistant inspired by olly.bot: live web search, chat with PDFs & links via in-memory vector search, Gmail & Google Calendar management, multimodal vision/voice/image generation, and travel planning across iMessage, SMS, and Slack.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased selection:bg-blue-500/30 selection:text-blue-200">
        {children}
      </body>
    </html>
  );
}

