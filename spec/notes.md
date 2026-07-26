# Notes & the live editor

The original app: encrypted Markdown notes with an Obsidian-style live editor.
See [accounts-and-crypto.md](accounts-and-crypto.md) for the key model,
[local-store.md](local-store.md) for the on-device schema, [ui.md](ui.md) for
theming, and [security.md](security.md) for rendering safety.

> **Status: local-only.** Notes live entirely in the device's encrypted vault
> (SQLCipher, via the Rust core). There is **no server copy**: no sync, no
> sharing, no version history, no offline outbox or conflict copies — those all
> belonged to the deleted v1 server and its browser client, and the relay-backed
> replacements are unbuilt ([roadmap.md](roadmap.md#notes-under-v8)). The editor
> itself is unchanged and is the largest part of this document.

## Storage model (as built)

- One **Y.Doc per note**, owned by the webview; the Rust core persists the
  encoded doc plus display metadata (`note_create` / `note_save` / `note_delete`
  / `notes_load_all`, see `web/src/lib/nativeNotes.ts`). Body edits are applied
  to the doc as a coarse replace inside a single transaction — one doc lineage
  per note, which is what real collaborative editing will build on.
- On unlock, **every** note is hydrated into the Pinia store
  (`useNotesStore.loadFromCache`); on lock the store is emptied, because
  plaintext must not outlive the key.
- Personal organization (folders, pins, note order) and tag colors are separate
  **encrypted settings blobs** in the same vault — see [Folders &
  organization](#folders--organization) below.

## Notes features (as built)

- Notes: create / edit / delete; **autosave** 800 ms after the last keystroke,
  with a four-state indicator (*Unsaved* → *Saving…* → *Saved* / *Failed to
  save*). A save that lands after further typing can't stomp the *Unsaved* state
  (an edit generation counter guards it).
- Tags (no folders in the payload); each tag is a pill with a color.
- **Search** is a client-side substring match over the already-decrypted titles
  and bodies in memory (`NotesPage.searchResults`), plus a tag filter; either
  swaps the folder tree for a flat result list. The core also exposes an FTS
  query (`notes_search`) over the encrypted store, but **the UI does not use it**
  — it only pays off once notes stop being loaded eagerly.
- The notes page restores the **last opened note** (`notes:last-open`,
  localStorage);
  failing that it opens the most recently edited one, or creates one if there are
  none (desktop only — on mobile an open note is a full-screen leaf, so the list
  is shown first).
- **Import/export** — a zip of Markdown files with frontmatter, done entirely
  client-side (`web/src/lib/transfer.ts`, driven from Settings). Export offers
  *As-is*, *Obsidian*, *Standard Markdown*, and *Plain text* (see "Export as"
  below).

### Attachments

- Files attach via the kebab's **Attach** item, by **pasting**, or by
  **drag-and-drop** from the OS file manager; paste/drop insert the image markup
  **at the caret** (the editor moves the caret to the drop point first), while the
  attach button appends to the end. All files embed as `![name](attachment:id)`.
- Each file gets a random per-file AES-GCM key; the ciphertext goes straight into
  the **vault's blob store** and the key + IV are held in the core's `attachments`
  row (`owner_kind: 'note'`). Nothing leaves the device — notes don't sync, so
  there is no relay copy to refetch and an evicted attachment simply renders as
  missing ([local-store.md](local-store.md#attachments-on-device)).
- Size cap is `attachmentCap` (`lib/attachments.ts`): **20 MiB** for images
  (measured *after* optimization) and videos, **32 MiB** for everything else —
  the ceiling kept in step with the relay's blob limit.
- Images render inline; **audio/video** (detected by `mediaKind` from the
  name/type) render as inline `<audio>`/`<video>` players; anything else falls
  back to a missing-attachment label. Removing an attachment strips its markup and
  evicts the ciphertext.
- **Known gap — attachment refs are not persisted.** The `AttachmentRef` list
  (id, name, type, size, key, IV) lives in `NotePayload.attachments`, but
  `nativeSaveNote` only writes the title, tags, search text and Y.Doc body, and
  `nativeLoadNotes` rebuilds the payload without it. So attachments work for the
  lifetime of the session and are gone after a reload: the `attachment:` markup
  remains in the body, resolves to nothing, and the orphaned ciphertext stays in
  the blob store. Fixing this means either persisting the refs alongside the note
  or rebuilding them from the core's `attachments` rows by owner (there is no
  list-by-owner command today).

## The Obsidian-style live editor

A true live-preview editor (CodeMirror 6, what Obsidian builds on): you never see
`**`/`#`/`` ` `` while typing. Formatting is applied visually and via shortcuts
while the document stays Markdown(-ish) text, so E2EE, export and (eventually)
sync are unchanged.

### Behavior

- **WYSIWYG concealment (final):** markers are *always* hidden in live mode — no
  reveal states (both boundary-touch and strict-inside reveal were tried and felt
  janky). Formatting is applied/removed via shortcuts and the selection toolbar;
  **source mode** is where raw markdown/markup is edited. Typed markdown still
  auto-renders (`# `, `- `, `**x**` convert as you type); it just never un-renders
  at the cursor. Concealed markers are **atomic** for cursor movement. Applies to
  headings, lists, quotes, links (URL hidden), inline code, strikethrough,
  highlight, spoilers, code fences. Typed whitespace just before a hidden closing
  marker relocates past it. Literal markers follow CommonMark (intra-word `_`
  never italicizes; `\_` renders bare) — except that a `- ` at the start of a line
  freshly broken off a paragraph (Shift+Enter then `- `) shows its bullet
  **immediately**, even though CommonMark won't let the still-empty item interrupt
  the paragraph until a character follows. Bullet styling requires the **hyphen
  *and* a space**: a bare `-` (which CommonMark parses as an empty list at the
  document/section start) stays literal text until you type the space, so the
  bullet never flashes in mid-type.
- **Keyboard shortcuts** (Cmd / Ctrl), toggling on selection or at the caret:
  Bold `B`, Italic `I`, Underline `U`, Inline code `E`, Highlight `Shift+H`,
  Strikethrough `Shift+X`, Link `K` (prompt for URL), Heading `Shift+1..6` (same
  level toggles off), Clear heading `Shift+0`.
- **List indent/outdent:** with the caret in a list item (bullet, ordered, or
  task), **Tab** nests it one level deeper — a sublist — and **Shift+Tab** lifts
  it back out. The nested marker aligns to its parent's content column (so a child
  under `1. ` indents 3, under `- ` indents 2) and the whole item subtree (its own
  deeper-indented children) moves with it, keeping the source valid CommonMark.
  Tab is a no-op on the first item of a list (nothing to nest under) and Shift+Tab
  a no-op at the top level; both fall through to normal Tab behaviour when the
  caret isn't in a list. Works in the note editor and the chat composer alike.
- **Editor modes** (remembered device-wide, not per note): **live preview**
  (default), **source** (raw Markdown escape hatch), **reading** (rendered,
  non-editable). The mode toggle sits top-right — inline on desktop, a floating
  control bottom-right on mobile-width windows; Attach and Delete live in a kebab
  (⋮) menu and the save indicator stays outside it. **Reading mode renders with
  `breaks`** (a single newline is a hard line break, like chat), so it keeps the
  line breaks you typed instead of soft-wrapping them away.
- **Selection toolbar:** one collision-aware popover anchored to the selection
  (Reka `PopoverContent`), shown in live-preview mode. On mobile-width windows it
  appears only for a non-empty selection — there is no caret-only formatting bar
  above the keyboard.
- **Color formatting:** palette popover with 8 presets + a custom picker; every
  color stores a light- and dark-theme value (see [ui.md](ui.md) for the token
  mechanism). Highlight (background) colors use the same palette. Applying a color
  keeps the selection; re-coloring swaps the enclosing span's tag in place (color
  spans never stack).
- **Spoilers:** `||hidden text||` (Discord syntax) — a solid overlay (black in
  light mode, light grey in dark) in live + reading modes; click-to-reveal,
  Cmd/Ctrl+click to re-conceal. Spoilered images show the overlay with a centered
  "SPOILER" label.
- **Images, media & embeds:** image attachments render inline, and audio/video
  attachments render as native inline players (live + reading; raw syntax in
  source). YouTube/Vimeo URLs render as **click-to-load** embeds
  (`youtube-nocookie.com` / `player.vimeo.com`, a logo placeholder; no request
  leaves the client until clicked) — see [security.md](security.md) for the
  remote-media privacy model.
- **Code blocks:** ` ``` ` fences become real embedded code editors — syntax
  highlighting for the fenced language while editing, language picker, copy
  button. Editing only, no execution. Languages lazy-load via
  `@codemirror/language-data`.
- **Tags are pills:** Enter/blur commits; ✕ removes; Backspace pops the last. Each
  tag is color-coded (stable preset hashed from the name until customized);
  clicking a pill opens the shared ColorPalette; pill text auto-picks black/white
  by WCAG luminance. Tag colors live in an **encrypted settings blob**
  (`tag-colors`, `settings_get`/`settings_set` → SQLCipher). The blob's *keys are
  tag names*, which are as sensitive as note bodies, so there is deliberately **no
  plaintext localStorage cache**.
- **Notes list:** the file tree described under [Folders &
  organization](#folders--organization). Previews are plain text (markup stripped
  via the export pipeline) prefixed by the note's tag pills.

### Extended syntax & persistence

The document stays plain text under encryption. Standard Markdown covers
bold/italic/code/strikethrough; the rest needs extended syntax:

- highlight: `==text==`; colored highlights are `background-color` spans using
  the palette mechanism.
- spoiler: `||text||`.
- underline: `<u>text</u>` (inline HTML).
- color: `<span style="color:var(--brand-red)">…</span>` for the 8 presets, or
  `<span style="color:light-dark(#l,#d)">…</span>` for custom picks. The
  `--brand-*` palette is a theme token layer (see [ui.md](ui.md)) so swapping
  theme re-colors every note instantly — notes store only var()/function
  references, never hexes. Other Markdown apps degrade to plain uncolored text.

**Export as:** *As-is* (extended syntax untouched), *Obsidian* (keeps
`==highlight==`, `<u>`, color spans; unwraps `||spoilers||`), *Standard Markdown*
(HTML stripped keeping inner text, `==`/`||` unwrapped), *Plain text* (all markup
stripped). Tag stripping runs to a **fixed point**, so a nested construct like
`<<u>u>` can't survive one pass and re-form a tag.

### Implementation notes

- Live-preview decoration plugin walks the Lezer markdown syntax tree, building
  mark/replace/line/widget decorations + an atomic-ranges set. A critical
  decoration **sort tiebreak on `startSide`** prevents `RangeSet.of` from throwing
  on same-position ranges (which would disable the whole plugin).
- `concealedMotion` (arrow-key keymap) steps the caret a visible char per press
  across atomic concealed markers; `newlineBreakout` / `whitespaceBreakout`
  transaction filters relocate typed whitespace/newlines out of formatted runs.
  Note: the caret **cannot rest before a concealed list-marker widget** at the
  line start in Firefox/Gecko — contentEditable snaps it past the widget — so
  "place the caret in front of the bullet" isn't a portable affordance.
- Caret/keymap changes **cannot be trusted to Vitest**: concealed markers are
  atomic ranges, so visual motion depends on layout geometry jsdom doesn't model.
  Verify in the standalone harness in `web/dev/` (see the root `CLAUDE.md`).

## Block-level live rendering

- **Task checkboxes:** in live preview the `[ ]`/`[x]` marker is a concealed,
  atomic checkbox widget; clicking flips the single state char via a doc change,
  and the redundant list bullet on task lines is suppressed. The checkbox carries
  the same left indent as the bullet (`ml-4`) so a checklist lines up with a
  normal list instead of sitting flush at the margin. Reading mode renders
  checkboxes with their state but **disabled** (conventional rendered-markdown
  behavior). (A source-rewriting reading-mode toggle was prototyped and dropped —
  its line-scan ordinal couldn't reliably match the renderer's task order across
  ordered/blockquote/indented cases.)
- **Tables:** a GFM table renders in live preview as an **editable grid** of cell
  inputs; committing a cell rewrites just that cell's source range (pipes/newlines
  escaped so an edit can't corrupt the grid). Implemented as a dedicated
  **StateField** (not the live-preview ViewPlugin, which may not supply block- or
  line-spanning replace decorations); the field provides decorations + atomic
  ranges, and arrow-key motion steps past the whole block. Reading-mode tables are
  read-only.

## Client-side media optimization (before encryption)

`optimizeImage` runs on raw bytes **before** encryption — the only place it can,
since everything downstream is ciphertext. It decodes via `createImageBitmap`,
downscales to ≤2560px on the long edge, and re-encodes to WebP (q≈0.82) via
`OffscreenCanvas` (HTMLCanvasElement fallback). Animated GIFs and SVGs are
skipped; a result that isn't smaller — or any failure — falls back to the original
bytes, so an attach is never blocked. On by default with a Settings toggle
(`notes:optimize-images`, device-local). The stored `AttachmentRef` type/size
reflect the optimized bytes, but the **name is not rewritten**: a re-encoded
`photo.jpeg` keeps its `.jpeg` name while carrying WebP bytes and an `image/webp`
type. `nameForType` in `lib/fileMeta.ts` exists to fix exactly this and is
currently called from nowhere. The multi-file `attachFiles` loop is resilient: a
client-side `attachmentCap` pre-check and per-file try/catch mean one bad file
can't abort the batch or orphan earlier files; failures surface in a banner.

No per-user storage quotas (deferred indefinitely).

## Folders & organization

Notes can be organized into **folders**, and notes/folders can be **pinned** into
a chat sidebar (see [chat.md](chat.md)).

This is all **personal organization**: folders, the note→folder assignment, the
manual ordering and the per-conversation pins are stored as a single
master-key-encrypted settings blob (`notes-org`, the same mechanism as tag
colors), in the **encrypted vault** (`settings_get`/`settings_set`, SQLCipher).
Folder names and pins are as sensitive as tag names, so there is deliberately
**no plaintext localStorage cache** of the blob (only UI-level state like
collapsed-folder ids and the sidebar width live in localStorage).

Because it lives outside the note payload, pinning a note into a chat sidebar
**does not share it** — nothing about this structure grants anyone else access.

Model: `folders: {id, name, position, parentId}[]` (**nestable** — `parentId:
null` is a root folder), `noteFolders: { noteId → folderId }` (absent = unfiled),
`noteOrder: { folderKey → noteId[] }` (manual drag order within a folder; the rest
fall back to recency), `pins: { conversationId → {kind, id}[] }`, and `chat:
{ conversationId → ChatOrg }` for the chat sidebar's own folder namespace.
Re-parenting (`setFolderParent`) refuses cycles. Deleting a folder lifts its child
folders to its parent, unfiles its notes, and drops its pins; deleting a note
(`notes.remove`) calls `org.forgetNote` to clear its folder + order + pins.

UI:

- **NotesPage** — a single **file tree**: folders (full-width, borderless rows,
  depth-indented) with their notes nested directly beneath, unfiled notes at the
  root. Clicking a folder row (anywhere but its hover buttons)
  **collapses/expands** it (shared `folderCollapse` store, persisted). Everything
  is drag-and-drop, with an absolute **drop-indicator line** (no layout shift) at
  the insertion point and a ring on a folder you'd drop into: drag a folder onto
  another to nest it (or onto empty space to move it to the top level); drag a
  note onto a folder to move it there, onto another note to reorder/move before
  it, or onto empty space to unfile it. A **compact** toggle (beside the
  new-folder button) shows note rows as name-only; otherwise rows show tags + a
  preview. Searching or filtering by a tag swaps the tree for a flat result list.
  `:emoji:` shortcodes render in note titles and folder names (`EmojiText`).
- **NoteEditor** — shows the note's folder as a read-only pill; assignment is by
  dragging in the tree.
- **Chat sidebar** — a Pinned section + a pin picker that toggles pins for
  existing notes/folders or creates a new note/folder (which also appears in the
  notes view) and pins it. Opening a pinned item navigates to the notes view
  (`/?note=` / `/?folder=`); a pinned note can also open over the chat window.
  Grouping *inside* the sidebar uses that conversation's own **chat folders** — a
  separate namespace from note folders.

## Not built

Everything below existed against the deleted v1 server and has **no v8
replacement yet**. Details and ordering are in
[roadmap.md](roadmap.md#notes-under-v8):

- **Sync.** Notes never leave the device. No relay upload of Yjs updates, no
  multi-device convergence, no "you're offline" indicator (there is nothing to be
  offline from).
- **Sharing.** No note or folder sharing, no recipient picker, no "shared by"
  label, no revoke-and-rotate. `DecryptedNote.shared` and the read-only /
  shared-badge branches in `NoteEditor.vue` are vestigial — nothing ever populates
  the field, and the core's `shared_json` column is only ever read, never written.
- **Version history.** No snapshots, no History dialog. The core has a
  `note_versions` table and `import_note_versions`, but no command writes or reads
  them (test-only today).
- **Live collaborative editing.** The per-note Y.Doc is the foundation, but there
  is no `y-codemirror.next` binding and no remote cursors.
- **Offline outbox / conflict copies.** Local writes are the source of truth, so
  the whole conflict model went away with the server; it returns only with sync.
