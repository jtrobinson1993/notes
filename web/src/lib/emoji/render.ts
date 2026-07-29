// The content-emoji policy layer: the *only* place in the app that turns a
// `:shortcode:` seen in content into image bytes, and therefore the only writer
// to the on-device emoji cache (`emote_get` caches on the way through).
//
// Everything here exists because content is attacker-controlled. A message body
// is written by whoever sent it, so "render every emote you see" is a remote
// trigger for unbounded work on this device *and* on the relay:
//
//   * disk is bounded by the core's byte budget (spec/local-store.md), but
//   * the *fetch* is not — 500 distinct emote refs in one message would make
//     every recipient issue 500 relay requests. The core cannot stop that: it
//     has no idea which message a call came from. So the cap lives here, keyed
//     by message, in module state that outlives any component.
//
// Consequences that are deliberate, not incidental:
//   - budget is charged only for work that touched the network (`fetched`), so
//     an emote already in the cache renders free, offline, forever;
//   - a charge is never refunded on failure, so a message cannot retry its way
//     past the cap by being re-rendered;
//   - the state is per *message id*, not per component, so scrolling a message
//     out of view and back cannot buy it a fresh budget.
import { ref } from 'vue';
import { emoteGet, emoteSearch } from '../native';
import { emoteIdFor, registerEmote, resolveEmoji, SHORTCODE_RE } from './index';

/** Distinct emotes one message may pull over the network, ever. Chosen to be
 *  comfortably above real usage (a dense emote message runs to a handful) and
 *  far below anything that is useful as an amplifier. */
export const PER_MESSAGE_EMOTE_CAP = 20;

/** Hits to consider when resolving a shortcode to a 7TV id. Small: we only
 *  accept an exact name match, so a long list buys nothing. */
const LOOKUP_LIMIT = 20;

interface ScopeBudget {
  /** Names this message has been allowed to resolve. */
  admitted: Set<string>;
  /** Network-touching resolutions charged to this message. Never decreases
   *  except when a resolution turned out to need no network at all. */
  spent: number;
}

// Keyed by message/note id, and deliberately **not** evicted: an LRU here would
// hand a re-viewed message a fresh budget, which is precisely the bypass the cap
// exists to close. An entry is created only for content that actually contains a
// shortcode, holds at most 20 short names, and the whole map dies on lock.
const scopes = new Map<string, ScopeBudget>();
const objectUrls = new Set<string>();
const inflight = new Map<string, Promise<Resolution>>();

/** Bumped whenever an emote becomes renderable, so the (non-reactive) registry
 *  can still drive a Vue render. */
export const emoteVersion = ref(0);

interface Resolution {
  url: string | null;
  /** True when resolving this name went to the relay (search and/or image). */
  networked: boolean;
}

function budget(scope: string): ScopeBudget {
  let s = scopes.get(scope);
  if (!s) {
    s = { admitted: new Set(), spent: 0 };
    scopes.set(scope, s);
  }
  return s;
}

/** Every distinct shortcode name in a string, in first-seen order. */
export function shortcodeNames(text: string): string[] {
  const re = new RegExp(SHORTCODE_RE.source, 'g');
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) seen.add(m[1]!);
  return [...seen];
}

async function fetchEmote(name: string, knownId?: string): Promise<Resolution> {
  // `networked` is raised BEFORE each await, never after. The thing being
  // rationed is the *request*, so a request that fails must still be charged.
  // Setting it afterwards meant any relay rejection (429, 5xx, offline) returned
  // `networked: false`, the caller refunded the slot and un-admitted the name,
  // and the cap could be bypassed without limit — amplifying hardest exactly
  // when the relay was already failing.
  let networked = false;
  try {
    let id = knownId ?? emoteIdFor(name);
    if (!id) {
      // The only name → id oracle a client has is the relay's proxied search.
      // Accept an **exact** name match only: a fuzzy hit would let the relay
      // decide which image a given shortcode shows.
      networked = true;
      const res = await emoteSearch(name, 1, LOOKUP_LIMIT);
      const hit =
        res.results.find((r) => r.name === name) ??
        res.results.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (!hit) return { url: null, networked };
      id = hit.id;
    }
    const searched = networked;
    // Assume the image fetch touches the relay until it reports otherwise; if it
    // throws we cannot know, and the safe assumption is that it did.
    networked = true;
    const img = await emoteGet(id, name);
    networked = searched || img.fetched;
    const url = URL.createObjectURL(new Blob([new Uint8Array(img.bytes)], { type: img.mime ?? 'image/webp' }));
    if (!registerEmote(name, url, id)) {
      URL.revokeObjectURL(url); // unreachable today (blob: is always allowed)
      return { url: null, networked };
    }
    objectUrls.add(url);
    emoteVersion.value += 1;
    return { url, networked };
  } catch {
    // A failed resolution renders as literal `:shortcode:` text — never a
    // toast: content is bulk, and one unreachable emote is not an app error.
    return { url: null, networked };
  }
}

/**
 * Resolve a shortcode seen in content, charging the message's fetch budget.
 *
 * `scope` is the message (or note) id the shortcode was found in. Returns the
 * renderable URL, or null when the emote is unknown, unreachable, or the
 * message has spent its budget — all of which render as literal text.
 */
export async function contentEmoteUrl(name: string, scope: string): Promise<string | null> {
  // Already renderable: no relay, no budget. This is the offline path, and the
  // reason a re-render of a capped message costs nothing.
  const known = resolveEmoji(name);
  if (known) return known;

  const s = budget(scope);
  const pending = inflight.get(name);
  if (s.admitted.has(name)) return pending ? (await pending).url : null;
  if (s.spent >= PER_MESSAGE_EMOTE_CAP) return null;

  // Reserve *before* awaiting: concurrent renders of one message must not all
  // sail through the check and then each spend.
  s.spent += 1;
  s.admitted.add(name);

  const work = pending ?? start(name);
  const res = await work;
  if (!res.networked) s.spent -= 1; // a pure cache hit is not amplification
  if (!res.url) s.admitted.delete(name); // may retry, still capped by `spent`
  return res.url;
}

function start(name: string, knownId?: string): Promise<Resolution> {
  const p = fetchEmote(name, knownId).finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

/**
 * Make an emote the core says it *already holds* renderable — the offline
 * picker's path, and the only emote resolution outside content rendering.
 *
 * No message budget is charged because there is no message: the input is
 * `emote_cached_list()`, i.e. entries the core has on disk, so this cannot pull
 * anything new into the cache. (If an entry is evicted between the list and the
 * read, `emote_get` re-fetches that one emote — an emote this device already
 * had, never a new one, and offline it simply fails and renders as text.)
 */
export async function cachedEmoteUrl(id: string, name: string): Promise<string | null> {
  const known = resolveEmoji(name);
  if (known) return known;
  const pending = inflight.get(name);
  if (pending) return (await pending).url;
  return (await start(name, id)).url;
}

/** Test/diagnostic view of a message's spent fetch budget. */
export function emoteBudgetSpent(scope: string): number {
  return scopes.get(scope)?.spent ?? 0;
}

/** Drop every per-message budget and revoke the blob URLs the renderer minted.
 *  Called on lock/account switch alongside `clearEmotes()`. */
export function resetEmoteRender(): void {
  scopes.clear();
  inflight.clear();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  emoteVersion.value += 1;
}
