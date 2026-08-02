// L3 test harness: a **stateful fake of the Rust core**, injected into the page
// before any app script runs (spec/testing.md § L3).
//
// The v8 UI talks to the core exclusively through `invoke()` (web/src/lib/
// native.ts). `@tauri-apps/api` resolves that to
// `window.__TAURI_INTERNALS__.invoke(cmd, args, options)` and reports
// `isTauri()` from `globalThis.isTauri`, so defining both *before* the app's
// modules evaluate is enough to run the real UI in a plain browser against a
// fake far side. Nothing here ships: this file lives in `e2e/`, is never
// imported by `web/src`, and no dev flag or production branch enables it.
//
// The fake is a small in-memory core, not a bag of canned replies:
//
//   * one `state` object holds the vault status, device settings, the relay
//     session, friends, groups, conversations, the message log, reactions and
//     notes — every command reads and writes it, so commands compose the way the
//     real ones do (create a vault → `vault_status` reports unlocked; send a
//     message → it is in `messages_page`, in `conversation_activity`, and it
//     moves that conversation to the top of the side rail);
//   * the guards the Rust core enforces are enforced here, with the same error
//     strings: anything that goes through `vault.store()` fails with "vault is
//     locked" while locked, and anything needing a relay session fails with
//     "not connected to a relay". That is what makes the re-lock teardown test
//     meaningful — after `vault_lock` the UI genuinely cannot read anything
//     back;
//   * `transformCallback` + `plugin:event|listen` are implemented, so the fake
//     can **push** (`relay:mail`, `kt:alarm`, `voice:frame`) at the UI rather
//     than only answer calls. `deliverInbound`/`deliverFriend` use that to
//     simulate live delivery: queue mail → emit `relay:mail` → the app drains.
//
// State is mirrored into `sessionStorage`, so `page.reload()` models a *webview*
// reload with the core process still alive (MK still in memory), which is how
// Tauri behaves; a fresh browser context models a cold app launch.
//
// Where the fake can drift from the real core is listed in spec/testing.md § L3
// — read that before treating a green run here as proof about the Rust core.

import type { Page } from '@playwright/test';

export interface SeedFriend {
  /** Contact id == the friend's per-relay identity key (base64 in the real core). */
  contactId: string;
  handle: string;
  displayName?: string | null;
  /** Whether the key-transparency log proved this contact's key (default true).
   *  `false` seeds the contact the core records when the relay's directory was
   *  unreachable — it must render as *not* verified. */
  ktVerified?: boolean;
}

export interface SeedMessage {
  /** contactId of the DM's friend. */
  contact: string;
  text: string;
  /** true = sent by me (`sender_contact_id = 'self'`). */
  mine?: boolean;
  /** Relay delivery stamp. */
  ts?: number;
}

export interface SeedNote {
  id: string;
  title: string;
  tags?: string[];
}

export interface FakeSeed {
  vault: 'uninitialized' | 'locked' | 'unlocked';
  /** The password `vault_unlock` accepts (and `vault_create` records). */
  password: string;
  recoveryCode: string;
  /** Whether the silent D3 keychain unlock succeeds (initGate tries it first). */
  keychain: boolean;
  /** Device settings already in the vault DB (`identity.handle`, `relay.url`, …). */
  settings: Record<string, string>;
  /** Relay session state. The core's relay client outlives a vault lock, so
   *  `connected: true` models an in-process re-lock; false models a cold launch. */
  connected: boolean;
  relayUrl: string;
  relayFp: string;
  handle: string;
  friends: SeedFriend[];
  groups: { groupId: string; name: string }[];
  messages: SeedMessage[];
  notes: SeedNote[];
}

/** A relay-connected, unlocked, onboarded account: two friends, one with history. */
export const seededAccount: FakeSeed = {
  vault: 'unlocked',
  password: 'correct horse battery staple',
  recoveryCode: 'FAKE-CODE-0000-1111-2222-3333',
  keychain: false,
  settings: {
    'identity.handle': 'Harbour#4417',
    'relay.url': 'https://relay.test',
    'profile.displayName': 'Test User',
  },
  connected: true,
  relayUrl: 'https://relay.test',
  relayFp: 'fp-relay-test',
  handle: 'Harbour#4417',
  friends: [
    { contactId: 'contact-alice', handle: 'Anchor#1001', displayName: 'Alice' },
    { contactId: 'contact-bob', handle: 'Beacon#2002', displayName: 'Bob' },
  ],
  groups: [],
  messages: [
    { contact: 'contact-alice', text: 'first light', mine: false, ts: 1_700_000_000_000 },
    { contact: 'contact-alice', text: 'morning Alice', mine: true, ts: 1_700_000_060_000 },
  ],
  notes: [],
};

/** A never-used device: no vault at all (first-run wizard). */
export const firstRun: FakeSeed = {
  ...seededAccount,
  vault: 'uninitialized',
  settings: {},
  connected: false,
  handle: 'Harbour#4417',
  friends: [],
  messages: [],
};

/** A returning device: vault locked, and the silent keychain unlock fails, so
 *  the gate stops on the password wall. */
export const lockedDevice: FakeSeed = { ...seededAccount, vault: 'locked' };

/**
 * The page-context fake. Everything it needs is inside this function: Playwright
 * serializes it with `Function.prototype.toString()`, so it must not close over
 * anything in this module.
 */
function fakeCoreScript(seed: FakeSeed): void {
  const STORE_KEY = '__accord_fake_core_state__';

  interface MessageRow {
    id: string;
    conversation_id: string;
    channel_id: string | null;
    sender_contact_id: string | null;
    relay_ts: number;
    content: string | null;
    kind: string;
    reply_ref_json: string | null;
    attachments_json: string | null;
    deleted: boolean;
    edited_at: number | null;
  }
  interface Friend {
    contact_id: string;
    handle: string;
    display_name: string | null;
    identity_pub: string;
    sealing_pub: string;
    delivery_token: string;
    /** Relay epoch of the signed KT root that proved this key (null = never
     *  proven; the UI must render that as unverified). */
    kt_verified_epoch: number | null;
  }
  interface NoteRow {
    meta: {
      id: string;
      title: string | null;
      folder_id: string | null;
      shared_json: string | null;
      tags_json: string | null;
      created: number;
      updated: number;
    };
    ydoc_state: number[] | null;
  }
  /** A queued inbound item. The real mailbox holds sealed envelopes the core
   *  opens and verifies; the fake skips the crypto and queues the *result*. */
  type Queued =
    | { queue_id: number; kind: 'msg'; from: string; text: string; ts: number; id: string }
    | { queue_id: number; kind: 'friend'; friend: Friend };

  interface State {
    status: 'uninitialized' | 'locked' | 'unlocked';
    password: string;
    recoveryCode: string;
    keychain: boolean;
    settings: Record<string, string>;
    relay: { connected: boolean; baseUrl: string | null; fp: string | null };
    identityPub: string;
    sealingPub: string;
    deliveryToken: string;
    friends: Friend[];
    groups: { group_id: string; name: string | null; members: string[] }[];
    conversations: Record<string, { type: string; lastReadTs: number }>;
    messages: MessageRow[];
    reactions: { message_id: string; emoji: string; reactor_id: string }[];
    notes: Record<string, NoteRow>;
    /** Note id → the plaintext search projection the core stores (`notes_search`). */
    noteSearch: Record<string, string>;
    attachments: Record<string, { meta: Record<string, unknown>; bytes: number[] | null }>;
    blobs: Record<string, number[]>;
    accounts: { active: string; accounts: { id: string; label: string; dir: string }[] };
    mailbox: Queued[];
    nextQueueId: number;
    invites: { tokenHash: string; expiresAt: number }[];
    calls: { callId: string; mediaKey: string; contactId: string }[];
    log: string[];
    unimplemented: string[];
    counter: number;
  }

  function fnv(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  /** Stands in for `identity::dm_conversation_id`: derived from both identity
   *  keys and order-independent, so both sides compute the same id. */
  function dmConvId(a: string, b: string): string {
    const pair = [a, b].sort();
    return `dm-${fnv(`${pair[0]}|${pair[1]}`)}`;
  }

  function initial(): State {
    const s: State = {
      status: seed.vault,
      password: seed.password,
      recoveryCode: seed.recoveryCode,
      keychain: seed.keychain,
      settings: { ...seed.settings },
      relay: {
        connected: seed.connected,
        baseUrl: seed.connected ? seed.relayUrl : null,
        fp: seed.connected ? seed.relayFp : null,
      },
      identityPub: 'self-identity-pub',
      sealingPub: 'self-sealing-pub',
      deliveryToken: 'self-delivery-token',
      friends: seed.friends.map((f) => ({
        contact_id: f.contactId,
        handle: f.handle,
        display_name: f.displayName ?? null,
        identity_pub: f.contactId,
        sealing_pub: `${f.contactId}-sealing`,
        delivery_token: `${f.contactId}-token`,
        // The core only records an epoch when the transparency log proved the
        // key; seeds say which state they want (default: proven).
        kt_verified_epoch: f.ktVerified === false ? null : 1,
      })),
      groups: seed.groups.map((g) => ({ group_id: g.groupId, name: g.name, members: ['self'] })),
      conversations: {},
      messages: [],
      reactions: [],
      notes: {},
      noteSearch: {},
      attachments: {},
      blobs: {},
      accounts: {
        active: 'default',
        accounts: [{ id: 'default', label: seed.handle || 'New account', dir: '/fake/accounts/default' }],
      },
      mailbox: [],
      nextQueueId: 1,
      invites: [],
      calls: [],
      log: [],
      unimplemented: [],
      counter: 0,
    };
    // A DM conversation row exists for every friend (the real one is created by
    // `dm_conversation_id_for` or the first message; seeding it matches a device
    // that has already opened them).
    for (const f of s.friends) {
      s.conversations[dmConvId(s.identityPub, f.contact_id)] = { type: 'dm', lastReadTs: 0 };
    }
    for (const g of s.groups) s.conversations[g.group_id] = { type: 'group', lastReadTs: 0 };
    let n = 0;
    for (const m of seed.messages) {
      const friend = s.friends.find((f) => f.contact_id === m.contact);
      if (!friend) continue;
      const ts = m.ts ?? 1_700_000_000_000 + n * 60_000;
      n += 1;
      s.messages.push({
        id: `seed-${fnv(`${m.contact}|${m.text}|${ts}`)}`,
        conversation_id: dmConvId(s.identityPub, friend.contact_id),
        channel_id: null,
        sender_contact_id: m.mine ? 'self' : friend.contact_id,
        relay_ts: ts,
        content: m.text,
        kind: 'text',
        reply_ref_json: null,
        attachments_json: null,
        deleted: false,
        edited_at: null,
      });
    }
    for (const note of seed.notes) {
      s.notes[note.id] = {
        meta: {
          id: note.id,
          title: note.title,
          folder_id: null,
          shared_json: null,
          tags_json: JSON.stringify(note.tags ?? []),
          created: 1_700_000_000_000,
          updated: 1_700_000_000_000,
        },
        ydoc_state: null,
      };
    }
    return s;
  }

  // sessionStorage can be unavailable (about:blank frames); the fake still works
  // in-memory, it just won't survive a reload.
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(STORE_KEY);
  } catch {
    saved = null;
  }
  const state: State = saved ? (JSON.parse(saved) as State) : initial();
  function save(): void {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* in-memory only */
    }
  }
  save();

  // --- event plumbing (callbacks are runtime-only, never persisted) ---------
  const callbacks = new Map<number, { fn: (payload: unknown) => void; once: boolean }>();
  const listeners: { id: number; event: string; handler: number }[] = [];
  let nextCallbackId = 1;
  let nextEventId = 1;

  function emit(event: string, payload: unknown): number {
    let delivered = 0;
    for (const l of [...listeners]) {
      if (l.event !== event) continue;
      const cb = callbacks.get(l.handler);
      if (!cb) continue;
      delivered += 1;
      cb.fn({ event, id: l.id, payload });
      if (cb.once) callbacks.delete(l.handler);
    }
    return delivered;
  }

  // --- guards (same failure modes + strings as the Rust core) ---------------
  function store(): void {
    if (state.status !== 'unlocked') throw 'vault is locked';
  }
  function relay(): void {
    if (!state.relay.connected || !state.relay.fp || !state.relay.baseUrl) {
      throw 'not connected to a relay';
    }
  }
  /** The relay identity anchor (spec/relay.md § Pinning the relay identity):
   *  a caller-supplied fingerprint — an invite's `relayFp`, or the pin — must be
   *  the relay we are. Mirrors the core so a UI that stops passing it fails
   *  here rather than silently losing the anchor. */
  function requireRelayFp(expected: string | null | undefined): void {
    if (expected && expected !== seed.relayFp) {
      throw `RELAY_IDENTITY_CHANGED: expected relay ${expected}, got ${seed.relayFp}`;
    }
  }
  function friendOf(contactId: string): Friend {
    const f = state.friends.find((x) => x.contact_id === contactId);
    if (!f) throw 'not a friend on this relay';
    return f;
  }
  function ensureConversation(id: string, type: string): void {
    if (!state.conversations[id]) state.conversations[id] = { type, lastReadTs: 0 };
  }
  function newId(prefix: string): string {
    state.counter += 1;
    return `${prefix}-${String(state.counter).padStart(4, '0')}`;
  }
  function arg<T>(args: Record<string, unknown>, camel: string, snake: string): T {
    return (camel in args ? args[camel] : args[snake]) as T;
  }
  function lastTsOf(conversationId: string): number {
    let max = 0;
    for (const m of state.messages) {
      if (m.conversation_id === conversationId && m.relay_ts > max) max = m.relay_ts;
    }
    return max;
  }
  function unreadOf(conversationId: string): number {
    const conv = state.conversations[conversationId];
    if (!conv) return 0;
    return state.messages.filter(
      (m) =>
        m.conversation_id === conversationId &&
        m.relay_ts > conv.lastReadTs &&
        !m.deleted &&
        m.sender_contact_id !== 'self',
    ).length;
  }
  /** Append a row the way `import_messages` does: idempotent on message id. */
  function importMessage(row: MessageRow): boolean {
    if (state.messages.some((m) => m.id === row.id)) return false;
    state.messages.push(row);
    return true;
  }
  function tombstone(id: string): void {
    const row = state.messages.find((m) => m.id === id);
    if (row) {
      row.deleted = true;
      row.content = null;
    }
  }
  function applyEdit(id: string, content: string, at: number): void {
    const row = state.messages.find((m) => m.id === id);
    if (row) {
      row.content = content;
      row.edited_at = at;
    }
  }
  function toggleReaction(messageId: string, emoji: string, add: boolean): void {
    const has = state.reactions.some(
      (r) => r.message_id === messageId && r.emoji === emoji && r.reactor_id === 'self',
    );
    if (add && !has) state.reactions.push({ message_id: messageId, emoji, reactor_id: 'self' });
    if (!add) {
      state.reactions = state.reactions.filter(
        (r) => !(r.message_id === messageId && r.emoji === emoji && r.reactor_id === 'self'),
      );
    }
  }

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    // ---- accounts ----
    account_list: () => state.accounts,
    account_switch: (a) => {
      state.accounts.active = arg<string>(a, 'id', 'id');
      return null;
    },
    account_add: () => {
      const id = newId('account');
      state.accounts.accounts.push({ id, label: 'New account', dir: `/fake/accounts/${id}` });
      state.accounts.active = id;
      return null;
    },
    account_set_label: (a) => {
      const active = state.accounts.accounts.find((x) => x.id === state.accounts.active);
      if (active) active.label = arg<string>(a, 'label', 'label');
      return null;
    },

    // ---- vault ----
    vault_status: () => state.status,
    vault_create: (a) => {
      if (state.status !== 'uninitialized') throw 'vault already initialized';
      state.password = arg<string>(a, 'password', 'password');
      state.status = 'unlocked'; // the real `create` opens the store it just made
      return state.recoveryCode;
    },
    vault_unlock_keychain: () => {
      if (state.status === 'unlocked') return null;
      if (state.status === 'uninitialized') throw 'vault not initialized';
      if (!state.keychain) throw 'OS keychain unavailable: vault key does not match metadata';
      state.status = 'unlocked';
      return null;
    },
    vault_unlock: (a) => {
      if (state.status === 'unlocked') return null;
      if (state.status === 'uninitialized') throw 'vault not initialized';
      if (arg<string>(a, 'password', 'password') !== state.password) throw 'wrong password';
      state.status = 'unlocked';
      return null;
    },
    vault_unlock_recovery: (a) => {
      if (state.status === 'unlocked') return null;
      if (state.status === 'uninitialized') throw 'vault not initialized';
      // The core normalizes case + separators before comparing.
      const norm = (v: string) => v.replace(/[^0-9a-z]/gi, '').toUpperCase();
      if (norm(arg<string>(a, 'code', 'code')) !== norm(state.recoveryCode)) throw 'wrong recovery code';
      state.status = 'unlocked';
      return null;
    },
    vault_lock: () => {
      // Drops the master key. The relay session deliberately survives (the core's
      // WS task keeps running), so `relay.connected` is not cleared here.
      state.status = 'locked';
      return null;
    },

    // ---- settings ----
    settings_get: (a) => {
      store();
      const key = arg<string>(a, 'key', 'key');
      return key in state.settings ? state.settings[key] : null;
    },
    settings_set: (a) => {
      store();
      state.settings[arg<string>(a, 'key', 'key')] = arg<string>(a, 'value', 'value');
      return null;
    },

    // ---- relay session ----
    device_public_key: () => {
      store();
      return 'fake-device-public-key';
    },
    relay_status: () => ({
      connected: state.relay.connected,
      base_url: state.relay.baseUrl,
      relay_fp: state.relay.fp,
    }),
    relay_connect: (a) => {
      requireRelayFp(arg<string | null>(a, 'expectRelayFp', 'expect_relay_fp'));
      state.relay.connected = true;
      state.relay.baseUrl = arg<string>(a, 'url', 'url');
      state.relay.fp = seed.relayFp;
      return null;
    },
    relay_register: (a) => {
      requireRelayFp(arg<string | null>(a, 'expectRelayFp', 'expect_relay_fp'));
      store();
      state.relay.connected = true;
      state.relay.baseUrl = arg<string>(a, 'url', 'url');
      state.relay.fp = seed.relayFp;
      return arg<string | null>(a, 'handleChoice', 'handle_choice') || seed.handle || 'Relay#0001';
    },
    relay_register_friend_accept: () => true,
    relay_directory_publish: () => {
      store();
      relay();
      return null;
    },
    relay_register_verifier: () => {
      store();
      relay();
      return state.deliveryToken;
    },
    relay_change_handle: (a) => {
      store();
      relay();
      const handle = arg<string>(a, 'handle', 'handle');
      state.settings['identity.handle'] = handle;
      return handle;
    },
    relay_my_directory_keys: () => {
      store();
      relay();
      return { identity_pub: state.identityPub, sealing_pub: state.sealingPub };
    },
    relay_invite_mint: (a) => {
      store();
      relay();
      const ttl = arg<number | null>(a, 'expiresInSec', 'expires_in_sec') ?? 86_400;
      const expiresAt = Date.now() + ttl * 1000;
      state.invites.push({ tokenHash: arg<string>(a, 'tokenHash', 'token_hash'), expiresAt });
      return expiresAt;
    },
    // Redeeming only drops a sealed friend-accept through the one-shot
    // capability; the friendship lands when the inviter's confirm drains back
    // (simulate that with `deliverFriend`).
    relay_invite_redeem: (a) => {
      store();
      relay();
      requireRelayFp(arg<string | null>(a, 'relayFp', 'relay_fp'));
      return Date.now();
    },
    envelope_seal: () => {
      store();
      return [1, 2, 3];
    },
    envelope_open: () => {
      store();
      throw 'malformed envelope';
    },
    relay_mailbox_fetch: () => {
      store();
      relay();
      return state.mailbox.map((q) => ({ queue_id: q.queue_id, relay_ts: Date.now(), envelope: [] }));
    },
    relay_mailbox_ack: (a) => {
      store();
      const ids = arg<number[]>(a, 'queueIds', 'queue_ids');
      state.mailbox = state.mailbox.filter((q) => !ids.includes(q.queue_id));
      return ids.length;
    },
    // Fetch → open/verify → ingest → ack in one pass, like the real drain.
    relay_mailbox_drain: () => {
      store();
      relay();
      let ingested = 0;
      let friends = 0;
      for (const item of state.mailbox) {
        if (item.kind === 'friend') {
          if (!state.friends.some((f) => f.contact_id === item.friend.contact_id)) {
            state.friends.push(item.friend);
            ensureConversation(dmConvId(state.identityPub, item.friend.contact_id), 'dm');
            friends += 1;
          }
          continue;
        }
        const friend = state.friends.find((f) => f.contact_id === item.from);
        if (!friend) continue; // unverifiable sender — the real core discards it
        const conversationId = dmConvId(state.identityPub, friend.contact_id);
        ensureConversation(conversationId, 'dm');
        const added = importMessage({
          id: item.id,
          conversation_id: conversationId,
          channel_id: null,
          sender_contact_id: friend.contact_id,
          relay_ts: item.ts,
          content: item.text,
          kind: 'text',
          reply_ref_json: null,
          attachments_json: null,
          deleted: false,
          edited_at: null,
        });
        if (added) ingested += 1;
      }
      const acked = state.mailbox.length;
      state.mailbox = [];
      return {
        ingested,
        acked,
        buffered: 0,
        friends,
        calls: [],
        kt_rejected: 0,
        groups_joined: 0,
        group_invites_rejected: 0,
      };
    },

    // ---- friends ----
    friends_list: () => {
      store();
      return state.friends.map((f) => ({
        contact_id: f.contact_id,
        handle: f.handle,
        display_name: f.display_name,
        identity_pub: f.identity_pub,
        kt_verified_epoch: f.kt_verified_epoch,
      }));
    },
    friend_addressing: (a) => {
      store();
      const f = state.friends.find((x) => x.contact_id === arg<string>(a, 'contactId', 'contact_id'));
      if (!f) return null;
      return { handle: f.handle, identity_pub: [1, 2, 3], sealing_pub: [4, 5, 6], delivery_token: f.delivery_token };
    },
    friend_remove: (a) => {
      store();
      const id = arg<string>(a, 'contactId', 'contact_id');
      state.friends = state.friends.filter((f) => f.contact_id !== id);
      return null;
    },

    // ---- DM identity / unread ----
    dm_conversation_id_for: (a) => {
      relay(); // the id is derived from the *per-relay* identity
      store();
      const f = friendOf(arg<string>(a, 'contactId', 'contact_id'));
      const id = dmConvId(state.identityPub, f.contact_id);
      ensureConversation(id, 'dm');
      return id;
    },
    dm_mark_read: (a) => {
      store();
      const id = arg<string>(a, 'conversationId', 'conversation_id');
      const conv = state.conversations[id];
      if (conv) conv.lastReadTs = Math.max(conv.lastReadTs, lastTsOf(id));
      return null;
    },
    dm_unread: (a) => {
      store();
      return unreadOf(arg<string>(a, 'conversationId', 'conversation_id'));
    },
    conversation_activity: () => {
      store();
      return Object.keys(state.conversations)
        .map((id) => ({ conversation_id: id, last_ts: lastTsOf(id), unread: unreadOf(id) }))
        .sort((x, y) => y.last_ts - x.last_ts);
    },
    conversation_reactions: (a) => {
      store();
      const convId = arg<string>(a, 'conversationId', 'conversation_id');
      const ids = new Set(state.messages.filter((m) => m.conversation_id === convId).map((m) => m.id));
      return state.reactions.filter((r) => ids.has(r.message_id));
    },

    // ---- DM send / edit / delete / react ----
    relay_send_message: (a) => {
      relay();
      store();
      const f = friendOf(arg<string>(a, 'contactId', 'contact_id'));
      const conversationId = dmConvId(state.identityPub, f.contact_id);
      ensureConversation(conversationId, 'dm');
      const id = newId('msg');
      importMessage({
        id,
        conversation_id: conversationId,
        channel_id: null,
        sender_contact_id: 'self', // the core tees its own copy with the self marker
        relay_ts: Date.now(),
        content: arg<string>(a, 'content', 'content'),
        kind: 'text',
        reply_ref_json: null,
        attachments_json: arg<string | null>(a, 'attachmentsJson', 'attachments_json') ?? null,
        deleted: false,
        edited_at: null,
      });
      return id;
    },
    relay_delete_message: (a) => {
      relay();
      store();
      friendOf(arg<string>(a, 'contactId', 'contact_id'));
      tombstone(arg<string>(a, 'messageId', 'message_id'));
      return null;
    },
    relay_edit_message: (a) => {
      relay();
      store();
      friendOf(arg<string>(a, 'contactId', 'contact_id'));
      applyEdit(arg<string>(a, 'messageId', 'message_id'), arg<string>(a, 'content', 'content'), Date.now());
      return null;
    },
    relay_react: (a) => {
      relay();
      store();
      friendOf(arg<string>(a, 'contactId', 'contact_id'));
      toggleReaction(arg<string>(a, 'messageId', 'message_id'), arg<string>(a, 'emoji', 'emoji'), arg<boolean>(a, 'add', 'add'));
      return null;
    },

    // ---- groups ----
    group_create: (a) => {
      relay();
      store();
      const id = newId('group');
      state.groups.push({ group_id: id, name: arg<string>(a, 'name', 'name'), members: ['self'] });
      ensureConversation(id, 'group');
      return id;
    },
    group_list: () => {
      store();
      return state.groups.map((g) => ({ group_id: g.group_id, name: g.name }));
    },
    group_add_member: (a) => {
      relay();
      store();
      const g = state.groups.find((x) => x.group_id === arg<string>(a, 'groupId', 'group_id'));
      if (!g) throw 'unknown group';
      const f = friendOf(arg<string>(a, 'contactId', 'contact_id'));
      if (!g.members.includes(f.contact_id)) g.members.push(f.contact_id);
      return null;
    },
    relay_send_group_message: (a) => {
      relay();
      store();
      const groupId = arg<string>(a, 'groupId', 'group_id');
      if (!state.groups.some((g) => g.group_id === groupId)) throw 'unknown group';
      ensureConversation(groupId, 'group');
      const id = newId('msg');
      importMessage({
        id,
        conversation_id: groupId,
        channel_id: null,
        sender_contact_id: 'self',
        relay_ts: Date.now(),
        content: arg<string>(a, 'content', 'content'),
        kind: 'text',
        reply_ref_json: null,
        attachments_json: arg<string | null>(a, 'attachmentsJson', 'attachments_json') ?? null,
        deleted: false,
        edited_at: null,
      });
      return id;
    },
    relay_group_delete_message: (a) => {
      relay();
      store();
      tombstone(arg<string>(a, 'messageId', 'message_id'));
      return null;
    },
    relay_group_edit_message: (a) => {
      relay();
      store();
      applyEdit(arg<string>(a, 'messageId', 'message_id'), arg<string>(a, 'content', 'content'), Date.now());
      return null;
    },
    relay_group_react: (a) => {
      relay();
      store();
      toggleReaction(arg<string>(a, 'messageId', 'message_id'), arg<string>(a, 'emoji', 'emoji'), arg<boolean>(a, 'add', 'add'));
      return null;
    },

    // ---- local log ----
    messages_page: (a) => {
      store();
      const conversationId = arg<string>(a, 'conversationId', 'conversation_id');
      const channelId = arg<string | null>(a, 'channelId', 'channel_id') ?? null;
      const cursorTs = arg<number | null>(a, 'beforeTs', 'before_ts') ?? Number.MAX_SAFE_INTEGER;
      const cursorId = arg<string | null>(a, 'beforeId', 'before_id') ?? '\u{10FFFF}';
      const limit = arg<number>(a, 'limit', 'limit');
      const cmp = (x: string | null, y: string | null) => ((y ?? '') < (x ?? '') ? -1 : (y ?? '') > (x ?? '') ? 1 : 0);
      return state.messages
        .filter((m) => m.conversation_id === conversationId)
        .filter((m) => (channelId === null ? m.channel_id === null : m.channel_id === channelId))
        // (relay_ts, id) < (cursorTs, cursorId) — the core's row-value cursor.
        .filter((m) => m.relay_ts < cursorTs || (m.relay_ts === cursorTs && m.id < cursorId))
        // ORDER BY relay_ts DESC, sender_contact_id DESC, id DESC
        .sort(
          (x, y) =>
            y.relay_ts - x.relay_ts ||
            cmp(x.sender_contact_id, y.sender_contact_id) ||
            cmp(x.id, y.id),
        )
        .slice(0, Math.min(limit, 500));
    },
    messages_ingest: (a) => {
      store();
      let n = 0;
      for (const row of arg<MessageRow[]>(a, 'batch', 'batch')) {
        ensureConversation(row.conversation_id, 'dm');
        if (importMessage({ ...row, deleted: false })) n += 1;
      }
      return n;
    },
    message_edit: (a) => {
      store();
      const row = state.messages.find((m) => m.id === arg<string>(a, 'id', 'id'));
      if (row) {
        row.content = arg<string | null>(a, 'content', 'content');
        row.edited_at = arg<number>(a, 'editedAt', 'edited_at');
      }
      return null;
    },
    message_delete: (a) => {
      store();
      tombstone(arg<string>(a, 'id', 'id'));
      return null;
    },

    // ---- notes ----
    notes_list: () => {
      store();
      return Object.values(state.notes)
        .map((n) => n.meta)
        .sort((x, y) => y.updated - x.updated);
    },
    notes_load_all: () => {
      store();
      return Object.values(state.notes).sort((x, y) => y.meta.updated - x.meta.updated);
    },
    note_get: (a) => {
      store();
      const note = state.notes[arg<string>(a, 'id', 'id')];
      if (!note) throw 'unknown note';
      return note;
    },
    note_create: (a) => {
      store();
      const id = arg<string>(a, 'id', 'id');
      const now = Date.now();
      state.notes[id] = {
        meta: { id, title: '', folder_id: null, shared_json: null, tags_json: null, created: now, updated: now },
        ydoc_state: null,
      };
      return null;
    },
    note_save: (a) => {
      store();
      const id = arg<string>(a, 'id', 'id');
      const existing = state.notes[id];
      const now = Date.now();
      state.notes[id] = {
        meta: {
          id,
          title: arg<string>(a, 'title', 'title'),
          folder_id: existing?.meta.folder_id ?? null,
          shared_json: existing?.meta.shared_json ?? null,
          tags_json: arg<string>(a, 'tagsJson', 'tags_json'),
          created: existing?.meta.created ?? now,
          updated: now,
        },
        ydoc_state: arg<number[]>(a, 'ydocState', 'ydoc_state'),
      };
      state.noteSearch[id] = arg<string>(a, 'searchText', 'search_text');
      return null;
    },
    note_delete: (a) => {
      store();
      const id = arg<string>(a, 'id', 'id');
      delete state.notes[id];
      delete state.noteSearch[id];
      return null;
    },
    notes_search: (a) => {
      store();
      const q = arg<string>(a, 'query', 'query').toLowerCase();
      return Object.values(state.notes)
        .filter(
          (n) =>
            (n.meta.title ?? '').toLowerCase().includes(q) ||
            (state.noteSearch[n.meta.id] ?? '').toLowerCase().includes(q),
        )
        .map((n) => n.meta);
    },

    // ---- attachments / blobs ----
    attachment_upload: (a) => {
      relay();
      store();
      const blobId = newId('blob');
      const bytes = arg<number[]>(a, 'bytes', 'bytes');
      state.blobs[blobId] = bytes;
      return {
        blobId,
        key: 'fake-file-key',
        iv: 'fake-iv',
        mime: arg<string>(a, 'mime', 'mime'),
        name: arg<string>(a, 'name', 'name'),
        size: bytes.length,
      };
    },
    attachment_fetch: (a) => {
      relay();
      store();
      const att = arg<{ blobId: string }>(a, 'attachment', 'attachment');
      const bytes = state.blobs[att.blobId];
      if (!bytes) throw 'attachment not found';
      return bytes;
    },
    attachment_put: (a) => {
      store();
      const meta = arg<Record<string, unknown>>(a, 'meta', 'meta');
      state.attachments[meta.id as string] = { meta, bytes: arg<number[]>(a, 'bytes', 'bytes') };
      return null;
    },
    attachment_get: (a) => {
      store();
      const row = state.attachments[arg<string>(a, 'id', 'id')];
      if (!row) throw 'unknown attachment';
      return { meta: { ...row.meta, state: row.bytes ? 'present' : 'evicted' }, bytes: row.bytes };
    },
    attachment_has: (a) => {
      store();
      return arg<string>(a, 'id', 'id') in state.attachments;
    },
    attachment_evict: (a) => {
      store();
      const row = state.attachments[arg<string>(a, 'id', 'id')];
      if (row) row.bytes = null;
      return null;
    },

    // ---- key transparency ----
    kt_self_audit: () => {
      relay();
      return { ok: true, reason: null, epoch: 1 };
    },
    // Re-verification sweep over contacts recorded without a log proof. This
    // fake relay is honest, so nothing is pending.
    kt_verify_contacts: () => {
      relay();
      store();
      return { verified: 0, unverified: 0, rejected: 0 };
    },
    kt_gossip_send: () => {
      relay();
      store();
      return null;
    },

    // ---- voice (control plane only; this layer carries no media) ----
    relay_call_offer: (a) => {
      relay();
      store();
      const contactId = arg<string>(a, 'contactId', 'contact_id');
      friendOf(contactId);
      const call = { callId: newId('call'), mediaKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', contactId };
      state.calls.push(call);
      return { callId: call.callId, mediaKey: call.mediaKey };
    },
    voice_join: () => null,
    voice_signal: () => null,
    voice_leave: () => null,

    // ---- emoji ----
    emote_search: () => ({ results: [], next: null }),
    emote_get: () => {
      throw 'unknown emote';
    },
    emote_cached_list: () => {
      store();
      return [];
    },
  };

  function handle(cmd: string, args: Record<string, unknown>): unknown {
    if (cmd === 'plugin:event|listen') {
      const id = nextEventId++;
      listeners.push({ id, event: args.event as string, handler: args.handler as number });
      return id;
    }
    if (cmd === 'plugin:event|unlisten') {
      const at = listeners.findIndex((l) => l.id === (args.eventId as number));
      if (at >= 0) listeners.splice(at, 1);
      return null;
    }
    if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
      emit(args.event as string, args.payload);
      return null;
    }
    const fn = commands[cmd];
    if (!fn) {
      state.unimplemented.push(cmd);
      throw `fake core: unimplemented command ${cmd}`;
    }
    return fn(args);
  }

  const internals = {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      state.log.push(cmd);
      return new Promise((resolve, reject) => {
        let out: unknown;
        try {
          out = handle(cmd, args ?? {});
        } catch (e) {
          save();
          // Tauri rejects with the command's error value (a plain string for
          // `Result<_, String>`), which the UI renders via `String(e)`.
          reject(e);
          return;
        }
        save();
        resolve(out ?? null);
      });
    },
    transformCallback(callback: (payload: unknown) => void, once = false): number {
      const id = nextCallbackId++;
      callbacks.set(id, { fn: callback, once });
      return id;
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },
    convertFileSrc(path: string, protocol = 'asset'): string {
      return `${protocol}://localhost/${encodeURIComponent(path)}`;
    },
  };

  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals, configurable: true });
  // `unlisten()` from `@tauri-apps/api/event` calls this *before* the
  // `plugin:event|unlisten` command; without it, every teardown path (lock,
  // sign-out, unmount) throws instead of unsubscribing.
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    value: {
      unregisterListener(event: string, eventId: number): void {
        const at = listeners.findIndex((l) => l.id === eventId && l.event === event);
        if (at >= 0) {
          callbacks.delete(listeners[at]!.handler);
          listeners.splice(at, 1);
        }
      },
    },
    configurable: true,
  });
  // `isTauri()` reads `(globalThis || window).isTauri`.
  (globalThis as unknown as { isTauri: boolean }).isTauri = true;

  // Test-side control surface. App code never touches this.
  (window as unknown as { __fakeCore: unknown }).__fakeCore = {
    /** JSON snapshot of the core's state (debugging). */
    snapshot: () => JSON.parse(JSON.stringify(state)) as State,
    /** Commands the UI called that the fake does not implement. */
    unimplemented: () => [...new Set(state.unimplemented)],
    /** Every command the UI has invoked, in order. */
    calls: () => [...state.log],
    /** Push a Tauri event at the UI (`relay:mail`, `kt:alarm`, `voice:frame`). */
    emit: (event: string, payload: unknown) => emit(event, payload),
    /** Queue an inbound message and nudge the app, like the relay's live wake. */
    deliverMessage: (from: string, text: string) => {
      state.counter += 1;
      state.mailbox.push({
        queue_id: state.nextQueueId++,
        kind: 'msg',
        from,
        text,
        ts: Date.now(),
        id: `in-${state.counter}`,
      });
      save();
      emit('relay:mail', {});
    },
    /** Queue a completed friend handshake and nudge the app. */
    deliverFriend: (contactId: string, handle: string, displayName: string | null) => {
      state.mailbox.push({
        queue_id: state.nextQueueId++,
        kind: 'friend',
        friend: {
          contact_id: contactId,
          handle,
          display_name: displayName,
          identity_pub: contactId,
          sealing_pub: `${contactId}-sealing`,
          delivery_token: `${contactId}-token`,
          // The real drain verifies the sender's key against the log before
          // recording; this fake relay is honest, so the proof lands too.
          kt_verified_epoch: 1,
        },
      });
      save();
      emit('relay:mail', {});
    },
  };
}

export interface InstallOptions {
  /** Expand the side rail so conversation titles render as text (default true). */
  expandRail?: boolean;
}

/** Install the fake before any app script runs. Call before `page.goto`. */
export async function installFakeCore(
  page: Page,
  seed: FakeSeed,
  options: InstallOptions = {},
): Promise<void> {
  if (options.expandRail !== false) {
    await page.addInitScript(() => localStorage.setItem('sidebar-expanded', '1'));
  }
  await page.addInitScript(fakeCoreScript, seed);
}

interface FakeCoreHandle {
  snapshot(): unknown;
  unimplemented(): string[];
  calls(): string[];
  emit(event: string, payload: unknown): number;
  deliverMessage(from: string, text: string): void;
  deliverFriend(contactId: string, handle: string, displayName: string | null): void;
}

/** Commands the UI invoked that the fake has no implementation for. A non-empty
 *  list means the harness has drifted from the app, not that the app is broken. */
export function unimplementedCommands(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __fakeCore?: FakeCoreHandle }).__fakeCore?.unimplemented() ?? [],
  );
}

/** Simulate live delivery: queue an inbound message and fire `relay:mail`. */
export function deliverInbound(page: Page, from: string, text: string): Promise<void> {
  return page.evaluate(
    ([f, t]) => (window as unknown as { __fakeCore: FakeCoreHandle }).__fakeCore.deliverMessage(f!, t!),
    [from, text],
  );
}

/** Simulate a completed friend handshake arriving in the mailbox. */
export function deliverFriend(
  page: Page,
  friend: { contactId: string; handle: string; displayName?: string | null },
): Promise<void> {
  return page.evaluate(
    ([id, handle, displayName]) =>
      (window as unknown as { __fakeCore: FakeCoreHandle }).__fakeCore.deliverFriend(
        id!,
        handle!,
        displayName ?? null,
      ),
    [friend.contactId, friend.handle, friend.displayName ?? null],
  );
}
