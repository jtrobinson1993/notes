<script setup lang="ts">
// v8 native DM surface (D4b/D6/D11): a self-contained friends + DM experience
// built on the native layers (nativeDm / nativeFriends) — no server, no seq. A
// DM's messages live in the local encrypted log; its identity derives from the
// two friends' keys. Kept separate from the legacy server-sourced chat UI.
import { onMounted, onUnmounted, ref } from 'vue';
import IconAdd from '~icons/mynaui/message-plus';
import IconSend from '~icons/mynaui/send-solid';
import IconBack from '~icons/mynaui/chevron-left';
import { listDms, openDm, sendDm, type DmSummary } from '../lib/nativeDm';
import { createInvite, redeemInvite } from '../lib/nativeFriends';
import { onMailIngested } from '../lib/nativeRelay';
import type { ChatMessageView } from '../stores/chat';

const PAGE = 50;

const dms = ref<DmSummary[]>([]);
const active = ref<DmSummary | null>(null);
const messages = ref<ChatMessageView[]>([]);
const draft = ref('');
const panel = ref<'list' | 'add'>('list');
const createdInvite = ref<string | null>(null);
const redeemText = ref('');
const error = ref('');
const busy = ref(false);

async function refreshDms(): Promise<void> {
  dms.value = await listDms();
}

async function open(dm: DmSummary): Promise<void> {
  error.value = '';
  active.value = dm;
  const res = await openDm(dm.contactId, PAGE);
  messages.value = res.messages;
}

async function reloadActive(): Promise<void> {
  if (active.value) messages.value = (await openDm(active.value.contactId, PAGE)).messages;
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !active.value || busy.value) return;
  busy.value = true;
  try {
    await sendDm(active.value.contactId, text);
    draft.value = '';
    await reloadActive();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function makeInvite(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    createdInvite.value = (await createInvite()).invite;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function doRedeem(): Promise<void> {
  const invite = redeemText.value.trim();
  if (!invite || busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await redeemInvite(invite);
    redeemText.value = '';
    await refreshDms();
    panel.value = 'list';
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

let unsub: (() => void) | null = null;
onMounted(() => {
  void refreshDms();
  // Live inbound: a drain that stored rows refreshes the open DM + the list.
  unsub = onMailIngested(() => {
    void reloadActive();
    void refreshDms();
  });
});
onUnmounted(() => unsub?.());
</script>

<template>
  <div class="flex h-full">
    <!-- DM list -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-neutral-500/20">
      <header class="flex items-center justify-between p-3">
        <h2 class="text-sm font-semibold">Direct messages</h2>
        <button
          data-testid="add-friend"
          class="rounded p-1 hover:bg-neutral-500/10"
          title="Add a friend"
          @click="((panel = 'add'), (createdInvite = null), (error = ''))"
        >
          <IconAdd class="h-5 w-5" />
        </button>
      </header>
      <ul class="flex-1 overflow-y-auto">
        <li v-for="dm in dms" :key="dm.contactId">
          <button
            class="w-full truncate px-3 py-2 text-left text-sm hover:bg-neutral-500/10"
            :class="{ 'bg-neutral-500/10': active?.contactId === dm.contactId }"
            @click="open(dm)"
          >
            {{ dm.displayName || dm.handle }}
          </button>
        </li>
        <li v-if="!dms.length" class="px-3 py-6 text-center text-xs opacity-60">
          No friends yet — add one to start a DM.
        </li>
      </ul>
    </aside>

    <!-- Add-friend panel -->
    <section v-if="panel === 'add'" class="flex flex-1 flex-col p-6">
      <button class="mb-4 flex items-center gap-1 text-sm opacity-70" @click="panel = 'list'">
        <IconBack class="h-4 w-4" /> Back
      </button>
      <h3 class="text-base font-semibold">Add a friend</h3>

      <div class="mt-4 space-y-2">
        <p class="text-sm opacity-70">Share an invite link:</p>
        <button
          data-testid="make-invite"
          :disabled="busy"
          class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          @click="makeInvite"
        >
          Create invite link
        </button>
        <p
          v-if="createdInvite"
          data-testid="invite-link"
          class="select-all break-all rounded border border-neutral-500/30 p-2 font-mono text-xs"
        >
          {{ createdInvite }}
        </p>
      </div>

      <div class="mt-6 space-y-2">
        <p class="text-sm opacity-70">Or redeem one you were sent:</p>
        <textarea
          v-model="redeemText"
          rows="2"
          placeholder="Paste an invite link"
          class="w-full rounded border border-neutral-500/30 bg-transparent p-2 font-mono text-xs"
        />
        <button
          data-testid="redeem"
          :disabled="busy || !redeemText.trim()"
          class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          @click="doRedeem"
        >
          Redeem
        </button>
      </div>
      <p v-if="error" class="mt-4 text-sm text-red-500">{{ error }}</p>
    </section>

    <!-- DM view -->
    <section v-else-if="active" class="flex flex-1 flex-col">
      <header class="border-b border-neutral-500/20 p-3 text-sm font-semibold">
        {{ active.displayName || active.handle }}
      </header>
      <ul class="flex-1 space-y-2 overflow-y-auto p-3">
        <li
          v-for="m in messages"
          :key="m.key ?? String(m.seq)"
          class="flex"
          :class="m.senderId === 'self' ? 'justify-end' : 'justify-start'"
        >
          <span
            class="max-w-[75%] break-words rounded-2xl px-3 py-1.5 text-sm"
            :class="m.senderId === 'self' ? 'bg-blue-600 text-white' : 'bg-neutral-500/15'"
          >{{ m.text }}</span>
        </li>
      </ul>
      <form class="flex items-center gap-2 border-t border-neutral-500/20 p-3" @submit.prevent="send">
        <input
          v-model="draft"
          data-testid="draft"
          placeholder="Message"
          class="flex-1 rounded-full border border-neutral-500/30 bg-transparent px-4 py-2 text-sm"
        />
        <button
          type="submit"
          data-testid="send"
          :disabled="busy || !draft.trim()"
          class="rounded-full bg-blue-600 p-2 text-white disabled:opacity-50"
        >
          <IconSend class="h-5 w-5" />
        </button>
      </form>
      <p v-if="error" class="p-3 text-sm text-red-500">{{ error }}</p>
    </section>

    <!-- Empty state -->
    <section v-else class="flex flex-1 items-center justify-center text-sm opacity-60">
      Select a DM, or add a friend to start one.
    </section>
  </div>
</template>
