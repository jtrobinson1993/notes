import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vault gate (NativeGate) owns auth + onboarding, so the router has no
// public/private routes and no session redirects. The only guard logic left is
// the one-shot "restore the last open view" on the first navigation of an app
// load, plus the chat pane it implies on a phone.

// Stub the lazily-imported page components so navigation doesn't pull in heavy
// page deps (voice worklets, the Rust IPC layer, etc.) the test environment
// can't transform — we only care about the guard's effects.
const stub = { default: { template: '<div />' } };
vi.mock('../src/pages/NotesPage.vue', () => stub);
vi.mock('../src/pages/FriendsPage.vue', () => stub);
vi.mock('../src/pages/NativeChatPage.vue', () => stub);
vi.mock('../src/pages/SettingsPage.vue', () => stub);

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
  window.history.replaceState(null, '', '/');
});
afterEach(() => localStorage.clear());

describe('routes', () => {
  it('serves exactly the four native views', async () => {
    const { router } = await freshRouter();
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/', '/friends', '/dm', '/settings', '/:pathMatch(.*)*']),
    );
    expect(paths).toHaveLength(5);
  });

  it('sends an unknown path back to notes rather than 404ing', async () => {
    const { router } = await freshRouter();
    await router.push('/chat/abc/general'); // a legacy v1 URL
    expect(router.currentRoute.value.path).toBe('/');
  });
});

describe('first-navigation restore', () => {
  it('opens the messages pane when loading the DM URL directly (reload)', async () => {
    const { router, chatPane } = await freshRouter();
    expect(chatPane.value).toBe('channels'); // default before any navigation
    await router.push('/dm');
    expect(chatPane.value).toBe('messages');
  });

  it('leaves the pane on the list for a non-chat URL', async () => {
    const { router, chatPane } = await freshRouter();
    await router.push('/friends');
    expect(chatPane.value).toBe('channels');
  });

  it('restores the last open view on a cold start at /', async () => {
    localStorage.setItem('last-route', '/friends');
    const { router } = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.fullPath).toBe('/friends');
  });

  it('restores a DM and opens its messages pane', async () => {
    localStorage.setItem('last-route', '/dm');
    const { router, chatPane } = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.fullPath).toBe('/dm');
    expect(chatPane.value).toBe('messages');
  });

  it('stays at / when the stored route is / (no redirect loop)', async () => {
    localStorage.setItem('last-route', '/');
    const { router } = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.fullPath).toBe('/');
  });

  it('only acts on the first navigation, not later ones', async () => {
    const { router, chatPane } = await freshRouter();
    await router.push('/friends'); // consumes the one-shot restore
    expect(chatPane.value).toBe('channels');
    await router.push('/dm'); // later nav must not force the pane
    expect(chatPane.value).toBe('channels');
  });
});

describe('last-route persistence', () => {
  it('records every navigation so the next cold start can restore it', async () => {
    const { router } = await freshRouter();
    await router.push('/friends');
    expect(localStorage.getItem('last-route')).toBe('/friends');
    await router.push('/settings');
    expect(localStorage.getItem('last-route')).toBe('/settings');
  });
});
