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
    const ddgRes = await fetch(ddgUrl, { signal: AbortSignal.timeout(4000) });
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
    // Ignore timeout and continue
  }

  try {
    // 2. Wikipedia OpenSearch / REST API for encyclopedic & factual queries
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&utf8=&format=json&srlimit=3`;
    const wikiRes = await fetch(wikiUrl, {
      headers: { "User-Agent": "VelnorBot/1.0 (https://pluco.dev)" },
      signal: AbortSignal.timeout(4000),
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

  try {
    // 3. Hacker News Algolia Live Index for real-time tech, AI & world news
    const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
      query
    )}&tags=story&hitsPerPage=2`;
    const hnRes = await fetch(hnUrl, { signal: AbortSignal.timeout(3500) });
    if (hnRes.ok) {
      const hnData = await hnRes.json();
      for (const hit of hnData.hits || []) {
        if (hit.title && (hit.url || hit.objectID)) {
          const hitUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
          snippets.push(`Recent discussion: "${hit.title}" (${hit.points || 0} pts)`);
          if (!citations.some((c) => c.url === hitUrl)) {
            citations.push({
              title: hit.title,
              url: hitUrl,
              snippet: `${hit.points || 0} points • ${hit.num_comments || 0} comments`,
            });
          }
        }
      }
    }
  } catch {
    // Ignore
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
        ? snippets.slice(0, 4).join("\n\n")
        : `Performed live search for "${query}".`,
    citations: citations.slice(0, 5),
  };
}
