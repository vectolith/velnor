import type { DocumentChunk, IndexedDocument } from "../types";
import type { PersistedTenantState } from "../storage/d1TenantState";
import type { TenantRepository } from "../storage/tenantRepository";

type DocumentTenantState = PersistedTenantState & {
  documents: IndexedDocument[];
  documentChunks: DocumentChunk[];
};

export interface RepositoryDocumentStore {
  ingest(params: { name: string; content: string }): Promise<IndexedDocument>;
  query(query: string, topK?: number): Promise<{
    matches: Array<{ docName: string; content: string; score: number }>;
    documents: IndexedDocument[];
  }>;
}

export interface RepositoryDocumentStoreOptions {
  repository: TenantRepository;
  tenantId: string;
  createInitialState: () => PersistedTenantState;
  embed?: (text: string) => Promise<number[] | undefined>;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((word) => word.length > 2);
}

function chunkText(text: string, maxWords = 140): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += maxWords - 25) {
    chunks.push(words.slice(index, index + maxWords).join(" "));
    if (index + maxWords >= words.length) break;
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

function documentState(state: PersistedTenantState): DocumentTenantState {
  const value = state as DocumentTenantState;
  if (!Array.isArray(value.documents) || !Array.isArray(value.documentChunks)) {
    throw new Error("Tenant state is missing its document collections; refusing to overwrite it.");
  }
  return value;
}

/**
 * Tenant-explicit document indexing for async repositories (D1/Workers).
 * This boundary accepts already-extracted text only. Node-only PDF parsing,
 * URL fetching, and legacy synchronous-store access remain outside this module.
 */
export function createRepositoryDocumentStore(
  options: RepositoryDocumentStoreOptions
): RepositoryDocumentStore {
  if (!/^[A-Za-z0-9._@+-]{1,128}$/.test(options.tenantId)) {
    throw new Error("A valid explicit tenant ID is required for document storage.");
  }

  return {
    async ingest(params) {
      if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 256) {
        throw new Error("A document name between 1 and 256 characters is required.");
      }
      if (params.content.length > 2_000_000) {
        throw new Error("Document text exceeds the 2 MB indexing limit.");
      }
      const cleanText = params.content.trim();
      if (!cleanText) throw new Error("No readable text was found; the document was not indexed.");

      const docId = "doc-" + crypto.randomUUID();
      const chunks = chunkText(cleanText);
      const preparedChunks: DocumentChunk[] = [];
      for (let index = 0; index < chunks.length; index++) {
        const content = chunks[index];
        const embedding = await options.embed?.(content);
        preparedChunks.push({
          id: `${docId}-chk-${index + 1}`,
          docId,
          docName: params.name,
          content,
          tokens: tokenize(content),
          embedding,
        });
      }

      const sentences = cleanText.split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 25);
      const document: IndexedDocument = {
        id: docId,
        name: params.name,
        sourceType: "file",
        summary: sentences.slice(0, 3).join(" ").slice(0, 420) || cleanText.slice(0, 320),
        chunkCount: preparedChunks.length,
        wordCount: cleanText.split(/\s+/).length,
        createdAt: new Date().toISOString(),
      };

      await options.repository.update(
        options.tenantId,
        options.createInitialState,
        (draft) => {
          const state = documentState(draft);
          state.documents.unshift(document);
          state.documentChunks.push(...preparedChunks);
        }
      );
      return document;
    },

    async query(query, topK = 4) {
      const record = await options.repository.load(options.tenantId);
      if (!record) return { matches: [], documents: [] };
      const state = documentState(record.state);
      const queryTokens = tokenize(query);
      const queryEmbedding = await options.embed?.(query);
      const scored = state.documentChunks.map((chunk) => {
        let score = 0;
        if (queryEmbedding && chunk.embedding) {
          score = cosineSimilarity(queryEmbedding, chunk.embedding);
        } else {
          const tokenSet = new Set(chunk.tokens);
          let hits = 0;
          for (const token of queryTokens) {
            if (tokenSet.has(token)) hits += 1;
            else if (chunk.content.toLowerCase().includes(token)) hits += 0.6;
          }
          score = queryTokens.length > 0
            ? hits / Math.sqrt(queryTokens.length * (chunk.tokens.length + 1))
            : 0.1;
        }
        return {
          docName: chunk.docName,
          content: chunk.content,
          score: Number(score.toFixed(4)),
        };
      });
      scored.sort((a, b) => b.score - a.score);
      const limit = Number.isFinite(topK) ? Math.max(0, Math.min(Math.floor(topK), 100)) : 4;
      return { matches: scored.slice(0, limit), documents: state.documents };
    },
  };
}
