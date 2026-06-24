<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MarkdownView from './MarkdownView.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import ChatAvatar from './ChatAvatar.vue';
import ProfileDialog from './ProfileDialog.vue';
import EmojiPicker from './EmojiPicker.vue';
import ChatAttachments from './ChatAttachments.vue';
import LinkPreviewCard from './LinkPreviewCard.vue';
import MessageActionsSheet from './MessageActionsSheet.vue';
import { encryptAndUploadFile } from '../lib/attachments';
import { resolveEmoji } from '../lib/emoji';
import { api } from '../lib/api';
import IconReply from '~icons/mynaui/message-reply';
import IconPencil from '~icons/mynaui/pencil';
import IconThread from '~icons/mynaui/chat-dots';
import IconReplyQuote from '~icons/mynaui/corner-up-left';
import IconX from '~icons/mynaui/x';
import IconImage from '~icons/mynaui/image';
import IconPaperclip from '~icons/mynaui/paperclip';
import IconPaperclipSolid from '~icons/mynaui/paperclip-solid';
import IconSend from '~icons/mynaui/send-solid';
import type { AttachmentRef, Conversation, GifRef, LinkPreview, ReplyRef, SystemEvent } from '@notes/shared';
import { joinText } from '../lib/systemMessages';
import { HISTORY_LIMIT, useChatStore, type ChatMessageView } from '../stores/chat';
import { useSessionStore } from '../stores/session';
import { useProfileStore } from '../stores/profile';
import { isMobile } from '../lib/mobileNav';
import { conversationTitle } from '../lib/convName';

// Renders one conversation (DM, group, or a thread). The parent owns routing and
// the thread panel, so opening a thread just emits the parent message's seq.
const props = defineProps<{
  convId: string;
  channelId?: string;
  isThreadPanel?: boolean;
  hideHeader?: boolean;
  /** Deep-link target (e.g. from a push notification): scroll to + flash this
   *  message's seq once it's rendered. */
  focusSeq?: number | null;
}>();
const emit = defineEmits<{ openThread: [seq: number]; close: [] }>();
const session = useSessionStore();
const chat = useChatStore();
const profile = useProfileStore();

const convId = computed(() => props.convId);
// The stream this view renders: a specific channel, or the general channel
// (== convId) for DMs/threads. Messages/reactions are keyed by this id.
const chanId = computed(() => props.channelId ?? props.convId);
const loading = ref(false);
const loadingOlder = ref(false);
// True once we've fetched a partial page of older messages — no more to load.
const reachedStart = ref(false);
const text = ref('');
const sending = ref(false);
const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
const composer = ref<{ insertText: (s: string) => void; focus: () => void; focusEnd: () => void }>();
const fileInput = ref<HTMLInputElement>();
const staged = ref<AttachmentRef[]>([]);
// Local object-URL thumbnails for staged images, keyed by ref id. Made from the
// originally-picked File (no re-decrypt needed) and revoked on remove/send/unmount.
const stagedPreviews = ref<Record<string, string>>({});
const attaching = ref(false);
const attachError = ref('');

/** Drop a staged image's preview URL, if any, freeing the blob. */
function revokePreview(id: string) {
  const url = stagedPreviews.value[id];
  if (url) {
    URL.revokeObjectURL(url);
    delete stagedPreviews.value[id];
  }
}

/** Clear all staged attachments and their previews (after a send). */
function clearStaged() {
  for (const id of Object.keys(stagedPreviews.value)) revokePreview(id);
  staged.value = [];
}

// While pinned to the bottom, keep glued there as the content height changes —
// the robust counterpart to scrollToBottom's one-shot image-wait, since chat
// images and avatars decrypt asynchronously and only mount (growing the height)
// after the initial scroll. Gated on `pinned` so a user who scrolled up is never
// yanked down.
let contentObserver: ResizeObserver | null = null;
onMounted(() => {
  if (!content.value || typeof ResizeObserver === 'undefined') return;
  contentObserver = new ResizeObserver(() => {
    if (pinned.value && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
  contentObserver.observe(content.value);
});

onBeforeUnmount(() => {
  contentObserver?.disconnect();
  for (const id of Object.keys(stagedPreviews.value)) revokePreview(id);
});
const replyingTo = ref<ReplyRef | null>(null);
// When set, the composer is editing this message's text (not sending a new one).
// `original` is the text as-sent, to detect a no-op save.
const editing = ref<{ seq: number; original: string } | null>(null);

// Only your own decryptable, non-system text messages can be edited.
function canEdit(m: ChatMessageView): boolean {
  return m.senderId === session.user?.id && !m.system && m.text !== null;
}

function startEdit(m: ChatMessageView) {
  if (!canEdit(m)) return;
  editing.value = { seq: m.seq, original: m.text ?? '' };
  replyingTo.value = null;
  text.value = m.text ?? '';
  // Wait for the new text to flush into the editor, then place the caret at the end.
  void nextTick(() => composer.value?.focusEnd());
}

function cancelEdit() {
  if (!editing.value) return;
  editing.value = null;
  text.value = '';
}

// ↑ on an empty composer edits your most recent editable message.
function editLast() {
  if (editing.value) return;
  const list = chat.messages[chanId.value] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (canEdit(list[i]!)) {
      startEdit(list[i]!);
      return;
    }
  }
}

// Touch long-press → bottom-sheet of actions. Mouse/pen keep the hover toolbar,
// so this is gated on `pointerType === 'touch'` and cancelled by scroll/lift.
const sheetMsg = ref<ChatMessageView | null>(null);
const sheetOpen = computed({
  get: () => sheetMsg.value !== null,
  set: (v) => {
    if (!v) sheetMsg.value = null;
  },
});
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressOrigin: { x: number; y: number } | null = null;

function onRowPointerDown(e: PointerEvent, m: ChatMessageView) {
  if (e.pointerType !== 'touch') return;
  pressOrigin = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    sheetMsg.value = m;
    pressOrigin = null;
  }, 500);
}
function onRowPointerMove(e: PointerEvent) {
  // A drag past a small threshold is a scroll, not a press — cancel.
  if (pressOrigin && Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > 10) cancelPress();
}
function cancelPress() {
  clearTimeout(pressTimer);
  pressOrigin = null;
}
// Suppress the OS long-press menu on touch (we show our own sheet); leave the
// desktop right-click menu alone.
function onRowContextMenu(e: MouseEvent) {
  if ((e as PointerEvent).pointerType === 'touch' || sheetOpen.value) e.preventDefault();
}

function sheetReact(emoji: string) {
  if (sheetMsg.value) react(sheetMsg.value.seq, emoji);
}
function sheetReply() {
  if (sheetMsg.value) startReply(sheetMsg.value);
}
function sheetEdit() {
  if (sheetMsg.value) startEdit(sheetMsg.value);
}
function sheetThread() {
  if (sheetMsg.value) openThreadFor(sheetMsg.value.seq);
}

const conversation = computed<Conversation | undefined>(() =>
  chat.conversations.find((c) => c.id === convId.value),
);

const isThread = computed(() => conversation.value?.kind === 'thread');
const title = computed(() =>
  conversation.value ? conversationTitle(conversation.value, session.user?.id) : 'Conversation',
);

// Opening a thread is owned by the parent (it manages the side panel).
function openThreadFor(seq: number) {
  emit('openThread', seq);
}

// Number of messages in the thread rooted on this message (0 = none yet).
function threadReplies(seq: number): number {
  return chat.threadFor(convId.value, seq)?.lastSeq ?? 0;
}

const msgs = computed(() => chat.messages[chanId.value] ?? []);

function memberName(senderId: string): string {
  return conversation.value?.members.find((m) => m.userId === senderId)?.displayName || 'Unknown';
}

/** Render an inline system notice (centered, muted). Self-references read better
 *  neutrally than as a third-person funny line. */
function systemText(ev: SystemEvent): string {
  const me = ev.userId === session.user?.id;
  if (ev.kind === 'member-joined') return me ? 'You joined the chat.' : joinText(memberName(ev.userId), ev.phrase);
  return '';
}

// A member's chosen name color as a CSS value (theme-aware --brand-* pair), or
// undefined for the default text color.
function nameColorCss(senderId: string): string | undefined {
  const c = conversation.value?.members.find((m) => m.userId === senderId)?.nameColor;
  return c ? `var(--brand-${c})` : undefined;
}

// A member's decrypted avatar, or null for the initial fallback. My own avatar
// comes from my profile data; others' come from the (reactive) profile cache,
// so they fill in once fetched.
function avatarFor(senderId: string): string | null {
  if (senderId === session.user?.id) return profile.myData.avatar ?? null;
  return profile.cache[senderId]?.data?.avatar ?? null;
}

// Lazily fetch every member's profile so avatars (and the profile dialog) resolve.
function loadMemberProfiles() {
  const meId = session.user?.id;
  for (const m of conversation.value?.members ?? []) {
    if (m.userId !== meId) void profile.fetch(m.userId).catch(() => {});
  }
}

// Profile dialog (opened by clicking a sender's avatar or name).
const profileUserId = ref<string | null>(null);
const profileOpen = ref(false);
function openProfile(userId: string) {
  if (userId === session.user?.id) return; // own profile lives in Settings
  profileUserId.value = userId;
  profileOpen.value = true;
}

// A short, single-line preview of a message, for the reply quote. Capped small
// (and the UI also truncates with an ellipsis) so it never wraps on mobile.
const REPLY_PREVIEW_MAX = 64;
function previewOf(m: ChatMessageView): string {
  const t = (m.text ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.length > REPLY_PREVIEW_MAX ? `${t.slice(0, REPLY_PREVIEW_MAX)}…` : t;
  if (m.gif) return '[GIF]';
  if (m.attachments?.length) return `[${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}]`;
  return '[message]';
}

function startReply(m: ChatMessageView) {
  replyingTo.value = { seq: m.seq, senderId: m.senderId, preview: previewOf(m) };
}

// A deep link (push notification) hands us a message seq to land on. Scroll to
// it once it's actually rendered — the message may arrive a tick later (still
// decrypting) or after a history page loads — and only auto-jump once per target
// so we don't keep yanking the user back.
let lastFocused: number | null = null;
watch(
  [() => props.focusSeq, () => msgs.value.length],
  async () => {
    const seq = props.focusSeq;
    if (seq == null || seq === lastFocused) return;
    await nextTick();
    if (!scroller.value?.querySelector(`[data-seq="${seq}"]`)) return; // not rendered yet
    lastFocused = seq;
    scrollToSeq(seq);
  },
  { immediate: true },
);

function scrollToSeq(seq: number) {
  const el = scroller.value?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Briefly highlight the target. Remove + reflow + re-add so a repeat click
  // restarts the flash.
  el.classList.remove('reply-flash');
  void el.offsetWidth;
  el.classList.add('reply-flash');
  window.setTimeout(() => el.classList.remove('reply-flash'), 1400);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// One full-width row per message. `isStart` marks the first message of a group
// (same sender within a 5-min gap): it shows the avatar + name + timestamp;
// consecutive rows leave the avatar gutter empty (a hover-only timestamp fills
// it instead).
const GROUP_GAP_MS = 5 * 60_000;
interface MessageRow {
  key: string;
  msg: ChatMessageView;
  senderId: string;
  name: string;
  isStart: boolean;
}
const rows = computed<MessageRow[]>(() => {
  const out: MessageRow[] = [];
  let prev: ChatMessageView | undefined;
  for (const m of msgs.value) {
    // A system notice renders on its own and also breaks the avatar grouping of
    // the messages around it.
    const isStart = !prev || prev.senderId !== m.senderId || !!prev.system || m.createdAt - prev.createdAt > GROUP_GAP_MS;
    out.push({ key: String(m.seq), msg: m, senderId: m.senderId, name: memberName(m.senderId), isStart });
    prev = m;
  }
  return out;
});

function atBottom(): boolean {
  const el = scroller.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// Whether the view is currently pinned to the bottom (updated as the user
// scrolls). A monotonic token lets a newer scroll/channel-switch cancel an older
// pending "re-pin after images load".
const pinned = ref(true);
let scrollToken = 0;

async function scrollToBottom() {
  const token = ++scrollToken;
  pinned.value = true;
  await nextTick();
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  // Late-loading content (avatars, custom emoji, link embeds, attachments) grows
  // the height after first paint, which would leave us parked above the bottom.
  // Re-pin to the bottom as those images settle — so opening a chat lands on the
  // latest message — unless a newer scroll superseded us or the user scrolled away.
  const imgs = Array.from(el.querySelectorAll('img')).filter((i) => !i.complete);
  if (!imgs.length) return;
  await Promise.race([
    Promise.all(
      imgs.map(
        (i) =>
          new Promise<void>((res) => {
            i.addEventListener('load', () => res(), { once: true });
            i.addEventListener('error', () => res(), { once: true });
          }),
      ),
    ),
    new Promise((res) => setTimeout(res, 1500)),
  ]);
  if (token === scrollToken && pinned.value && scroller.value) {
    scroller.value.scrollTop = scroller.value.scrollHeight;
  }
}

async function markReadHere() {
  const list = msgs.value;
  const last = list[list.length - 1];
  if (last) await chat.markRead(convId.value, chanId.value, last.seq);
}

async function activate() {
  const cid = convId.value;
  const ch = chanId.value;
  chat.setActive(cid, ch);
  loading.value = true;
  reachedStart.value = false;
  try {
    if ((chat.messages[ch]?.length ?? 0) === 0) {
      const count = await chat.loadHistory(cid, ch);
      // A first page shorter than the limit is the whole channel.
      if (count < HISTORY_LIMIT) reachedStart.value = true;
    }
    await chat.loadReactions(cid, ch);
  } finally {
    loading.value = false;
  }
  loadMemberProfiles();
  await scrollToBottom();
  await markReadHere();
}

// Re-activate when either the conversation OR the selected channel changes.
watch([convId, chanId], () => void activate(), { immediate: true });

// New messages arriving / sent: keep pinned to bottom when already there, and
// clear unread when viewing the bottom.
watch(
  () => msgs.value.length,
  async (len, prev) => {
    if (len > (prev ?? 0)) {
      const wasAtBottom = atBottom();
      if (wasAtBottom) {
        await scrollToBottom();
        await markReadHere();
      }
    }
  },
);

async function loadOlder() {
  const oldest = msgs.value[0];
  if (!oldest || loadingOlder.value || reachedStart.value) return;
  const el = scroller.value;
  // Measure height before the "Loading…" indicator renders, and restore scroll
  // after it's removed, so only the prepended rows count toward the adjustment —
  // keeping the previously-top message visually in place (no viewport jump).
  const prevHeight = el?.scrollHeight ?? 0;
  loadingOlder.value = true;
  try {
    const count = await chat.loadHistory(convId.value, chanId.value, oldest.seq);
    if (count < HISTORY_LIMIT) reachedStart.value = true;
  } finally {
    loadingOlder.value = false;
  }
  await nextTick();
  if (el) el.scrollTop = el.scrollHeight - prevHeight;
}

// Distance from the top at which we begin fetching the next older chunk.
const LOAD_OLDER_THRESHOLD_PX = 200;

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  pinned.value = atBottom(); // user scrolling away unpins; back to bottom re-pins
  if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) void loadOlder();
  if (atBottom()) void markReadHere();
}

// Link previews only when EVERY member (including me) has opted in.
const previewsAllowed = computed(() => {
  const members = conversation.value?.members ?? [];
  return members.length > 0 && members.every((m) => m.linkPreviews);
});
function linkPreviewsAllowed(): boolean {
  return previewsAllowed.value;
}

const URL_RE = /\bhttps?:\/\/[^\s<>]+/i;
function firstUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  // Trim trailing sentence punctuation the regex may have caught.
  return m[0].replace(/[)\].,!?;:'"]+$/, '');
}

// A message has a link but no preview *because* not everyone has previews on —
// show a hint where the preview would have rendered. (When previews are allowed
// but a message still has none, it's a no-OG-data case, not an opt-in gap.)
function showLinkPreviewHint(m: ChatMessageView): boolean {
  return !previewsAllowed.value && !m.linkPreview && !!m.text && !!firstUrl(m.text);
}

async function send() {
  if (sending.value) return;
  const body = text.value.trim();
  // Editing path: re-encrypt the message in place (no attachments/preview flow).
  if (editing.value) {
    if (!body) return; // empty edit is a no-op; cancel via Esc / ✕
    // Unchanged → just leave edit mode; no API call, no "edited" marker.
    if (body === editing.value.original.trim()) {
      cancelEdit();
      return;
    }
    const wasAtBottom = atBottom();
    sending.value = true;
    try {
      await chat.editMessage(convId.value, chanId.value, editing.value.seq, body);
      editing.value = null;
      text.value = '';
      if (wasAtBottom) await scrollToBottom();
    } finally {
      sending.value = false;
    }
    return;
  }
  if (!body && !staged.value.length) return;
  sending.value = true;
  try {
    const opts: { attachments?: AttachmentRef[]; replyTo?: ReplyRef; linkPreview?: LinkPreview } = {};
    if (staged.value.length) opts.attachments = [...staged.value];
    if (replyingTo.value) opts.replyTo = replyingTo.value;
    if (body && linkPreviewsAllowed()) {
      const url = firstUrl(body);
      if (url) {
        try {
          opts.linkPreview = await api.og(url);
        } catch {
          // No preview (unreachable / blocked / no OG tags) — send without one.
        }
      }
    }
    await chat.sendMessage(convId.value, chanId.value, body, Object.keys(opts).length ? opts : undefined);
    text.value = '';
    clearStaged();
    replyingTo.value = null;
    await scrollToBottom();
  } finally {
    sending.value = false;
  }
}

// Each file uploads independently (encrypted client-side) and is staged as a
// chip; Send then embeds the refs in the message. A single failure doesn't
// abort the batch.
async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files?.length) return;
  // Hand focus to the composer so Enter sends the message rather than
  // re-triggering the (now-focused) attach button.
  composer.value?.focus();
  attaching.value = true;
  attachError.value = '';
  const failed: string[] = [];
  for (const file of files) {
    try {
      const ref = await encryptAndUploadFile(file);
      // Thumbnail from the original picked bytes — no round-trip decrypt.
      if (ref.type.startsWith('image/')) stagedPreviews.value[ref.id] = URL.createObjectURL(file);
      staged.value.push(ref);
    } catch (err) {
      failed.push(`${file.name} — ${err instanceof Error ? err.message : 'upload failed'}`);
    }
  }
  input.value = '';
  attaching.value = false;
  attachError.value = failed.length ? `Couldn't attach: ${failed.join('; ')}` : '';
}

function removeStaged(id: string) {
  revokePreview(id);
  staged.value = staged.value.filter((a) => a.id !== id);
}

function insertEmoji(s: string) {
  composer.value?.insertText(s);
}

// Reactions: group the conversation's reactions for a given message by emoji.
interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}
function reactionGroups(seq: number): ReactionGroup[] {
  const meId = session.user?.id;
  const map = new Map<string, ReactionGroup>();
  for (const r of chat.reactions[chanId.value] ?? []) {
    if (r.seq !== seq || !r.emoji) continue;
    const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    g.count++;
    if (r.userId === meId) g.mine = true;
    map.set(r.emoji, g);
  }
  return [...map.values()];
}

// A reaction emoji is either a `:name:` custom/emote (→ image) or a literal char.
function reactionImg(emoji: string): string | null {
  const m = /^:([A-Za-z0-9_]{2,40}):$/.exec(emoji);
  return m ? resolveEmoji(m[1]!) : null;
}

function react(seq: number, emoji: string) {
  void chat.toggleReaction(convId.value, chanId.value, seq, emoji);
}

async function sendGif(gif: GifRef) {
  if (sending.value) return;
  sending.value = true;
  try {
    await chat.sendMessage(convId.value, chanId.value, '', { gif });
    await scrollToBottom();
  } finally {
    sending.value = false;
  }
}
</script>

<template>
    <div class="flex h-full flex-col">
      <!-- Header is only rendered for the thread panel (the main view passes
           hide-header; group name/icon + calls live in ConversationPage). -->
      <div v-if="!hideHeader" class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <IconThread v-if="isThread" class="h-5 w-5 shrink-0 text-zinc-400" />
        <span v-else class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
          {{ (title.trim()[0] ?? '?').toUpperCase() }}
        </span>
        <p class="font-semibold">{{ title }}</p>
        <span v-if="isThread" class="text-xs text-zinc-400">thread</span>
        <button
          v-if="isThreadPanel"
          class="ml-auto flex items-center rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Close thread"
          @click="emit('close')"
        >
          <IconX class="h-4 w-4" />
        </button>
      </div>

      <div ref="scroller" class="min-h-0 grow overflow-y-auto" :class="isMobile ? 'pt-2' : 'py-2'" @scroll="onScroll">
        <!-- Content wrapper (min-h-full so the empty/loading states still center)
             whose height a ResizeObserver watches — re-pinning to the bottom as
             late async content (decrypted images, avatars, link previews) grows
             it, so a refresh lands on the latest message. -->
        <div ref="content" class="min-h-full">
        <!-- Older messages auto-load as the user scrolls up; this just reflects
             the in-flight fetch and marks the start of history. -->
        <div v-if="loadingOlder" class="flex justify-center py-2 text-xs text-zinc-400">Loading…</div>
        <div
          v-else-if="reachedStart && msgs.length"
          class="flex justify-center py-2 text-xs text-zinc-400"
        >
          End of message history
        </div>

        <div v-if="loading && !msgs.length" class="flex h-full items-center justify-center text-sm text-zinc-400">
          Loading…
        </div>
        <div v-else-if="!msgs.length" class="flex h-full items-center justify-center text-sm text-zinc-400">
          No messages yet — say hello.
        </div>

        <!-- One full-width row per message; the avatar gutter sits on the left.
             Messages align the same for everyone (no own-message special-case). -->
        <template v-for="row in rows" :key="row.key">
        <!-- System notice (member joined, …): a centered, muted line, no bubble. -->
        <div
          v-if="row.msg.system"
          :data-seq="row.msg.seq"
          class="px-4 py-1.5 text-center text-xs text-zinc-400 dark:text-zinc-500"
        >
          {{ systemText(row.msg.system) }}
        </div>
        <div
          v-else
          :data-seq="row.msg.seq"
          class="group relative flex items-start gap-3 px-4 py-0.5 [-webkit-touch-callout:none] hover:bg-black/5 dark:hover:bg-white/5"
          :class="row.isStart ? 'mt-3' : ''"
          @pointerdown="onRowPointerDown($event, row.msg)"
          @pointermove="onRowPointerMove"
          @pointerup="cancelPress"
          @pointercancel="cancelPress"
          @pointerleave="cancelPress"
          @contextmenu="onRowContextMenu"
        >
          <!-- Hover actions: react + reply + thread. Pulled up by half its
               height (only the bottom half overlays the message). Stays visible
               while a child popover (the emoji picker) is open — otherwise
               leaving the row to reach the popover hides the trigger and the
               popover loses its anchor. -->
          <div class="absolute right-3 top-0 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-zinc-200 bg-white px-1 py-0.5 shadow-sm group-hover:flex has-[[data-state=open]]:flex dark:border-zinc-700 dark:bg-zinc-800">
            <EmojiPicker compact @pick="(s) => react(row.msg.seq, s)" />
            <button
              class="flex items-center rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
              title="Reply"
              @click="startReply(row.msg)"
            >
              <IconReply class="h-4 w-4" />
            </button>
            <button
              v-if="canEdit(row.msg)"
              class="flex items-center rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
              title="Edit"
              @click="startEdit(row.msg)"
            >
              <IconPencil class="h-4 w-4" />
            </button>
            <button
              v-if="!isThread"
              class="flex items-center rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
              title="Start/open thread"
              @click="openThreadFor(row.msg.seq)"
            >
              <IconThread class="h-4 w-4" />
            </button>
          </div>
          <!-- Left gutter: avatar at a group's first message; otherwise a
               hover-only timestamp for the consecutive message. -->
          <div class="w-10 shrink-0">
            <!-- Center the avatar within a fixed-height box (~one header + line)
                 anchored at the top: it reads centered on a single-line message,
                 and the fixed height keeps it in that same spot when the message
                 wraps to multiple lines. -->
            <div v-if="row.isStart" class="flex h-11 items-center">
              <button
                type="button"
                class="rounded-full transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                :aria-label="`View ${row.name}'s profile`"
                @click="openProfile(row.senderId)"
              >
                <ChatAvatar :name="row.name" :seed="row.senderId" :src="avatarFor(row.senderId)" class="h-10 w-10 text-sm" />
              </button>
            </div>
            <time
              v-else
              class="hidden whitespace-nowrap pt-0.5 text-right text-[10px] leading-5 tabular-nums text-zinc-400 group-hover:block dark:text-zinc-500"
            >{{ formatTime(row.msg.createdAt) }}</time>
          </div>
          <!-- Content fills the rest of the width. -->
          <div class="min-w-0 grow text-sm">
            <!-- Reply quote: a snapshot embedded in the message; click to jump. -->
            <button
              v-if="row.msg.replyTo"
              class="mb-0.5 flex max-w-full items-center gap-1 truncate text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              @click="scrollToSeq(row.msg.replyTo.seq)"
            >
              <IconReplyQuote class="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span class="font-medium" :style="{ color: nameColorCss(row.msg.replyTo.senderId) }">{{ memberName(row.msg.replyTo.senderId) }}</span>
              <span class="truncate opacity-80">{{ row.msg.replyTo.preview }}</span>
            </button>
            <div v-if="row.isStart" class="flex items-baseline gap-2">
              <button
                type="button"
                class="font-medium text-zinc-700 hover:underline dark:text-zinc-200"
                :style="{ color: nameColorCss(row.senderId) }"
                @click="openProfile(row.senderId)"
              >{{ row.name }}</button>
              <time class="text-xs text-zinc-400 dark:text-zinc-500">{{ formatTime(row.msg.createdAt) }}</time>
            </div>
            <div class="chat-message">
              <span
                v-if="row.msg.text === null && !row.msg.gif && !row.msg.attachments?.length"
                class="italic opacity-70"
              >message could not be decrypted</span>
              <template v-else>
                <MarkdownView v-if="row.msg.text" :source="row.msg.text" breaks />
                <img
                  v-if="row.msg.gif"
                  :src="row.msg.gif.url"
                  :alt="row.msg.gif.title || 'GIF'"
                  :style="{ aspectRatio: `${row.msg.gif.width} / ${row.msg.gif.height}` }"
                  class="mt-1 w-full max-w-[260px] rounded-lg bg-zinc-100 dark:bg-zinc-800"
                  loading="lazy"
                />
                <ChatAttachments
                  v-if="row.msg.attachments?.length"
                  :attachments="row.msg.attachments"
                />
                <LinkPreviewCard v-if="row.msg.linkPreview" :preview="row.msg.linkPreview" />
                <p
                  v-else-if="showLinkPreviewHint(row.msg)"
                  class="mt-1 text-xs text-zinc-400 dark:text-zinc-500"
                >
                  No link preview — every member needs link previews enabled (Settings → Privacy).
                </p>
              </template>
            </div>
            <!-- Reaction pills: grouped by emoji; click toggles mine. A new pill
                 pops in (TransitionGroup enter, never on initial load); the count
                 pops when it changes (keyed Transition). -->
            <TransitionGroup
              tag="div"
              name="pill"
              class="flex flex-wrap gap-1 empty:hidden"
              :class="reactionGroups(row.msg.seq).length ? 'mt-1' : ''"
            >
              <button
                v-for="g in reactionGroups(row.msg.seq)"
                :key="g.emoji"
                class="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none"
                :class="g.mine ? 'border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950' : 'border-zinc-200 dark:border-zinc-700'"
                @click="react(row.msg.seq, g.emoji)"
              >
                <img v-if="reactionImg(g.emoji)" :src="reactionImg(g.emoji)!" :alt="g.emoji" class="h-4 w-4 object-contain" />
                <span v-else>{{ g.emoji }}</span>
                <Transition name="count" mode="out-in">
                  <span :key="g.count" class="tabular-nums text-zinc-500">{{ g.count }}</span>
                </Transition>
              </button>
            </TransitionGroup>
            <!-- Thread indicator + "edited" note, on one line. -->
            <div
              v-if="(!isThread && threadReplies(row.msg.seq) > 0) || row.msg.editedAt"
              class="mt-1 flex items-center gap-1"
            >
              <span
                v-if="row.msg.editedAt"
                class="select-none text-[11px] text-zinc-400 dark:text-zinc-500"
                :title="`Edited ${formatTime(row.msg.editedAt)}`"
              >(edited)</span>
              <button
                v-if="!isThread && threadReplies(row.msg.seq) > 0"
                class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
                @click="openThreadFor(row.msg.seq)"
              >
                <IconThread class="h-3.5 w-3.5" />
                {{ threadReplies(row.msg.seq) }} {{ threadReplies(row.msg.seq) === 1 ? 'reply' : 'replies' }}
              </button>
            </div>
          </div>
        </div>
        </template>
        </div>
      </div>

      <div class="shrink-0 p-3">
        <!-- Editing banner. -->
        <div
          v-if="editing"
          class="mb-2 flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-800"
        >
          <span class="flex items-center gap-1 opacity-60"><IconPencil class="h-3.5 w-3.5" /> Editing message</span>
          <span class="min-w-0 grow truncate opacity-60">— Enter to save, Esc to cancel</span>
          <button class="flex items-center rounded px-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Cancel edit" @click="cancelEdit"><IconX class="h-3.5 w-3.5" /></button>
        </div>

        <!-- Replying-to banner. -->
        <div
          v-if="replyingTo && !editing"
          class="mb-2 flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-800"
        >
          <span class="flex items-center gap-1 opacity-60"><IconReplyQuote class="h-3.5 w-3.5" /> Replying to</span>
          <span class="font-medium" :style="{ color: nameColorCss(replyingTo.senderId) }">{{ memberName(replyingTo.senderId) }}</span>
          <span class="min-w-0 grow truncate opacity-80">{{ replyingTo.preview }}</span>
          <button class="flex items-center rounded px-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Cancel reply" @click="replyingTo = null"><IconX class="h-3.5 w-3.5" /></button>
        </div>

        <!-- Staged attachments (uploaded encrypted; sent with the next message). -->
        <div v-if="staged.length || attaching || attachError" class="mb-2 flex flex-wrap items-center gap-2">
          <span
            v-for="a in staged"
            :key="a.id"
            class="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 py-1 pl-1.5 pr-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
          >
            <img
              v-if="stagedPreviews[a.id]"
              :src="stagedPreviews[a.id]"
              :alt="a.name"
              class="h-10 w-10 shrink-0 rounded-md object-cover"
            />
            <IconImage v-else-if="a.type.startsWith('image/')" class="h-3.5 w-3.5 shrink-0" />
            <IconPaperclip v-else class="h-3.5 w-3.5 shrink-0" />
            <span class="max-w-[160px] truncate">{{ a.name }}</span>
            <button class="flex items-center rounded px-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Remove" @click="removeStaged(a.id)"><IconX class="h-3.5 w-3.5" /></button>
          </span>
          <span v-if="attaching" class="text-xs text-zinc-400">Uploading…</span>
          <span v-if="attachError" class="text-xs text-red-500">{{ attachError }}</span>
        </div>

        <!-- One border wraps the whole composer (input + the two square
             buttons), all vertically centered. The buttons are borderless,
             equal-size squares with solid icons; the input fills the height so
             the whole row is an easy click target. A subtle tint lifts it off
             the app background. -->
        <div class="flex items-center gap-1 rounded-xl border border-zinc-300 bg-black/[2.5%] px-1.5 py-1 text-sm focus-within:ring-2 focus-within:ring-blue-500 dark:border-zinc-700 dark:bg-white/[2.5%]">
          <input ref="fileInput" type="file" multiple class="hidden" @change="onPickFiles" />
          <button
            type="button"
            title="Attach files"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-700/70"
            @click="fileInput?.click()"
          >
            <IconPaperclipSolid class="h-5 w-5" />
          </button>
          <!-- Reuse the v2.1 live editor as the composer: code blocks, spoilers,
               colors, and the selection toolbar all come for free. Desktop:
               Enter sends, Shift+Enter inserts a newline. Mobile: Enter inserts
               a newline and the Send button (right) sends. -->
          <div class="flex min-w-0 grow cursor-text items-center self-stretch px-1" @click="composer?.focus()">
            <MarkdownEditor
              ref="composer"
              v-model="text"
              class="w-full"
              submit-on-enter
              :placeholder="editing ? 'Edit message…' : 'Message…'"
              @submit="send"
              @edit-last="editLast"
              @escape="cancelEdit"
            />
          </div>
          <EmojiPicker gifs @pick="insertEmoji" @gif="sendGif" />
          <!-- Mobile: Enter inserts a newline, so a visible Send button is the
               way to send. Desktop: Enter sends, so this stays an off-screen
               control for screen-reader/keyboard users. -->
          <button
            v-if="isMobile"
            type="button"
            :disabled="(!text.trim() && !staged.length) || sending"
            title="Send message"
            aria-label="Send message"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-blue-600 hover:bg-zinc-200/70 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-zinc-700/70"
            @click="send"
          >
            <IconSend class="h-5 w-5" />
          </button>
          <button
            v-else
            :disabled="(!text.trim() && !staged.length) || sending"
            class="sr-only"
            aria-label="Send message"
            @click="send"
          >
            Send
          </button>
        </div>
      </div>

      <ProfileDialog v-model:open="profileOpen" :user-id="profileUserId" />
      <MessageActionsSheet
        v-model:open="sheetOpen"
        :can-edit="!!sheetMsg && canEdit(sheetMsg)"
        :is-thread="isThread"
        @react="sheetReact"
        @reply="sheetReply"
        @edit="sheetEdit"
        @thread="sheetThread"
      />
    </div>
</template>

<style scoped>
/* A newly added reaction pill pops from 1.25x to its normal size (~0.15s).
   TransitionGroup enter never runs on the initial render, so existing
   reactions don't animate when a conversation opens. */
.pill-enter-active {
  transition: transform 0.15s ease-out;
}
.pill-enter-from {
  transform: scale(1.25);
}

/* When a reaction count changes, the number pops up and settles back. */
.count-enter-active {
  animation: count-pop 0.15s ease-out;
}
@keyframes count-pop {
  0% {
    transform: translateY(-0.35em) scale(1.25);
  }
  100% {
    transform: translateY(0) scale(1);
  }
}

/* Briefly highlight a message when jumped to from a reply quote. */
.reply-flash {
  animation: reply-flash 1.4s ease-out;
}
@keyframes reply-flash {
  0%,
  30% {
    background-color: rgb(59 130 246 / 0.18);
  }
  100% {
    background-color: transparent;
  }
}
</style>
