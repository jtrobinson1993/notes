import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { deviceToken } from './helpers/deviceToken';

// Voice E2E foundation (spec/voice.md § v8, spec/testing.md Layer E). Drives the
// real running server + a real mediasoup worker over HTTP: two independent peers
// obtain device tokens (via the test-auth seam) and join the same v8 SFU call
// room. This validates the whole capability path end-to-end — test-session →
// device enroll → challenge/token → SFU join — that the browser CallMedia will
// build on. The in-browser media round-trip (getUserMedia → produce → consume
// with frame E2EE) lands with the CallMedia impl, driven through this harness.

const callId = (): string => `e2e-${randomBytes(9).toString('hex')}`;

test('two peers obtain device tokens and join the same v8 SFU call room', async ({ baseURL, playwright }) => {
  const apiA = await playwright.request.newContext({ baseURL });
  const apiB = await playwright.request.newContext({ baseURL });
  try {
    const a = await deviceToken(apiA, 'Alice#0001');
    const b = await deviceToken(apiB, 'Bob#0002');
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(a.userId).not.toBe(b.userId);

    const id = callId();
    const joinA = await apiA.post(`/api/relay/voice/rooms/${id}/join`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(joinA.ok()).toBe(true);
    const bodyA = (await joinA.json()) as {
      routerRtpCapabilities: { codecs: { mimeType: string }[] };
      peers: unknown[];
    };
    // Real mediasoup worker/router ran — opus is in the capabilities.
    expect(bodyA.routerRtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus')).toBe(true);
    expect(bodyA.peers).toEqual([]); // Alice is first in the room

    const joinB = await apiB.post(`/api/relay/voice/rooms/${id}/join`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(joinB.ok()).toBe(true);
    const bodyB = (await joinB.json()) as { peers: { participantId: string; producerId: string | null }[] };
    // Bob sees Alice in the roster (identity-free: an ephemeral participant id).
    expect(bodyB.peers).toHaveLength(1);
    expect(bodyB.peers[0].producerId).toBeNull(); // nobody has produced yet
    expect(typeof bodyB.peers[0].participantId).toBe('string');
  } finally {
    await apiA.dispose();
    await apiB.dispose();
  }
});

test('the v8 SFU rejects a join without a device token', async ({ baseURL, playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    const res = await api.post(`/api/relay/voice/rooms/${callId()}/join`);
    expect(res.status()).toBe(401);
  } finally {
    await api.dispose();
  }
});
