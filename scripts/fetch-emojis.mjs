#!/usr/bin/env node
// Refresh the default emote SET (metadata only) from 7TV's public API. The
// images themselves are no longer committed — the server fetches each one from
// 7TV's CDN on first request and caches it (server/routes/emoji.ts), serving it
// from our own origin. So this only writes the manifest of names → 7TV ids.
//
// Output:
//   web/src/lib/emoji/defaultEmoji.json  — [{ name, file, w, h, animated }]
//   where `file` is `<7TV-id>.webp` (the server proxy key).
//
// Re-run to refresh the set:  node scripts/fetch-emojis.mjs [count]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COUNT = Number(process.argv[2] ?? 300);
const PAGE_SIZE = 100;
const GQL = 'https://7tv.io/v3/gql';
// Shortcode-safe names only (rendered as :name: in messages).
const NAME_RE = /^[A-Za-z0-9_]{2,40}$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'web', 'src', 'lib', 'emoji', 'defaultEmoji.json');

const QUERY = `query SearchEmotes($query: String!, $page: Int, $limit: Int, $filter: EmoteSearchFilter) {
  emotes(query: $query, page: $page, limit: $limit, filter: $filter) {
    items { id name animated host { files { name format width height } } }
  }
}`;

async function fetchPage(page) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'SearchEmotes',
      query: QUERY,
      variables: {
        query: '',
        page,
        limit: PAGE_SIZE,
        filter: { category: 'TOP', exact_match: false, case_sensitive: false, ignore_tags: false, zero_width: false, aspect_ratio: '' },
      },
    }),
  });
  if (!res.ok) throw new Error(`7TV gql ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`7TV gql: ${JSON.stringify(json.errors)}`);
  return json.data?.emotes?.items ?? [];
}

async function main() {
  await mkdir(dirname(manifestPath), { recursive: true });

  const manifest = [];
  const seen = new Set();
  let page = 1;
  while (manifest.length < COUNT && page <= Math.ceil((COUNT * 3) / PAGE_SIZE) + 5) {
    const items = await fetchPage(page++);
    if (!items.length) break;
    for (const e of items) {
      if (manifest.length >= COUNT) break;
      if (!NAME_RE.test(e.name) || seen.has(e.name)) continue;
      // Use the 2x WebP's dimensions (fall back to 1x). The server proxy always
      // serves the 2x WebP keyed by emote id, so only metadata is needed here.
      const file = e.host?.files?.find((f) => f.name === '2x.webp') ?? e.host?.files?.find((f) => f.name === '1x.webp');
      if (!file) continue;
      manifest.push({ name: e.name, file: `${e.id}.webp`, w: file.width, h: file.height, animated: !!e.animated });
      seen.add(e.name);
    }
    process.stdout.write(`\rcollected ${manifest.length}/${COUNT}`);
  }
  // Keep 7TV's popularity order (most-used first) — do NOT alphabetize, so the
  // picker defaults to the top emotes. Search filters by name at render time.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 0) + '\n');
  process.stdout.write(`\ndone: ${manifest.length} emotes -> ${manifestPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
