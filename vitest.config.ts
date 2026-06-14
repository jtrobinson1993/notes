import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath } from 'node:url';

// All cryptography/types live in the shared workspace as TS source. Alias the
// package to its source so tests need no build step.
const alias = {
  '@notes/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Three projects mirror the spec's tooling split:
    //  - crypto/server run under Node (WebCrypto, better-sqlite3, Fastify)
    //  - web runs under jsdom for DOM/store/editor/component tests
    projects: [
      {
        extends: true,
        test: {
          name: 'crypto',
          environment: 'node',
          include: ['web/test/crypto/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [vue(), Icons({ compiler: 'vue3' })],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/test/**/*.test.ts'],
          exclude: ['web/test/crypto/**'],
          setupFiles: ['web/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Scope coverage to what this suite actually targets (the spec's P0–P2
      // surface), so the gate is meaningful rather than diluted by untested
      // glue (idb/api/webauthn/etc.).
      include: [
        'web/src/lib/crypto.ts',
        'web/src/lib/chatCrypto.ts',
        'web/src/lib/recovery.ts',
        'web/src/lib/theme.ts',
        'web/src/lib/tagColors.ts',
        'web/src/lib/transfer.ts',
        'web/src/lib/editor/livePreview.ts',
        'web/src/stores/chat.ts',
        'web/src/stores/friends.ts',
        'server/src/db.ts',
        'server/src/realtime.ts',
        'server/src/routes/chat.ts',
        'server/src/session.ts',
      ],
      exclude: ['**/*.d.ts'],
      // High bar on the security/crypto + routes + stores core; lighter
      // baseline elsewhere (P3).
      thresholds: {
        statements: 60,
        branches: 70,
        functions: 55,
        lines: 60,
        'web/src/lib/chatCrypto.ts': { statements: 100, branches: 95, functions: 100, lines: 100 },
        'web/src/lib/recovery.ts': { statements: 95, branches: 80, functions: 100, lines: 95 },
        'web/src/lib/transfer.ts': { statements: 95, branches: 75, functions: 100, lines: 95 },
        'server/src/routes/chat.ts': { statements: 85, branches: 78, functions: 90, lines: 85 },
        'web/src/stores/chat.ts': { statements: 75, branches: 70, functions: 75, lines: 75 },
        'web/src/stores/friends.ts': { statements: 80, branches: 85, functions: 60, lines: 80 },
      },
    },
  },
});
