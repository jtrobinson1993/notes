<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useChatStore } from '../stores/chat';
import { useFriendsStore } from '../stores/friends';
import { goHome, homeOpen, isMobile } from '../lib/mobileNav';
import IconChevronLeft from '~icons/mynaui/chevron-left';

const friends = useFriendsStore();
const chat = useChatStore();
const router = useRouter();

const loading = ref(true);
const loadError = ref('');

onMounted(async () => {
  try {
    await friends.load();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'failed to load friends';
  } finally {
    loading.value = false;
  }
});

const incoming = computed(() => friends.requests.filter((r) => r.direction === 'incoming'));
const outgoing = computed(() => friends.requests.filter((r) => r.direction === 'outgoing'));

// --- Invites ---
const copiedId = ref('');
const inviteBusy = ref(false);

async function createInvite() {
  inviteBusy.value = true;
  try {
    await friends.createInvite();
  } finally {
    inviteBusy.value = false;
  }
}

async function copyToken(invite: { id: string; token: string }) {
  await navigator.clipboard.writeText(invite.token);
  copiedId.value = invite.id;
  setTimeout(() => (copiedId.value = ''), 2000);
}

// --- Redeem ---
const redeemCode = ref('');
const redeemMsg = ref('');
const redeemOk = ref(false);
const redeemBusy = ref(false);

async function redeem() {
  const token = redeemCode.value.trim();
  if (!token) return;
  redeemBusy.value = true;
  redeemMsg.value = '';
  try {
    await friends.redeem(token);
    redeemOk.value = true;
    redeemMsg.value = 'Request sent.';
    redeemCode.value = '';
  } catch (e) {
    redeemOk.value = false;
    redeemMsg.value = e instanceof Error ? e.message : 'could not redeem code';
  } finally {
    redeemBusy.value = false;
  }
}

// --- Requests ---
async function accept(id: string) {
  await friends.accept(id);
}
async function decline(id: string) {
  await friends.decline(id);
}

// --- Friends list ---
const dmError = ref('');
async function openDm(userId: string) {
  dmError.value = '';
  const friend = friends.friends.find((f) => f.userId === userId);
  if (!friend) return;
  try {
    const convId = await chat.openDm(friend);
    router.push(`/chat/${convId}`);
  } catch (e) {
    dmError.value = e instanceof Error ? e.message : 'could not open chat';
  }
}

function fmtExpiry(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <AppLayout>
    <div class="mx-auto h-full max-w-2xl space-y-8 overflow-y-auto p-6" :class="{ 'hidden': isMobile && homeOpen }">
      <div class="flex items-center gap-2">
        <button
          v-if="isMobile"
          type="button"
          class="-ml-2 shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Back to menu"
          @click="goHome()"
        >
          <IconChevronLeft class="h-5 w-5" />
        </button>
        <h1 class="text-2xl font-bold">Friends</h1>
        <span class="grow" />
        <RouterLink
          to="/"
          title="Back to notes"
          aria-label="Close"
          class="rounded-lg px-2 py-1 text-lg leading-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </RouterLink>
      </div>

      <p v-if="loadError" class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>

      <!-- Redeem a code -->
      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Add a friend</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Paste a friend invite code someone shared with you to send them a friend request.
        </p>
        <form class="flex gap-2" @submit.prevent="redeem">
          <input
            v-model="redeemCode"
            placeholder="Invite code"
            class="grow rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            :disabled="redeemBusy || !redeemCode.trim()"
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send request
          </button>
        </form>
        <p v-if="redeemMsg" class="text-sm" :class="redeemOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
          {{ redeemMsg }}
        </p>
      </section>

      <!-- My invites -->
      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Your invite codes</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Share a code with someone so they can send you a friend request. Codes expire after 24 hours.
        </p>
        <button
          :disabled="inviteBusy"
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          @click="createInvite"
        >
          Generate invite code
        </button>
        <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          <li v-for="invite in friends.invites" :key="invite.id" class="flex items-center gap-3 p-3">
            <div class="min-w-0 grow">
              <p class="truncate font-mono text-xs">{{ invite.token }}</p>
              <p class="text-xs text-zinc-500">expires {{ fmtExpiry(invite.expiresAt) }}</p>
            </div>
            <button
              class="shrink-0 text-sm text-blue-600 hover:underline dark:text-blue-400"
              @click="copyToken(invite)"
            >
              {{ copiedId === invite.id ? 'Copied!' : 'Copy' }}
            </button>
            <button class="shrink-0 text-sm text-red-500 hover:underline" @click="friends.deleteInvite(invite.id)">
              Revoke
            </button>
          </li>
          <li v-if="!friends.invites.length" class="p-3 text-sm text-zinc-400">No active invite codes</li>
        </ul>
      </section>

      <!-- Incoming requests -->
      <section v-if="incoming.length" class="space-y-3">
        <h2 class="text-lg font-semibold">Friend requests</h2>
        <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          <li v-for="req in incoming" :key="req.id" class="flex items-center gap-3 p-3">
            <p class="grow text-sm font-medium">{{ req.displayName }}</p>
            <button
              class="shrink-0 rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
              @click="accept(req.id)"
            >
              Accept
            </button>
            <button class="shrink-0 text-sm text-zinc-500 hover:underline" @click="decline(req.id)">Decline</button>
          </li>
        </ul>
      </section>

      <!-- Outgoing requests -->
      <section v-if="outgoing.length" class="space-y-3">
        <h2 class="text-lg font-semibold">Pending</h2>
        <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          <li v-for="req in outgoing" :key="req.id" class="flex items-center gap-3 p-3">
            <p class="grow text-sm font-medium">{{ req.displayName }}</p>
            <span class="shrink-0 text-xs text-zinc-400">request sent</span>
          </li>
        </ul>
      </section>

      <!-- Friends list -->
      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Your friends</h2>
        <p v-if="dmError" class="text-sm text-red-600 dark:text-red-400">{{ dmError }}</p>
        <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          <li v-for="f in friends.friends" :key="f.userId" class="flex items-center gap-3 p-3">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
              {{ (f.displayName.trim()[0] ?? '?').toUpperCase() }}
            </span>
            <div class="grow">
              <p class="text-sm font-medium">{{ f.displayName }}</p>
              <p class="text-xs" :class="f.online ? 'text-green-600 dark:text-green-400' : 'text-zinc-400'">
                {{ f.online ? 'online' : 'offline' }}
              </p>
            </div>
            <button
              class="shrink-0 rounded-lg border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              @click="openDm(f.userId)"
            >
              Message
            </button>
            <button class="shrink-0 text-sm text-red-500 hover:underline" @click="friends.unfriend(f.userId)">
              Remove
            </button>
          </li>
          <li v-if="!loading && !friends.friends.length" class="p-3 text-sm text-zinc-400">
            No friends yet — generate an invite code or redeem one.
          </li>
        </ul>
      </section>
    </div>
  </AppLayout>
</template>
