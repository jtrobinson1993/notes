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
import ActiveBar from './ActiveBar.vue';
import { conversationInitial, conversationTitle } from '../lib/convName';
import { chatPane, closeNote, isMobile, noteOpen, showChannels } from '../lib/mobileNav';
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
const expandedPref = ref(localStorage.getItem(STORAGE_KEY) === '1');
// The rail only ever expands on desktop; a phone keeps it a narrow icon strip.
const expanded = computed(() => !isMobile.value && expandedPref.value);

function toggle() {
  expandedPref.value = !expandedPref.value;
  localStorage.setItem(STORAGE_KEY, expandedPref.value ? '1' : '0');
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

// Highlight the active conversation/Notes in the rail — it stays visible beside
// the list on mobile too, so the indicator is meaningful there.
const isNotesActive = computed(() => router.currentRoute.value.path === '/');
function chatActive(id: string): boolean {
  return activeConvId.value === id;
}

// --- Mobile: the rail is a narrow icon strip shown beside an intermediary list
// (chat channels / notes list). It steps aside (hidden) only when a leaf owns
// the whole screen — a channel's messages or an open note — so you never land on
// a bare full-width menu. On desktop it's always the normal rail. ---
const railHidden = computed(() => {
  if (!isMobile.value) return false;
  const p = router.currentRoute.value.path;
  if (p.startsWith('/chat/')) {
    // Only step aside for a real, loaded conversation's messages — otherwise a
    // missing/not-yet-loaded chat would hide the rail into a blank screen.
    const id = activeConvId.value;
    return chatPane.value === 'messages' && !!id && chat.conversations.some((c) => c.id === id);
  }
  if (p === '/') return noteOpen.value;
  return false; // friends/settings keep the rail for navigation
});
const navClass = computed(() => {
  if (isMobile.value) return railHidden.value ? 'hidden' : 'w-14';
  return expandedPref.value ? 'w-56' : 'w-14';
});
</script>

<template>
  <nav
    class="flex shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    :class="navClass"
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
            class="group relative flex items-center gap-2 text-sm"
            @click="showChannels()"
            :class="[
              'px-2 py-1',
              expanded ? '' : 'justify-center',
              chatActive(conv.id) ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-200',
            ]"
          >
            <ActiveBar :active="chatActive(conv.id)" />
            <span
              class="relative flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-300 text-xs font-medium text-zinc-700 transition-[border-radius] duration-300 ease-[cubic-bezier(0.34,1.8,0.5,1)] dark:bg-zinc-700 dark:text-zinc-100"
              :class="chatActive(conv.id) ? 'rounded-xl icon-pop' : 'rounded-[18px] group-hover:rounded-xl'"
            >
              <img
                v-if="convIcon(conv)"
                :src="convIcon(conv) ?? undefined"
                alt=""
                class="absolute inset-0 h-full w-full object-cover transition-[border-radius] duration-300 ease-[cubic-bezier(0.34,1.8,0.5,1)]"
                :class="chatActive(conv.id) ? 'rounded-xl' : 'rounded-[18px] group-hover:rounded-xl'"
              />
              <template v-else>{{ convInitial(conv) }}</template>
              <span
                v-if="chat.unreadCount(conv.id) > 0 && !expanded"
                class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
              >
                {{ chat.unreadCount(conv.id) }}
              </span>
            </span>
            <span v-if="expanded" class="min-w-0 grow truncate">{{ convName(conv) }}</span>
            <span
              v-if="chat.unreadCount(conv.id) > 0 && expanded"
              class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
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
            class="group relative flex items-center gap-2 text-sm"
            @click="closeNote()"
            :class="[
              'px-2 py-1',
              expanded ? '' : 'justify-center',
              isNotesActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-200',
            ]"
          >
            <ActiveBar :active="isNotesActive" />
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-200 transition-[border-radius] duration-300 ease-[cubic-bezier(0.34,1.8,0.5,1)] dark:bg-zinc-700"
              :class="isNotesActive ? 'rounded-xl icon-pop' : 'rounded-[18px] group-hover:rounded-xl'"
            >
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
        <SidebarTooltip v-if="!isMobile" :label="expanded ? 'Collapse' : 'Expand'" :disabled="expanded">
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
