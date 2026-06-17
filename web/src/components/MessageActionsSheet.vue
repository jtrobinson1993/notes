<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import EmojiPicker from './EmojiPicker.vue';
import IconReply from '~icons/mynaui/message-reply';
import IconPencil from '~icons/mynaui/pencil';
import IconThread from '~icons/mynaui/chat-dots';

/**
 * Touch-only **bottom sheet** of per-message actions, opened by long-pressing a
 * message on a coarse pointer (the desktop hover toolbar is untouched). Same
 * reka-ui Dialog foundation as AppModal/AppDrawer (Escape / scrim-tap dismiss,
 * focus trap) but anchored to the bottom edge and sliding up.
 */
defineProps<{ canEdit?: boolean; isThread?: boolean }>();
const emit = defineEmits<{ react: [string]; reply: []; edit: []; thread: [] }>();
const open = defineModel<boolean>('open', { default: false });

// A handful of one-tap reactions; the picker covers everything else.
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function choose(action: 'reply' | 'edit' | 'thread') {
  if (action === 'reply') emit('reply');
  else if (action === 'edit') emit('edit');
  else emit('thread');
  open.value = false;
}
function react(emoji: string) {
  emit('react', emoji);
  open.value = false;
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="app-overlay fixed inset-0 z-modal bg-black/30" />
      <DialogContent
        class="app-sheet fixed inset-x-0 bottom-0 z-modal flex flex-col gap-1 rounded-t-2xl bg-white p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl focus:outline-none dark:bg-zinc-900"
      >
        <DialogTitle class="sr-only">Message actions</DialogTitle>
        <DialogDescription class="sr-only">React to, reply to, edit, or open a thread on this message.</DialogDescription>

        <!-- grab handle -->
        <div class="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700" />

        <!-- quick reactions + full picker -->
        <div class="mb-1 flex items-center gap-1 px-1">
          <button
            v-for="e in QUICK"
            :key="e"
            class="flex h-10 flex-1 items-center justify-center rounded-lg text-2xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
            @click="react(e)"
          >
            {{ e }}
          </button>
          <div class="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <EmojiPicker compact @pick="react" />
          </div>
        </div>

        <button
          class="flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          @click="choose('reply')"
        >
          <IconReply class="h-5 w-5 text-zinc-500" /> Reply
        </button>
        <button
          v-if="canEdit"
          class="flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          @click="choose('edit')"
        >
          <IconPencil class="h-5 w-5 text-zinc-500" /> Edit
        </button>
        <button
          v-if="!isThread"
          class="flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          @click="choose('thread')"
        >
          <IconThread class="h-5 w-5 text-zinc-500" /> Open thread
        </button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.app-sheet[data-state='open'] {
  animation: sheet-up 0.18s ease-out;
}
@keyframes sheet-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
</style>
