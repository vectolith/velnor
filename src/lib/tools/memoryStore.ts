import { getStore, saveStore } from "../store";
import { MemoryFact } from "../types";

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
