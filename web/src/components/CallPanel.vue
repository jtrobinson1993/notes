<script setup lang="ts">
import { computed } from 'vue';
import IconMic from '~icons/mynaui/microphone';
import IconMicOff from '~icons/mynaui/microphone-off';
import IconHeadphones from '~icons/mynaui/headphones';
import IconVolumeOff from '~icons/mynaui/volume-off';
import IconHangup from '~icons/mynaui/telephone-off';
import IconSignal from '~icons/mynaui/signal';
import { useVoiceStore } from '../stores/voice';
import { formatKeyCode, pttKey } from '../lib/voicePrefs';
import ChatAvatar from './ChatAvatar.vue';

// Lives at the bottom of the chat sidebar. `collapsed` renders just the
// essential buttons (mic / deafen / hangup) stacked vertically.
defineProps<{ collapsed?: boolean }>();

const voice = useVoiceStore();

const qualityColor = computed(
  () =>
    ({ good: 'text-green-500', fair: 'text-amber-500', poor: 'text-red-500', unknown: 'text-zinc-400' })[
      voice.connectionQuality
    ],
);
const qualityLabel = computed(() => `Connection: ${voice.connectionQuality}`);

const btnBase = 'flex items-center justify-center rounded-lg p-2';
const btnNeutral = 'bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700';
const btnActive = 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400';
</script>

<template>
  <div v-if="voice.inCall" class="shrink-0 border-t border-zinc-200 dark:border-zinc-800">
    <!-- Collapsed: just mic / deafen / hangup, stacked. -->
    <div v-if="collapsed" class="flex flex-col items-center gap-1.5 px-1.5 pt-1.5">
      <button :class="[btnBase, voice.micMuted ? btnActive : btnNeutral]" :title="voice.muted ? 'Unmute' : 'Mute'" @click="voice.toggleMute()">
        <component :is="voice.micMuted ? IconMicOff : IconMic" class="h-4 w-4" />
      </button>
      <button :class="[btnBase, voice.deafened ? btnActive : btnNeutral]" :title="voice.deafened ? 'Undeafen' : 'Deafen'" @click="voice.toggleDeafen()">
        <component :is="voice.deafened ? IconVolumeOff : IconHeadphones" class="h-4 w-4" />
      </button>
      <button :class="[btnBase, 'bg-red-600 text-white hover:bg-red-700']" title="Leave call" @click="voice.leave()">
        <IconHangup class="h-4 w-4" />
      </button>
    </div>

    <!-- Expanded: room + connection, roster, controls. -->
    <div v-else class="px-3 py-2">
      <div class="mb-2 flex items-center gap-2">
        <span class="grow truncate text-sm font-semibold">{{ voice.activeRoomName ?? 'Voice' }}</span>
        <IconSignal class="h-4 w-4" :class="qualityColor" :title="qualityLabel" />
        <span v-if="voice.connecting" class="text-xs text-zinc-500">connecting…</span>
      </div>

      <p v-if="voice.error" class="mb-2 text-xs text-red-600 dark:text-red-400">{{ voice.error }}</p>

      <!-- p-1 keeps the green speaking ring (ring-2) off the scroll clip edges. -->
      <ul class="mb-2 max-h-40 space-y-1 overflow-y-auto p-1">
        <li class="flex items-center gap-2">
          <ChatAvatar name="You" class="h-7 w-7 text-xs" :class="voice.localSpeaking && !voice.micMuted ? 'ring-2 ring-green-500' : ''" />
          <span class="grow truncate text-sm">You</span>
          <IconMicOff v-if="voice.micMuted" class="h-4 w-4 text-red-500" :title="voice.deafened ? 'Mic muted (deafened)' : 'Muted'" />
        </li>
        <li v-for="p in voice.peerList" :key="p.userId" class="flex items-center gap-2">
          <ChatAvatar :name="p.displayName" :seed="p.userId" class="h-7 w-7 text-xs" :class="p.speaking ? 'ring-2 ring-green-500' : ''" />
          <span class="min-w-0 grow truncate text-sm">{{ p.displayName }}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="p.volume"
            class="w-16 accent-blue-600"
            :title="`Volume for ${p.displayName}`"
            @input="voice.setVolume(p.userId, Number(($event.target as HTMLInputElement).value))"
          />
        </li>
      </ul>

      <div class="flex items-center gap-1.5">
        <button :class="[btnBase, voice.micMuted ? btnActive : btnNeutral]" :title="voice.deafened ? 'Mic muted (deafened — undeafen to talk)' : voice.muted ? 'Unmute' : 'Mute'" @click="voice.toggleMute()">
          <component :is="voice.micMuted ? IconMicOff : IconMic" class="h-4 w-4" />
        </button>
        <button :class="[btnBase, voice.deafened ? btnActive : btnNeutral]" :title="voice.deafened ? 'Undeafen' : 'Deafen'" @click="voice.toggleDeafen()">
          <component :is="voice.deafened ? IconVolumeOff : IconHeadphones" class="h-4 w-4" />
        </button>
        <!-- Push-to-talk hold button (mouse fallback). PTT mode + the optional
             key are configured in Settings → Voice. -->
        <button
          v-if="voice.pushToTalk"
          class="grow rounded-lg bg-zinc-200 py-2 text-xs font-medium hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          :title="pttKey ? `Hold to talk (or hold ${formatKeyCode(pttKey)})` : 'Hold to talk'"
          @pointerdown="voice.setPttHeld(true)"
          @pointerup="voice.setPttHeld(false)"
          @pointerleave="voice.setPttHeld(false)"
        >
          Hold to talk<span v-if="pttKey" class="ml-1 text-zinc-500 dark:text-zinc-400">({{ formatKeyCode(pttKey) }})</span>
        </button>
        <span v-else class="grow"></span>
        <button :class="[btnBase, 'bg-red-600 text-white hover:bg-red-700']" title="Leave call" @click="voice.leave()">
          <IconHangup class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
</template>
