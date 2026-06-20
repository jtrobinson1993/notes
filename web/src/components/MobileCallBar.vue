<script setup lang="ts">
import IconMic from '~icons/mynaui/microphone';
import IconMicOff from '~icons/mynaui/microphone-off';
import IconHeadphones from '~icons/mynaui/headphones';
import IconVolumeOff from '~icons/mynaui/volume-off';
import IconHangup from '~icons/mynaui/telephone-off';
import { useVoiceStore } from '../stores/voice';
import ChatAvatar from './ChatAvatar.vue';

// In-call controls + speaking indicators as a top bar on mobile. Rendered in the
// app's flex column above everything, so the rest of the app shrinks below it
// (you can still see the top of the current screen).
const voice = useVoiceStore();

const btn = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg';
const neutral = 'bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700';
const muted = 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400';
</script>

<template>
  <div
    v-if="voice.inCall"
    class="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
  >
    <span class="shrink-0 truncate text-sm font-semibold">{{ voice.activeRoomName ?? 'Voice' }}</span>
    <!-- Speaking indicators. p-0.5 keeps the ring off the scroll clip edge. -->
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-0.5">
      <ChatAvatar
        name="You"
        class="h-7 w-7 shrink-0 text-xs"
        :class="voice.localSpeaking && !voice.micMuted ? 'ring-2 ring-green-500' : ''"
      />
      <ChatAvatar
        v-for="p in voice.peerList"
        :key="p.userId"
        :name="p.displayName"
        :seed="p.userId"
        class="h-7 w-7 shrink-0 text-xs"
        :class="p.speaking ? 'ring-2 ring-green-500' : ''"
      />
    </div>
    <button :class="[btn, voice.micMuted ? muted : neutral]" :title="voice.muted ? 'Unmute' : 'Mute'" @click="voice.toggleMute()">
      <component :is="voice.micMuted ? IconMicOff : IconMic" class="h-4 w-4" />
    </button>
    <button :class="[btn, voice.deafened ? muted : neutral]" :title="voice.deafened ? 'Undeafen' : 'Deafen'" @click="voice.toggleDeafen()">
      <component :is="voice.deafened ? IconVolumeOff : IconHeadphones" class="h-4 w-4" />
    </button>
    <button :class="[btn, 'bg-red-600 text-white hover:bg-red-700']" title="Leave call" @click="voice.leave()">
      <IconHangup class="h-4 w-4" />
    </button>
  </div>
</template>
