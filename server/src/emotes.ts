// 7TV emote proxy: search + image.
//
// Both halves exist so the CLIENT'S IP never reaches 7TV — the relay is the only
// thing that talks to 7tv.io / cdn.7tv.app. Images are cached on disk and served
// from our own origin (also keeps them offline-usable and service-worker
// cacheable), so a given emote is fetched upstream at most once per relay.
//
// This replaces the old fixed-manifest design (a committed defaultEmoji.json of
// ~300 ids refreshed by scripts/fetch-emojis.mjs): the relay now proxies live
// 7TV search, so the client picks from the whole catalogue instead of a snapshot.

import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** 7TV emote ids are 26-char Crockford ULIDs. Only these may be proxied, and
 *  only from 7TV's CDN, so this can never become an open proxy — and the id can
 *  never escape the cache directory. */
export const EMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const EMOTE_FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.webp$/;

const CDN = (id: string) => `https://cdn.7tv.app/emote/${id}/2x.webp`;
const GQL = 'https://7tv.io/v3/gql';
const IMAGE_TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 1024 * 1024; // emote WebPs are a few KB; 1 MB is generous.
/** Soft ceiling on cached emote files; the oldest are evicted past it so a
 *  client that walks the 7TV catalogue can't fill the relay's disk. */
const MAX_CACHE_ENTRIES = 4000;
const PRUNE_EVERY_WRITES = 50;

// Shortcode-safe names only (rendered as :name: in messages).
const NAME_RE = /^[A-Za-z0-9_]{2,40}$/;
export const MAX_EMOTE_QUERY = 100;
export const MAX_EMOTE_LIMIT = 100;

/** One 7TV emote as the relay reports it (the image URL is added by the route,
 *  which is the only thing that can mint the capability path). */
export interface Emote {
  id: string;
  name: string;
  width: number;
  height: number;
  animated: boolean;
}

const QUERY = `query SearchEmotes($query: String!, $page: Int, $limit: Int, $filter: EmoteSearchFilter) {
  emotes(query: $query, page: $page, limit: $limit, filter: $filter) {
    items { id name animated host { files { name format width height } } }
  }
}`;

interface GqlFile {
  name?: string;
  format?: string;
  width?: number;
  height?: number;
}
interface GqlItem {
  id?: string;
  name?: string;
  animated?: boolean;
  host?: { files?: GqlFile[] };
}

/** Search 7TV. An empty query returns the current top emotes, which is what
 *  the picker shows by default (the replacement for the old fixed set). */
export async function searchEmotes(query: string, page: number, limit: number): Promise<Emote[]> {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    body: JSON.stringify({
      operationName: 'SearchEmotes',
      query: QUERY,
      variables: {
        query,
        page,
        limit,
        filter: {
          // TOP orders by popularity; with an empty query that yields the
          // default picker set, with a query it ranks the matches.
          category: 'TOP',
          exact_match: false,
          case_sensitive: false,
          ignore_tags: false,
          zero_width: false,
          aspect_ratio: '',
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`7tv gql ${res.status}`);
  const json = (await res.json()) as { data?: { emotes?: { items?: GqlItem[] } }; errors?: unknown };
  if (json.errors) throw new Error('7tv gql error');
  const items = json.data?.emotes?.items ?? [];
  const out: Emote[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const id = it?.id;
    const name = it?.name;
    if (typeof id !== 'string' || !EMOTE_ID_RE.test(id)) continue;
    if (typeof name !== 'string' || !NAME_RE.test(name) || seen.has(name)) continue;
    const files = it.host?.files ?? [];
    const file = files.find((f) => f?.name === '2x.webp') ?? files.find((f) => f?.name === '1x.webp');
    if (!file || typeof file.width !== 'number' || typeof file.height !== 'number') continue;
    seen.add(name);
    out.push({ id, name, width: file.width, height: file.height, animated: !!it.animated });
  }
  return out;
}

/** Contain the emote id inside the cache dir. The ULID allowlist already
 *  forbids separators; this is defense-in-depth and the explicit barrier a
 *  path-injection analyzer needs. */
export function emoteCachePath(cacheDir: string, id: string): string | null {
  if (!EMOTE_ID_RE.test(id)) return null;
  const root = resolve(cacheDir);
  const path = resolve(root, `${id}.webp`);
  return path === join(root, `${id}.webp`) && path.startsWith(root + sep) ? path : null;
}

let writesSincePrune = 0;

/** Evict the oldest cached files once the directory exceeds the soft ceiling. */
async function pruneCache(cacheDir: string): Promise<void> {
  writesSincePrune = 0;
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  if (names.length <= MAX_CACHE_ENTRIES) return;
  const entries: { path: string; mtime: number }[] = [];
  for (const n of names) {
    const p = join(cacheDir, n);
    try {
      entries.push({ path: p, mtime: (await stat(p)).mtimeMs });
    } catch {
      /* raced with another eviction */
    }
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  const target = Math.floor(MAX_CACHE_ENTRIES * 0.9);
  for (const e of entries.slice(0, Math.max(0, entries.length - target))) {
    await unlink(e.path).catch(() => {});
  }
}

export type EmoteImageOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid-id' | 'fetch-failed' | 'unavailable' | 'not-an-image' | 'too-large' };

/** Return the on-disk path for an emote image, fetching + caching it on a miss. */
export async function ensureEmoteCached(cacheDir: string, id: string): Promise<EmoteImageOutcome> {
  const path = emoteCachePath(cacheDir, id);
  if (!path) return { ok: false, reason: 'invalid-id' };

  try {
    await stat(path);
    return { ok: true, path };
  } catch {
    /* cache miss → fetch below */
  }

  let res: Response;
  try {
    res = await fetch(CDN(id), { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
  if (!res.ok) return { ok: false, reason: 'unavailable' };
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) {
    return { ok: false, reason: 'not-an-image' };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, buf);
  if (++writesSincePrune >= PRUNE_EVERY_WRITES) await pruneCache(cacheDir);
  return { ok: true, path };
}

export function emoteStream(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}
