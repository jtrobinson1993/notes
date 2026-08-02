# `web/dev/` — editor harness

A standalone mount of the real `<MarkdownEditor>` (CodeMirror + the live-preview
plugin and all editor keymaps) with **no app auth, router, or Pinia stores**.
Use it to develop and verify caret / keymap / live-preview behaviour in
isolation — both by hand in a browser and automated via Playwright.

Dev-server only: the page is served by Vite at dev time and is **not** part of
the production build (nothing references it from `index.html`), and `web/dev/`
is outside the typed build (`web/tsconfig.json`).

## Why it exists

The editor conceals Markdown markers as **atomic** ranges, so the caret skips
over invisible syntax. Visual caret motion (`cursorCharLeft`, clicks) across
those concealed widgets depends on real layout geometry. **jsdom has no layout**,
so Vitest can't reproduce those cases — a unit test can pass while the real
browser misbehaves. This harness runs the editor in a real browser so caret
behaviour can actually be observed and asserted.

## Manual use

```sh
npm run dev:web        # serves http://localhost:5173
```

Open <http://localhost:5173/dev/editor-harness.html>. You get the editor plus:

- a **mode** switch (`live` / `source`) and a **composer** toggle
  (submit-on-enter), and
- a live **readout** of the document text and the current caret/anchor offsets —
  the offset is the thing you can't see in a WYSIWYG editor.

> HMR caveat: the editor builds its keymap once in `onMounted`, so editing editor
> source updates the module but **not** the already-mounted CodeMirror instance.
> After changing a keymap/command, do a **full page reload** (the toggles also
> force a remount via `:key`).

## Browser console / Playwright API

The harness exposes helpers on `window`:

| Helper | Purpose |
| --- | --- |
| `window.__doc()` | current document text |
| `window.__caret()` | main selection head offset (the caret), or `-1` |
| `window.__setDoc(text, caret?)` | replace the doc, optionally place the caret, then focus |

## Automated driving (Playwright)

`editor-probe.mjs` opens the harness in Chromium and prints the caret offset
after each key press. With the dev server running:

```sh
node web/dev/editor-probe.mjs
```

Example output (ArrowLeft jumping in front of a concealed list marker, then
Backspace deleting the blank line above while keeping the list):

```
{"doc":"\n- item","caret":3,"key":"ArrowLeft","start":3,"heads":[1,0,0,0], ...}
Backspace-after-ArrowLeft → "- item"
```

Edit the `SCENARIOS` array, or `import { openHarness } from './editor-probe.mjs'`
in your own script and call `probe({ doc, caret, key, presses })`.

## `csp-probe.mjs` — the webview Content-Security-Policy

Not an editor tool, but it lives here for the same reason: it needs a real
browser. The native shell ships a CSP (`app.security.csp` in
`src-tauri/tauri.conf.json`), and a too-tight policy fails **silently** — a
missing avatar, attachment, worker or stylesheet, never an exception.

```sh
npm run build:web && node web/dev/csp-probe.mjs   # prod policy vs web/dist
node web/dev/csp-probe.mjs --dev                  # dev policy, dev server running
```

It loads the app under the exact shipped header in **Chromium and WebKit**,
reports every `securitypolicyviolation`, and exits non-zero if there was one.
`--dev` also loads the editor harness above, which is what exercises CodeMirror's
runtime `<style>` injection. `CSP=…` overrides the policy — drop a directive and
confirm the run goes red — and note the dev server sends the policy itself
(`web/csp.ts`), because Tauri never sees a document it doesn't serve.

Re-run it after touching `index.html`, adding a dependency that loads or injects
anything, or editing the policy. Rationale per directive: `spec/security.md`.
