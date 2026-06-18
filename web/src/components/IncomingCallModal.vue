<script setup lang="ts">
import IconAnswer from '~icons/mynaui/telephone-call';
import IconDecline from '~icons/mynaui/telephone-off';
import { useVoiceStore } from '../stores/voice';
import ChatAvatar from './ChatAvatar.vue';

const voice = useVoiceStore();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="voice.incomingCall"
      class="z-modal fixed inset-0 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
    >
      <div class="w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-xl dark:bg-zinc-900">
        <ChatAvatar
          :name="voice.incomingCall.fromDisplayName"
          :seed="voice.incomingCall.fromUserId"
          class="mx-auto mb-3 h-16 w-16 animate-pulse text-2xl"
        />
        <p class="text-lg font-semibold">{{ voice.incomingCall.fromDisplayName }}</p>
        <p class="mb-5 text-sm text-zinc-500 dark:text-zinc-400">Incoming voice call…</p>
        <div class="flex items-center justify-center gap-6">
          <button
            class="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700"
            title="Decline"
            @click="voice.declineCall()"
          >
            <IconDecline class="h-6 w-6" />
          </button>
          <button
            class="flex h-14 w-14 items-center justify-center rounded-full bg-green-600 text-white hover:bg-green-700"
            title="Answer"
            @click="voice.answerCall()"
          >
            <IconAnswer class="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
