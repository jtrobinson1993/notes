<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import DeviceLockSettings from '../components/settings/DeviceLockSettings.vue';
import { relayChangeHandle, accountSetLabel } from '../lib/native';
import { generateHandleOptions } from '@notes/shared';
import { clickToLoadEmbeds, clickToLoadImages, optimizeImages, setClickToLoadEmbeds, setClickToLoadImages, setOptimizeImages } from '../lib/privacy';
import { getPalette, getTheme, setPalette, setTheme, type Palette, type Theme } from '../lib/theme';
import { exportNotesZip, parseImportFiles, type ExportFormat } from '../lib/transfer';
import { useNotesStore } from '../stores/notes';
import { useProfileStore } from '../stores/profile';
import { MAX_AVATAR_INPUT_BYTES } from '../lib/avatar';
import AvatarCropper from '../components/AvatarCropper.vue';
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

const notes = useNotesStore();
// E2EE profile: handle, display name, bio + avatar. All but the handle are
// encrypted and shared only with contacts.
const profile = useProfileStore();

// Settings is split into sections navigated by the left rail.
const sections = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'security', label: 'Security' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'voice', label: 'Voice' },
  { id: 'data', label: 'Import & export' },
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
const displayName = ref('');
const displayNameMsg = ref('');
const displayNameOk = ref(false);
const displayNameBusy = ref(false);

// Public "Word#1234" handle (shown to non-contacts).
const handle = ref('');

// Handle change: pick a new generated Word#1234 candidate (client-side, like
// signup) and claim it on the relay — no password reauth (the vault is the
// credential). Friends are unaffected (they address me by identity key).
const nativeHandleOptions = ref<string[]>([]);
const handleChangeBusy = ref(false);
const handleChangeMsg = ref('');
function nativeRerollHandles(): void {
  handleChangeMsg.value = '';
  nativeHandleOptions.value = generateHandleOptions(4);
}
async function nativeChangeHandle(opt: string): Promise<void> {
  handleChangeBusy.value = true;
  handleChangeMsg.value = '';
  try {
    const confirmed = await relayChangeHandle(opt);
    handle.value = confirmed;
    profile.myHandle = confirmed;
    await accountSetLabel(confirmed); // keep the account switcher label current
    nativeHandleOptions.value = [];
    handleChangeMsg.value = 'Handle changed.';
  } catch (e) {
    handleChangeMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    handleChangeBusy.value = false;
  }
}

/** The display name is end-to-end encrypted (in the profile blob) and shared
 *  only with contacts — the relay never sees it. */
async function saveDisplayName() {
  const name = displayName.value.trim();
  if (!name) return;
  displayNameBusy.value = true;
  displayNameMsg.value = '';
  try {
    await profile.updateProfileData({ displayName: name });
    displayName.value = name;
    displayNameOk.value = true;
    displayNameMsg.value = 'Saved.';
  } catch (e) {
    displayNameOk.value = false;
    displayNameMsg.value = e instanceof Error ? e.message : 'could not save';
  } finally {
    displayNameBusy.value = false;
  }
}

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
    handle.value = profile.myHandle;
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

function applyTheme() {
  setTheme(theme.value);
}

function applyPalette() {
  setPalette(palette.value);
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
    if (!notes.loaded) await notes.loadFromCache();
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
    if (!notes.loaded) await notes.loadFromCache();
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
        <!-- The mobile-open variant insets for the notch/safe areas via `max(…,
             env())` longhands rather than the `.app-safe` class: app-safe is
             unlayered CSS, so it would override the `p-6` padding utility and
             leave the section flush against the screen edges (no padding on
             mobile). max() keeps the base 1.5rem and only grows it where a safe
             area is larger (e.g. behind the notch). -->
        <div
          class="min-w-0 grow overflow-y-auto p-6"
          :class="isMobile
            ? (mobileSectionOpen
                ? 'fixed inset-0 z-nav bg-zinc-50 dark:bg-zinc-950 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.5rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))]'
                : 'hidden')
            : ''"
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
          <!-- Native handle change: pick a fresh generated candidate (no reauth). -->
          <div class="mt-3">
            <button
              v-if="!nativeHandleOptions.length"
              type="button"
              class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              @click="nativeRerollHandles"
            >
              Change handle
            </button>
            <div v-else class="space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-xs text-zinc-500 dark:text-zinc-400">Pick a new handle:</span>
                <button type="button" class="text-xs text-blue-600 hover:underline dark:text-blue-400" @click="nativeRerollHandles">Re-roll</button>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="opt in nativeHandleOptions"
                  :key="opt"
                  type="button"
                  data-testid="native-handle-option"
                  :disabled="handleChangeBusy"
                  class="rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 font-mono text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                  @click="nativeChangeHandle(opt)"
                >
                  {{ opt }}
                </button>
              </div>
              <button type="button" class="text-xs text-zinc-500 hover:underline dark:text-zinc-400" @click="nativeHandleOptions = []">Cancel</button>
            </div>
          </div>
          <p v-if="handleChangeMsg" class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{{ handleChangeMsg }}</p>
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

      <!-- Security: passkeys + recovery code -->
      <section v-show="activeSection === 'security'" class="space-y-3">
        <h2 class="text-lg font-semibold">Device lock</h2>
        <DeviceLockSettings />
      </section>

      <section v-show="activeSection === 'privacy'" class="space-y-3">
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

      <section v-show="activeSection === 'data'" class="space-y-3">
        <h2 class="text-lg font-semibold">Import & export</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Export decrypts your notes locally into a zip of Markdown files. Import accepts .md/.txt
          files or a zip of them.
        </p>
        <div class="flex gap-2">
          <select
            v-model="exportFormat"
            :disabled="transferBusy"
            title="As written keeps extended syntax (colors, spoilers); Obsidian keeps what Obsidian renders and unwraps spoilers; standard Markdown strips non-standard bits; plain text strips all markup"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="as-is">As written</option>
            <option value="obsidian">Obsidian</option>
            <option value="standard">Standard Markdown</option>
            <option value="plain">Plain text</option>
          </select>
          <button
            :disabled="transferBusy"
            class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            @click="exportAll"
          >
            Export all notes (.zip)
          </button>
          <button
            :disabled="transferBusy"
            class="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            @click="importInput?.click()"
          >
            Import notes…
          </button>
          <input ref="importInput" type="file" multiple accept=".md,.txt,.markdown,.zip" class="hidden" @change="importFiles" />
        </div>
        <p v-if="transferMsg" class="text-sm text-zinc-500 dark:text-zinc-400">{{ transferMsg }}</p>
      </section>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
