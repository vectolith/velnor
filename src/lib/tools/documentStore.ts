import { GoogleGenAI } from "@google/genai";
import { safeFetchText } from "@/lib/security/outboundUrl";
import { DEFAULT_STATE, getEffectiveKeys, getStore } from "../store";
import type { PersistedTenantState } from "../storage/d1TenantState";
import { getNodeTenantRepositoryContext } from "../storage/currentTenantRepository";
import type { IndexedDocument } from "../types";
import { extractTextFromPdfBuffer } from "./pdfParser";
import { createRepositoryDocumentStore } from "./repositoryDocumentStore";

async function computeEmbedding(text: string, geminiKey?: string): Promise<number[] | undefined> {
  if (!geminiKey) return undefined;
  try {
    const client = new GoogleGenAI({ apiKey: geminiKey });
    const res = await client.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
    });
    return res.embeddings?.[0]?.values;
  } catch {
    return undefined;
  }
}

function tenantDocumentStore(
  context: ReturnType<typeof getNodeTenantRepositoryContext>,
  geminiApiKey?: string
) {
  return createRepositoryDocumentStore({
    repository: context.repository,
    tenantId: context.tenantId,
    createInitialState: () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    embed: (text) => computeEmbedding(text, geminiApiKey),
  });
}

export async function ingestDocumentOrUrl(params: {
  name: string;
  content?: string;
  base64Data?: string;
  mimeType?: string;
  url?: string;
}): Promise<IndexedDocument> {
  const context = getNodeTenantRepositoryContext();
  const { geminiApiKey } = getEffectiveKeys(getStore());
  let rawText = params.content || "";
  if (rawText.length > 2_000_000) throw new Error("Document text exceeds the 2 MB indexing limit.");

  if (params.base64Data) {
    const cleanB64 = params.base64Data.includes(",") ? params.base64Data.split(",")[1] : params.base64Data;
    const pdfBuf = Buffer.from(cleanB64, "base64");
    if (pdfBuf.length === 0 || pdfBuf.length > 15 * 1024 * 1024) {
      throw new Error("Uploaded document is empty or exceeds the 15 MB limit.");
    }
    if (params.mimeType === "application/pdf" || params.name.toLowerCase().endsWith(".pdf")) {
      rawText = extractTextFromPdfBuffer(pdfBuf);
    } else if (/^(text\/|application\/(json|xml))/.test(params.mimeType || "")) {
      rawText = pdfBuf.toString("utf8");
    } else {
      throw new Error("Unsupported document type. Upload a PDF or text-based document.");
    }
  }

  if (params.url && !rawText) {
    const fetched = await safeFetchText(String(params.url), {
      timeoutMs: 8000,
      maxBytes: 2_000_000,
      maxRedirects: 3,
      accept: (contentType) => /text\/|application\/(json|xml)|html/i.test(contentType),
    });
    rawText = fetched.text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/?[^>]+(>|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!rawText.trim()) throw new Error("No readable text was found; the document was not indexed.");
  return tenantDocumentStore(context, geminiApiKey).ingest({
    name: params.name,
    content: rawText,
    sourceType: params.url ? "url" : "file",
    url: params.url,
  });
}

export async function queryVectorDocuments(
  query: string,
  topK = 4
): Promise<{
  matches: Array<{ docName: string; content: string; score: number }>;
  documents: IndexedDocument[];
}> {
  const context = getNodeTenantRepositoryContext();
  const { geminiApiKey } = getEffectiveKeys(getStore());
  return tenantDocumentStore(context, geminiApiKey).query(query, topK);
}
