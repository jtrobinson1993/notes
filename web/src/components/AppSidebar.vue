<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { TooltipProvider } from 'reka-ui';
import AccountSwitcher from './AccountSwitcher.vue';
import SidebarTooltip from './SidebarTooltip.vue';
import ActiveBar from './ActiveBar.vue';
import { nativeConversations } from '../lib/nativeConversations';
import { lockVault } from '../lib/nativeVault';
import { chatPane, closeNote, isMobile, noteOpen, showChannels } from '../lib/mobileNav';
import IconPanelLeftOpen from '~icons/mynaui/panel-left-open';
import IconPanelLeftClose from '~icons/mynaui/panel-left-close';
import IconMessagePlus from '~icons/mynaui/message-plus';
import IconPen from '~icons/mynaui/pen';
import IconCog from '~icons/mynaui/cog';
import IconUsers from '~icons/mynaui/users';
import IconUserCircle from '~icons/mynaui/user-circle';
import IconLogout from '~icons/mynaui/logout';

const router = useRouter();

// There is no server session to end — "sign out" re-locks the vault (the
// local-first equivalent); NativeGate then shows the unlock wall and App.vue
// drops everything the master key decrypted.
async function logout() {
  await lockVault();
}

const STORAGE_KEY = 'sidebar-expanded';
const expandedPref = ref(localStorage.getItem(STORAGE_KEY) === '1');
// The rail only ever expands on desktop; a phone keeps it a narrow icon strip.
const expanded = computed(() => !isMobile.value && expandedPref.value);

function toggle() {
  expandedPref.value = !expandedPref.value;
  localStorage.setItem(STORAGE_KEY, expandedPref.value ? '1' : '0');
}

const accountSwitcherOpen = ref(false);

/** New chat: the chat surface's add panel. */
function newChat(): void {
  void router.push({ path: '/dm', query: { add: '1' } });
}

// A sidebar conversation is active when the chat surface has it open.
function chatActive(key: string): boolean {
  const r = router.currentRoute.value;
  return r.path === '/dm' && r.query.open === key;
}

// Highlight the active conversation/Notes in the rail — it stays visible beside
// the list on mobile too, so the indicator is meaningful there.
const isNotesActive = computed(() => router.currentRoute.value.path === '/');

// --- Mobile: the rail is a narrow icon strip shown beside an intermediary list
// (chat sidebar / notes list). It steps aside (hidden) only when a leaf owns the
// whole screen — a conversation's messages or an open note — so you never land
// on a bare full-width menu. On desktop it's always the normal rail. ---
const railHidden = computed(() => {
  if (!isMobile.value) return false;
  const r = router.currentRoute.value;
  if (r.path === '/dm') {
    // The messages (or a note over them) own the screen; the chat's sidebar pane
    // keeps the rail beside it. Only step aside for a real, loaded conversation,
    // so a missing one can never hide the rail into a blank screen.
    const key = r.query.open;
    return (
      chatPane.value === 'messages' &&
      typeof key === 'string' &&
      nativeConversations.value.some((c) => c.key === key)
    );
  }
  if (r.path === '/') return noteOpen.value;
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
      <!-- Top: new chat (opens the chat surface's add panel). -->
      <div class="flex flex-col gap-1 p-2">
        <SidebarTooltip label="New chat" :disabled="expanded">
          <button
            class="flex items-center gap-2 rounded-lg bg-blue-600 px-2 py-2 text-sm font-medium text-white hover:bg-blue-700"
            :class="expanded ? 'w-fit pr-3' : 'justify-center'"
            aria-label="New chat"
            @click="newChat"
          >
            <IconMessagePlus class="h-6 w-6 shrink-0" />
            <span v-if="expanded" class="truncate">New chat</span>
          </button>
        </SidebarTooltip>
      </div>
      <AccountSwitcher v-model:open="accountSwitcherOpen" />

      <!-- Conversations + Notes -->
      <div class="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
        <!-- DMs + groups (above Notes), title + icon from member/group name. -->
        <SidebarTooltip
          v-for="c in nativeConversations"
          :key="c.key"
          :label="c.title"
          :disabled="expanded"
        >
          <RouterLink
            :to="{ path: '/dm', query: { open: c.key } }"
            :aria-label="c.title"
            class="group relative flex items-center gap-2 px-2 py-1 text-sm"
            @click="showChannels()"
            :class="[
              expanded ? '' : 'justify-center',
              chatActive(c.key) ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-200',
            ]"
          >
            <ActiveBar :active="chatActive(c.key)" />
            <span
              class="relative flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-300 text-xs font-medium text-zinc-700 transition-[border-radius] duration-300 ease-[cubic-bezier(0.34,1.8,0.5,1)] dark:bg-zinc-700 dark:text-zinc-100"
              :class="chatActive(c.key) ? 'rounded-xl icon-pop' : 'rounded-[18px] group-hover:rounded-xl'"
            >
              {{ c.initial }}
              <span
                v-if="c.unread > 0 && !expanded"
                class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
              >
                {{ c.unread }}
              </span>
            </span>
            <span v-if="expanded" class="min-w-0 grow truncate">{{ c.title }}</span>
            <span
              v-if="c.unread > 0 && expanded"
              class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
            >
              {{ c.unread }}
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
        <SidebarTooltip label="Switch account" :disabled="expanded">
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 dark:text-zinc-400"
            :class="expanded ? 'hover:bg-zinc-200 dark:hover:bg-zinc-800' : 'justify-center'"
            aria-label="Switch account"
            @click="accountSwitcherOpen = true"
          >
            <IconUserCircle class="h-5 w-5 shrink-0" />
            <span v-if="expanded" class="truncate">Switch account</span>
          </button>
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
