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
