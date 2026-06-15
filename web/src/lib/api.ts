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
  NotesSyncResponse,
  ProfileInfo,
  SealedKey,
  SealedMemberKey,
  ShareAccess,
  ShareInfo,
  SharedNoteRecord,
  UserInfo,
  UserKeys,
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
  profileSet: (displayName: string) => req<ProfileInfo>('PUT', '/api/profile', { displayName }),

  // ---- v3 chat: conversations + messages ----
  conversations: () => req<Conversation[]>('GET', '/api/conversations'),
  conversationCreateDm: (friendId: string, members: SealedMemberKey[]) =>
    req<Conversation>('POST', '/api/conversations/dm', { friendId, members }),
  conversationMessages: (id: string, opts?: { before?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<ChatMessage[]>(
      'GET',
      `/api/conversations/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ''}`,
    );
  },
  messageSend: (id: string, body: { ciphertext: string; iv: string; epoch: number }) =>
    req<ChatMessage>('POST', `/api/conversations/${encodeURIComponent(id)}/messages`, body),
  conversationRead: (id: string, seq: number) =>
    req<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/read`, { seq }),
  reactions: (id: string) =>
    req<ChatReaction[]>('GET', `/api/conversations/${encodeURIComponent(id)}/reactions`),
  reactionAdd: (id: string, seq: number, body: { ciphertext: string; iv: string }) =>
    req<ChatReaction>('POST', `/api/conversations/${encodeURIComponent(id)}/messages/${seq}/reactions`, body),
  reactionRemove: (id: string, rid: string) =>
    req<{ ok: true }>('DELETE', `/api/conversations/${encodeURIComponent(id)}/reactions/${encodeURIComponent(rid)}`),
  gifSearch: (q: string, pos?: string) => {
    const params = new URLSearchParams({ q });
    if (pos) params.set('pos', pos);
    return req<GifSearchResponse>('GET', `/api/gifs/search?${params}`);
  },
  gifTrending: (pos?: string) =>
    req<GifSearchResponse>('GET', `/api/gifs/trending${pos ? `?pos=${encodeURIComponent(pos)}` : ''}`),
};
