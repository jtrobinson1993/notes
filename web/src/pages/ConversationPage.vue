<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import MarkdownView from '../components/MarkdownView.vue';
import type { Conversation } from '@notes/shared';
import { useChatStore } from '../stores/chat';
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

function isMine(senderId: string): boolean {
  return senderId === session.user?.id;
}

function memberName(senderId: string): string {
  return conversation.value?.members.find((m) => m.userId === senderId)?.displayName || 'Unknown';
}

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

      <div ref="scroller" class="min-h-0 grow space-y-2 overflow-y-auto p-4" @scroll="onScroll">
        <div v-if="msgs.length" class="flex justify-center">
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

        <div
          v-for="m in msgs"
          :key="m.seq"
          class="flex flex-col"
          :class="isMine(m.senderId) ? 'items-end' : 'items-start'"
        >
          <span v-if="!isMine(m.senderId)" class="mb-0.5 px-1 text-xs text-zinc-400">{{ memberName(m.senderId) }}</span>
          <div
            class="max-w-[80%] rounded-2xl px-3 py-2 text-sm"
            :class="isMine(m.senderId)
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'"
          >
            <MarkdownView v-if="m.text !== null" :source="m.text" />
            <span v-else class="italic opacity-70">message could not be decrypted</span>
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
