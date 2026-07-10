// E2E helper: obtain a v8 relay device token for a fresh test user, over real
// HTTP against the running server. Uses the env-gated test-auth seam
// (POST /api/test/session) to get a session without the passkey ceremony, then
// runs the real device enroll → challenge → signed-nonce → token flow (D4b) with
// a Node-generated Ed25519 device key. The returned bearer authorizes the v8
// SFU + signaling endpoints.
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export interface DeviceIdentity {
  token: string;
  userId: string;
  handle: string;
}

/** `api` must be a fresh APIRequestContext (its cookie jar holds the session). */
export async function deviceToken(api: APIRequestContext, handle?: string): Promise<DeviceIdentity> {
  const session = await api.post('/api/test/session', { data: handle ? { handle } : {} });
  if (!session.ok()) throw new Error(`test-session failed (${session.status()}) — is E2E_TEST_AUTH=1?`);
  const { userId, handle: assigned } = (await session.json()) as { userId: string; handle: string };

  // Device key (Ed25519); enroll its raw 32-byte public key.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubKey = spki.subarray(spki.length - 32).toString('base64');
  await api.post('/api/relay/devices', { data: { pubKey } });

  const info = (await (await api.get('/api/relay/info')).json()) as { identityFingerprint: string };
  const { nonce } = (await (await api.post('/api/relay/auth/challenge')).json()) as { nonce: string };
  const signature = edSign(null, Buffer.from(`${nonce}|${info.identityFingerprint}`), privateKey).toString('base64');
  const tokenRes = await api.post('/api/relay/auth/token', { data: { pubKey, nonce, signature } });
  const { token } = (await tokenRes.json()) as { token: string };

  return { token, userId, handle: assigned };
}
