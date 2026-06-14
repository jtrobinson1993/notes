<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import MarkdownView from '../components/MarkdownView.vue';
import ChatAvatar from '../components/ChatAvatar.vue';
import type { Conversation } from '@notes/shared';
import { useChatStore, type ChatMessageView } from '../stores/chat';
import { useSessionStore } from '../stores/session';

const route = useRoute();
const session = useSessionStore();
const chat = useChatStore();

const convId = computed(() => String(route.params.id));
const loading = ref(false);
const loadingOlder = ref(false);
const text = ref('');
const sending = ref(false);
const scroller = ref<HTMLElement>();

const conversation = computed<Conversation | undefined>(() =>
  chat.conversations.find((c) => c.id === convId.value),
);

const otherMember = computed(() => {
  const meId = session.user?.id;
  return conversation.value?.members.find((m) => m.userId !== meId) ?? conversation.value?.members[0];
});

const title = computed(() => otherMember.value?.displayName || 'Conversation');

const msgs = computed(() => chat.messages[convId.value] ?? []);

function memberName(senderId: string): string {
  return conversation.value?.members.find((m) => m.userId === senderId)?.displayName || 'Unknown';
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
    const isStart = !prev || prev.senderId !== m.senderId || m.createdAt - prev.createdAt > GROUP_GAP_MS;
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

async function scrollToBottom() {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function markReadHere() {
  const list = msgs.value;
  const last = list[list.length - 1];
  if (last) await chat.markRead(convId.value, last.seq);
}

async function activate(id: string) {
  chat.setActive(id);
  loading.value = true;
  try {
    if ((chat.messages[id]?.length ?? 0) === 0) {
      await chat.loadHistory(id);
    }
  } finally {
    loading.value = false;
  }
  await scrollToBottom();
  await markReadHere();
}

watch(convId, (id) => void activate(id), { immediate: true });

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
  if (!oldest || loadingOlder.value) return;
  loadingOlder.value = true;
  const el = scroller.value;
  const prevHeight = el?.scrollHeight ?? 0;
  try {
    await chat.loadHistory(convId.value, oldest.seq);
    await nextTick();
    if (el) el.scrollTop = el.scrollHeight - prevHeight;
  } finally {
    loadingOlder.value = false;
  }
}

function onScroll() {
  if (atBottom()) void markReadHere();
}

async function send() {
  const body = text.value.trim();
  if (!body || sending.value) return;
  sending.value = true;
  try {
    await chat.sendMessage(convId.value, body);
    text.value = '';
    await scrollToBottom();
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
          {{ (title.trim()[0] ?? '?').toUpperCase() }}
        </span>
        <p class="font-semibold">{{ title }}</p>
      </div>

      <div ref="scroller" class="min-h-0 grow overflow-y-auto py-2" @scroll="onScroll">
        <div v-if="msgs.length" class="flex justify-center py-2">
          <button
            :disabled="loadingOlder"
            class="rounded-lg px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
            @click="loadOlder"
          >
            {{ loadingOlder ? 'Loading…' : 'Load older messages' }}
          </button>
        </div>

        <div v-if="loading && !msgs.length" class="flex h-full items-center justify-center text-sm text-zinc-400">
          Loading…
        </div>
        <div v-else-if="!msgs.length" class="flex h-full items-center justify-center text-sm text-zinc-400">
          No messages yet — say hello.
        </div>

        <!-- One full-width row per message; the avatar gutter sits on the left.
             Messages align the same for everyone (no own-message special-case). -->
        <div
          v-for="row in rows"
          :key="row.key"
          class="group flex items-start gap-3 px-4 py-0.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          :class="row.isStart ? 'mt-3' : ''"
        >
          <!-- Left gutter: avatar at a group's first message; otherwise a
               hover-only timestamp for the consecutive message. -->
          <div class="w-10 shrink-0">
            <ChatAvatar v-if="row.isStart" :name="row.name" :seed="row.senderId" class="h-10 w-10 text-sm" />
            <time
              v-else
              class="hidden whitespace-nowrap pt-0.5 text-right text-[10px] leading-5 tabular-nums text-zinc-400 group-hover:block dark:text-zinc-500"
            >{{ formatTime(row.msg.createdAt) }}</time>
          </div>
          <!-- Content fills the rest of the width. -->
          <div class="min-w-0 grow text-sm">
            <div v-if="row.isStart" class="mb-0.5 flex items-baseline gap-2">
              <span class="font-medium text-zinc-700 dark:text-zinc-200">{{ row.name }}</span>
              <time class="text-xs text-zinc-400 dark:text-zinc-500">{{ formatTime(row.msg.createdAt) }}</time>
            </div>
            <div class="chat-message">
              <MarkdownView v-if="row.msg.text !== null" :source="row.msg.text" />
              <span v-else class="italic opacity-70">message could not be decrypted</span>
            </div>
          </div>
        </div>
      </div>

      <div class="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div class="flex items-end gap-2">
          <textarea
            v-model="text"
            rows="1"
            placeholder="Message…"
            class="max-h-40 grow resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            @keydown="onKeydown"
          />
          <button
            :disabled="!text.trim() || sending"
            class="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            @click="send"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
