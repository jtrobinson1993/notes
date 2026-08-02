// jsdom ships getRandomValues but no SubtleCrypto. Borrow Node's WebCrypto so
// crypto-touching store/lib code runs unchanged under the web project.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto || !('subtle' in globalThis.crypto)) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

// jsdom implements neither half of the object-URL API, and several surfaces
// (attachments, decrypted emote bytes) mint one. Hand out a unique blob: URL so
// tests can assert on it, and record revocation.
if (typeof URL.createObjectURL !== 'function') {
  let n = 0;
  URL.createObjectURL = () => `blob:mock/${++n}`;
  URL.revokeObjectURL = () => {};
}

// jsdom ships no ResizeObserver; the conversation page observes the chat region
// to decide the thread layout. A no-op stub is enough (callbacks never fire).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom ships no matchMedia; theme.ts and friends call it. Default to a
// light-scheme, no-op-listener stub.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
