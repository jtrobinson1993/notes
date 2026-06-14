<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui';
import type { Conversation } from '@notes/shared';
import { useChatStore } from '../stores/chat';
import { useFriendsStore } from '../stores/friends';
import { useSessionStore } from '../stores/session';
import IconPanelLeftOpen from '~icons/mynaui/panel-left-open';
import IconPanelLeftClose from '~icons/mynaui/panel-left-close';
import IconPen from '~icons/mynaui/pen';

const session = useSessionStore();
const chat = useChatStore();
const friends = useFriendsStore();
const router = useRouter();

const STORAGE_KEY = 'sidebar-expanded';
const expanded = ref(localStorage.getItem(STORAGE_KEY) === '1');

function toggle() {
  expanded.value = !expanded.value;
  localStorage.setItem(STORAGE_KEY, expanded.value ? '1' : '0');
}

const newChatOpen = ref(false);

/** For a DM, the member who isn't me; otherwise the first member. */
function otherMember(conv: Conversation) {
  const meId = session.user?.id;
  return conv.members.find((m) => m.userId !== meId) ?? conv.members[0];
}

function convName(conv: Conversation): string {
  return otherMember(conv)?.displayName || 'Conversation';
}

function convInitial(conv: Conversation): string {
  return (convName(conv).trim()[0] ?? '?').toUpperCase();
}

const sortedConversations = computed(() =>
  [...chat.conversations].sort((a, b) => b.lastSeq - a.lastSeq),
);

const activeConvId = computed(() => {
  const m = /^\/chat\/(.+)$/.exec(router.currentRoute.value.path);
  return m ? m[1] : null;
});

async function startDm(userId: string) {
  newChatOpen.value = false;
  const friend = friends.friends.find((f) => f.userId === userId);
  if (!friend) return;
  try {
    const convId = await chat.openDm(friend);
    router.push(`/chat/${convId}`);
  } catch {
    // openDm can throw if the friend has no public key; fall back to friends view.
    router.push('/friends');
  }
}
</script>

<template>
  <nav
    class="flex shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    :class="expanded ? 'w-56' : 'w-14'"
  >
    <!-- Top: new chat -->
    <div class="flex flex-col gap-1 p-2">
      <PopoverRoot v-model:open="newChatOpen">
        <PopoverTrigger
          class="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800"
          :class="expanded ? '' : 'justify-center'"
          title="New chat"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-base leading-none text-white">+</span>
          <span v-if="expanded" class="truncate">New chat</span>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="right"
            align="start"
            :side-offset="6"
            class="z-30 w-56 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p class="px-3 py-1.5 text-xs font-medium text-zinc-400">Start a chat</p>
            <button
              v-for="f in friends.friends"
              :key="f.userId"
              class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              @click="startDm(f.userId)"
            >
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
                {{ (f.displayName.trim()[0] ?? '?').toUpperCase() }}
              </span>
              <span class="truncate">{{ f.displayName }}</span>
            </button>
            <p v-if="!friends.friends.length" class="px-3 py-2 text-xs text-zinc-400">No friends yet</p>
            <RouterLink
              to="/friends"
              class="mt-1 block border-t border-zinc-100 px-3 py-1.5 text-sm text-blue-600 hover:underline dark:border-zinc-800 dark:text-blue-400"
              @click="newChatOpen = false"
            >
              Manage friends…
            </RouterLink>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <!-- Conversations + Notes -->
    <div class="min-h-0 grow overflow-y-auto px-2">
      <RouterLink
        v-for="conv in sortedConversations"
        :key="conv.id"
        :to="`/chat/${conv.id}`"
        class="relative flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-zinc-200 dark:hover:bg-zinc-800"
        :class="[
          expanded ? '' : 'justify-center',
          activeConvId === conv.id
            ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
            : 'text-zinc-700 dark:text-zinc-200',
        ]"
        :title="convName(conv)"
      >
        <span class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100">
          {{ convInitial(conv) }}
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

      <!-- Notes, below the chats, in flow -->
      <RouterLink
        to="/"
        class="mt-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800"
        :class="expanded ? '' : 'justify-center'"
        title="Notes"
      >
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800">
          <IconPen class="h-4 w-4" />
        </span>
        <span v-if="expanded" class="truncate">Notes</span>
      </RouterLink>
    </div>

    <!-- Bottom: expand/collapse toggle -->
    <div class="p-2">
      <button
        class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
        :class="expanded ? '' : 'justify-center'"
        :title="expanded ? 'Collapse' : 'Expand'"
        @click="toggle"
      >
        <IconPanelLeftClose v-if="expanded" class="h-5 w-5 shrink-0" />
        <IconPanelLeftOpen v-else class="h-5 w-5 shrink-0" />
        <span v-if="expanded" class="truncate">Collapse</span>
      </button>
    </div>
  </nav>
</template>
