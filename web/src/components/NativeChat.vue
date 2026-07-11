<script setup lang="ts">
// v8 native chat surface (D4b/D6/D11/D14): a self-contained DMs + groups
// experience on the native layers (nativeDm / nativeGroup / nativeFriends) — no
// server, no seq. Conversations' messages live in the local encrypted log.
// Message actions (edit/delete/react) are DM-only for now (group edit/react
// fan-out is a follow-up); groups support create / send / receive / add-member.
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import IconAdd from '~icons/mynaui/message-plus';
import IconSend from '~icons/mynaui/send-solid';
import IconBack from '~icons/mynaui/chevron-left';
import IconUsers from '~icons/mynaui/users';
import IconPaperclip from '~icons/mynaui/paperclip';
import IconPhone from '~icons/mynaui/telephone-call-solid';
import NativeAttachment from './NativeAttachment.vue';
import { callHost } from '../lib/callHost';
import { listDms, openDm, sendDm, type DmSummary } from '../lib/nativeDm';
import {
  addGroupMember,
  createGroup,
  listGroups,
  openGroup,
  sendGroup,
  type GroupItem,
} from '../lib/nativeGroup';
import { createInvite, redeemInvite } from '../lib/nativeFriends';
import {
  attachmentUpload,
  conversationReactions,
  relayDeleteMessage,
  relayEditMessage,
  relayReact,
  relayGroupDeleteMessage,
  relayGroupEditMessage,
  relayGroupReact,
  type MessageAttachment,
  type ReactionRow,
} from '../lib/native';
import { onMailIngested } from '../lib/nativeRelay';
import type { ChatMessageView } from '../stores/chat';

const PAGE = 50;

type Conv = { kind: 'dm' | 'group'; id: string; name: string; conversationId: string };

const dms = ref<DmSummary[]>([]);
const groups = ref<GroupItem[]>([]);
const active = ref<Conv | null>(null);
const messages = ref<ChatMessageView[]>([]);
const reactions = ref<ReactionRow[]>([]);
const draft = ref('');
const pendingFiles = ref<File[]>([]);
const panel = ref<'list' | 'add'>('list');
const createdInvite = ref<string | null>(null);
const redeemText = ref('');
const newGroupName = ref('');
const addingMember = ref(false);
const error = ref('');
const busy = ref(false);

async function refreshLists(): Promise<void> {
  [dms.value, groups.value] = await Promise.all([listDms(), listGroups()]);
}

async function loadReactions(): Promise<void> {
  reactions.value = active.value ? await conversationReactions(active.value.conversationId) : [];
}

function groupedReactions(msgKey: string | undefined): { emoji: string; count: number; mine: boolean }[] {
  if (!msgKey) return [];
  const g = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions.value) {
    if (r.message_id !== msgKey) continue;
    const e = g.get(r.emoji) ?? { count: 0, mine: false };
    e.count += 1;
    if (r.reactor_id === 'self') e.mine = true;
    g.set(r.emoji, e);
  }
  return [...g.entries()].map(([emoji, v]) => ({ emoji, ...v }));
}

async function loadMessages(): Promise<void> {
  if (!active.value) return;
  const res =
    active.value.kind === 'dm'
      ? await openDm(active.value.id, PAGE)
      : await openGroup(active.value.id, PAGE);
  messages.value = res.messages;
  await loadReactions();
}

async function open(conv: Conv): Promise<void> {
  error.value = '';
  addingMember.value = false;
  active.value = conv;
  await loadMessages();
  await refreshLists(); // opening marked it read → clear its unread badge
}

/** A message's attachments (the payload's attachments_json, parsed in rowToView). */
function msgAttachments(m: ChatMessageView): MessageAttachment[] {
  return (m.attachments ?? []) as unknown as MessageAttachment[];
}

function onFilePick(e: Event): void {
  const files = (e.target as HTMLInputElement).files;
  if (files) pendingFiles.value = [...pendingFiles.value, ...files];
  (e.target as HTMLInputElement).value = ''; // allow re-picking the same file
}

/** Ring the active DM's friend (v8 voice); the global call panel takes over. */
function startCall(): void {
  const a = active.value;
  if (a?.kind === 'dm') void callHost().placeCall(a.id);
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  const a = active.value;
  if ((!text && !pendingFiles.value.length) || !a || busy.value) return;
  busy.value = true;
  try {
    let attachmentsJson: string | undefined;
    if (pendingFiles.value.length) {
      const refs: MessageAttachment[] = [];
      for (const f of pendingFiles.value) {
        const bytes = Array.from(new Uint8Array(await f.arrayBuffer()));
        refs.push(await attachmentUpload(a.kind, a.id, bytes, f.type || 'application/octet-stream', f.name));
      }
      attachmentsJson = JSON.stringify(refs);
    }
    if (a.kind === 'dm') await sendDm(a.id, text, attachmentsJson);
    else await sendGroup(a.id, text, attachmentsJson);
    draft.value = '';
    pendingFiles.value = [];
    await loadMessages();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function toggleReaction(msgKey: string, emoji: string): Promise<void> {
  if (!active.value || busy.value) return;
  const mine = groupedReactions(msgKey).find((x) => x.emoji === emoji)?.mine ?? false;
  const a = active.value;
  busy.value = true;
  try {
    if (a.kind === 'dm') await relayReact(a.id, msgKey, emoji, !mine);
    else await relayGroupReact(a.id, msgKey, emoji, !mine);
    await loadReactions();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function remove(messageId: string): Promise<void> {
  if (!active.value || busy.value) return;
  const a = active.value;
  busy.value = true;
  try {
    if (a.kind === 'dm') await relayDeleteMessage(a.id, messageId);
    else await relayGroupDeleteMessage(a.id, messageId);
    await loadMessages();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

const editingId = ref<string | null>(null);
const editDraft = ref('');
function startEdit(m: ChatMessageView): void {
  editingId.value = m.key ?? null;
  editDraft.value = m.text ?? '';
}
function cancelEdit(): void {
  editingId.value = null;
}
async function saveEdit(messageId: string): Promise<void> {
  const text = editDraft.value.trim();
  if (!text || !active.value || busy.value) return;
  const a = active.value;
  busy.value = true;
  try {
    if (a.kind === 'dm') await relayEditMessage(a.id, messageId, text);
    else await relayGroupEditMessage(a.id, messageId, text);
    editingId.value = null;
    await loadMessages();
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
    await refreshLists();
    panel.value = 'list';
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function makeGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name || busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await createGroup(name);
    newGroupName.value = '';
    await refreshLists();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function addMember(contactId: string): Promise<void> {
  if (!active.value || active.value.kind !== 'group' || busy.value) return;
  busy.value = true;
  try {
    await addGroupMember(active.value.id, contactId);
    addingMember.value = false;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

const route = useRoute();
let unsub: (() => void) | null = null;
onMounted(async () => {
  await refreshLists();
  // Deep link from the Friends page ("Message"): auto-open that friend's DM.
  const openId = route?.query?.open;
  if (typeof openId === 'string') {
    const dm = dms.value.find((d) => d.contactId === openId);
    if (dm) await open({ kind: 'dm', id: dm.contactId, name: dm.displayName || dm.handle, conversationId: dm.conversationId });
  }
  unsub = onMailIngested(() => {
    void loadMessages();
    void refreshLists();
  });
});
onUnmounted(() => unsub?.());
</script>

<template>
  <div class="flex h-full">
    <!-- Conversation list -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-neutral-500/20">
      <header class="flex items-center justify-between p-3">
        <h2 class="text-sm font-semibold">Chats</h2>
        <button
          data-testid="add-friend"
          class="rounded p-1 hover:bg-neutral-500/10"
          title="Add a friend / group"
          @click="((panel = 'add'), (createdInvite = null), (error = ''))"
        >
          <IconAdd class="h-5 w-5" />
        </button>
      </header>
      <ul class="flex-1 overflow-y-auto">
        <li v-if="!dms.length && !groups.length" class="px-3 py-6 text-center text-xs opacity-60">
          No chats yet — add a friend or create a group.
        </li>
        <li v-for="dm in dms" :key="'dm:' + dm.contactId">
          <button
            data-testid="dm-row"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-500/10"
            :class="{ 'bg-neutral-500/10': active?.kind === 'dm' && active.id === dm.contactId }"
            @click="open({ kind: 'dm', id: dm.contactId, name: dm.displayName || dm.handle, conversationId: dm.conversationId })"
          >
            <span class="flex-1 truncate">{{ dm.displayName || dm.handle }}</span>
            <span v-if="dm.unread > 0" data-testid="unread-badge" class="shrink-0 rounded-full bg-blue-600 px-1.5 text-xs text-white">{{ dm.unread > 99 ? '99+' : dm.unread }}</span>
          </button>
        </li>
        <li v-for="g in groups" :key="'grp:' + g.groupId">
          <button
            data-testid="group-row"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-500/10"
            :class="{ 'bg-neutral-500/10': active?.kind === 'group' && active.id === g.groupId }"
            @click="open({ kind: 'group', id: g.groupId, name: g.name || 'Group', conversationId: g.conversationId })"
          >
            <IconUsers class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 truncate">{{ g.name || 'Group' }}</span>
            <span v-if="g.unread > 0" class="shrink-0 rounded-full bg-blue-600 px-1.5 text-xs text-white">{{ g.unread > 99 ? '99+' : g.unread }}</span>
          </button>
        </li>
      </ul>
      <footer class="border-t border-neutral-500/20 p-2">
        <form data-testid="new-group-form" class="flex items-center gap-1" @submit.prevent="makeGroup">
          <input v-model="newGroupName" data-testid="new-group" placeholder="New group name" class="min-w-0 flex-1 rounded border border-neutral-500/30 bg-transparent px-2 py-1 text-xs" />
          <button type="submit" data-testid="create-group" :disabled="busy || !newGroupName.trim()" class="rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:opacity-50">Create</button>
        </form>
      </footer>
    </aside>

    <!-- Add-friend panel -->
    <section v-if="panel === 'add'" class="flex flex-1 flex-col p-6">
      <button class="mb-4 flex items-center gap-1 text-sm opacity-70" @click="panel = 'list'">
        <IconBack class="h-4 w-4" /> Back
      </button>
      <h3 class="text-base font-semibold">Add a friend</h3>
      <div class="mt-4 space-y-2">
        <p class="text-sm opacity-70">Share an invite link:</p>
        <button data-testid="make-invite" :disabled="busy" class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" @click="makeInvite">Create invite link</button>
        <p v-if="createdInvite" data-testid="invite-link" class="select-all break-all rounded border border-neutral-500/30 p-2 font-mono text-xs">{{ createdInvite }}</p>
      </div>
      <div class="mt-6 space-y-2">
        <p class="text-sm opacity-70">Or redeem one you were sent:</p>
        <textarea v-model="redeemText" rows="2" placeholder="Paste an invite link" class="w-full rounded border border-neutral-500/30 bg-transparent p-2 font-mono text-xs" />
        <button data-testid="redeem" :disabled="busy || !redeemText.trim()" class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" @click="doRedeem">Redeem</button>
      </div>
      <p v-if="error" class="mt-4 text-sm text-red-500">{{ error }}</p>
    </section>

    <!-- Conversation view -->
    <section v-else-if="active" class="flex flex-1 flex-col">
      <header class="flex items-center justify-between border-b border-neutral-500/20 p-3 text-sm font-semibold">
        <span>{{ active.name }}</span>
        <div class="flex items-center gap-3">
          <button
            v-if="active.kind === 'dm'"
            data-testid="call-start"
            class="rounded p-1 text-green-600 hover:bg-neutral-500/10"
            title="Start a voice call"
            @click="startCall"
          >
            <IconPhone class="h-5 w-5" />
          </button>
          <button v-if="active.kind === 'group'" data-testid="add-member-toggle" class="text-xs font-normal text-blue-500" @click="addingMember = !addingMember">Add member</button>
        </div>
      </header>
      <!-- add-member picker (friends) -->
      <ul v-if="addingMember && active.kind === 'group'" class="border-b border-neutral-500/20 p-2 text-sm">
        <li v-for="dm in dms" :key="dm.contactId">
          <button data-testid="add-member-pick" class="w-full rounded px-2 py-1 text-left hover:bg-neutral-500/10" @click="addMember(dm.contactId)">{{ dm.displayName || dm.handle }}</button>
        </li>
        <li v-if="!dms.length" class="px-2 py-1 text-xs opacity-60">Add friends first.</li>
      </ul>
      <ul class="flex-1 space-y-2 overflow-y-auto p-3">
        <li v-for="m in messages" :key="m.key ?? String(m.seq)" class="flex flex-col" :class="m.senderId === 'self' ? 'items-end' : 'items-start'">
          <div class="group flex items-center gap-1">
            <form v-if="editingId === m.key" data-testid="edit-form" class="flex items-center gap-1" @submit.prevent="saveEdit(m.key!)">
              <input v-model="editDraft" data-testid="edit-input" class="rounded border border-neutral-500/30 bg-transparent px-2 py-1 text-sm" />
              <button type="submit" class="text-xs text-blue-500">Save</button>
              <button type="button" class="text-xs opacity-60" @click="cancelEdit">Cancel</button>
            </form>
            <template v-else>
              <span v-if="m.text !== null && m.key" class="flex gap-1 opacity-0 group-hover:opacity-100">
                <button data-testid="react-msg" class="text-xs" title="React 👍" @click="toggleReaction(m.key, '👍')">👍</button>
                <template v-if="m.senderId === 'self'">
                  <button data-testid="edit-msg" class="text-xs text-blue-500" @click="startEdit(m)">Edit</button>
                  <button data-testid="delete-msg" class="text-xs text-red-500" @click="remove(m.key)">Delete</button>
                </template>
              </span>
              <span v-if="m.text === null" class="max-w-[75%] rounded-2xl bg-neutral-500/10 px-3 py-1.5 text-sm italic opacity-60">Message deleted</span>
              <span v-else class="max-w-[75%] break-words rounded-2xl px-3 py-1.5 text-sm" :class="m.senderId === 'self' ? 'bg-blue-600 text-white' : 'bg-neutral-500/15'">{{ m.text }}<span v-if="m.editedAt" class="ml-1 text-[10px] opacity-60">(edited)</span></span>
            </template>
          </div>
          <div
            v-if="msgAttachments(m).length"
            class="mt-1 flex flex-col gap-1"
            :class="m.senderId === 'self' ? 'items-end' : 'items-start'"
          >
            <NativeAttachment
              v-for="(a, i) in msgAttachments(m)"
              :key="a.blobId + i"
              :attachment="a"
              :kind="active?.kind ?? 'dm'"
              :target-id="active?.id ?? ''"
            />
          </div>
          <div v-if="groupedReactions(m.key).length" class="mt-0.5 flex gap-1">
            <button v-for="rg in groupedReactions(m.key)" :key="rg.emoji" data-testid="reaction-chip" class="rounded-full px-1.5 text-xs" :class="rg.mine ? 'bg-blue-600/25' : 'bg-neutral-500/15'" @click="toggleReaction(m.key!, rg.emoji)">{{ rg.emoji }} {{ rg.count }}</button>
          </div>
        </li>
      </ul>
      <div v-if="pendingFiles.length" class="flex flex-wrap gap-1 border-t border-neutral-500/20 px-3 pt-2">
        <span v-for="(f, i) in pendingFiles" :key="i" data-testid="pending-file" class="flex items-center gap-1 rounded bg-neutral-500/15 px-2 py-0.5 text-xs">
          <span class="max-w-[140px] truncate">{{ f.name }}</span>
          <button class="opacity-60" @click="pendingFiles.splice(i, 1)">✕</button>
        </span>
      </div>
      <form data-testid="composer" class="flex items-center gap-2 border-t border-neutral-500/20 p-3" @submit.prevent="send">
        <label class="cursor-pointer rounded-full p-2 hover:bg-neutral-500/10" title="Attach a file">
          <IconPaperclip class="h-5 w-5 opacity-70" />
          <input type="file" multiple data-testid="file-input" class="hidden" @change="onFilePick" />
        </label>
        <input v-model="draft" data-testid="draft" placeholder="Message" class="flex-1 rounded-full border border-neutral-500/30 bg-transparent px-4 py-2 text-sm" />
        <button type="submit" data-testid="send" :disabled="busy || (!draft.trim() && !pendingFiles.length)" class="rounded-full bg-blue-600 p-2 text-white disabled:opacity-50">
          <IconSend class="h-5 w-5" />
        </button>
      </form>
      <p v-if="error" class="p-3 text-sm text-red-500">{{ error }}</p>
    </section>

    <section v-else class="flex flex-1 items-center justify-center text-sm opacity-60">
      Select a chat, or add a friend / create a group.
    </section>
  </div>
</template>
