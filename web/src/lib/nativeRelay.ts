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
  relayMailboxDrain,
  relayStatus,
  settingsGet,
  settingsSet,
  type DrainReport,
} from './native';

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

let onIngested: (report: DrainReport) => void = () => {};

/** Register a hook fired after a drain that stored new rows — the seam the v8
 *  chat store will use to refresh live. Replaces any previous hook. */
export function setOnMailIngested(cb: (report: DrainReport) => void): void {
  onIngested = cb;
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
      if (report.ingested > 0) onIngested(report);
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
      await relayConnect(url);
    }
    await startRelayDelivery();
  } catch {
    // Offline / relay down / not yet enrolled — leave delivery off; the next
    // unlock retries. Never throws into the unlock path.
  }
}
