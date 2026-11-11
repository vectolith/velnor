import { Citation } from "../types";
import { safeFetchText } from "@/lib/security/outboundUrl";

export interface WebSearchOutput {
  query: string;
  summary: string;
  citations: Citation[];
  /** True when at least one result page was actually fetched and read. */
  grounded: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 3;
const PAGE_CHARS = 1400;

const cache = new Map<string, { at: number; value: WebSearchOutput }>();

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Pull organic results out of DuckDuckGo's no-JS HTML endpoint. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));

  let i = 0;
  while ((m = linkRe.exec(html)) && hits.length < 8) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//i.test(href)) continue;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    hits.push({ title, url: href, snippet: snippets[i] || "" });
    i++;
  }
  return hits;
}

/** Crude but dependency-free readability: drop chrome, keep prose. */
export function extractReadableText(html: string): string {
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");

  const article = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  if (article) body = article[0];

  const paragraphs = Array.from(body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .map((m) => stripTags(m[1]))
    .filter((p) => p.length > 60);

  const text = paragraphs.length >= 2 ? paragraphs.join("\n\n") : stripTags(body);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchPageText(rawUrl: string): Promise<string> {
  try {
    const result = await safeFetchText(rawUrl, { timeoutMs: 6000, maxBytes: 2_000_000, maxRedirects: 3 });
    return result.text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);
  } catch {
    return "";
  }
}

export async function performWebSearch(query: string): Promise<WebSearchOutput> {
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const [ddg, wiki, hn] = await Promise.all([duckDuckGo(query), wikipedia(query), hackerNews(query)]);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const hit of [...ddg, ...wiki, ...hn]) {
    const normalized = hit.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hits.push(hit);
    if (hits.length >= 6) break;
  }

  const pages = await Promise.all(hits.slice(0, MAX_PAGES).map((h) => fetchPageText(h.url)));

  const citations: Citation[] = [];
  const sections: string[] = [];
  let grounded = false;

  hits.slice(0, MAX_PAGES).forEach((hit, i) => {
    const text = pages[i];
    if (text) grounded = true;
    citations.push({
      title: hit.title,
      url: hit.url,
      snippet: (text || hit.snippet || "").slice(0, 300),
    });
    if (text) {
      sections.push("[" + (i + 1) + "] " + hit.title + " (" + hit.url + ")\n" + text);
    } else if (hit.snippet) {
      sections.push("[" + (i + 1) + "] " + hit.title + " (" + hit.url + ")\n" + hit.snippet);
    }
  });

  for (const hit of hits.slice(MAX_PAGES)) {
    citations.push({ title: hit.title, url: hit.url, snippet: hit.snippet });
  }

  const summary =
    sections.length > 0
      ? sections.join("\n\n")
      : 'No live results were reachable for "' + query + '".';

  const value: WebSearchOutput = { query, summary, citations: citations.slice(0, 6), grounded };
  cache.set(key, { at: Date.now(), value });
  return value;
}
