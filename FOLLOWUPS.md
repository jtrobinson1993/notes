# Follow-ups

Captured ideas/bugs to pick up later (not yet implemented). Newest first.

## Chat composer / editor

- [ ] **Emoji/emote autocomplete (Discord-style).** Typing `:` preceded by a
  space (or at line start) opens an inline autocomplete of unicode emoji + custom
  `:shortcode:` emotes; arrow keys + Enter/Tab to pick. Applies to the chat
  composer (and likely the note editor). See `lib/emoji/*`, `MarkdownEditor.vue`.

- [ ] **List-start after a hard newline.** In the live editor, pressing
  Shift+Enter (newline) after text on line 1 and then typing `- ` doesn't start a
  list until the first character after it. The `- ` at the start of a freshly
  broken line should begin a list immediately, same as on a fresh line.

- [ ] **Cmd+Enter always sends in chat**, even while formatting a list. Keep the
  current Enter behaviour inside a list (Enter = new list item); Cmd+Enter should
  send the message regardless of list context.

- [ ] **Up-arrow edits your last message.** Pressing ↑ while focused in the chat
  input (and the input is empty / you haven't typed anything) starts editing your
  most recent message. If you've already typed something, ↑ does nothing special.
  Depends on message editing existing (below).

## Messages

- [ ] **Edit button on message hover toolbar.** Add an Edit action to the
  per-message hover toolbar (`ConversationView.vue`) for your own messages. Likely
  requires building a message-edit flow (re-encrypt + an edit/update endpoint +
  an "edited" marker) — message editing may not exist yet.

- [ ] **Reduce new-reaction pop-in scale** from 1.5 → 1.25 (the reaction pill
  enter animation initial scale). See the `pill`/`count` transitions in
  `ConversationView.vue` / `style.css`.

- [ ] **Mobile: press-and-hold to open the message toolbar.** On touch devices,
  long-press a message to open its actions in a **slide-up bottom-sheet panel**
  (mobile only). Desktop click/hover behaviour stays as-is. Differentiate
  click vs tap (pointer type `mouse` vs `touch`/coarse pointer) so we keep the
  normal hover toolbar for mouse at all screen sizes and only use long-press +
  bottom sheet for touch. Could reuse `AppDrawer` with a bottom-anchored variant.

## Navigation

- [ ] **Notes tab active highlight.** The sidebar Notes link (`/`) doesn't get the
  active/highlighted background that conversation links do when it's the current
  route. Give it the same active styling (`AppSidebar.vue`, mirror `activeConvId`).
