import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite';
import { devCspHeader } from './csp';

// The dev server sends the native shell's own CSP (see ./csp.ts for why Vite has
// to be the one to send it). tauri.conf.json is the single source of truth.
const tauriConf = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
) as { app: { security: { csp: string | null; devCsp?: string } } };
const csp = devCspHeader(
  tauriConf.app.security,
  readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8'),
);

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    // Bundle Iconify icons (Myna set) as inline Vue SVG components at build
    // time — no runtime CDN calls, only the icons actually imported ship.
    Icons({ compiler: 'vue3' }),
  ],
  server: {
    // Same policy the built shell ships (see the devCsp note above). The HMR
    // websocket is named explicitly for the default loopback dev server; a LAN
    // session (`vite --host`, e.g. the Linux-WebKit harness run in
    // web/dev/README.md) reaches the page from another origin, so HMR's socket
    // is refused there and the page needs a manual reload — deliberate, rather
    // than allowing `ws:` wholesale.
    headers: csp ? { 'Content-Security-Policy': csp } : {},
    proxy: {
      // ws:true so the chat WebSocket upgrade at /api/ws is proxied too — with
      // the string shorthand only REST is forwarded, so the socket fails to
      // connect and the client reconnect-churns (re-decrypting on each cycle).
      '/api': { target: 'http://localhost:3000', ws: true },
      // Default emote images are proxied/cached by the backend (no longer
      // committed static files), so forward /emoji in dev too.
      '/emoji': { target: 'http://localhost:3000' },
    },
  },
});
