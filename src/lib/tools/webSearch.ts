import { Citation } from "../types";

export interface WebSearchOutput {
  query: string;
  summary: string;
  citations: Citation[];
}

export async function performWebSearch(query: string): Promise<WebSearchOutput> {
  const citations: Citation[] = [];
  const snippets: string[] = [];

  try {
    // 1. DuckDuckGo Instant Answer API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const ddgRes = await fetch(ddgUrl, { signal: AbortSignal.timeout(4500) });
    if (ddgRes.ok) {
      const ddgData = await ddgRes.json();
      if (ddgData.AbstractText) {
        snippets.push(ddgData.AbstractText);
        citations.push({
          title: ddgData.Heading || "DuckDuckGo Knowledge Graph",
          url: ddgData.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
          snippet: ddgData.AbstractText,
        });
      }
      if (Array.isArray(ddgData.RelatedTopics)) {
        for (const topic of ddgData.RelatedTopics.slice(0, 3)) {
          if (topic.Text && topic.FirstURL) {
            snippets.push(topic.Text);
            citations.push({
              title: topic.Text.split(" - ")[0]?.slice(0, 70) || "Web Result",
              url: topic.FirstURL,
              snippet: topic.Text,
            });
          }
        }
      }
    }
  } catch {
    // Ignore timeout and continue to Wikipedia fallback
  }

  try {
    // 2. Wikipedia OpenSearch / REST API for encyclopedic & factual queries
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&utf8=&format=json&srlimit=3`;
    const wikiRes = await fetch(wikiUrl, {
      headers: { "User-Agent": "OlliBot/1.0 (https://olly.bot)" },
      signal: AbortSignal.timeout(4500),
    });
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      const searchItems = wikiData?.query?.search || [];
      for (const item of searchItems) {
        const cleanSnippet = String(item.snippet || "").replace(/<\/?[^>]+(>|$)/g, "");
        const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
          item.title.replace(/ /g, "_")
        )}`;
        snippets.push(`${item.title}: ${cleanSnippet}`);
        if (!citations.some((c) => c.url === pageUrl)) {
          citations.push({
            title: `${item.title} — Wikipedia`,
            url: pageUrl,
            snippet: cleanSnippet,
          });
        }
      }
    }
  } catch {
    // Ignore network errors
  }

  if (citations.length === 0) {
    citations.push({
      title: `Google Search: "${query}"`,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      snippet: `Live search results for ${query}`,
    });
  }

  return {
    query,
    summary:
      snippets.length > 0
        ? snippets.join("\n\n")
        : `Performed live search for "${query}". Use grounded knowledge and provide direct links.`,
    citations: citations.slice(0, 5),
  };
}

