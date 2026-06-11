<script setup lang="ts">
import { ref } from 'vue';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import RecoveryCodeCard from '../components/RecoveryCodeCard.vue';
import { api } from '../lib/api';
import { getTheme, setTheme, type Theme } from '../lib/theme';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const queryCache = useQueryCache();
const isAdmin = session.user?.role === 'admin';

const theme = ref<Theme>(getTheme());
const autoLock = ref(String(session.autoLockMinutes));
const newPasskeyName = ref('');
const passkeyError = ref('');
const newRecoveryCode = ref('');
const copiedInvite = ref('');

const { data: credentials } = useQuery({ key: ['credentials'], query: () => api.credentials() });
const { data: invites } = useQuery({ key: ['invites'], query: () => api.invites(), enabled: isAdmin });
const { data: users } = useQuery({ key: ['users'], query: () => api.users(), enabled: isAdmin });

const addPasskey = useMutation({
  mutation: () => session.addPasskey(newPasskeyName.value.trim()),
  onSettled: () => queryCache.invalidateQueries({ key: ['credentials'] }),
  onSuccess: () => {
    newPasskeyName.value = '';
    passkeyError.value = '';
  },
  onError: (e) => (passkeyError.value = e instanceof Error ? e.message : 'failed'),
});

const deletePasskey = useMutation({
  mutation: (id: string) => api.credentialDelete(id),
  onSettled: () => queryCache.invalidateQueries({ key: ['credentials'] }),
});

const createInvite = useMutation({
  mutation: () => api.inviteCreate(),
  onSettled: () => queryCache.invalidateQueries({ key: ['invites'] }),
});

const deleteInvite = useMutation({
  mutation: (id: string) => api.inviteDelete(id),
  onSettled: () => queryCache.invalidateQueries({ key: ['invites'] }),
});

const deleteUser = useMutation({
  mutation: (id: string) => api.userDelete(id),
  onSettled: () => queryCache.invalidateQueries({ key: ['users'] }),
});

function applyTheme() {
  setTheme(theme.value);
}

function applyAutoLock() {
  session.setAutoLock(Number(autoLock.value));
}

async function rotateCode() {
  if (!confirm('Generate a new recovery code? The old one will stop working.')) return;
  newRecoveryCode.value = await session.rotateRecoveryCode();
}

async function copyInvite(invite: { id: string; url: string }) {
  await navigator.clipboard.writeText(invite.url);
  copiedInvite.value = invite.id;
  setTimeout(() => (copiedInvite.value = ''), 2000);
}

function confirmDeleteUser(id: string, username: string) {
  if (confirm(`Remove ${username} and all their (encrypted) notes from this server?`)) {
    deleteUser.mutate(id);
  }
}

function fmtDate(ts: number | null): string {
  return ts ? new Date(ts).toLocaleDateString() : '—';
}
</script>

<template>
  <AppLayout>
    <div class="mx-auto max-w-2xl space-y-8 overflow-y-auto p-6">
      <h1 class="text-2xl font-bold">Settings</h1>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Appearance & security</h2>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Theme</span>
          <select v-model="theme" class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" @change="applyTheme">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Auto-lock after inactivity</span>
          <select v-model="autoLock" class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" @change="applyAutoLock">
            <option value="1">1 minute</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="0">Never</option>
          </select>
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Passkeys</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Register a passkey on each device you use. Every passkey can unlock your encrypted notes.
        </p>
        <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          <li v-for="cred in credentials" :key="cred.id" class="flex items-center gap-3 p-3">
            <div class="grow">
              <p class="text-sm font-medium">{{ cred.name }}</p>
              <p class="text-xs text-zinc-500">
                Added {{ fmtDate(cred.createdAt) }} · Last used {{ fmtDate(cred.lastUsedAt) }}
                <span v-if="!cred.hasWrappedMk" class="text-amber-500"> · cannot unlock notes</span>
              </p>
            </div>
            <button
              v-if="(credentials?.length ?? 0) > 1"
              class="text-sm text-red-500 hover:underline"
              @click="deletePasskey.mutate(cred.id)"
            >
              Remove
            </button>
          </li>
        </ul>
        <div class="flex gap-2" :class="{ 'opacity-50': !session.unlocked }">
          <input
            v-model="newPasskeyName"
            placeholder="Name (e.g. Work laptop)"
            :disabled="!session.unlocked"
            class="grow rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            :disabled="!session.unlocked || addPasskey.isLoading.value"
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            @click="addPasskey.mutate()"
          >
            Add passkey
          </button>
        </div>
        <p v-if="passkeyError" class="text-sm text-red-600 dark:text-red-400">{{ passkeyError }}</p>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Recovery code</h2>
        <button
          :disabled="!session.unlocked"
          class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          @click="rotateCode"
        >
          Generate new recovery code
        </button>
        <RecoveryCodeCard v-if="newRecoveryCode" :code="newRecoveryCode" />
      </section>

      <template v-if="isAdmin">
        <section class="space-y-3">
          <h2 class="text-lg font-semibold">Invites</h2>
          <button
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            @click="createInvite.mutate()"
          >
            Create invite link
          </button>
          <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
            <li v-for="invite in invites" :key="invite.id" class="flex items-center gap-3 p-3">
              <div class="min-w-0 grow">
                <p class="truncate font-mono text-xs">{{ invite.url }}</p>
                <p class="text-xs text-zinc-500">
                  <template v-if="invite.usedBy">used</template>
                  <template v-else-if="invite.expiresAt < Date.now()">expired</template>
                  <template v-else>expires {{ fmtDate(invite.expiresAt) }}</template>
                </p>
              </div>
              <button
                v-if="!invite.usedBy"
                class="shrink-0 text-sm text-blue-600 hover:underline dark:text-blue-400"
                @click="copyInvite(invite)"
              >
                {{ copiedInvite === invite.id ? 'Copied!' : 'Copy' }}
              </button>
              <button class="shrink-0 text-sm text-red-500 hover:underline" @click="deleteInvite.mutate(invite.id)">
                Delete
              </button>
            </li>
            <li v-if="!invites?.length" class="p-3 text-sm text-zinc-400">No invites</li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-lg font-semibold">Users</h2>
          <ul class="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
            <li v-for="u in users" :key="u.id" class="flex items-center gap-3 p-3">
              <div class="grow">
                <p class="text-sm font-medium">{{ u.username }} <span v-if="u.role === 'admin'" class="text-xs text-zinc-400">(admin)</span></p>
                <p class="text-xs text-zinc-500">Joined {{ fmtDate(u.createdAt) }}</p>
              </div>
              <button
                v-if="u.id !== session.user?.id"
                class="text-sm text-red-500 hover:underline"
                @click="confirmDeleteUser(u.id, u.username)"
              >
                Remove
              </button>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </AppLayout>
</template>
