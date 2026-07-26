import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

// The security invariant this file guards: decrypted state must never outlive
// the master key. App.vue watches the vault gate and, on anything other than
// 'ready', drops every piece of plaintext the MK produced — note bodies, folder
// and tag names, friend handles, conversation titles, and a live call's media.
// A regression here is silent (the app looks fine; the plaintext just lingers in
// memory after a re-lock), so it is asserted directly rather than via the UI.

// A real ref, so App.vue's watcher actually reacts to gate transitions.
vi.mock('../src/lib/nativeVault', async () => {
  const { ref } = await import('vue');
  return { gateState: ref('locked') };
});

const teardown = vi.hoisted(() => ({
  teardownCallHost: vi.fn(),
  resetNativeChat: vi.fn(),
  stopNativeConversations: vi.fn(),
  startNativeConversations: vi.fn(),
  resetTagColors: vi.fn(),
}));
vi.mock('../src/lib/callHost', () => ({ teardownCallHost: teardown.teardownCallHost }));
vi.mock('../src/lib/nativeChat', () => ({ resetNativeChat: teardown.resetNativeChat }));
vi.mock('../src/lib/tagColors', () => ({ resetTagColors: teardown.resetTagColors }));
vi.mock('../src/lib/nativeConversations', () => ({
  nativeConversations: ref([]),
  startNativeConversations: teardown.startNativeConversations,
  stopNativeConversations: teardown.stopNativeConversations,
}));

const stores = vi.hoisted(() => ({
  notesReset: vi.fn(),
  profileReset: vi.fn(),
  profileLoad: vi.fn().mockResolvedValue(undefined),
  friendsReset: vi.fn(),
  orgReset: vi.fn(),
}));
vi.mock('../src/stores/notes', () => ({ useNotesStore: () => ({ reset: stores.notesReset }) }));
vi.mock('../src/stores/profile', () => ({
  useProfileStore: () => ({ reset: stores.profileReset, load: stores.profileLoad }),
}));
vi.mock('../src/stores/friends', () => ({ useFriendsStore: () => ({ reset: stores.friendsReset }) }));
vi.mock('../src/stores/organization', () => ({ useOrgStore: () => ({ reset: stores.orgReset }) }));

import App from '../src/App.vue';
import { gateState } from '../src/lib/nativeVault';

const stubs = {
  NativeGate: { template: '<div><slot /></div>' },
  NativeCallHost: { template: '<div />' },
  KtAlarm: { template: '<div />' },
  RouterView: { template: '<div />' },
};

/** Every teardown the lock path must perform, by name. */
const ALL_TEARDOWNS = [
  ['call host', () => teardown.teardownCallHost],
  ['conversation list', () => teardown.stopNativeConversations],
  ['chat', () => teardown.resetNativeChat],
  ['tag colours', () => teardown.resetTagColors],
  ['notes store', () => stores.notesReset],
  ['profile store', () => stores.profileReset],
  ['friends store', () => stores.friendsReset],
  ['organization store', () => stores.orgReset],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  gateState.value = 'locked';
});

describe('App vault-gate teardown', () => {
  it('drops every piece of decrypted state when the vault re-locks', async () => {
    gateState.value = 'ready';
    mount(App, { global: { stubs } });
    await flushPromises();
    // Nothing is torn down while the vault is open.
    for (const [name, fn] of ALL_TEARDOWNS) {
      expect(fn(), `${name} must not be reset while unlocked`).not.toHaveBeenCalled();
    }

    gateState.value = 'locked';
    await flushPromises();

    for (const [name, fn] of ALL_TEARDOWNS) {
      expect(fn(), `${name} must be dropped on re-lock`).toHaveBeenCalled();
    }
  });

  it('starts from a torn-down state when the app boots locked', async () => {
    mount(App, { global: { stubs } });
    await flushPromises();

    // The watcher is immediate, so a cold start before unlock must not leave
    // stale plaintext from a previous session's stores lying around.
    for (const [name, fn] of ALL_TEARDOWNS) {
      expect(fn(), `${name} must be dropped on a locked boot`).toHaveBeenCalled();
    }
    expect(teardown.startNativeConversations).not.toHaveBeenCalled();
  });

  it('loads the identity and starts the conversation list once the gate opens', async () => {
    mount(App, { global: { stubs } });
    await flushPromises();
    vi.clearAllMocks();

    gateState.value = 'ready';
    await flushPromises();

    expect(stores.profileLoad).toHaveBeenCalled();
    expect(teardown.startNativeConversations).toHaveBeenCalled();
    expect(teardown.stopNativeConversations).not.toHaveBeenCalled();
  });

  it('tears down for onboarding too — the gate is only trustworthy at "ready"', async () => {
    gateState.value = 'ready';
    mount(App, { global: { stubs } });
    await flushPromises();

    // 'onboarding' means the vault is unlocked but there is no relay account
    // yet. It is still not 'ready', so the decrypted world must be dropped
    // rather than left half-populated.
    gateState.value = 'onboarding';
    await flushPromises();

    expect(teardown.teardownCallHost).toHaveBeenCalled();
    expect(stores.notesReset).toHaveBeenCalled();
  });
});
