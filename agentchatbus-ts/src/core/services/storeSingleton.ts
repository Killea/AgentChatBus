import type { MemoryStore } from "./memoryStore.js";

let _store: MemoryStore | null = null;

export function registerStore(store: MemoryStore) {
  _store = store;
}

export function getStore(): MemoryStore {
  if (!_store) {
    throw new Error('MemoryStore not registered yet');
  }
  return _store;
}
