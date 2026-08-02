// E2E helper: obtain a v8 relay device token for a fresh test account, over real
// HTTP against the running relay. It uses only production endpoints — there is
// no test-auth seam: `POST /api/relay/register` creates the account and enrolls
// a Node-generated Ed25519 device key (the relay under test runs with
// RELAY_REGISTRATION_MODE=public), then the real challenge → signed-nonce →
// token flow (D4b) mints the bearer that authorizes the SFU + signaling
// endpoints. The token returned by /register is deliberately discarded so the
// signed-nonce path is exercised end to end.
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export interface DeviceIdentity {
  token: string;
  userId: string;
  handle: string;
}

export async function deviceToken(api: APIRequestContext): Promise<DeviceIdentity> {
  // Device key (Ed25519); the relay enrolls its raw 32-byte public key.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubKey = spki.subarray(spki.length - 32).toString('base64');

  const registered = await api.post('/api/relay/register', { data: { pubKey, name: 'e2e device' } });
  if (!registered.ok()) {
    throw new Error(
      `register failed (${registered.status()}) — is the relay running with RELAY_REGISTRATION_MODE=public?`,
    );
  }
  const { userId, handle } = (await registered.json()) as { userId: string; handle: string };

  const info = (await (await api.get('/api/relay/info')).json()) as { identityFingerprint: string };
  const { nonce } = (await (await api.post('/api/relay/auth/challenge')).json()) as { nonce: string };
  const signature = edSign(null, Buffer.from(`${nonce}|${info.identityFingerprint}`), privateKey).toString('base64');
  const tokenRes = await api.post('/api/relay/auth/token', { data: { pubKey, nonce, signature } });
  if (!tokenRes.ok()) throw new Error(`auth/token failed (${tokenRes.status()})`);
  const { token } = (await tokenRes.json()) as { token: string };

  return { token, userId, handle };
}
