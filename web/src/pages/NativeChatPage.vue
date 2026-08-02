<script setup lang="ts">
// v8 local-first chat page (native shell only). Lays out the legacy three-column
// shape: the app rail (AppLayout) | this conversation's sidebar (#chat + pinned
// notes + folders) | the messages — with a pinned note opening over the chat. In
// the browser there is no native chat store, so the route redirects home.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import NativeChat from '../components/NativeChat.vue';
import NativeChatSidebar from '../components/NativeChatSidebar.vue';
import NoteEditor from '../components/NoteEditor.vue';
import { isNative } from '../lib/native';
import { nativeConversations } from '../lib/nativeConversations';
import { chatPane, isMobile, showChannels, showMessages } from '../lib/mobileNav';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';

const route = useRoute();
const router = useRouter();
const notes = useNotesStore();
const org = useOrgStore();

onMounted(async () => {
  if (!isNative) {
    void router.replace('/');
    return;
  }
  // Pinned notes live in the notes store + the personal org blob, and a chat can
  // be the first thing opened after unlock — load both here too (idempotent).
  void org.load();
  if (!notes.loaded) await notes.loadFromCache();
});

/** The conversation the route has open (`?open=dm:<id>|grp:<id>`), if any. */
const active = computed(() => {
  const key = route.query.open;
  if (typeof key !== 'string' || route.query.add === '1') return null;
  return nativeConversations.value.find((c) => c.key === key) ?? null;
});

// The note open over the chat (a sidebar pin). Cleared whenever the conversation
// changes, so switching chats never leaves the previous one's note on screen.
const openNoteId = ref<string | null>(null);
const openNote = computed(() => (openNoteId.value ? (notes.notes.get(openNoteId.value) ?? null) : null));
watch(() => active.value?.key, () => (openNoteId.value = null));

function selectChat(): void {
  openNoteId.value = null;
  showMessages();
}
function openNoteFromSidebar(id: string): void {
  openNoteId.value = id;
  showMessages(); // on a phone the note owns the screen, like a channel's messages
}

// On a phone the sidebar is a pane of its own (reached from the rail) and the
// messages/note take the whole screen; on desktop both are always side by side.
const showSidebar = computed(() => !!active.value && (!isMobile.value || chatPane.value === 'channels'));
const showMain = computed(() => !isMobile.value || chatPane.value === 'messages' || !active.value);
</script>

<template>
  <AppLayout>
    <div v-if="isNative" class="flex h-full min-h-0">
      <NativeChatSidebar
        v-if="showSidebar && active"
        :conversation-id="active.conversationId"
        :title="active.title"
        :open-note-id="openNoteId"
        :mobile="isMobile"
        @select="selectChat"
        @open-note="openNoteFromSidebar"
      />
      <div v-if="showMain" class="relative flex min-h-0 min-w-0 grow flex-col">
        <NativeChat :hide-list="true" />
        <!-- A pinned note, opened over the conversation. -->
        <div v-if="openNote" class="absolute inset-0 z-modal flex flex-col bg-zinc-50 dark:bg-zinc-950">
          <NoteEditor :note="openNote" closable @deleted="openNoteId = null" @close="openNoteId = null" />
        </div>
      </div>
    </div>
  </AppLayout>
</template>
