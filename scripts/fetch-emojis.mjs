#!/usr/bin/env node
// Fetch the top N emotes from 7TV's public API, download each as a small
// (64px) WebP, and write them + a manifest into the web app. 7TV's 2x WebP is
// already aggressively optimized (a few KB each), so no re-encoding is needed.
//
// Output (committed, per the v3.1 decision to self-host the default set):
//   web/public/emoji/7tv/<name>.webp     — the assets, served at /emoji/7tv/…
//   web/src/lib/emoji/defaultEmoji.json  — [{ name, file, w, h, animated }]
//
// Re-run to refresh the set:  node scripts/fetch-emojis.mjs [count]
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COUNT = Number(process.argv[2] ?? 300);
const PAGE_SIZE = 100;
const GQL = 'https://7tv.io/v3/gql';
// Shortcode-safe names only (rendered as :name: in messages).
const NAME_RE = /^[A-Za-z0-9_]{2,40}$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = join(root, 'web', 'public', 'emoji', '7tv');
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
  await rm(assetDir, { recursive: true, force: true });
  await mkdir(assetDir, { recursive: true });
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
      // Prefer the crisp 2x WebP, but fall back to 1x for heavy (usually
      // animated) emotes, and skip anything still too large — keeps the
      // committed set lean.
      const pick2x = e.host?.files?.find((f) => f.name === '2x.webp');
      const pick1x = e.host?.files?.find((f) => f.name === '1x.webp');
      const candidates = [pick2x, pick1x].filter(Boolean);
      if (!candidates.length) continue;
      try {
        let chosen = null;
        let buf = null;
        for (const file of candidates) {
          const r = await fetch(`https://cdn.7tv.app/emote/${e.id}/${file.name}`);
          if (!r.ok) continue;
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length === 0) continue;
          chosen = file;
          buf = b;
          if (b.length <= 24 * 1024) break; // small enough; stop at 2x
        }
        if (!chosen || !buf || buf.length > 48 * 1024) continue; // skip oversize
        // Filename by emote id (not name): avoids collisions on case-insensitive
        // filesystems between names that differ only in case.
        const fname = `${e.id}.webp`;
        await writeFile(join(assetDir, fname), buf);
        manifest.push({ name: e.name, file: fname, w: chosen.width, h: chosen.height, animated: !!e.animated });
        seen.add(e.name);
      } catch {
        /* skip a single failed download */
      }
    }
    process.stdout.write(`\rcollected ${manifest.length}/${COUNT}`);
  }
  // Keep 7TV's popularity order (most-used first) — do NOT alphabetize, so the
  // picker defaults to the top emotes. Search filters by name at render time.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 0) + '\n');
  process.stdout.write(`\ndone: ${manifest.length} emotes -> ${assetDir}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
