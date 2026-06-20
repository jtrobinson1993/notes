<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { TooltipProvider } from 'reka-ui';
import type { Conversation } from '@notes/shared';
import { useChatStore } from '../stores/chat';
import { useSessionStore } from '../stores/session';
import { useNotesStore } from '../stores/notes';
import NewChatModal from './NewChatModal.vue';
import SidebarTooltip from './SidebarTooltip.vue';
import { conversationInitial, conversationTitle } from '../lib/convName';
import IconPanelLeftOpen from '~icons/mynaui/panel-left-open';
import IconPanelLeftClose from '~icons/mynaui/panel-left-close';
import IconMessagePlus from '~icons/mynaui/message-plus';
import IconPen from '~icons/mynaui/pen';
import IconLock from '~icons/mynaui/lock';
import IconCog from '~icons/mynaui/cog';
import IconUsers from '~icons/mynaui/users';
import IconLogout from '~icons/mynaui/logout';

const session = useSessionStore();
const chat = useChatStore();
const notes = useNotesStore();
const router = useRouter();

async function logout() {
  await session.logout();
  notes.reset();
  router.push('/login');
}

const STORAGE_KEY = 'sidebar-expanded';
const expanded = ref(localStorage.getItem(STORAGE_KEY) === '1');

function toggle() {
  expanded.value = !expanded.value;
  localStorage.setItem(STORAGE_KEY, expanded.value ? '1' : '0');
}

const newChatOpen = ref(false);

function convName(conv: Conversation): string {
  return conversationTitle(conv, session.user?.id);
}

function convInitial(conv: Conversation): string {
  return conversationInitial(conv, session.user?.id);
}

// Decrypted group-icon data URL for a conversation (groups only; null otherwise).
// Reactive via the chat store's groupIcons map, so renaming/changing the icon
// reflects here without a reload.
function convIcon(conv: Conversation): string | null {
  return conv.kind === 'group' ? chat.groupIconUrl(conv.id) : null;
}

const sortedConversations = computed(() =>
  // Threads aren't top-level entries — they're reached from their parent message.
  chat.conversations.filter((c) => c.kind !== 'thread').sort((a, b) => b.lastSeq - a.lastSeq),
);

const activeConvId = computed(() => {
  const m = /^\/chat\/(.+)$/.exec(router.currentRoute.value.path);
  return m ? m[1] : null;
});

const isNotesActive = computed(() => router.currentRoute.value.path === '/');
</script>

<template>
  <nav
    class="flex shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    :class="expanded ? 'w-56' : 'w-14'"
  >
    <TooltipProvider :delay-duration="0" :skip-delay-duration="0">
      <!-- Top: new chat -->
      <div class="flex flex-col gap-1 p-2">
        <SidebarTooltip label="New chat" :disabled="expanded">
          <button
            class="flex items-center gap-2 rounded-lg bg-blue-600 px-2 py-2 text-sm font-medium text-white hover:bg-blue-700"
            :class="expanded ? 'w-fit pr-3' : 'justify-center'"
            aria-label="New chat"
            @click="newChatOpen = true"
          >
            <IconMessagePlus class="h-6 w-6 shrink-0" />
            <span v-if="expanded" class="truncate">New chat</span>
          </button>
        </SidebarTooltip>
      </div>
      <NewChatModal v-model:open="newChatOpen" />

      <!-- Conversations + Notes -->
      <div class="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
        <SidebarTooltip
          v-for="conv in sortedConversations"
          :key="conv.id"
          :label="convName(conv)"
          :disabled="expanded"
        >
          <RouterLink
            :to="`/chat/${conv.id}`"
            :aria-label="convName(conv)"
            class="relative flex items-center gap-2 p-1 text-sm"
            :class="[
              expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center',
              activeConvId === conv.id
                ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-700 dark:text-zinc-200',
            ]"
          >
            <span class="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100">
              <img
                v-if="convIcon(conv)"
                :src="convIcon(conv) ?? undefined"
                alt=""
                class="absolute inset-0 h-full w-full rounded-full object-cover"
              />
              <template v-else>{{ convInitial(conv) }}</template>
              <span
                v-if="chat.unreadCount(conv.id) > 0 && !expanded"
                class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white"
              >
                {{ chat.unreadCount(conv.id) }}
              </span>
            </span>
            <span v-if="expanded" class="min-w-0 grow truncate">{{ convName(conv) }}</span>
            <span
              v-if="chat.unreadCount(conv.id) > 0 && expanded"
              class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white"
            >
              {{ chat.unreadCount(conv.id) }}
            </span>
          </RouterLink>
        </SidebarTooltip>

        <!-- Notes, below the chats, in flow -->
        <SidebarTooltip label="Notes" :disabled="expanded">
          <RouterLink
            to="/"
            aria-label="Notes"
            class="flex items-center gap-2 p-1 text-sm"
            :class="[
              expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center',
              isNotesActive
                ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-700 dark:text-zinc-200',
            ]"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
              <IconPen class="h-4 w-4" />
            </span>
            <span v-if="expanded" class="truncate">Notes</span>
          </RouterLink>
        </SidebarTooltip>
      </div>

      <!-- Bottom: fixed controls (the chat/note list scrolls underneath). A line
           separates them from the list above. -->
      <div class="shrink-0 border-t border-zinc-200 p-2 dark:border-zinc-800">
        <p
          v-if="expanded && (notes.syncing || notes.syncError)"
          class="px-2 pb-1 text-xs"
          :class="notes.syncError ? 'text-amber-500' : 'text-zinc-400'"
          :title="notes.syncError || ''"
        >
          {{ notes.syncError ? 'offline' : 'syncing…' }}
        </p>
        <SidebarTooltip :label="expanded ? 'Collapse' : 'Expand'" :disabled="expanded">
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
            :aria-label="expanded ? 'Collapse' : 'Expand'"
            @click="toggle"
          >
            <IconPanelLeftClose v-if="expanded" class="h-5 w-5 shrink-0" />
            <IconPanelLeftOpen v-else class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Collapse</span>
          </button>
        </SidebarTooltip>
        <SidebarTooltip v-if="session.unlocked" label="Lock now" :disabled="expanded">
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
            aria-label="Lock now"
            @click="session.lock()"
          >
            <IconLock class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Lock</span>
          </button>
        </SidebarTooltip>
        <SidebarTooltip label="Friends" :disabled="expanded">
          <RouterLink
            to="/friends"
            aria-label="Friends"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
          >
            <IconUsers class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Friends</span>
          </RouterLink>
        </SidebarTooltip>
        <SidebarTooltip label="Settings" :disabled="expanded">
          <RouterLink
            to="/settings"
            aria-label="Settings"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
          >
            <IconCog class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Settings</span>
          </RouterLink>
        </SidebarTooltip>
        <SidebarTooltip label="Sign out" :disabled="expanded">
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
            aria-label="Sign out"
            @click="logout"
          >
            <IconLogout class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Sign out</span>
          </button>
        </SidebarTooltip>
      </div>
    </TooltipProvider>
  </nav>
</template>
