<script setup lang="ts">
import { ref } from 'vue';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import RecoveryCodeCard from '../components/RecoveryCodeCard.vue';
import { api } from '../lib/api';
import { clickToLoadEmbeds, clickToLoadImages, optimizeImages, setClickToLoadEmbeds, setClickToLoadImages, setOptimizeImages } from '../lib/privacy';
import { getPalette, getTheme, setPalette, setTheme, type Palette, type Theme } from '../lib/theme';
import { exportNotesZip, parseImportFiles, type ExportFormat } from '../lib/transfer';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';
import { addCustomEmoji, customEmoji, loadCustomEmoji, removeCustomEmoji } from '../lib/emoji/custom';
import { resolveEmoji } from '../lib/emoji';
import IconX from '~icons/mynaui/x';

const session = useSessionStore();
const notes = useNotesStore();
const queryCache = useQueryCache();
const isAdmin = session.user?.role === 'admin';

const theme = ref<Theme>(getTheme());
const palette = ref<Palette>(getPalette());
const autoLock = ref(String(session.autoLockMinutes));
const displayName = ref('');
const displayNameMsg = ref('');
const displayNameOk = ref(false);
const displayNameBusy = ref(false);
const newPasskeyName = ref('');
const passkeyError = ref('');
const newRecoveryCode = ref('');
const copiedInvite = ref('');

// Custom emoji palette (encrypted; see lib/emoji/custom.ts).
const emojiName = ref('');
const emojiInput = ref<HTMLInputElement>();
const emojiError = ref('');
const emojiBusy = ref(false);
void loadCustomEmoji();

async function addEmoji() {
  const file = emojiInput.value?.files?.[0];
  const name = emojiName.value.trim();
  if (!name || !file) {
    emojiError.value = 'Pick an image and enter a name.';
    return;
  }
  emojiBusy.value = true;
  emojiError.value = '';
  try {
    await addCustomEmoji(name, file);
    emojiName.value = '';
    if (emojiInput.value) emojiInput.value.value = '';
  } catch (e) {
    emojiError.value = e instanceof Error ? e.message : 'could not add emoji';
  } finally {
    emojiBusy.value = false;
  }
}

useQuery({
  key: ['profile'],
  query: async () => {
    const p = await api.profileGet();
    displayName.value = p.displayName;
    return p;
  },
});

async function saveDisplayName() {
  const name = displayName.value.trim();
  if (!name) return;
  displayNameBusy.value = true;
  displayNameMsg.value = '';
  try {
    const p = await api.profileSet(name);
    displayName.value = p.displayName;
    displayNameOk.value = true;
    displayNameMsg.value = 'Saved.';
  } catch (e) {
    displayNameOk.value = false;
    displayNameMsg.value = e instanceof Error ? e.message : 'could not save';
  } finally {
    displayNameBusy.value = false;
  }
}

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

function applyPalette() {
  setPalette(palette.value);
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

const transferBusy = ref(false);
const transferMsg = ref('');
const importInput = ref<HTMLInputElement>();
const exportFormat = ref<ExportFormat>('as-is');

async function exportAll() {
  transferBusy.value = true;
  transferMsg.value = '';
  try {
    if (!notes.loaded) {
      await notes.loadFromCache();
      await notes.sync();
    }
    const own = notes.sorted.filter((n) => !n.shared);
    const blob = exportNotesZip(own, exportFormat.value);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `notes-export-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    transferMsg.value = `Exported ${own.length} notes.`;
  } catch (e) {
    transferMsg.value = e instanceof Error ? e.message : 'export failed';
  } finally {
    transferBusy.value = false;
  }
}

async function importFiles(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files?.length) return;
  transferBusy.value = true;
  transferMsg.value = '';
  try {
    if (!notes.loaded) {
      await notes.loadFromCache();
      await notes.sync();
    }
    const imported = await parseImportFiles(files);
    for (const n of imported) await notes.create(n);
    transferMsg.value = `Imported ${imported.length} notes.`;
  } catch (e) {
    transferMsg.value = e instanceof Error ? e.message : 'import failed';
  } finally {
    transferBusy.value = false;
    (event.target as HTMLInputElement).value = '';
  }
}
</script>

<template>
  <AppLayout>
    <div class="mx-auto max-w-2xl space-y-8 overflow-y-auto p-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">Settings</h1>
        <RouterLink
          to="/"
          title="Back to notes"
          aria-label="Close settings"
          class="rounded-lg px-2 py-1 text-lg leading-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </RouterLink>
      </div>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Profile</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          This is the name other users see in chats and friend requests. Your username is never shown to them.
        </p>
        <form class="flex gap-2" @submit.prevent="saveDisplayName">
          <input
            v-model="displayName"
            placeholder="Display name"
            class="grow rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            :disabled="displayNameBusy || !displayName.trim()"
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
        </form>
        <p v-if="displayNameMsg" class="text-sm" :class="displayNameOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
          {{ displayNameMsg }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Appearance & security</h2>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Light / dark</span>
          <select v-model="theme" class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" @change="applyTheme">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Color theme</span>
          <select v-model="palette" class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" @change="applyPalette">
            <option value="brand">Brand</option>
            <option value="pastel">Pastel</option>
            <option value="high-contrast">High contrast</option>
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
        <h2 class="text-lg font-semibold">Privacy</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Loading remote media reveals your IP address to whoever hosts it. Click to load keeps
          requests from leaving until you ask.
        </p>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Remote images</span>
          <select
            :value="String(clickToLoadImages)"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            @change="setClickToLoadImages(($event.target as HTMLSelectElement).value === 'true')"
          >
            <option value="true">Click to load</option>
            <option value="false">Load automatically</option>
          </select>
        </div>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Video embeds (YouTube/Vimeo)</span>
          <select
            :value="String(clickToLoadEmbeds)"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            @change="setClickToLoadEmbeds(($event.target as HTMLSelectElement).value === 'true')"
          >
            <option value="true">Click to load</option>
            <option value="false">Load automatically</option>
          </select>
        </div>
        <div class="flex items-center justify-between rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <span class="text-sm">Optimize images before upload</span>
          <select
            :value="String(optimizeImages)"
            title="Resize large images and re-encode to WebP on this device before encryption, to save space. Applied to the original file; the server only ever sees ciphertext."
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            @change="setOptimizeImages(($event.target as HTMLSelectElement).value === 'true')"
          >
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Custom emoji</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Upload your own emoji to use in chat as <code>:name:</code>. Images are encrypted on this
          device before upload; when you send one, it's embedded (encrypted) in the message so others
          can see it.
        </p>
        <div class="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-zinc-500">Name</span>
            <input
              v-model="emojiName"
              placeholder="catJAM"
              class="w-40 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <input ref="emojiInput" type="file" accept="image/*" class="text-sm" />
          <button
            :disabled="emojiBusy"
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            @click="addEmoji"
          >
            {{ emojiBusy ? 'Adding…' : 'Add' }}
          </button>
          <span v-if="emojiError" class="text-xs text-red-500">{{ emojiError }}</span>
        </div>
        <div v-if="customEmoji.items.length" class="flex flex-wrap gap-2">
          <span
            v-for="e in customEmoji.items"
            :key="e.name"
            class="flex items-center gap-1.5 rounded-lg border border-zinc-200 py-1 pl-2 pr-1 text-xs dark:border-zinc-700"
          >
            <img v-if="resolveEmoji(e.name)" :src="resolveEmoji(e.name)!" :alt="e.name" class="h-5 w-5 object-contain" />
            <span>:{{ e.name }}:</span>
            <button class="flex items-center rounded px-1 text-zinc-400 hover:text-red-500" title="Remove" @click="removeCustomEmoji(e.name)"><IconX class="h-3.5 w-3.5" /></button>
          </span>
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

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Import & export</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Export decrypts your notes locally into a zip of Markdown files. Import accepts .md/.txt
          files or a zip of them.
        </p>
        <div class="flex gap-2" :class="{ 'opacity-50': !session.unlocked }">
          <select
            v-model="exportFormat"
            :disabled="!session.unlocked || transferBusy"
            title="As written keeps extended syntax (colors, spoilers); Obsidian keeps what Obsidian renders and unwraps spoilers; standard Markdown strips non-standard bits; plain text strips all markup"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="as-is">As written</option>
            <option value="obsidian">Obsidian</option>
            <option value="standard">Standard Markdown</option>
            <option value="plain">Plain text</option>
          </select>
          <button
            :disabled="!session.unlocked || transferBusy"
            class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            @click="exportAll"
          >
            Export all notes (.zip)
          </button>
          <button
            :disabled="!session.unlocked || transferBusy"
            class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            @click="importInput?.click()"
          >
            Import notes…
          </button>
          <input ref="importInput" type="file" multiple accept=".md,.txt,.markdown,.zip" class="hidden" @change="importFiles" />
        </div>
        <p v-if="transferMsg" class="text-sm text-zinc-500 dark:text-zinc-400">{{ transferMsg }}</p>
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
