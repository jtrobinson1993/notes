import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import Icons from 'unplugin-icons/vite';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    // Bundle Iconify icons (Myna set) as inline Vue SVG components at build
    // time — no runtime CDN calls, only the icons actually imported ship.
    Icons({ compiler: 'vue3' }),
    VitePWA({
      // The PWA layer (service worker, manifest, install prompt) is web-only:
      // inside the Tauri shell the app is a native install already, storage is
      // the Rust core, and SW registration on the tauri:// origin is
      // unsupported — so the whole plugin is disabled for Tauri dev/builds
      // (Tauri always sets TAURI_ENV_PLATFORM).
      disable: !!process.env.TAURI_ENV_PLATFORM,
      // Custom service worker (src/sw.ts) so we can host Web Push handlers, which
      // the generated worker can't. It keeps the precache + emoji runtime cache.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        // The default 7TV emoji set is hundreds of small files; don't bloat the
        // precache with them — cache on demand the first time one is rendered.
        globIgnores: ['**/emoji/**'],
      },
      // Don't register the service worker in dev: its precache serves stale JS
      // across reloads, which silently masks code changes (a recurring "why
      // isn't my change showing up" trap). Prod always registers it. The cost is
      // that Web Push / notifications can't be exercised against the dev server
      // (`navigator.serviceWorker.ready` never resolves, so Settings shows "Not
      // supported here") — flip `enabled` back to true temporarily to test those.
      devOptions: {
        enabled: false,
        type: 'module',
      },
      manifest: {
        name: 'Accord',
        short_name: 'Accord',
        description: 'Self-hosted, end-to-end encrypted notes & chat',
        theme_color: '#18181b',
        background_color: '#18181b',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
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
