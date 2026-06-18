<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from './AppModal.vue';
import EmojiText from './EmojiText.vue';
import { useChatStore } from '../stores/chat';
import { useSessionStore } from '../stores/session';
import type { ChannelInfo, Conversation } from '@notes/shared';
import IconCheck from '~icons/mynaui/check';

// Manage who can access a PRIVATE channel: toggling grants or revokes a
// conversation member (each change re-keys the channel). Granting/revoking does
// NOT expose past plaintext a removed member already held (documented boundary).
const props = defineProps<{ conversation: Conversation; channel: ChannelInfo }>();
const open = defineModel<boolean>('open', { default: false });
const chat = useChatStore();
const session = useSessionStore();
const meId = computed(() => session.user?.id);
const busy = ref<string | null>(null);
const error = ref('');

// Re-read the channel from the store so member changes reflect live.
const live = computed(
  () => chat.conversations.find((c) => c.id === props.conversation.id)?.channels.find((ch) => ch.id === props.channel.id) ?? props.channel,
);
const isMember = (id: string) => live.value.memberIds.includes(id);

async function toggle(userId: string) {
  if (userId === meId.value || busy.value) return; // can't toggle yourself here
  busy.value = userId;
  error.value = '';
  try {
    if (isMember(userId)) await chat.revokeChannelMember(props.conversation.id, props.channel.id, userId);
    else await chat.grantChannelMember(props.conversation.id, props.channel.id, userId, 'fresh');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'failed';
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <AppModal v-model:open="open" :title="`Members of #${channel.name}`" description="Private channel — only these members can read it. Changes re-key the channel; a removed member can't read new messages." max-width="sm:max-w-sm">
    <ul class="space-y-0.5 pb-2">
      <li v-for="m in conversation.members" :key="m.userId">
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-800"
          :disabled="m.userId === meId || busy === m.userId"
          @click="toggle(m.userId)"
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="isMember(m.userId) ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 dark:border-zinc-600'">
            <IconCheck v-if="isMember(m.userId)" class="h-3 w-3" />
          </span>
          <span class="min-w-0 grow truncate"><EmojiText :text="m.displayName" /></span>
          <span v-if="m.userId === meId" class="shrink-0 text-xs text-zinc-400">you</span>
        </button>
      </li>
    </ul>
    <p v-if="error" class="px-1 pb-1 text-sm text-red-500">{{ error }}</p>
  </AppModal>
</template>
