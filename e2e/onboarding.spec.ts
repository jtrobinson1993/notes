import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

// No-auth smoke tests: prove the built **relay** boots and serves its public
// surface. There is no SPA and no `/api/meta` any more — the product shell is
// the native Tauri app, so the only unauthenticated surfaces are the health
// probe and the pinned-identity handshake the native client uses to decide
// whether it trusts (and may register with) this relay.

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
});

test('relay info reports a pinned identity fingerprint and its registration mode', async ({ request }) => {
  const res = await request.get('/api/relay/info');
  expect(res.ok()).toBeTruthy();
  const info = (await res.json()) as {
    name: string;
    identityFingerprint: string;
    identityPubKey: string;
    delegation: { version: number; onlineKey: string; notAfter: number; signature: string };
    delegations: { version: number }[];
    apiVersion: number;
    registrationMode: string;
  };

  expect(info.apiVersion).toBe(2);
  expect(typeof info.name).toBe('string');

  // The fingerprint is what the client pins, so it must actually be the digest
  // of the advertised identity key — not an unrelated (or empty) string. That
  // key is the relay's offline ROOT (spec/relay.md): it signs delegations and
  // nothing else.
  const pubKey = Buffer.from(info.identityPubKey, 'base64');
  expect(pubKey).toHaveLength(32);
  const expected = createHash('sha256').update(pubKey).digest('base64url');
  expect(info.identityFingerprint).toBe(expected);

  // The delegation names the online key that actually signs KT roots, and it is
  // a different key from the pinned one — otherwise the split bought nothing.
  expect(info.delegation.version).toBeGreaterThanOrEqual(1);
  expect(Buffer.from(info.delegation.onlineKey, 'base64')).toHaveLength(32);
  expect(info.delegation.onlineKey).not.toBe(info.identityPubKey);
  expect(info.delegation.notAfter).toBeGreaterThan(Date.now());
  expect(info.delegations.at(-1)?.version).toBe(info.delegation.version);

  // This run boots the relay open (see playwright.config.ts) so the specs can
  // create throwaway accounts through the real signup endpoint.
  expect(info.registrationMode).toBe('public');
});

test('relay info is stable across calls (the pin cannot drift mid-session)', async ({ request }) => {
  const a = (await (await request.get('/api/relay/info')).json()) as { identityFingerprint: string };
  const b = (await (await request.get('/api/relay/info')).json()) as { identityFingerprint: string };
  expect(a.identityFingerprint).toBe(b.identityFingerprint);
});
