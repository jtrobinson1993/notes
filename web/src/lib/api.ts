import type {
  CredentialInfo,
  InviteInfo,
  LoginVerifyResponse,
  MetaResponse,
  NotesSyncResponse,
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
  notePut: (id: string, data: { ciphertext: string; iv: string; wrappedKey: WrappedKey; createdAt: number }) =>
    req<{ id: string; updatedAt: number }>('PUT', `/api/notes/${encodeURIComponent(id)}`, data),
  noteDelete: (id: string) => req<{ id: string; updatedAt: number }>('DELETE', `/api/notes/${encodeURIComponent(id)}`),
};
