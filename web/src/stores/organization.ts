import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../lib/api';
import { unwrapKey, wrapKey } from '../lib/crypto';
import { useSessionStore } from './session';

// v4 — note folders + chat-sidebar pins.
//
// Folders and pins are *personal organization*: they never touch the (E2EE) note
// payloads or the server note model, so they work for both owned and
// shared-with-me notes, and pinning a note into a chat sidebar does NOT share it
// (sharing is v5). The whole structure is one master-key-encrypted settings blob
// (folder names are as sensitive as tag names), mirroring tag colors / custom
// emoji, with a localStorage instant-load cache.

const SETTING_KEY = 'notes-org';
const LOCAL_KEY = 'notes:org';
const INFO_SETTINGS = 'notes:wrap:settings:v1';

export interface OrgFolder {
  id: string;
  name: string;
  position: number;
}
/** A note or folder pinned into one conversation's sidebar (personal). */
export interface OrgPin {
  kind: 'note' | 'folder';
  id: string;
}
interface OrgData {
  folders: OrgFolder[];
  /** noteId → folderId (absent = unfiled). */
  noteFolders: Record<string, string>;
  /** conversationId → pinned items (in order). */
  pins: Record<string, OrgPin[]>;
}

function empty(): OrgData {
  return { folders: [], noteFolders: {}, pins: {} };
}

function loadLocal(): OrgData {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return empty();
    return { ...empty(), ...(JSON.parse(raw) as OrgData) };
  } catch {
    return empty();
  }
}

export const useOrgStore = defineStore('organization', () => {
  const session = useSessionStore();
  const folders = ref<OrgFolder[]>([]);
  const noteFolders = ref<Record<string, string>>({});
  const pins = ref<Record<string, OrgPin[]>>({});
  const loaded = ref(false);

  // Hydrate from the local cache immediately (instant; corrected by load()).
  function hydrateLocal(): void {
    const d = loadLocal();
    folders.value = d.folders;
    noteFolders.value = d.noteFolders;
    pins.value = d.pins;
  }
  hydrateLocal();

  const sortedFolders = computed(() => [...folders.value].sort((a, b) => a.position - b.position));

  function snapshot(): OrgData {
    return { folders: folders.value, noteFolders: noteFolders.value, pins: pins.value };
  }

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  function persist(): void {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot()));
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushRemote(), 800);
  }
  async function pushRemote(): Promise<void> {
    if (!session.mk) return;
    const wrapped = await wrapKey(session.mk, new TextEncoder().encode(JSON.stringify(snapshot())), INFO_SETTINGS);
    await api.settingPut(SETTING_KEY, JSON.stringify(wrapped)).catch(() => {});
  }

  /** Fetch + decrypt the server copy once unlocked. */
  async function load(): Promise<void> {
    if (loaded.value || !session.mk) return;
    loaded.value = true;
    try {
      const remote = await api.settingGet(SETTING_KEY);
      if (!remote) return; // nothing stored yet
      const pt = await unwrapKey(session.mk, JSON.parse(remote.data), INFO_SETTINGS);
      const d = { ...empty(), ...(JSON.parse(new TextDecoder().decode(pt)) as OrgData) };
      folders.value = d.folders;
      noteFolders.value = d.noteFolders;
      pins.value = d.pins;
      localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot()));
    } catch {
      loaded.value = false; // transient: retry next call
    }
  }

  // ---- Folders ----
  function createFolder(name: string): string {
    const id = crypto.randomUUID();
    const position = folders.value.reduce((m, f) => Math.max(m, f.position), -1) + 1;
    folders.value = [...folders.value, { id, name: name.trim(), position }];
    persist();
    return id;
  }
  function renameFolder(id: string, name: string): void {
    folders.value = folders.value.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
    persist();
  }
  /** Delete a folder; its notes become unfiled, and it's unpinned everywhere. */
  function deleteFolder(id: string): void {
    folders.value = folders.value.filter((f) => f.id !== id);
    const nf = { ...noteFolders.value };
    for (const [noteId, folderId] of Object.entries(nf)) if (folderId === id) delete nf[noteId];
    noteFolders.value = nf;
    removePinEverywhere('folder', id);
    persist();
  }
  function folderOf(noteId: string): string | null {
    return noteFolders.value[noteId] ?? null;
  }
  function setNoteFolder(noteId: string, folderId: string | null): void {
    const nf = { ...noteFolders.value };
    if (folderId) nf[noteId] = folderId;
    else delete nf[noteId];
    noteFolders.value = nf;
    persist();
  }

  // ---- Pins (per conversation) ----
  function pinsFor(convId: string): OrgPin[] {
    return pins.value[convId] ?? [];
  }
  function isPinned(convId: string, kind: OrgPin['kind'], id: string): boolean {
    return pinsFor(convId).some((p) => p.kind === kind && p.id === id);
  }
  function pin(convId: string, kind: OrgPin['kind'], id: string): void {
    if (isPinned(convId, kind, id)) return;
    pins.value = { ...pins.value, [convId]: [...pinsFor(convId), { kind, id }] };
    persist();
  }
  function unpin(convId: string, kind: OrgPin['kind'], id: string): void {
    pins.value = { ...pins.value, [convId]: pinsFor(convId).filter((p) => !(p.kind === kind && p.id === id)) };
    persist();
  }
  /** Drop a pin of `kind`/`id` from every conversation (e.g. note/folder deleted). */
  function removePinEverywhere(kind: OrgPin['kind'], id: string): void {
    const next: Record<string, OrgPin[]> = {};
    for (const [convId, list] of Object.entries(pins.value)) {
      next[convId] = list.filter((p) => !(p.kind === kind && p.id === id));
    }
    pins.value = next;
  }
  /** Call when a note is deleted so it's removed from folders + all pins. */
  function forgetNote(noteId: string): void {
    if (noteId in noteFolders.value) {
      const nf = { ...noteFolders.value };
      delete nf[noteId];
      noteFolders.value = nf;
    }
    removePinEverywhere('note', noteId);
    persist();
  }

  function reset(): void {
    folders.value = [];
    noteFolders.value = {};
    pins.value = {};
    loaded.value = false;
  }

  return {
    folders,
    sortedFolders,
    noteFolders,
    pins,
    loaded,
    load,
    createFolder,
    renameFolder,
    deleteFolder,
    folderOf,
    setNoteFolder,
    pinsFor,
    isPinned,
    pin,
    unpin,
    forgetNote,
    reset,
  };
});
