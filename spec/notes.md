# Notes & the live editor

The original app: encrypted Markdown notes with an Obsidian-style live editor.
See [accounts-and-crypto.md](accounts-and-crypto.md) for the key model,
[ui.md](ui.md) for theming, and [security.md](security.md) for rendering safety.

## Notes features (v1 / v2, shipped)

- Notes: create / edit / delete; autosave with a four-state indicator
  (*Unsaved* → *Saving…* → *Saved* / *Failed to save*).
- Tags (no folders); client-side full-text search over decrypted titles+bodies.
- **Encrypted local cache** (IndexedDB stores ciphertext only): instant load,
  background sync via Pinia Colada, offline reading.
- **Sharing** notes — **with friends only**: the note key is sealed to the
  recipient's X25519 key (read or write access, revocable) — see the sealing
  primitive in [accounts-and-crypto.md](accounts-and-crypto.md). The server
  enforces friendship on `POST /api/notes/:id/shares` (non-friend → 403), and the
  picker (`/api/members`, `ShareDialog.vue`) lists only the caller's friends. All
  three surfaces — the picker, the recipient list, and the "shared by" label —
  show the **display name / public handle, never any login identifier** (matching
  the chat rule).
- **Encrypted attachments** — a per-attachment key stored *inside* the encrypted
  note payload (so sharing a note shares its attachments); all files embed via
  `![name](attachment:id)`. Images render inline; **audio/video** (detected by
  `mediaKind` from the name/type) render as inline `<audio>`/`<video>` players;
  other files fall back to a missing-attachment label. Size cap is `attachmentCap`
  (`lib/attachments.ts`): **20 MiB** for images (after optimization) and videos,
  32 MiB for everything else. Files can be
  added via the attach button (appended to the end), or by **pasting** / **drag-
  and-dropping** from the OS file manager — the latter two insert the image
  markup **at the caret** (the editor moves the caret to the drop point first).
- **Version history** — the server snapshots ciphertext on update, coalesced to
  one per 10 min, max 50; restore from the History dialog.
- **Offline editing** — an IndexedDB outbox flushed before sync; server-side
  conflict detection via `baseUpdatedAt`, preserved as "(conflict copy)" notes.
- **Import/export** — a zip of Markdown files with frontmatter, client-side
  (plaintext never touches the server). Export offers *As-is*, *Obsidian*,
  *Standard Markdown*, and *Plain text* (see "Export as" below).
- **Encrypted backups** — periodic SQLite snapshots into `DATA_DIR/backups`
  (`BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP`); the DB is ciphertext-only.

## v2.1 — Obsidian-style live editor (shipped)

A true live-preview editor (CodeMirror 6, what Obsidian builds on): you never
see `**`/`#`/`` ` `` while typing. Formatting is applied visually and via
shortcuts while the document stays Markdown(-ish) text, so sync, E2EE, history,
and export are unchanged.

### Behavior

- **WYSIWYG concealment (final):** markers are *always* hidden in live mode — no
  reveal states (both boundary-touch and strict-inside reveal were tried and
  felt janky). Formatting is applied/removed via shortcuts and the selection
  toolbar; **source mode** is where raw markdown/markup is edited. Typed
  markdown still auto-renders (`# `, `- `, `**x**` convert as you type); it just
  never un-renders at the cursor. Concealed markers are **atomic** for cursor
  movement. Applies to headings, lists, quotes, links (URL hidden), inline code,
  strikethrough, highlight, spoilers, code fences. Typed whitespace just before
  a hidden closing marker relocates past it. Literal markers follow CommonMark
  (intra-word `_` never italicizes; `\_` renders bare) — except that a `- ` at
  the start of a line freshly broken off a paragraph (Shift+Enter then `- `)
  shows its bullet **immediately**, even though CommonMark won't let the still-
  empty item interrupt the paragraph until a character follows. Bullet styling
  requires the **hyphen *and* a space**: a bare `-` (which CommonMark parses as
  an empty list at the document/section start) stays literal text until you type
  the space, so the bullet never flashes in mid-type.
- **Keyboard shortcuts** (Cmd / Ctrl), toggling on selection or at the caret:
  Bold `B`, Italic `I`, Underline `U`, Inline code `E`, Highlight `Shift+H`,
  Strikethrough `Shift+X`, Link `K` (prompt for URL), Heading `Shift+1..6` (same
  level toggles off), Clear heading `Shift+0`.
- **List indent/outdent:** with the caret in a list item (bullet, ordered, or
  task), **Tab** nests it one level deeper — a sublist — and **Shift+Tab** lifts
  it back out. The nested marker aligns to its parent's content column (so a
  child under `1. ` indents 3, under `- ` indents 2) and the whole item subtree
  (its own deeper-indented children) moves with it, keeping the source valid
  CommonMark. Tab is a no-op on the first item of a list (nothing to nest under)
  and Shift+Tab a no-op at the top level; both fall through to normal Tab
  behaviour when the caret isn't in a list. Works in the note editor and the
  chat composer alike.
- **Editor modes** (per note): **live preview** (default), **source** (raw
  Markdown escape hatch), **reading** (rendered, non-editable). The mode toggle
  sits top-right; Share / History / Attach / Delete live in a kebab (⋮) menu;
  the save indicator stays outside it. The selection/formatting toolbar (desktop
  popover + mobile bar) shows in live-preview mode only. **Reading mode renders
  with `breaks`** (a single newline is a hard line break, like chat), so it keeps
  the line breaks you typed instead of soft-wrapping them away. History previews
  render the same way.
- **Color formatting:** palette popover with 8 presets + a custom picker; every
  color stores a light- and dark-theme value (see [ui.md](ui.md) for the token
  mechanism). Highlight (background) colors use the same palette. Applying a
  color keeps the selection; re-coloring swaps the enclosing span's tag in place
  (color spans never stack).
- **Spoilers:** `||hidden text||` (Discord syntax) — a solid overlay (black in
  light mode, light grey in dark) in live + reading modes; click-to-reveal,
  Cmd/Ctrl+click to re-conceal. Spoilered images show the overlay with a
  centered "SPOILER" label.
- **Images, media & embeds:** image attachments render inline, and audio/video
  attachments render as native inline players (live + reading; raw syntax in
  source). YouTube/Vimeo URLs render as **click-to-load** embeds (a
  logo placeholder; no request leaves the client until clicked) — see
  [security.md](security.md) for the remote-media privacy model.
- **Code blocks:** ` ``` ` fences become real embedded code editors — syntax
  highlighting for the fenced language while editing, language picker, copy
  button. Editing only, no execution. Languages lazy-load via
  `@codemirror/language-data`.
- **Tags are pills:** Enter/blur commits; ✕ removes; Backspace pops the last.
  Each tag is color-coded (stable preset hashed from the name until customized);
  clicking a pill opens the shared ColorPalette; pill text auto-picks black/white
  by WCAG luminance. Tag colors sync as an **encrypted settings blob**
  (`user_settings` table, `GET/PUT /api/settings/:key`, wrapped by MK — tag
  names never reach the server in plaintext), with localStorage as cache.
- **Notes list:** opening the page auto-selects the most-recently-edited note
  (or creates one if empty; desktop only). Previews are plain text (markup
  stripped via the export pipeline) prefixed by the note's tag pills.
- **Mobile/PWA:** a compact formatting toolbar above the keyboard / on selection
  with the same actions.

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
`==highlight==`, `<u>`, color spans; unwraps `||spoilers||`), *Standard
Markdown* (HTML stripped keeping inner text, `==`/`||` unwrapped), *Plain text*
(all markup stripped).

### Implementation notes

- Live-preview decoration plugin walks the Lezer markdown syntax tree, building
  mark/replace/line/widget decorations + an atomic-ranges set. A critical
  decoration **sort tiebreak on `startSide`** prevents `RangeSet.of` from
  throwing on same-position ranges (which would disable the whole plugin).
- `concealedMotion` (arrow-key keymap) steps the caret a visible char per press
  across atomic concealed markers; `newlineBreakout` / `whitespaceBreakout`
  transaction filters relocate typed whitespace/newlines out of formatted runs.

## v2.2 — block-level live rendering & media optimization (shipped)

### Block-level live rendering

- **Task checkboxes:** in live preview the `[ ]`/`[x]` marker is a concealed,
  atomic checkbox widget; clicking flips the single state char via a doc change,
  and the redundant list bullet on task lines is suppressed. Reading mode renders
  checkboxes with their state but **disabled** (conventional rendered-markdown
  behavior). (A source-rewriting reading-mode toggle was prototyped and dropped —
  its line-scan ordinal couldn't reliably match the renderer's task order across
  ordered/blockquote/indented cases.)
- **Tables:** a GFM table renders in live preview as an **editable grid** of cell
  inputs; committing a cell rewrites just that cell's source range (pipes/newlines
  escaped so an edit can't corrupt the grid). Implemented as a dedicated
  **StateField** (not the live-preview ViewPlugin, which may not supply block- or
  line-spanning replace decorations); the field provides decorations + atomic
  ranges, and arrow-key motion steps past the whole block. Reading-mode tables
  are read-only.

### Client-side media optimization (before encryption)

`optimizeImage` runs on raw bytes **before** encryption — the only place it can,
since the server only sees ciphertext. It decodes via `createImageBitmap`,
downscales to ≤2560px on the long edge, and re-encodes to WebP (q≈0.82) via
`OffscreenCanvas` (HTMLCanvasElement fallback for older Safari). Animated GIFs
and SVGs are skipped; a result that isn't smaller — or any failure — falls back
to the original bytes, so an upload is never blocked. On by default with a
Settings toggle (`notes:optimize-images`, device-local). The stored
`AttachmentRef` type/size reflect the optimized bytes, and when the format
changes the **name extension is rewritten** to match (`photo.jpeg` → `photo.webp`
via `nameForType`) so it never contradicts the actual bytes. The multi-file `attach()`
loop is resilient: a client-side `attachmentCap` pre-check (20 MiB media / 32 MiB
other) and per-file try/catch mean one bad file can't abort the batch or orphan
earlier uploads; failures surface in a banner.

No video uploads, no per-user storage quotas (deferred indefinitely).

## Folders & organization (v4)

Notes can be organized into **folders**, and notes/folders can be **pinned** into
a chat sidebar (see [chat.md](chat.md#pins-v4--as-built)).

This is all **personal organization**: folders, the note→folder assignment, and
the per-conversation pins are stored as a single **master-key-encrypted settings
blob** (`notes-org`, the same mechanism as tag colors / custom emoji), with a
`localStorage` instant-load cache (`web/src/stores/organization.ts`). Folder
names are as sensitive as tag names, so the whole blob is encrypted; the server
only ever stores ciphertext.

Because it lives outside the (E2EE) note payload and the server note model:

- it applies to **notes shared with me** as well as my own (a shared note can go
  in one of my folders);
- pinning a note/folder into a chat sidebar **does not share it** — sharing
  notes/folders with chat participants is its own crypto feature (**v5**).

Model: `folders: {id, name, position, parentId}[]` (**nestable** — `parentId:
null` is a root folder), `noteFolders: { noteId → folderId }` (absent =
unfiled), `noteOrder: { folderKey → noteId[] }` (manual drag order within a
folder; the rest fall back to recency), `pins: { conversationId → {kind, id}[]
}`. Re-parenting (`setFolderParent`) refuses cycles. Deleting a folder lifts its
child folders to its parent, unfiles its notes, and drops its pins; deleting a
note (`notes.remove`) calls `org.forgetNote` to clear its folder + order + pins.

UI:

- **NotesPage** — a single **file tree**: folders (full-width, borderless rows,
  depth-indented) with their notes nested directly beneath, unfiled notes at the
  root. Clicking a folder row (anywhere but its hover buttons) **collapses/
  expands** it (shared `folderCollapse` store, persisted). Everything is
  drag-and-drop, with an absolute **drop-indicator line** (no layout shift) at the
  insertion point and a ring on a folder you'd drop into: drag a folder onto
  another to nest it (or onto empty space to move it to the top level); drag a
  note onto a folder to move it there, onto another note to reorder/move before
  it, or onto empty space to unfile it. A **compact** toggle (beside the
  new-folder button) shows note rows as name-only; otherwise rows show tags + a
  preview. Searching or filtering by a tag swaps the tree for a flat result list.
  `:emoji:` shortcodes render in note titles and folder names (`EmojiText`).
- **NoteEditor** — a folder picker (`<select>`, indented to show nesting) on each
  note.
- **Chat sidebar** — pins individual **notes** (not note-folders) into a
  conversation; grouping there uses the conversation's own **chat folders** (a
  separate namespace — see [chat.md](chat.md#chat-folders--pins-v4--as-built)).
  Clicking a pinned note opens it over the chat window.
- **Chat sidebar** — a Pinned section + a pin picker that toggles pins for
  existing notes/folders or creates a new note/folder (which also appears in the
  notes view) and pins it. Opening a pinned item navigates to the notes view
  (`/?note=` / `/?folder=`).

## Sharing (v5)

Individual note sharing (v1) gains:

- **Recipients = friends OR conversation co-members.** You can now share with a
  friend-of-friend you share a group with, not just direct friends
  (`/api/members` → `listShareableMembers`). True outsiders are still rejected.
- **Revoke rotates the note key.** `notes.revokeShare` re-encrypts the note under
  a fresh key (re-wrapped under MK), re-seals it to the remaining recipients, and
  drops the revoked recipient — so they can't read future edits. Prior plaintext
  they already held is a documented boundary.
- **Folder sharing** (`notes.shareFolder`) — a one-time recursive snapshot grant:
  every OWNED note in a folder + its subfolders is shared with each recipient.
  There's no folder-level permission record, so notes added later aren't
  auto-shared (`FolderShareDialog`, reached from a folder's Share hover action).
