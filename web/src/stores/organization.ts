import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
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
  /** parent folder id for nesting; null/absent = a root folder. */
  parentId: string | null;
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
  /** folder key ('' = unfiled/root) → manually-ordered note ids. Notes in a
   *  folder but absent here fall back to recency order, appended after. */
  noteOrder: Record<string, string[]>;
  /** Per-conversation chat-sidebar organization (folders that group channels +
   *  pinned notes). Distinct from note folders, and personal (like pins). */
  chat: Record<string, ChatOrg>;
}

/** A chat-sidebar folder — a separate namespace from note folders. */
export interface ChatFolder {
  id: string;
  name: string;
  position: number;
  parentId: string | null;
}
export interface ChatOrg {
  folders: ChatFolder[];
  /** item key ('c:'+channelId | 'n:'+noteId) → chat folder id (absent = root). */
  itemFolder: Record<string, string>;
  /** folder key ('' = root) → manually-ordered item keys. */
  itemOrder: Record<string, string[]>;
}

/** Item keys used in the chat tree (channels and pinned notes share one space). */
export const chKey = (channelId: string): string => `c:${channelId}`;
export const noteItemKey = (noteId: string): string => `n:${noteId}`;

/** A note's folder, as a stable key for the noteOrder map. */
export function folderKey(folderId: string | null): string {
  return folderId ?? '';
}

function empty(): OrgData {
  return { folders: [], noteFolders: {}, pins: {}, noteOrder: {}, chat: {} };
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
  const noteOrder = ref<Record<string, string[]>>({});
  const chat = ref<Record<string, ChatOrg>>({});
  const loaded = ref(false);

  // Hydrate from the local cache immediately (instant; corrected by load()).
  function hydrateLocal(): void {
    const d = loadLocal();
    folders.value = d.folders;
    noteFolders.value = d.noteFolders;
    pins.value = d.pins;
    noteOrder.value = d.noteOrder ?? {};
    chat.value = d.chat ?? {};
  }
  hydrateLocal();

  const sortedFolders = computed(() => [...folders.value].sort((a, b) => a.position - b.position));

  /** Direct children of a folder (null = root folders), in position order. */
  function childFolders(parentId: string | null): OrgFolder[] {
    return sortedFolders.value.filter((f) => (f.parentId ?? null) === parentId);
  }
  /** A folder plus all of its descendants (for descendant-aware filtering). */
  function descendantFolderIds(id: string): string[] {
    const out: string[] = [id];
    for (let i = 0; i < out.length; i++) {
      for (const f of folders.value) if ((f.parentId ?? null) === out[i]) out.push(f.id);
    }
    return out;
  }

  function snapshot(): OrgData {
    return {
      folders: folders.value,
      noteFolders: noteFolders.value,
      pins: pins.value,
      noteOrder: noteOrder.value,
      chat: chat.value,
    };
  }

  /** Order a folder's candidate notes by the manual order, recency for the rest.
   *  `candidates` are pre-sorted by recency (newest first). */
  function orderedNoteIds(folderId: string | null, candidates: string[]): string[] {
    const manual = noteOrder.value[folderKey(folderId)] ?? [];
    const inManual = manual.filter((id) => candidates.includes(id));
    const rest = candidates.filter((id) => !inManual.includes(id));
    return [...inManual, ...rest];
  }
  function setNoteOrder(folderId: string | null, ids: string[]): void {
    noteOrder.value = { ...noteOrder.value, [folderKey(folderId)]: ids };
    persist();
  }
  function removeFromAllOrders(noteId: string): void {
    const next: Record<string, string[]> = {};
    let changed = false;
    for (const [k, ids] of Object.entries(noteOrder.value)) {
      const filtered = ids.filter((id) => id !== noteId);
      if (filtered.length !== ids.length) changed = true;
      next[k] = filtered;
    }
    if (changed) noteOrder.value = next;
  }

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  function persist(): void {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot()));
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushRemote(), 800);
  }
  // Drop a still-pending debounced push if the store's scope is torn down (e.g.
  // $dispose between tests), so an orphaned timer can't fire later and clobber a
  // newer state. Harmless in the app, where the store lives for the session.
  onScopeDispose(() => {
    if (pushTimer) clearTimeout(pushTimer);
  });
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
      noteOrder.value = d.noteOrder ?? {};
      chat.value = d.chat ?? {};
      localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot()));
    } catch {
      loaded.value = false; // transient: retry next call
    }
  }

  // ---- Folders ----
  function createFolder(name: string, parentId: string | null = null): string {
    const id = crypto.randomUUID();
    const position = folders.value.reduce((m, f) => Math.max(m, f.position), -1) + 1;
    folders.value = [...folders.value, { id, name: name.trim(), position, parentId }];
    persist();
    return id;
  }
  function renameFolder(id: string, name: string): void {
    folders.value = folders.value.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
    persist();
  }
  /** Re-parent a folder (drag-to-nest). No-ops on a cycle (can't nest a folder
   *  inside itself or one of its own descendants). */
  function setFolderParent(id: string, parentId: string | null): void {
    if (id === parentId) return;
    if (parentId !== null && descendantFolderIds(id).includes(parentId)) return;
    folders.value = folders.value.map((f) => (f.id === id ? { ...f, parentId } : f));
    persist();
  }
  /** Delete a folder; its child folders move up to its parent, its notes become
   *  unfiled, and it's unpinned everywhere. */
  function deleteFolder(id: string): void {
    const parent = folders.value.find((f) => f.id === id)?.parentId ?? null;
    folders.value = folders.value
      .filter((f) => f.id !== id)
      .map((f) => ((f.parentId ?? null) === id ? { ...f, parentId: parent } : f));
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
    // Drop it from its old folder's manual order; it'll re-sort in the new one.
    removeFromAllOrders(noteId);
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
    removeFromAllOrders(noteId);
    removePinEverywhere('note', noteId);
    persist();
  }

  // ---- Chat-sidebar folders (per conversation; personal; channels + notes) ----
  function chatOf(convId: string): ChatOrg {
    return chat.value[convId] ?? { folders: [], itemFolder: {}, itemOrder: {} };
  }
  function mutateChat(convId: string, fn: (rec: ChatOrg) => void): void {
    const cur = chatOf(convId);
    const rec: ChatOrg = {
      folders: [...cur.folders],
      itemFolder: { ...cur.itemFolder },
      itemOrder: { ...cur.itemOrder },
    };
    fn(rec);
    chat.value = { ...chat.value, [convId]: rec };
    persist();
  }
  function chatFolders(convId: string): ChatFolder[] {
    return [...chatOf(convId).folders].sort((a, b) => a.position - b.position);
  }
  function chatChildFolders(convId: string, parentId: string | null): ChatFolder[] {
    return chatFolders(convId).filter((f) => (f.parentId ?? null) === parentId);
  }
  function chatDescendantIds(convId: string, id: string): string[] {
    const out = [id];
    const all = chatOf(convId).folders;
    for (let i = 0; i < out.length; i++) {
      for (const f of all) if ((f.parentId ?? null) === out[i]) out.push(f.id);
    }
    return out;
  }
  function createChatFolder(convId: string, name: string, parentId: string | null = null): string {
    const id = crypto.randomUUID();
    mutateChat(convId, (rec) => {
      const position = rec.folders.reduce((m, f) => Math.max(m, f.position), -1) + 1;
      rec.folders.push({ id, name: name.trim(), position, parentId });
    });
    return id;
  }
  function renameChatFolder(convId: string, id: string, name: string): void {
    mutateChat(convId, (rec) => {
      rec.folders = rec.folders.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
    });
  }
  function setChatFolderParent(convId: string, id: string, parentId: string | null): void {
    if (id === parentId) return;
    if (parentId !== null && chatDescendantIds(convId, id).includes(parentId)) return;
    mutateChat(convId, (rec) => {
      rec.folders = rec.folders.map((f) => (f.id === id ? { ...f, parentId } : f));
    });
  }
  function deleteChatFolder(convId: string, id: string): void {
    mutateChat(convId, (rec) => {
      const parent = rec.folders.find((f) => f.id === id)?.parentId ?? null;
      rec.folders = rec.folders.filter((f) => f.id !== id).map((f) => ((f.parentId ?? null) === id ? { ...f, parentId: parent } : f));
      for (const [k, fid] of Object.entries(rec.itemFolder)) if (fid === id) delete rec.itemFolder[k];
      delete rec.itemOrder[id];
    });
  }
  function chatItemFolderOf(convId: string, itemKey: string): string | null {
    return chatOf(convId).itemFolder[itemKey] ?? null;
  }
  function setChatItemFolder(convId: string, itemKey: string, folderId: string | null): void {
    mutateChat(convId, (rec) => {
      if (folderId) rec.itemFolder[itemKey] = folderId;
      else delete rec.itemFolder[itemKey];
      for (const k of Object.keys(rec.itemOrder)) rec.itemOrder[k] = rec.itemOrder[k]!.filter((x) => x !== itemKey);
    });
  }
  function orderedChatItems(convId: string, folderId: string | null, candidates: string[]): string[] {
    const manual = chatOf(convId).itemOrder[folderKey(folderId)] ?? [];
    const inManual = manual.filter((k) => candidates.includes(k));
    return [...inManual, ...candidates.filter((k) => !inManual.includes(k))];
  }
  function setChatItemOrder(convId: string, folderId: string | null, keys: string[]): void {
    mutateChat(convId, (rec) => {
      rec.itemOrder[folderKey(folderId)] = keys;
    });
  }

  function reset(): void {
    folders.value = [];
    noteFolders.value = {};
    pins.value = {};
    noteOrder.value = {};
    chat.value = {};
    loaded.value = false;
  }

  return {
    folders,
    sortedFolders,
    noteFolders,
    pins,
    loaded,
    load,
    childFolders,
    descendantFolderIds,
    createFolder,
    renameFolder,
    setFolderParent,
    deleteFolder,
    folderOf,
    setNoteFolder,
    orderedNoteIds,
    setNoteOrder,
    pinsFor,
    isPinned,
    pin,
    unpin,
    forgetNote,
    // chat-sidebar folders
    chatFolders,
    chatChildFolders,
    chatDescendantIds,
    createChatFolder,
    renameChatFolder,
    setChatFolderParent,
    deleteChatFolder,
    chatItemFolderOf,
    setChatItemFolder,
    orderedChatItems,
    setChatItemOrder,
    reset,
  };
});
