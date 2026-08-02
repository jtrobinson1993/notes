// Native-shell live inbound delivery (spec/relay.md § live delivery; D6/D11).
//
// Completes the live-delivery loop on the client: the Rust core holds the relay
// WebSocket and emits a content-free `relay:mail` Tauri event on each nudge;
// here we listen for it and run the idempotent mailbox drain
// (`relayMailboxDrain` → fetch/open/verify/decode/ingest/ack in the core). We
// also drain once on connect to catch anything queued while offline.
//
// This durably *captures* inbound v8 messages into the local log. Live
// *rendering* of drained rows is intentionally decoupled (see `onIngested`):
// the chat store still orders by legacy `seq`, and v8 rows are keyed by
// `(relay_ts, id)` — surfacing them live waits on the v8 chat store model.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isNative,
  relayConnect,
  relayDirectoryPublish,
  relayMailboxDrain,
  relayRegisterVerifier,
  relayStatus,
  settingsGet,
  settingsSet,
  type DrainReport,
} from './native';
import { toastError } from './toast';
import { toastCoreError } from './nativeErrors';

/** Device-only setting: the relay URL to reconnect to on a later boot. In the
 *  native shell `window.location.origin` is `tauri://…`, not the relay, so the
 *  URL is captured here at connect time and read back on unlock. */
const RELAY_URL_KEY = 'relay.url';

/** Persist the relay URL so a future cold start can reconnect. Call right after
 *  a successful `relayConnect` (vault is unlocked then, so settings are writable). */
export async function rememberRelayUrl(url: string): Promise<void> {
  if (!isNative) return;
  await settingsSet(RELAY_URL_KEY, url);
}

const ingestedListeners = new Set<(report: DrainReport) => void>();

/** Subscribe to drains that stored new rows — the seam views (the chat store,
 *  the native DM surface) use to refresh live. Returns an unsubscribe fn.
 *  Multiple subscribers are fanned out. */
export function onMailIngested(cb: (report: DrainReport) => void): () => void {
  ingestedListeners.add(cb);
  return () => {
    ingestedListeners.delete(cb);
  };
}

const connectedListeners = new Set<() => void>();

/**
 * Fires once the relay session is live (after a cold-start redial, or a later
 * reconnect).
 *
 * This exists because the vault gate opens *before* the redial finishes: the
 * gate sets `ready`, the watcher on that state loads the conversation rail, and
 * the rail needs the relay fingerprint to derive DM conversation ids. It lost
 * that race every cold launch — the refresh chain is two IPCs deep and the
 * redial three, so it is an ordering bug, not a timing one — and nothing
 * retried, because drains only notify when they actually ingest something. The
 * rail then stayed empty until mail arrived, despite every conversation already
 * being in the local store.
 */
export function onRelayConnected(cb: () => void): () => void {
  connectedListeners.add(cb);
  return () => {
    connectedListeners.delete(cb);
  };
}

// Single-flight with coalescing: a nudge arriving mid-drain schedules exactly
// one more pass (never a re-entrant drain, never a lost nudge — JS is
// single-threaded, so `rerun`/`draining` only change at the awaits below).
let draining = false;
let rerun = false;

/** Run the mailbox drain now; safe to call concurrently (calls coalesce). */
export async function drainMailbox(): Promise<void> {
  if (!isNative) return;
  if (draining) {
    rerun = true;
    return;
  }
  draining = true;
  try {
    do {
      rerun = false;
      const report = await relayMailboxDrain();
      // The core refused a friend handshake because the relay's transparency
      // log publishes a different key for that handle. It already raised the
      // hard KT alarm; toast the catalogued code too, so the user gets the
      // explanation and a lookup URL rather than only a banner.
      if ((report.kt_rejected ?? 0) > 0) toastError('KT_CONTACT_KEY_MISMATCH');
      // A group-invite the core would not act on. Silence here would be wrong
      // in both directions: a friend who added you would look like they never
      // did, and a re-key attempt on a group you're in — the serious case —
      // would leave only a banner with no explanation to look up.
      if ((report.group_invites_rejected ?? 0) > 0) toastError('GROUP_INVITE_REFUSED');
      if (report.ingested > 0) for (const l of ingestedListeners) l(report);
    } while (rerun);
  } catch {
    // Best-effort: the REST path stays authoritative, and the next nudge,
    // reconnect, or startup drain retries. A dropped drain never loses mail
    // (hold-until-ack keeps unacked envelopes queued).
  } finally {
    draining = false;
  }
}

let unlisten: UnlistenFn | null = null;

/** Start live delivery: subscribe to `relay:mail` (once) and drain any backlog.
 *  Call after a relay connection is established. Idempotent. */
export async function startRelayDelivery(): Promise<void> {
  if (!isNative) return;
  if (!unlisten) {
    unlisten = await listen('relay:mail', () => void drainMailbox());
  }
  await drainMailbox();
}

/** Tear down the listener (e.g. on relay switch / sign-out). */
export function stopRelayDelivery(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}

/**
 * Reconnect to the remembered relay and (re)start live delivery. Called after
 * the vault unlocks — the relay session lives only in this process, so a cold
 * start has to redial before nudges/drains can flow. Requires the vault
 * unlocked because the drain opens envelopes with the MK-derived sealing key.
 * Idempotent + best-effort: skips the redial if already connected, and a failed
 * connect just leaves delivery off until the next unlock.
 */
export async function reconnectRelay(): Promise<void> {
  if (!isNative) return;
  try {
    const status = await relayStatus();
    if (!status.connected) {
      const url = await settingsGet(RELAY_URL_KEY);
      if (!url) return; // never connected a relay on this device yet
      try {
        await relayConnect(url);
      } catch (e) {
        // The core holds this relay to the identity pinned on the first
        // connect. A refusal there is the whole point of that pin, so it must
        // not join the "offline / relay down" silence below: toast it and leave
        // delivery off. Anything else falls through to that silence.
        if (toastCoreError(e)) return;
        throw e;
      }
    }
    // Self-heal: (re)publish our directory entry + sealed-sender verifier
    // (idempotent). Onboarding does this too, but a partial onboarding — e.g. a
    // verifier step that failed after register — completes here on reconnect, so
    // an account can't stay half-published.
    try {
      await relayDirectoryPublish();
      await relayRegisterVerifier();
    } catch {
      // Best-effort; the next connect retries. Never blocks live delivery.
    }
    await startRelayDelivery();
    // The session is live now. Anything that needed the relay to render (the
    // conversation rail derives DM ids from the relay fingerprint) gets its
    // second chance here rather than waiting for mail to arrive.
    for (const cb of connectedListeners) {
      try {
        cb();
      } catch {
        // A listener must never break delivery startup.
      }
    }
  } catch {
    // Offline / relay down / not yet enrolled — leave delivery off; the next
    // unlock retries. Never throws into the unlock path.
  }
}
