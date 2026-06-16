<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Conversation, ConversationMember, ConversationRole, Friend, ManagePolicy } from '@notes/shared';
import { canManageMembers } from '@notes/shared';
import { useChatStore } from '../stores/chat';
import { useFriendsStore } from '../stores/friends';
import { useSessionStore } from '../stores/session';
import AppModal from './AppModal.vue';
import IconUserPlus from '~icons/mynaui/user-plus';
import IconUserX from '~icons/mynaui/user-x';
import IconLogout from '~icons/mynaui/logout';
import IconStar from '~icons/mynaui/star';
import IconShield from '~icons/mynaui/shield';
import IconCog from '~icons/mynaui/cog';

const props = defineProps<{ conversation: Conversation }>();
const open = defineModel<boolean>('open', { default: false });

const chat = useChatStore();
const friends = useFriendsStore();
const session = useSessionStore();

const busy = ref(false);
const error = ref('');
const history = ref<'share' | 'fresh'>('share');

watch(open, (o) => {
  if (!o) {
    error.value = '';
    busy.value = false;
    history.value = 'share';
  }
});

const meId = computed(() => session.user?.id);
const myRole = computed(() => props.conversation.myRole);
const isOwner = computed(() => myRole.value === 'owner');
const canManage = computed(() => canManageMembers(props.conversation.managePolicy, myRole.value));

const ROLE_RANK: Record<ConversationRole, number> = { owner: 0, admin: 1, member: 2 };
const members = computed(() =>
  [...props.conversation.members].sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.displayName.localeCompare(b.displayName),
  ),
);

// Friends who can be added: have a public key and aren't already in the group.
const eligible = computed(() => {
  const inGroup = new Set(props.conversation.members.map((m) => m.userId));
  return [...friends.friends]
    .filter((f) => f.publicKey && !inGroup.has(f.userId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

const POLICY_LABELS: Record<ManagePolicy, string> = {
  owner: 'Only the owner can add or remove members',
  admins: 'The owner and admins can manage members',
  open: 'Any member can add or remove members',
};

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'action failed';
  } finally {
    busy.value = false;
  }
}

const add = (f: Friend) => run(() => chat.addMember(props.conversation.id, f, history.value));
const remove = (m: ConversationMember) => run(() => chat.removeMember(props.conversation.id, m.userId));
const leave = () =>
  run(async () => {
    await chat.removeMember(props.conversation.id, meId.value!);
    open.value = false;
  });
const setRole = (m: ConversationMember, role: 'admin' | 'member') =>
  run(() => chat.setMemberRole(props.conversation.id, m.userId, role));
const setPolicy = (e: Event) =>
  run(() => chat.setManagePolicy(props.conversation.id, (e.target as HTMLSelectElement).value as ManagePolicy));
</script>

<template>
  <AppModal v-model:open="open" title="Members" :description="`${members.length} in this group`">
    <!-- Current members -->
    <ul class="pb-2">
      <li
        v-for="m in members"
        :key="m.userId"
        class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
          {{ initial(m.displayName) }}
        </span>
        <span class="min-w-0 grow truncate text-sm font-medium">
          {{ m.displayName }}<span v-if="m.userId === meId" class="text-zinc-400"> (you)</span>
        </span>
        <span
          v-if="m.role === 'owner'"
          class="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
        >
          <IconStar class="h-3 w-3" /> Owner
        </span>
        <span
          v-else-if="m.role === 'admin'"
          class="flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-400"
        >
          <IconShield class="h-3 w-3" /> Admin
        </span>

        <!-- Owner can promote/demote any non-owner member. -->
        <button
          v-if="isOwner && m.userId !== meId && m.role !== 'owner'"
          class="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
          :disabled="busy"
          @click="setRole(m, m.role === 'admin' ? 'member' : 'admin')"
        >
          {{ m.role === 'admin' ? 'Revoke admin' : 'Make admin' }}
        </button>
        <!-- Anyone allowed to manage can remove a non-owner; you can always leave. -->
        <button
          v-if="m.userId === meId"
          class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
          :disabled="busy"
          title="Leave group"
          @click="leave"
        >
          <IconLogout class="h-4 w-4" /> Leave
        </button>
        <button
          v-else-if="canManage && m.role !== 'owner'"
          class="flex shrink-0 items-center rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          :disabled="busy"
          title="Remove from group"
          @click="remove(m)"
        >
          <IconUserX class="h-4 w-4" />
        </button>
      </li>
    </ul>

    <!-- Add members (only when allowed to manage) -->
    <div v-if="canManage" class="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="flex items-center gap-1.5 text-sm font-semibold"><IconUserPlus class="h-4 w-4" /> Add a friend</p>
        <!-- Per-add history choice (the spec's inviter-decides flag). -->
        <div class="flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
          <button
            class="px-2 py-1"
            :class="history === 'share' ? 'bg-blue-600 text-white' : 'text-zinc-500'"
            @click="history = 'share'"
          >
            Share history
          </button>
          <button
            class="px-2 py-1"
            :class="history === 'fresh' ? 'bg-blue-600 text-white' : 'text-zinc-500'"
            @click="history = 'fresh'"
          >
            Start fresh
          </button>
        </div>
      </div>
      <ul>
        <li v-for="f in eligible" :key="f.userId">
          <button
            class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
            :disabled="busy"
            @click="add(f)"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
              {{ initial(f.displayName) }}
            </span>
            <span class="min-w-0 grow truncate text-sm font-medium">{{ f.displayName }}</span>
            <IconUserPlus class="h-4 w-4 shrink-0 text-zinc-400" />
          </button>
        </li>
        <li v-if="!eligible.length" class="px-2 py-4 text-center text-sm text-zinc-400">
          No friends left to add.
        </li>
      </ul>
    </div>

    <!-- Owner-only: who may manage membership -->
    <div v-if="isOwner" class="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p class="mb-2 flex items-center gap-1.5 text-sm font-semibold"><IconCog class="h-4 w-4" /> Who can manage members</p>
      <select
        class="w-full rounded-lg border border-zinc-300 bg-white py-2 px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        :value="conversation.managePolicy"
        :disabled="busy"
        @change="setPolicy"
      >
        <option v-for="(label, value) in POLICY_LABELS" :key="value" :value="value">{{ label }}</option>
      </select>
    </div>

    <p v-if="error" class="pt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
  </AppModal>
</template>
