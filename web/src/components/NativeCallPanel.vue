<script setup lang="ts">
// v8 voice call surface — a presentational panel driven by the VoiceCall engine
// state (spec/voice.md § v8). Purely visual: it renders the current call phase
// and emits control intents (accept / decline / hangup); the wiring
// (useNativeCall → createNativeCall) owns the engine + media. Hidden when idle.
import IconIn from '~icons/mynaui/telephone-in-solid';
import IconOff from '~icons/mynaui/telephone-off-solid';
import type { CallState } from '../lib/voiceCall';

defineProps<{
  state: CallState;
  /** The other party's display name (or handle), if known. */
  peerName?: string | null;
}>();

defineEmits<{
  accept: [];
  decline: [];
  hangup: [];
}>();
</script>

<template>
  <div
    v-if="state !== 'idle' && state !== 'ended'"
    data-testid="call-panel"
    class="fixed bottom-4 right-4 z-modal flex w-72 flex-col gap-3 rounded-xl border border-neutral-500/20 bg-neutral-900/95 p-4 text-white shadow-lg backdrop-blur"
  >
    <div class="flex items-center gap-2">
      <span class="relative flex h-2.5 w-2.5">
        <span
          v-if="state !== 'connected'"
          class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400/70"
        />
        <span
          class="relative inline-flex h-2.5 w-2.5 rounded-full"
          :class="state === 'connected' ? 'bg-green-500' : 'bg-green-400'"
        />
      </span>
      <div class="min-w-0">
        <p data-testid="call-status" class="text-sm font-medium">
          {{
            state === 'ringing'
              ? 'Incoming call'
              : state === 'dialing'
                ? 'Calling…'
                : state === 'connecting'
                  ? 'Connecting…'
                  : 'In call'
          }}
        </p>
        <p class="truncate text-xs opacity-70">{{ peerName || 'Unknown' }}</p>
      </div>
    </div>

    <!-- Incoming ring: accept or decline. -->
    <div v-if="state === 'ringing'" class="flex gap-2">
      <button
        data-testid="call-accept"
        class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-green-600 py-2 text-sm font-medium hover:bg-green-500"
        @click="$emit('accept')"
      >
        <IconIn class="h-4 w-4" /> Accept
      </button>
      <button
        data-testid="call-decline"
        class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-red-600 py-2 text-sm font-medium hover:bg-red-500"
        @click="$emit('decline')"
      >
        <IconOff class="h-4 w-4" /> Decline
      </button>
    </div>

    <!-- Outgoing / active: a single end-call action (engine.hangup). -->
    <button
      v-else
      data-testid="call-hangup"
      class="flex items-center justify-center gap-1 rounded-lg bg-red-600 py-2 text-sm font-medium hover:bg-red-500"
      @click="$emit('hangup')"
    >
      <IconOff class="h-4 w-4" />
      {{ state === 'connected' ? 'Hang up' : 'Cancel' }}
    </button>
  </div>
</template>
