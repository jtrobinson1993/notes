<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ConversationView from '../components/ConversationView.vue';
import { useChatStore } from '../stores/chat';

const route = useRoute();
const chat = useChatStore();

const convId = computed(() => String(route.params.id));
// The thread shown in the side panel (a thread is itself a conversation id).
const activeThread = ref<string | null>(null);

async function onOpenThread(seq: number) {
  try {
    activeThread.value = await chat.openThread(convId.value, seq);
  } catch {
    /* member missing a public key, etc. */
  }
}

// Switching the main conversation closes any open thread panel.
watch(convId, () => {
  activeThread.value = null;
});
</script>

<template>
  <AppLayout>
    <!-- Container query on the chat region (not the viewport): the available
         width depends on the sidebar state too. Wide enough → thread opens as a
         right-hand panel; otherwise it slides over the whole chat. -->
    <div class="@container/chat relative flex h-full">
      <div class="min-w-0 flex-1">
        <ConversationView :conv-id="convId" @open-thread="onOpenThread" />
      </div>

      <Transition
        enter-active-class="transition-transform duration-200 ease-out"
        leave-active-class="transition-transform duration-150 ease-in"
        enter-from-class="translate-x-full"
        leave-to-class="translate-x-full"
      >
        <div
          v-if="activeThread"
          :key="activeThread"
          class="h-full w-88 shrink-0 border-l border-zinc-200 dark:border-zinc-800 @max-3xl/chat:absolute @max-3xl/chat:inset-0 @max-3xl/chat:z-20 @max-3xl/chat:w-full @max-3xl/chat:bg-white @max-3xl/chat:dark:bg-zinc-900"
        >
          <ConversationView
            :conv-id="activeThread"
            is-thread-panel
            @open-thread="onOpenThread"
            @close="activeThread = null"
          />
        </div>
      </Transition>
    </div>
  </AppLayout>
</template>
