import type { KeyStore } from '../../shared/whiteboard.mjs';

export * from '../../shared/whiteboard.mjs';

// Session storage keeps retry keys across reloads. In-memory keys still cover disabled storage.
const memory = new Map<string, string>();

export const sessionKeys: KeyStore = {
  get(operation) {
    try {
      return memory.get(operation) ?? sessionStorage.getItem(operation);
    } catch {
      return memory.get(operation);
    }
  },
  set(operation, key) {
    memory.set(operation, key);
    try {
      sessionStorage.setItem(operation, key);
    } catch {
      // Storage can be disabled.
    }
  },
  delete(operation) {
    memory.delete(operation);
    try {
      sessionStorage.removeItem(operation);
    } catch {
      // Storage can be disabled.
    }
  },
};
