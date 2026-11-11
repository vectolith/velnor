import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { safeFetchText } from "@/lib/security/outboundUrl";
import { getEffectiveKeys, getStore, saveStore } from "../store";
import { DocumentChunk, IndexedDocument } from "../types";
import { extractTextFromPdfBuffer } from "./pdfParser";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function chunkText(text: string, maxWords = 140): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords - 25) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
    if (i + maxWords >= words.length) break;
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

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

export async function ingestDocumentOrUrl(params: {
  name: string;
  content?: string;
  base64Data?: string;
  mimeType?: string;
  url?: string;
}): Promise<IndexedDocument> {
  const state = getStore();
  const { geminiApiKey } = getEffectiveKeys(state);

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

  const cleanText = rawText.trim();
  if (!cleanText) throw new Error("No readable text was found; the document was not indexed.");
  const docId = "doc-" + crypto.randomUUID();
  const wordCount = cleanText.split(/\s+/).length;

  // Build quick extractive summary
  const sentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const summary =
    sentences.slice(0, 3).join(" ").slice(0, 420) ||
    cleanText.slice(0, 320);
  const chunks = chunkText(cleanText);
  const docId = `doc-${Date.now()}`;
  const wordCount = cleanText.split(/\s+/).length;

  // Build quick extractive summary
  const sentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const summary =
    sentences.slice(0, 3).join(" ").slice(0, 420) ||
    cleanText.slice(0, 320);

  const newChunks: DocumentChunk[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const cText = chunks[idx];
    const emb = await computeEmbedding(cText, geminiApiKey);
    newChunks.push({
      id: `${docId}-chk-${idx + 1}`,
      docId,
      docName: params.name,
      content: cText,
      tokens: tokenize(cText),
      embedding: emb,
    });
  }

  const indexedDoc: IndexedDocument = {
    id: docId,
    name: params.name,
    sourceType: params.url ? "url" : "file",
    url: params.url,
    summary,
    chunkCount: newChunks.length,
    wordCount,
    createdAt: new Date().toISOString(),
  };

  state.documents.unshift(indexedDoc);
  state.documentChunks.push(...newChunks);
  saveStore(state);
  return indexedDoc;
}

export async function queryVectorDocuments(
  query: string,
  topK = 4
): Promise<{
  matches: Array<{ docName: string; content: string; score: number }>;
  documents: IndexedDocument[];
}> {
  const state = getStore();
  const { geminiApiKey } = getEffectiveKeys(state);
  const qTokens = tokenize(query);
  const qEmbedding = await computeEmbedding(query, geminiApiKey);

  const scored = state.documentChunks.map((chunk) => {
    let score = 0;
    if (qEmbedding && chunk.embedding) {
      score = cosineSimilarity(qEmbedding, chunk.embedding);
    } else {
      const tokenSet = new Set(chunk.tokens);
      let hits = 0;
      for (const qt of qTokens) {
        if (tokenSet.has(qt)) hits += 1;
        else if (chunk.content.toLowerCase().includes(qt)) hits += 0.6;
      }
      score = qTokens.length > 0 ? hits / Math.sqrt(qTokens.length * (chunk.tokens.length + 1)) : 0.1;
    }
    return {
      docName: chunk.docName,
      content: chunk.content,
      score: Number(score.toFixed(4)),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    matches: scored.slice(0, topK),
    documents: state.documents,
  };
}

