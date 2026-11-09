import { GoogleGenAI } from "@google/genai";
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
  if (params.base64Data && (params.mimeType === "application/pdf" || params.name.toLowerCase().endsWith(".pdf"))) {
    const cleanB64 = params.base64Data.includes(",")
      ? params.base64Data.split(",")[1]
      : params.base64Data;
    const pdfBuf = Buffer.from(cleanB64, "base64");
    rawText = extractTextFromPdfBuffer(pdfBuf);
  }
  if (params.url && !rawText) {
    try {
      const response = await fetch(params.url, {
        headers: { "User-Agent": "VelnorBot/1.0 (+https://pluco.dev)" },
        signal: AbortSignal.timeout(6000),
      });
      const html = await response.text();
      rawText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/?[^>]+(>|$)/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20000);
    } catch (err) {
      rawText = `URL source (${params.url}) registered. Could not fetch full body directly (${String(err)}).`;
    }
  }

  const cleanText = rawText.trim() || `Document "${params.name}" uploaded.`;
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

