import { getStore, saveStore } from "../store";
import { MemoryFact } from "../types";
import type { TenantRepository } from "../storage/tenantRepository";
import type { PersistedTenantState } from "../storage/d1TenantState";

export function addMemoryFact(params: {
  fact: string;
  category?: MemoryFact["category"];
}): MemoryFact {
  const state = getStore();
  if (!Array.isArray(state.memories)) {
    state.memories = [];
  }

  const lower = params.fact.toLowerCase();
  const inferredCategory: MemoryFact["category"] =
    params.category ||
    (lower.includes("flight") || lower.includes("airport") || lower.includes("hotel") || lower.includes("seat")
      ? "travel"
      : lower.includes("@") || lower.includes("email") || lower.includes("manager") || lower.includes("contact")
      ? "contact"
      : lower.includes("meeting") || lower.includes("project") || lower.includes("slack")
      ? "work"
      : "preference");

  const newFact: MemoryFact = {
    id: `mem-${Date.now()}`,
    category: inferredCategory,
    fact: params.fact.trim(),
    createdAt: new Date().toISOString(),
  };

  state.memories.unshift(newFact);
  saveStore(state);
  return newFact;
}

export function listMemoryFacts(query?: string): MemoryFact[] {
  const state = getStore();
  const memories = state.memories || [];
  if (!query || !query.trim()) return memories;
  const q = query.toLowerCase();
  return memories.filter(
    (m) => m.fact.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
  );
}

export function deleteMemoryFact(id: string): MemoryFact[] {
  const state = getStore();
  state.memories = (state.memories || []).filter((m) => m.id !== id);
  saveStore(state);
  return state.memories;
}


/**
 * Async repository-backed memory operations. Callers must pass the authenticated
 * tenant ID explicitly; the legacy synchronous API above remains unchanged
 * until its callers have been migrated.
 */
function inferMemoryCategory(fact: string, category?: MemoryFact["category"]): MemoryFact["category"] {
  const lower = fact.toLowerCase();
  return category ||
    (lower.includes("flight") || lower.includes("airport") || lower.includes("hotel") || lower.includes("seat")
      ? "travel"
      : lower.includes("@") || lower.includes("email") || lower.includes("manager") || lower.includes("contact")
      ? "contact"
      : lower.includes("meeting") || lower.includes("project") || lower.includes("slack")
      ? "work"
      : "preference");
}

function initialMemoryState(): PersistedTenantState {
  return { memories: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
}

export async function addMemoryFactAsync(
  repository: TenantRepository,
  tenantId: string,
  params: { fact: string; category?: MemoryFact["category"] },
): Promise<MemoryFact> {
  const newFact: MemoryFact = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: inferMemoryCategory(params.fact, params.category),
    fact: params.fact.trim(),
    createdAt: new Date().toISOString(),
  };
  await repository.update(tenantId, initialMemoryState, (draft) => {
    const memories = Array.isArray(draft.memories) ? draft.memories as MemoryFact[] : [];
    draft.memories = [newFact, ...memories];
  });
  return newFact;
}

export async function listMemoryFactsAsync(
  repository: TenantRepository,
  tenantId: string,
  query?: string,
): Promise<MemoryFact[]> {
  const record = await repository.load(tenantId);
  const memories = Array.isArray(record?.state.memories) ? record.state.memories as MemoryFact[] : [];
  if (!query || !query.trim()) return memories;
  const q = query.toLowerCase();
  return memories.filter((memory) =>
    memory.fact.toLowerCase().includes(q) || memory.category.toLowerCase().includes(q)
  );
}

export async function deleteMemoryFactAsync(
  repository: TenantRepository,
  tenantId: string,
  id: string,
): Promise<MemoryFact[]> {
  let remaining: MemoryFact[] = [];
  await repository.update(tenantId, initialMemoryState, (draft) => {
    const memories = Array.isArray(draft.memories) ? draft.memories as MemoryFact[] : [];
    remaining = memories.filter((memory) => memory.id !== id);
    draft.memories = remaining;
  });
  return remaining;
}
