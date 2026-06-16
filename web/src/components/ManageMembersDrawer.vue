<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Conversation, ConversationMember, ConversationRole } from '@notes/shared';
import { canManageMembers } from '@notes/shared';
import { useChatStore } from '../stores/chat';
import { useSessionStore } from '../stores/session';
import AppDrawer from './AppDrawer.vue';
import AddGroupMemberModal from './AddGroupMemberModal.vue';
import IconUserPlus from '~icons/mynaui/user-plus';
import IconX from '~icons/mynaui/x';
import IconLogout from '~icons/mynaui/logout';
import IconStar from '~icons/mynaui/star';
import IconShield from '~icons/mynaui/shield';

const props = defineProps<{ conversation: Conversation }>();
const open = defineModel<boolean>('open', { default: false });

const chat = useChatStore();
const session = useSessionStore();

const busy = ref(false);
const error = ref('');
const showAdd = ref(false);

watch(open, (o) => {
  if (!o) {
    error.value = '';
    busy.value = false;
  }
});

const meId = computed(() => session.user?.id);
// Owners and admins can manage; admins have the same powers as the owner, except
// they can never remove (or demote) the owner.
const canManage = computed(() => canManageMembers(props.conversation.myRole));

const ROLE_RANK: Record<ConversationRole, number> = { owner: 0, admin: 1, member: 2 };
const members = computed(() =>
  [...props.conversation.members].sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.displayName.localeCompare(b.displayName),
  ),
);

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

const remove = (m: ConversationMember) => run(() => chat.removeMember(props.conversation.id, m.userId));
const leave = () =>
  run(async () => {
    await chat.removeMember(props.conversation.id, meId.value!);
    open.value = false;
  });
const setRole = (m: ConversationMember, role: 'admin' | 'member') =>
  run(() => chat.setMemberRole(props.conversation.id, m.userId, role));

// You can manage another member (remove / change role) when you have manage
// rights and they aren't the owner — and it isn't yourself.
const canManageMember = (m: ConversationMember) =>
  canManage.value && m.role !== 'owner' && m.userId !== meId.value;
</script>

<template>
  <AppDrawer v-model:open="open" title="Members" :description="`${members.length} in this group`">
    <!-- Add a friend → opens the standard picker modal. -->
    <button
      v-if="canManage"
      class="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      @click="showAdd = true"
    >
      <IconUserPlus class="h-4 w-4" /> Add friend
    </button>

    <ul class="-mx-2">
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

        <!-- Owner/admins can grant or revoke admin on any non-owner member. -->
        <button
          v-if="canManageMember(m)"
          class="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
          :disabled="busy"
          @click="setRole(m, m.role === 'admin' ? 'member' : 'admin')"
        >
          {{ m.role === 'admin' ? 'Revoke admin' : 'Make admin' }}
        </button>
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
          v-else-if="canManageMember(m)"
          class="flex shrink-0 items-center rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          :disabled="busy"
          title="Remove from group"
          @click="remove(m)"
        >
          <IconX class="h-4 w-4" />
        </button>
      </li>
    </ul>

    <p v-if="error" class="pt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

    <AddGroupMemberModal v-model:open="showAdd" :conversation="conversation" />
  </AppDrawer>
</template>
