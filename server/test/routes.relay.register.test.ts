import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

const hash = (t: string) => createHash('sha256').update(t).digest('base64url');

/** A fresh Ed25519 device keypair, with the raw 32-byte public key base64'd the
 *  way the relay expects it. */
function deviceKey(): { pubKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pubKey: spki.subarray(spki.length - 32).toString('base64'), privateKey };
}

/** POST /api/relay/register and return the raw response. */
function register(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/api/relay/register', payload });
}

/** Enroll a device for an existing (legacy-session) user and return its bearer —
 *  used to give an inviter a mailbox so friend-accept delivery is observable. */
async function deviceBearer(cookie: string): Promise<string> {
  const { pubKey, privateKey } = deviceKey();
  await ctx.app.inject({ method: 'POST', url: '/api/relay/devices', headers: { cookie }, payload: { pubKey } });
  const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
  const nonce = (await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' })).json().nonce as string;
  const signature = edSign(null, Buffer.from(`${nonce}|${info.json().identityFingerprint as string}`), privateKey).toString('base64');
  const token = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/token', payload: { pubKey, nonce, signature } });
  return `Bearer ${token.json().token as string}`;
}

describe('account registration (v8 native bootstrap)', () => {
  it('exposes the registration mode via /api/relay/info', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    expect(info.json().registrationMode).toBe('public');
  });

  it('public mode: anyone can register, and the returned token authenticates', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    seedAuthedUser(ctx.db, { handle: 'Existing#0001' }); // not the first user
    const { pubKey } = deviceKey();

    const res = await register({ pubKey, name: 'Laptop' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.handle).toMatch(/#\d{4}$/);
    expect(typeof body.token).toBe('string');

    // The token is immediately usable on a device-token-authed route (the
    // mailbox — /api/relay/devices is gated on the legacy session, not a bearer).
    const mailbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: `Bearer ${body.token as string}` },
    });
    expect(mailbox.statusCode).toBe(200);
    expect(mailbox.json()).toHaveLength(0);
  });

  it('claims a chosen (valid) handle at registration', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    const res = await register({ pubKey, handle: 'Otter#0421' });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe('Otter#0421');
  });

  it('ignores a malformed / non-wordlist handle and auto-assigns instead', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    const res = await register({ pubKey, handle: 'not a real handle!!' });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toMatch(/^[A-Z][a-z]+#\d{4}$/);
    expect(res.json().handle).not.toBe('not a real handle!!');
  });

  it('changes the handle to another valid generated one (device-authed)', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    const bearer = `Bearer ${(await register({ pubKey, handle: 'Otter#0421' })).json().token as string}`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/handle',
      headers: { authorization: bearer },
      payload: { handle: 'Willow#3589' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe('Willow#3589');
    // The old handle is now free (another account can claim it).
    const { pubKey: pk2 } = deviceKey();
    expect((await register({ pubKey: pk2, handle: 'Otter#0421' })).json().handle).toBe('Otter#0421');
  });

  it('handle change rejects a malformed handle (400) and a taken one (409)', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    const bearer = `Bearer ${(await register({ pubKey })).json().token as string}`;
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/handle',
      headers: { authorization: bearer },
      payload: { handle: 'not valid' },
    });
    expect(bad.statusCode).toBe(400);
    // A second account takes Otter#0421; the first can't claim it.
    const { pubKey: pk2 } = deviceKey();
    await register({ pubKey: pk2, handle: 'Otter#0421' });
    const taken = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/handle',
      headers: { authorization: bearer },
      payload: { handle: 'Otter#0421' },
    });
    expect(taken.statusCode).toBe(409);
  });

  it('invite mode: registration always requires an invite (no first-user bypass)', async () => {
    // Even on a fresh, empty relay there is no admin/first-user free pass — the
    // operator must mint an invite (via CLI) to seed the first account.
    ctx = await makeApp({ registrationMode: 'invite' });
    expect(ctx.db.userCount()).toBe(0);
    const { pubKey } = deviceKey();
    const res = await register({ pubKey });
    expect(res.statusCode).toBe(403);
  });

  it('invite mode: an operator registration invite lets an account register (no friendship)', async () => {
    ctx = await makeApp({ registrationMode: 'invite' });
    const token = randomBytes(24).toString('base64url');
    ctx.db.mintRegistrationInvite(hash(token), Date.now() + 60_000);

    const { pubKey } = deviceKey();
    const res = await register({ pubKey, inviteToken: token });
    expect(res.statusCode).toBe(200);
    const bearer = `Bearer ${res.json().token as string}`;

    // Operator invites carry no inviter, so there's nothing to friend-accept.
    const fa = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/register/friend-accept',
      headers: { authorization: bearer },
      payload: { envelope: Buffer.from('x').toString('base64') },
    });
    expect(fa.json().delivered).toBe(false);

    // One-time: the same operator invite can't register a second account.
    const { pubKey: pk2 } = deviceKey();
    const reuse = await register({ pubKey: pk2, inviteToken: token });
    expect(reuse.statusCode).toBe(401);
  });

  it('invite mode: a valid invite registers the account, is consumed, and delivers a friend-accept', async () => {
    ctx = await makeApp({ registrationMode: 'invite' });
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const aliceBearer = await deviceBearer(alice.cookie); // gives Alice a mailbox
    const token = randomBytes(24).toString('base64url');
    ctx.db.mintRelayInvite(hash(token), alice.id, Date.now() + 60_000);

    // Bob registers via the invite.
    const { pubKey } = deviceKey();
    const res = await register({ pubKey, inviteToken: token });
    expect(res.statusCode).toBe(200);
    const bobBearer = `Bearer ${res.json().token as string}`;

    // The invite is now consumed (a fresh register with it is refused).
    const { pubKey: pk2 } = deviceKey();
    const reuse = await register({ pubKey: pk2, inviteToken: token });
    expect(reuse.statusCode).toBe(401);

    // Bob's first authed leg delivers the sealed friend-accept to Alice.
    const envelope = Buffer.from('sealed friend-accept').toString('base64');
    const fa = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/register/friend-accept',
      headers: { authorization: bobBearer },
      payload: { envelope },
    });
    expect(fa.statusCode).toBe(200);
    expect(fa.json().delivered).toBe(true);

    const mailbox = await ctx.app.inject({ method: 'GET', url: '/api/relay/mailbox', headers: { authorization: aliceBearer } });
    expect(mailbox.json()).toHaveLength(1);
    expect(mailbox.json()[0].envelope).toBe(envelope);

    // The one-shot is spent: a second friend-accept delivers nothing.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/register/friend-accept',
      headers: { authorization: bobBearer },
      payload: { envelope },
    });
    expect(again.json().delivered).toBe(false);
  });

  it('invite mode: an invalid invite is refused (uniform 401)', async () => {
    ctx = await makeApp({ registrationMode: 'invite' });
    seedAuthedUser(ctx.db, { handle: 'Admin#0001' });
    const { pubKey } = deviceKey();
    const res = await register({ pubKey, inviteToken: 'never-minted' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a device key that is already enrolled (no duplicate account)', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    expect((await register({ pubKey })).statusCode).toBe(200);
    const dup = await register({ pubKey });
    expect(dup.statusCode).toBe(409);
    expect(ctx.db.userCount()).toBe(1);
  });

  it('public signup has no pending inviter — friend-accept is a no-op', async () => {
    ctx = await makeApp({ registrationMode: 'public' });
    const { pubKey } = deviceKey();
    const bearer = `Bearer ${(await register({ pubKey })).json().token as string}`;
    const fa = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/register/friend-accept',
      headers: { authorization: bearer },
      payload: { envelope: Buffer.from('x').toString('base64') },
    });
    expect(fa.json().delivered).toBe(false);
  });
});
