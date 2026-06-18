import type {
  ChatMessage,
  Conversation,
  CredentialInfo,
  ChatReaction,
  Friend,
  FriendInvite,
  FriendRequest,
  GifSearchResponse,
  InviteInfo,
  LoginVerifyResponse,
  MemberInfo,
  MetaResponse,
  NoteVersionInfo,
  LinkPreview,
  NotesSyncResponse,
  ProfileCipher,
  ProfileInfo,
  ProfileView,
  PushSubscriptionInput,
  SealedEpochKey,
  SealedKey,
  SealedMemberKey,
  SealedProfileKey,
  ShareAccess,
  ShareInfo,
  SharedNoteRecord,
  UserInfo,
  UserKeys,
  VoiceConnectTransportRequest,
  VoiceConsumeRequest,
  VoiceConsumeResponse,
  VoiceJoinResponse,
  VoiceProduceRequest,
  VoiceProduceResponse,
  VoicePeer,
  VoiceTransportRequest,
  VoiceTransportResponse,
  WrappedKey,
} from '@notes/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? res.statusText);
  return json as T;
}

export interface MeResponse {
  user: UserInfo;
  hasKeys: boolean;
  wrappedPrivateKey: WrappedKey | null;
  recoveryWrappedMk: WrappedKey | null;
  sessionRecovery: boolean;
}

export interface InviteWithUrl extends InviteInfo {
  url: string;
}

export const api = {
  meta: () => req<MetaResponse>('GET', '/api/meta'),

  registerOptions: (username: string, inviteToken?: string) =>
    req<{ regId: string; options: Record<string, unknown> }>('POST', '/api/register/options', { username, inviteToken }),
  registerVerify: (regId: string, response: unknown, credentialName?: string) =>
    req<{ user: UserInfo; credentialId: string }>('POST', '/api/register/verify', { regId, response, credentialName }),

  loginOptions: () => req<{ authId: string; options: Record<string, unknown> }>('POST', '/api/login/options', {}),
  loginVerify: (authId: string, response: unknown) =>
    req<LoginVerifyResponse>('POST', '/api/login/verify', { authId, response }),
  logout: () => req<{ ok: true }>('POST', '/api/logout'),

  recoveryLogin: (username: string, authKey: string) =>
    req<{ user: UserInfo; recoveryWrappedMk: WrappedKey }>('POST', '/api/recovery/login', { username, authKey }),

  me: () => req<MeResponse>('GET', '/api/me'),
  putKeys: (keys: UserKeys) => req<{ ok: true }>('PUT', '/api/me/keys', keys),

  credentials: () => req<CredentialInfo[]>('GET', '/api/me/credentials'),
  credentialAddOptions: () =>
    req<{ regId: string; options: Record<string, unknown> }>('POST', '/api/me/credentials/options', {}),
  credentialAddVerify: (regId: string, response: unknown, credentialName?: string) =>
    req<{ credentialId: string }>('POST', '/api/me/credentials/verify', { regId, response, credentialName }),
  credentialPutWrappedMk: (id: string, wrappedKey: WrappedKey) =>
    req<{ ok: true }>('PUT', `/api/me/credentials/${encodeURIComponent(id)}/wrapped-mk`, { wrappedKey }),
  credentialRename: (id: string, name: string) =>
    req<{ ok: true }>('PATCH', `/api/me/credentials/${encodeURIComponent(id)}`, { name }),
  credentialDelete: (id: string) => req<{ ok: true }>('DELETE', `/api/me/credentials/${encodeURIComponent(id)}`),

  invites: () => req<InviteWithUrl[]>('GET', '/api/invites'),
  inviteCreate: (expiresInHours?: number) => req<InviteWithUrl>('POST', '/api/invites', { expiresInHours }),
  inviteDelete: (id: string) => req<{ ok: true }>('DELETE', `/api/invites/${encodeURIComponent(id)}`),

  users: () => req<UserInfo[]>('GET', '/api/users'),
  userDelete: (id: string) => req<{ ok: true }>('DELETE', `/api/users/${encodeURIComponent(id)}`),

  notes: (since: number) => req<NotesSyncResponse>('GET', `/api/notes?since=${since}`),
  notePut: (
    id: string,
    data: { ciphertext: string; iv: string; wrappedKey?: WrappedKey; createdAt: number; baseUpdatedAt?: number },
  ) => req<{ id: string; updatedAt: number }>('PUT', `/api/notes/${encodeURIComponent(id)}`, data),
  noteDelete: (id: string) => req<{ id: string; updatedAt: number }>('DELETE', `/api/notes/${encodeURIComponent(id)}`),

  members: () => req<MemberInfo[]>('GET', '/api/members'),
  sharedNotes: () => req<SharedNoteRecord[]>('GET', '/api/shared'),
  noteShares: (id: string) => req<ShareInfo[]>('GET', `/api/notes/${encodeURIComponent(id)}/shares`),
  shareNote: (id: string, recipientId: string, sealedKey: SealedKey, access: ShareAccess) =>
    req<{ ok: true }>('POST', `/api/notes/${encodeURIComponent(id)}/shares`, { recipientId, sealedKey, access }),
  unshareNote: (id: string, recipientId: string) =>
    req<{ ok: true }>('DELETE', `/api/notes/${encodeURIComponent(id)}/shares/${encodeURIComponent(recipientId)}`),

  noteVersions: (id: string) => req<NoteVersionInfo[]>('GET', `/api/notes/${encodeURIComponent(id)}/versions`),
  noteVersion: (id: string, vid: number) =>
    req<{ id: number; ciphertext: string; iv: string; wrappedKey: WrappedKey; createdAt: number }>(
      'GET',
      `/api/notes/${encodeURIComponent(id)}/versions/${vid}`,
    ),

  settingGet: (key: string) =>
    req<{ data: string; updatedAt: number } | null>('GET', `/api/settings/${encodeURIComponent(key)}`),
  settingPut: (key: string, data: string) =>
    req<{ updatedAt: number }>('PUT', `/api/settings/${encodeURIComponent(key)}`, { data }),

  attachmentUpload: async (data: Uint8Array): Promise<{ id: string; size: number }> => {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: data as unknown as BodyInit,
    });
    if (!res.ok) throw new ApiError(res.status, ((await res.json()) as { error?: string }).error ?? res.statusText);
    return (await res.json()) as { id: string; size: number };
  },
  attachmentDownload: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return new Uint8Array(await res.arrayBuffer());
  },
  attachmentDelete: (id: string) => req<{ ok: true }>('DELETE', `/api/attachments/${encodeURIComponent(id)}`),

  // ---- v3 chat: friends ----
  friendInviteCreate: () => req<FriendInvite>('POST', '/api/friend-invites'),
  friendInvites: () => req<FriendInvite[]>('GET', '/api/friend-invites'),
  friendInviteDelete: (id: string) =>
    req<{ ok: true }>('DELETE', `/api/friend-invites/${encodeURIComponent(id)}`),
  friendRedeem: (token: string) => req<{ ok: true }>('POST', '/api/friends/redeem', { token }),
  friendRequests: () => req<FriendRequest[]>('GET', '/api/friends/requests'),
  friendRequestAccept: (id: string) =>
    req<Friend>('POST', `/api/friends/requests/${encodeURIComponent(id)}/accept`),
  friendRequestDecline: (id: string) =>
    req<{ ok: true }>('POST', `/api/friends/requests/${encodeURIComponent(id)}/decline`),
  friends: () => req<Friend[]>('GET', '/api/friends'),
  unfriend: (userId: string) => req<{ ok: true }>('DELETE', `/api/friends/${encodeURIComponent(userId)}`),

  // ---- v3 chat: profile ----
  profileGet: () => req<ProfileInfo>('GET', '/api/profile'),
  profileSet: (patch: { displayName?: string; nameColor?: string | null }) =>
    req<ProfileInfo>('PUT', '/api/profile', patch),

  // ---- v3.2: E2EE profiles (bio + avatar) ----
  profileDataGet: () =>
    req<{ profile: (ProfileCipher & { ownerWrappedKey: WrappedKey }) | null }>('GET', '/api/profile/data'),
  profileDataSet: (body: {
    ciphertext: string;
    iv: string;
    epoch: number;
    ownerWrappedKey: WrappedKey;
    keys: SealedProfileKey[];
  }) => req<{ ok: true; epoch: number }>('PUT', '/api/profile/data', body),
  profileKeysAdd: (epoch: number, keys: SealedProfileKey[]) =>
    req<{ ok: true }>('POST', '/api/profile/keys', { epoch, keys }),
  profileVisibilitySet: (friendsOnly: boolean) =>
    req<ProfileInfo>('PUT', '/api/profile/visibility', { friendsOnly }),
  linkPreviewsSet: (enabled: boolean) =>
    req<ProfileInfo>('PUT', '/api/profile/link-previews', { enabled }),
  userProfileGet: (userId: string) =>
    req<ProfileView>('GET', `/api/users/${encodeURIComponent(userId)}/profile`),

  // ---- v3.4: link previews (server-side OG proxy) ----
  og: (url: string) => req<LinkPreview>('GET', `/api/og?url=${encodeURIComponent(url)}`),

  // ---- v3 chat: conversations + messages ----
  conversations: () => req<Conversation[]>('GET', '/api/conversations'),
  conversationCreateDm: (friendId: string, members: SealedMemberKey[]) =>
    req<Conversation>('POST', '/api/conversations/dm', { friendId, members }),
  conversationCreateGroup: (members: SealedMemberKey[]) =>
    req<Conversation>('POST', '/api/conversations/group', { members }),
  threadCreate: (parentId: string, seq: number, members: SealedMemberKey[]) =>
    req<Conversation>('POST', `/api/conversations/${encodeURIComponent(parentId)}/messages/${seq}/thread`, { members }),
  // ---- v3 phase 2: group membership management ----
  conversationAddMember: (
    id: string,
    body: { userId: string; epoch: number; history: 'share' | 'fresh'; keys: SealedMemberKey[]; priorKeys?: SealedEpochKey[] },
  ) => req<Conversation>('POST', `/api/conversations/${encodeURIComponent(id)}/members`, body),
  conversationRemoveMember: (id: string, userId: string, body: { epoch: number; keys: SealedMemberKey[] }) =>
    req<{ ok: true }>('DELETE', `/api/conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, body),
  conversationSetRole: (id: string, userId: string, role: 'admin' | 'member') =>
    req<Conversation>('POST', `/api/conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/role`, { role }),
  conversationMessages: (id: string, opts?: { before?: number; limit?: number; channelId?: string }) => {
    const q = new URLSearchParams();
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.channelId !== undefined) q.set('channelId', opts.channelId);
    const qs = q.toString();
    return req<ChatMessage[]>(
      'GET',
      `/api/conversations/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ''}`,
    );
  },
  messageSend: (id: string, body: { ciphertext: string; iv: string; epoch: number; channelId?: string }) =>
    req<ChatMessage>('POST', `/api/conversations/${encodeURIComponent(id)}/messages`, body),
  messageEdit: (id: string, seq: number, body: { ciphertext: string; iv: string }) =>
    req<ChatMessage>('PATCH', `/api/conversations/${encodeURIComponent(id)}/messages/${seq}`, body),
  conversationRead: (id: string, seq: number, channelId?: string) =>
    req<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/read`, { seq, channelId }),
  reactions: (id: string, channelId?: string) => {
    const qs = channelId !== undefined ? `?channelId=${encodeURIComponent(channelId)}` : '';
    return req<ChatReaction[]>('GET', `/api/conversations/${encodeURIComponent(id)}/reactions${qs}`);
  },
  reactionAdd: (id: string, seq: number, body: { ciphertext: string; iv: string }) =>
    req<ChatReaction>('POST', `/api/conversations/${encodeURIComponent(id)}/messages/${seq}/reactions`, body),
  reactionRemove: (id: string, rid: string) =>
    req<{ ok: true }>('DELETE', `/api/conversations/${encodeURIComponent(id)}/reactions/${encodeURIComponent(rid)}`),
  // ---- v4/v5: channels (groups only; v5 adds private channels) ----
  channelCreate: (id: string, body: { name: string; type: 'text' | 'voice'; private?: boolean; members?: SealedMemberKey[] }) =>
    req<Conversation>('POST', `/api/conversations/${encodeURIComponent(id)}/channels`, body),
  channelRename: (id: string, channelId: string, name: string) =>
    req<Conversation>('PATCH', `/api/conversations/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, { name }),
  channelReorder: (id: string, order: string[]) =>
    req<Conversation>('POST', `/api/conversations/${encodeURIComponent(id)}/channels/reorder`, { order }),
  channelDelete: (id: string, channelId: string) =>
    req<{ ok: true }>('DELETE', `/api/conversations/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`),
  channelAddMember: (
    id: string,
    channelId: string,
    body: { userId: string; epoch: number; history: 'share' | 'fresh'; keys: SealedMemberKey[]; priorKeys?: SealedEpochKey[] },
  ) => req<Conversation>('POST', `/api/conversations/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/members`, body),
  channelRemoveMember: (id: string, channelId: string, userId: string, body: { epoch: number; keys: SealedMemberKey[] }) =>
    req<{ ok: true }>('DELETE', `/api/conversations/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`, body),
  gifSearch: (q: string, pos?: string) => {
    const params = new URLSearchParams({ q });
    if (pos) params.set('pos', pos);
    return req<GifSearchResponse>('GET', `/api/gifs/search?${params}`);
  },
  gifTrending: (pos?: string) =>
    req<GifSearchResponse>('GET', `/api/gifs/trending${pos ? `?pos=${encodeURIComponent(pos)}` : ''}`),

  pushKey: () => req<{ publicKey: string | null }>('GET', '/api/push/key'),
  pushSubscribe: (sub: PushSubscriptionInput) => req<{ ok: true }>('POST', '/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>('POST', '/api/push/unsubscribe', { endpoint }),

  // v6 voice (mediasoup SFU). `room` is a voice-channel id. Blobs are mediasoup
  // params, typed loosely here and precisely by mediasoup-client at the edges.
  voiceJoin: (room: string) => req<VoiceJoinResponse>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/join`),
  voiceLeave: (room: string) => req<{ ok: true }>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/leave`),
  voiceCreateTransport: (room: string, direction: 'send' | 'recv') =>
    req<VoiceTransportResponse>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/transport`, { direction } satisfies VoiceTransportRequest),
  voiceConnectTransport: (room: string, body: VoiceConnectTransportRequest) =>
    req<{ ok: true }>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/transport/connect`, body),
  voiceProduce: (room: string, body: VoiceProduceRequest) =>
    req<VoiceProduceResponse>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/produce`, body),
  voiceConsume: (room: string, body: VoiceConsumeRequest) =>
    req<VoiceConsumeResponse>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/consume`, body),
  voiceRekey: (room: string, epoch: number, keys: SealedMemberKey[]) =>
    req<{ ok: true }>('POST', `/api/voice/rooms/${encodeURIComponent(room)}/rekey`, { epoch, keys }),
  voicePresence: (room: string) => req<{ peers: VoicePeer[] }>('GET', `/api/voice/rooms/${encodeURIComponent(room)}/presence`),
};
