import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A logged-in, set-up session so the guard reaches its first-navigation restore
// logic. Mutable between tests via the fields below.
const session = { loggedIn: true, needsSetup: false, init: vi.fn(async () => {}) };
vi.mock('../src/stores/session', () => ({ useSessionStore: () => session }));

// Stub the lazily-imported page components so navigation doesn't pull in heavy
// page deps (voice worklets, etc.) the test environment can't transform — we
// only care about the beforeEach guard's effect on the chat pane.
const stub = { default: { template: '<div />' } };
vi.mock('../src/pages/ConversationPage.vue', () => stub);
vi.mock('../src/pages/NotesPage.vue', () => stub);
vi.mock('../src/pages/FriendsPage.vue', () => stub);

// Each test loads a fresh router + mobileNav pair so the module-level
// `restoredInitial` flag (a one-shot guard) and `chatPane` default reset.
async function freshRouter() {
  vi.resetModules();
  const mobileNav = await import('../src/lib/mobileNav');
  const { router } = await import('../src/router');
  return { router, chatPane: mobileNav.chatPane };
}

beforeEach(() => {
  localStorage.clear();
  session.loggedIn = true;
  session.needsSetup = false;
  window.history.replaceState(null, '', '/');
});
afterEach(() => localStorage.clear());

describe('first-navigation chat pane restore', () => {
  it('opens the messages pane when loading a chat URL directly (reload)', async () => {
    const { router, chatPane } = await freshRouter();
    expect(chatPane.value).toBe('channels'); // default before any navigation
    await router.push('/chat/abc/general');
    expect(chatPane.value).toBe('messages');
  });

  it('opens the messages pane for a bare DM chat URL too', async () => {
    const { router, chatPane } = await freshRouter();
    await router.push('/chat/abc');
    expect(chatPane.value).toBe('messages');
  });

  it('leaves the pane on the channel list for a non-chat URL', async () => {
    const { router, chatPane } = await freshRouter();
    await router.push('/friends');
    expect(chatPane.value).toBe('channels');
  });

  it('restores the last open chat (messages) on a cold start at /', async () => {
    localStorage.setItem('last-route', '/chat/xyz/general');
    const { router, chatPane } = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.fullPath).toBe('/chat/xyz/general');
    expect(chatPane.value).toBe('messages');
  });

  it('only acts on the first navigation, not later ones', async () => {
    const { router, chatPane } = await freshRouter();
    await router.push('/friends'); // consumes the one-shot restore
    expect(chatPane.value).toBe('channels');
    await router.push('/chat/abc/general'); // later nav must not force the pane
    expect(chatPane.value).toBe('channels');
  });
});
