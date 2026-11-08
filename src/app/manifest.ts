import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Olli — Personal AI Assistant",
    short_name: "Olli",
    description:
      "Personal AI assistant in iMessage, SMS & Slack with live web search, document vector Q&A, Gmail & Google Calendar management, and travel planning.",
    start_url: "/",
    display: "standalone",
    background_color: "#090b10",
    theme_color: "#0d111a",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
