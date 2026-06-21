<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import RecoveryCodeCard from '../components/RecoveryCodeCard.vue';
import { api } from '../lib/api';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { clickToLoadEmbeds, clickToLoadImages, optimizeImages, setClickToLoadEmbeds, setClickToLoadImages, setOptimizeImages } from '../lib/privacy';
import { getPalette, getTheme, setPalette, setTheme, type Palette, type Theme } from '../lib/theme';
import { exportNotesZip, parseImportFiles, type ExportFormat } from '../lib/transfer';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';
import { useProfileStore } from '../stores/profile';
import { useChatStore } from '../stores/chat';
import { MAX_AVATAR_INPUT_BYTES } from '../lib/avatar';
import AvatarCropper from '../components/AvatarCropper.vue';
import { addCustomEmoji, customEmoji, loadCustomEmoji, removeCustomEmoji } from '../lib/emoji/custom';
import { resolveEmoji } from '../lib/emoji';
import { NAME_COLORS } from '@notes/shared';
import { isMobile } from '../lib/mobileNav';
import IconChevronLeft from '~icons/mynaui/chevron-left';
import {
  denoiseStrength,
  formatKeyCode,
  pttKey,
  setDenoiseStrength,
  setPttKey,
  setVoiceActivation,
  voiceActivation,
} from '../lib/voicePrefs';
import IconX from '~icons/mynaui/x';

const session = useSessionStore();
const notes = useNotesStore();
const chat = useChatStore();
const queryCache = useQueryCache();
const isAdmin = session.user?.role === 'admin';

// Settings is split into sections navigated by the left rail.
const sections = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'security', label: 'Security' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'voice', label: 'Voice' },
  { id: 'emoji', label: 'Custom emoji' },
  { id: 'data', label: 'Import & export' },
  ...(isAdmin ? [{ id: 'invites', label: 'Invites' }, { id: 'users', label: 'Users' }] : []),
];
const activeSection = ref('profile');
// Mobile: the section menu is its own screen; tapping a section opens its content
// full-screen over everything, with a back button. Desktop shows both at once.
const mobileSectionOpen = ref(false);
const activeLabel = computed(() => sections.find((s) => s.id === activeSection.value)?.label ?? 'Settings');
function selectSection(id: string) {
  activeSection.value = id;
  mobileSectionOpen.value = true;
}

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

// Background push notifications (content-free; see lib/push.ts).
const notif = ref<PushState>('unsupported');
const notifBusy = ref(false);
onMounted(async () => {
  notif.value = await pushState();
});
async function toggleNotifications() {
  notifBusy.value = true;
  try {
    notif.value = notif.value === 'on' ? await disablePush() : await enablePush();
  } finally {
    notifBusy.value = false;
  }
}

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

const nameColor = ref<string | null>(null);

// Public "Word#1234" handle (shown to non-contacts) + regenerate flow.
const handle = ref('');
const handleOptions = ref<string[]>([]);
const handleBusy = ref(false);
const handleMsg = ref('');

useQuery({
  key: ['profile'],
  query: async () => {
    const p = await api.profileGet();
    handle.value = p.handle;
    nameColor.value = p.nameColor;
    return p;
  },
});

// The display name is now end-to-end encrypted (in the profile blob), shared
// only with contacts — the server can't read it. Saving it clears any legacy
// plaintext copy the server may still hold.
async function saveDisplayName() {
  const name = displayName.value.trim();
  if (!name) return;
  displayNameBusy.value = true;
  displayNameMsg.value = '';
  try {
    await profile.updateProfileData({ displayName: name });
    try {
      await api.profileSet({ displayName: null });
    } catch {
      /* clearing the legacy copy is best-effort */
    }
    displayName.value = name;
    chat.hydrateNames();
    displayNameOk.value = true;
    displayNameMsg.value = 'Saved.';
  } catch (e) {
    displayNameOk.value = false;
    displayNameMsg.value = e instanceof Error ? e.message : 'could not save';
  } finally {
    displayNameBusy.value = false;
  }
}

async function loadHandleOptions() {
  handleBusy.value = true;
  handleMsg.value = '';
  try {
    handleOptions.value = (await api.handleOptions()).options;
  } finally {
    handleBusy.value = false;
  }
}

async function chooseHandle(h: string) {
  handleBusy.value = true;
  handleMsg.value = '';
  try {
    const p = await api.handleSet(h);
    handle.value = p.handle;
    profile.myHandle = p.handle;
    handleOptions.value = [];
    handleMsg.value = 'Handle updated.';
  } catch (e) {
    handleMsg.value = e instanceof Error ? e.message : 'could not set handle';
  } finally {
    handleBusy.value = false;
  }
}

// Name color: pick from the curated NAME_COLORS palette (or null for default).
async function pickNameColor(c: string | null) {
  const prev = nameColor.value;
  nameColor.value = c;
  try {
    await api.profileSet({ nameColor: c });
  } catch {
    nameColor.value = prev; // revert on failure
  }
}

// E2EE profile: bio + avatar, encrypted and shared with contacts.
const profile = useProfileStore();
const BIO_MAX = 500;
const bio = ref('');
const avatar = ref<string | undefined>(undefined);
const avatarInput = ref<HTMLInputElement>();
const profileMsg = ref('');
const profileOk = ref(false);
const profileBusy = ref(false);

useQuery({
  key: ['profile-data'],
  query: async () => {
    if (!profile.loaded) await profile.load();
    displayName.value = profile.myData.displayName ?? '';
    bio.value = profile.myData.bio ?? '';
    avatar.value = profile.myData.avatar;
    return true;
  },
});

// Avatar picking opens the cropper; the cropper emits the final WebP data URL.
const cropFile = ref<File | null>(null);
const cropOpen = ref(false);

function pickAvatar() {
  const file = avatarInput.value?.files?.[0];
  if (avatarInput.value) avatarInput.value.value = '';
  if (!file) return;
  profileMsg.value = '';
  if (file.size > MAX_AVATAR_INPUT_BYTES) {
    profileOk.value = false;
    profileMsg.value = `That image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is ${Math.round(MAX_AVATAR_INPUT_BYTES / 1024 / 1024)} MB.`;
    return;
  }
  cropFile.value = file;
  cropOpen.value = true;
}

// Tracks unsaved avatar/bio edits so we can prompt the user to hit Save.
const profileDirty = ref(false);

function onCropped(dataUrl: string) {
  avatar.value = dataUrl;
  profileDirty.value = true;
}

function removeAvatar() {
  avatar.value = undefined;
  profileDirty.value = true;
}

async function saveProfile() {
  if (profileBusy.value) return;
  profileBusy.value = true;
  profileMsg.value = '';
  try {
    // Merge into the existing blob so we never drop the encrypted display name
    // (omitting it here re-distributed a blank name to every contact). `undefined`
    // clears the field; the display name is left untouched.
    const trimmed = bio.value.trim();
    await profile.updateProfileData({
      bio: trimmed ? trimmed.slice(0, BIO_MAX) : undefined,
      avatar: avatar.value || undefined,
    });
    profileOk.value = true;
    profileMsg.value = 'Profile saved.';
    profileDirty.value = false;
  } catch (e) {
    profileOk.value = false;
    profileMsg.value = e instanceof Error ? e.message : 'could not save profile';
  } finally {
    profileBusy.value = false;
  }
}

// Privacy: profile visibility (friends-only vs. also group co-members).
const visibilityBusy = ref(false);
async function toggleFriendsOnly(v: boolean) {
  visibilityBusy.value = true;
  try {
    await profile.setVisibility(v);
  } finally {
    visibilityBusy.value = false;
  }
}

// Privacy: link previews (opt-in).
const linkPreviewBusy = ref(false);
async function toggleLinkPreviews(v: boolean) {
  linkPreviewBusy.value = true;
  try {
    await profile.setLinkPreviews(v);
  } finally {
    linkPreviewBusy.value = false;
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

// Voice (device-level prefs; see lib/voicePrefs.ts). The PTT key is recorded by
// capturing the next keypress; Esc cancels.
const recordingPtt = ref(false);
function recordPttKey() {
  recordingPtt.value = true;
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') setPttKey(e.code);
    recordingPtt.value = false;
    window.removeEventListener('keydown', onKey, true);
  };
  window.addEventListener('keydown', onKey, true);
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
    <div class="flex h-full flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <h1 class="text-2xl font-bold">Settings</h1>
        <span class="grow" />
        <RouterLink
          to="/"
          title="Back to notes"
          aria-label="Close settings"
          class="rounded-lg px-2 py-1 text-lg leading-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </RouterLink>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Section nav. Mobile: fills the page (its own screen); desktop: a rail. -->
        <nav
          class="space-y-0.5 overflow-y-auto border-r border-zinc-200 p-3 dark:border-zinc-800"
          :class="isMobile ? 'w-full' : 'w-52 shrink-0'"
        >
          <button
            v-for="s in sections"
            :key="s.id"
            class="block w-full rounded-lg px-3 py-1.5 text-left text-sm"
            :class="activeSection === s.id
              ? 'bg-zinc-200 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'"
            @click="selectSection(s.id)"
          >
            {{ s.label }}
          </button>
        </nav>

        <!-- Section content. Mobile: full-screen over everything (incl. the app
             sidebar) when a section is open, else hidden; desktop: inline. -->
        <div
          class="min-w-0 grow overflow-y-auto p-6"
          :class="isMobile ? (mobileSectionOpen ? 'fixed inset-0 z-nav bg-zinc-50 dark:bg-zinc-950' : 'hidden') : ''"
        >
          <button
            v-if="isMobile && mobileSectionOpen"
            type="button"
            class="mb-4 flex items-center gap-1 text-sm font-medium text-zinc-600 dark:text-zinc-300"
            @click="mobileSectionOpen = false"
          >
            <IconChevronLeft class="h-5 w-5" /> {{ activeLabel }}
          </button>
          <div class="mx-auto max-w-2xl space-y-8">

      <section v-show="activeSection === 'profile'" class="space-y-3">
        <h2 class="text-lg font-semibold">Profile</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Your display name is <strong>end-to-end encrypted</strong> and shown only to your contacts —
          the server can't read it. Everyone else (and the server) sees your public handle below.
          Your username is never shown to anyone.
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

        <!-- Public handle: server-visible, shown to non-contacts. -->
        <div class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm">Public handle</p>
              <p class="text-xs text-zinc-500 dark:text-zinc-400">
                Shown to people who aren't your contacts (and the only name the server can see).
                Share it so friends can recognise you: “<span class="font-medium">{{ handle }}</span> is me”.
              </p>
            </div>
            <span class="shrink-0 rounded-lg bg-zinc-100 px-2.5 py-1 font-mono text-sm dark:bg-zinc-800">{{ handle }}</span>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              :disabled="handleBusy"
              class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              @click="loadHandleOptions"
            >
              {{ handleBusy ? '…' : 'Change handle' }}
            </button>
            <template v-for="opt in handleOptions" :key="opt">
              <button
                type="button"
                :disabled="handleBusy"
                class="rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 font-mono text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                @click="chooseHandle(opt)"
              >
                {{ opt }}
              </button>
            </template>
            <button
              v-if="handleOptions.length"
              type="button"
              :disabled="handleBusy"
              class="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
              @click="loadHandleOptions"
            >
              More options
            </button>
          </div>
          <p v-if="handleMsg" class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{{ handleMsg }}</p>
        </div>

        <div>
          <p class="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">Name color (shown to others in chat)</p>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              title="Default"
              class="flex h-7 w-7 items-center justify-center rounded-full border text-xs"
              :class="nameColor === null ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-zinc-300 dark:border-zinc-600'"
              @click="pickNameColor(null)"
            >
              <IconX class="h-3.5 w-3.5 text-zinc-400" />
            </button>
            <button
              v-for="c in NAME_COLORS"
              :key="c"
              type="button"
              :title="c"
              class="h-7 w-7 rounded-full border"
              :class="nameColor === c ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-transparent'"
              :style="{ backgroundColor: `var(--brand-${c})` }"
              @click="pickNameColor(c)"
            />
          </div>
        </div>

        <!-- Avatar + bio: end-to-end encrypted, shared only with your contacts. -->
        <div class="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p class="text-sm text-zinc-500 dark:text-zinc-400">
            Your avatar and bio are <strong>end-to-end encrypted</strong> and shared only with the
            contacts who can see your profile — the server can't read them.
          </p>
          <div class="mt-3 flex items-center gap-4">
            <span class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-200 text-xl font-medium text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300">
              <img v-if="avatar" :src="avatar" alt="Avatar preview" class="h-full w-full object-cover" />
              <span v-else>{{ (displayName.trim()[0] ?? '?').toUpperCase() }}</span>
            </span>
            <div class="flex flex-col gap-2">
              <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="pickAvatar" />
              <button
                type="button"
                class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                @click="avatarInput?.click()"
              >
                {{ avatar ? 'Change avatar' : 'Upload avatar' }}
              </button>
              <button
                v-if="avatar"
                type="button"
                class="text-left text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                @click="removeAvatar"
              >
                Remove
              </button>
            </div>
            <span v-if="profileDirty" class="text-sm font-medium text-red-600 dark:text-red-400">
              Not saved — click Save profile
            </span>
          </div>

          <label class="mt-3 block">
            <span class="text-sm text-zinc-500 dark:text-zinc-400">Bio</span>
            <textarea
              v-model="bio"
              :maxlength="BIO_MAX"
              rows="3"
              placeholder="A short bio your contacts will see…"
              class="mt-1 w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
              @input="profileDirty = true"
            />
            <span class="text-xs text-zinc-400">{{ bio.length }}/{{ BIO_MAX }}</span>
          </label>

          <div class="mt-2 flex items-center gap-3">
            <button
              type="button"
              :disabled="profileBusy"
              class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              @click="saveProfile"
            >
              Save profile
            </button>
            <p v-if="profileMsg" class="text-sm" :class="profileOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ profileMsg }}
            </p>
          </div>
        </div>

        <AvatarCropper v-model:open="cropOpen" :file="cropFile" @cropped="onCropped" />
      </section>

      <section v-show="activeSection === 'appearance'" class="space-y-3">
        <h2 class="text-lg font-semibold">Appearance</h2>
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
      </section>

      <!-- Security: auto-lock + passkeys + recovery code -->
      <section v-show="activeSection === 'security'" class="space-y-3">
        <h2 class="text-lg font-semibold">Auto-lock</h2>
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

        <h2 class="text-lg font-semibold">Notifications</h2>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <p class="text-sm">New-message notifications</p>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              Get a push when a message arrives while the app is closed. Notifications are
              <strong>content-free</strong> — just “New message”, never the text or sender — because
              the server can't read your encrypted messages.
            </p>
          </div>
          <button
            v-if="notif === 'on' || notif === 'off'"
            :disabled="notifBusy"
            class="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            @click="toggleNotifications"
          >
            {{ notifBusy ? '…' : notif === 'on' ? 'Disable' : 'Enable' }}
          </button>
          <span v-else-if="notif === 'denied'" class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
            Blocked in browser settings
          </span>
          <span v-else class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">Not supported here</span>
        </div>
      </section>

      <section v-show="activeSection === 'privacy'" class="space-y-3">
        <h2 class="text-lg font-semibold">Privacy</h2>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <p class="text-sm">Only allow friends to see my profile</p>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              When off, group co-members who aren't friends can also see your encrypted avatar and bio.
            </p>
          </div>
          <select
            :value="String(profile.friendsOnly)"
            :disabled="visibilityBusy"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            @change="toggleFriendsOnly(($event.target as HTMLSelectElement).value === 'true')"
          >
            <option value="true">Friends only</option>
            <option value="false">Friends + group members</option>
          </select>
        </div>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <p class="text-sm">Link previews</p>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              Generating a preview sends the link to this server to fetch — so the server sees URLs
              you post. A preview is only created when <strong>everyone</strong> in the chat has this
              on. Off by default.
            </p>
          </div>
          <select
            :value="String(profile.linkPreviews)"
            :disabled="linkPreviewBusy"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            @change="toggleLinkPreviews(($event.target as HTMLSelectElement).value === 'true')"
          >
            <option value="false">Off</option>
            <option value="true">On</option>
          </select>
        </div>
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

      <section v-show="activeSection === 'voice'" class="space-y-3">
        <h2 class="text-lg font-semibold">Voice</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          These settings apply to this device only. Calls are end-to-end encrypted; noise
          suppression runs locally before your audio is encrypted.
        </p>

        <div class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <p class="text-sm">Voice activation</p>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              Voice activity keeps your mic open; push-to-talk only transmits while a key or the
              on-screen button is held.
            </p>
          </div>
          <select
            :value="voiceActivation"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            @change="setVoiceActivation(($event.target as HTMLSelectElement).value === 'ptt' ? 'ptt' : 'voice')"
          >
            <option value="voice">Voice activity</option>
            <option value="ptt">Push to talk</option>
          </select>
        </div>

        <div
          v-if="voiceActivation === 'ptt'"
          class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div>
            <p class="text-sm">Push-to-talk key</p>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              Held anywhere (except while typing) to open your mic. Optional — the in-call
              “Hold to talk” button always works.
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              class="min-w-24 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              @click="recordPttKey"
            >
              {{ recordingPtt ? 'Press a key…' : formatKeyCode(pttKey) }}
            </button>
            <button
              v-if="pttKey && !recordingPtt"
              type="button"
              class="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
              @click="setPttKey(null)"
            >
              Clear
            </button>
          </div>
        </div>

        <div class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm">Noise suppression strength</p>
              <p class="text-xs text-zinc-500 dark:text-zinc-400">
                How aggressively background noise (keyboard, fans, hum) is removed by RNNoise.
                Lower lets more of your raw mic through.
              </p>
            </div>
            <span class="shrink-0 text-sm tabular-nums text-zinc-500 dark:text-zinc-400">{{ Math.round(denoiseStrength * 100) }}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="denoiseStrength"
            class="mt-3 w-full accent-blue-600"
            @input="setDenoiseStrength(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </section>

      <section v-show="activeSection === 'emoji'" class="space-y-3">
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

      <section v-show="activeSection === 'security'" class="space-y-3">
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

      <section v-show="activeSection === 'security'" class="space-y-3">
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

      <section v-show="activeSection === 'data'" class="space-y-3">
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
        <section v-show="activeSection === 'invites'" class="space-y-3">
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

        <section v-show="activeSection === 'users'" class="space-y-3">
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
        </div>
      </div>
    </div>
  </AppLayout>
</template>
