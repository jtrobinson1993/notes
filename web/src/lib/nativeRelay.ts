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
import { isNative, relayMailboxDrain, type DrainReport } from './native';

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
