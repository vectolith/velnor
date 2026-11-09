import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Velnor — Executive Personal AI Assistant for iMessage, SMS & Slack",
  description:
    "Velnor is an executive personal AI assistant powered by multi-provider routing and the velnor-core-v1 LoRA model: live web search, chat with PDFs & links via vector search, Gmail & Google Calendar management, multimodal vision/voice/image generation, and travel planning across iMessage, SMS, and Slack.",
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

