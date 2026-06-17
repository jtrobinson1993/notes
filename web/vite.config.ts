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
      registerType: 'autoUpdate',
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // The default 7TV emoji set is hundreds of small files; don't bloat the
        // precache with them — cache on demand the first time one is rendered.
        globIgnores: ['**/emoji/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/emoji/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'emoji',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'Notes',
        short_name: 'Notes',
        description: 'Self-hosted end-to-end encrypted notes',
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
