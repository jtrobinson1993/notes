import type { FastifyInstance } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { LoginVerifyResponse, WrappedKey } from '@notes/shared';
import type { Config } from './../config.js';
import { toCredentialInfo, toUserInfo, type DB, type CredentialRow } from '../db.js';
import { endSession, requireAuth, startSession } from '../session.js';
import { newId, now, sha256b64, validUsername, validWrappedKey } from '../util.js';

interface RegChallenge {
  challenge: string;
  username: string;
  inviteId: string | null;
  /** set when adding a passkey to an existing logged-in account */
  userId: string | null;
}

interface AuthChallenge {
  challenge: string;
}

function credentialForVerify(c: CredentialRow) {
  return {
    id: c.id,
    publicKey: new Uint8Array(c.public_key),
    counter: c.counter,
    transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
  };
}

// Naive in-memory throttle for recovery-code attempts.
const recoveryAttempts = new Map<string, { count: number; resetAt: number }>();

export function authRoutes(app: FastifyInstance, db: DB, config: Config): void {
  // The unauthenticated credential ceremony (register / login / recovery) is the
  // brute-force surface, so it gets a tighter ceiling than the global limit —
  // still liberal (a real login is two requests, so ~30 attempts/min by default).
  const authLimit = {
    config: { rateLimit: { max: Math.max(30, Math.ceil(config.rateLimitMax / 10)), timeWindow: '1 minute' } },
  };

  app.get('/api/meta', async () => ({
    needsSetup: db.userCount() === 0,
    appName: config.appName,
  }));

  // ---- Registration (first-run setup or via invite) ----

  app.post('/api/register/options', authLimit, async (request, reply) => {
    const { username, inviteToken } = request.body as { username?: unknown; inviteToken?: unknown };
    if (!validUsername(username)) {
      return reply.code(400).send({ error: 'username must be 3-32 chars: letters, digits, - or _' });
    }
    let inviteId: string | null = null;
    if (db.userCount() > 0) {
      const invite = typeof inviteToken === 'string' ? db.getInviteByToken(inviteToken) : undefined;
      if (!invite || invite.used_by || invite.expires_at < now()) {
        return reply.code(403).send({ error: 'invalid or expired invite' });
      }
      inviteId = invite.id;
    }
    if (db.getUserByUsername(username)) {
      return reply.code(409).send({ error: 'username already taken' });
    }

    const options = await generateRegistrationOptions({
      rpName: config.appName,
      rpID: config.rpId,
      userName: username,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const regId = newId();
    db.putChallenge({
      id: regId,
      type: 'register',
      data: { challenge: options.challenge, username, inviteId, userId: null } satisfies RegChallenge,
    });
    return { regId, options };
  });

  app.post('/api/register/verify', authLimit, async (request, reply) => {
    const { regId, response, credentialName } = request.body as {
      regId?: unknown;
      response?: RegistrationResponseJSON;
      credentialName?: unknown;
    };
    if (typeof regId !== 'string' || !response) {
      return reply.code(400).send({ error: 'missing regId or response' });
    }
    const ch = db.takeChallenge<RegChallenge>(regId, 'register');
    if (!ch) return reply.code(400).send({ error: 'unknown or expired challenge' });

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'passkey verification failed' });
    }
    const { credential } = verification.registrationInfo;

    // Re-check invite/username inside this request to avoid races.
    if (db.getUserByUsername(ch.username)) {
      return reply.code(409).send({ error: 'username already taken' });
    }
    const firstUser = db.userCount() === 0;
    if (!firstUser) {
      if (!ch.inviteId) return reply.code(403).send({ error: 'invite required' });
      const invites = db.listInvites().find((i) => i.id === ch.inviteId);
      if (!invites || invites.used_by || invites.expires_at < now()) {
        return reply.code(403).send({ error: 'invalid or expired invite' });
      }
    }

    const userId = newId();
    db.createUser({ id: userId, username: ch.username, role: firstUser ? 'admin' : 'member' });
    db.createCredential({
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      name: typeof credentialName === 'string' && credentialName.length <= 64 ? credentialName : 'Passkey 1',
    });
    if (ch.inviteId) db.markInviteUsed(ch.inviteId, userId);

    startSession(db, config, reply, userId);
    const user = db.getUser(userId)!;
    return { user: toUserInfo(user), credentialId: credential.id };
  });

  // ---- Login (usernameless / discoverable) ----

  app.post('/api/login/options', authLimit, async () => {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: 'required',
    });
    const authId = newId();
    db.putChallenge({ id: authId, type: 'login', data: { challenge: options.challenge } satisfies AuthChallenge });
    return { authId, options };
  });

  app.post('/api/login/verify', authLimit, async (request, reply) => {
    const { authId, response } = request.body as { authId?: unknown; response?: AuthenticationResponseJSON };
    if (typeof authId !== 'string' || !response) {
      return reply.code(400).send({ error: 'missing authId or response' });
    }
    const ch = db.takeChallenge<AuthChallenge>(authId, 'login');
    if (!ch) return reply.code(400).send({ error: 'unknown or expired challenge' });

    const cred = db.getCredential(response.id);
    if (!cred) return reply.code(400).send({ error: 'unknown credential' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      credential: credentialForVerify(cred),
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return reply.code(401).send({ error: 'authentication failed' });
    }
    db.updateCredentialCounter(cred.id, verification.authenticationInfo.newCounter);

    const user = db.getUser(cred.user_id)!;
    startSession(db, config, reply, user.id);
    const result: LoginVerifyResponse = {
      user: toUserInfo(user),
      credentialId: cred.id,
      wrappedMk: cred.wrapped_mk ? (JSON.parse(cred.wrapped_mk) as WrappedKey) : null,
    };
    return result;
  });

  app.post('/api/logout', async (request, reply) => {
    endSession(db, request, reply);
    return { ok: true };
  });

  // ---- Recovery-code login ----

  app.post('/api/recovery/login', authLimit, async (request, reply) => {
    const { username, authKey } = request.body as { username?: unknown; authKey?: unknown };
    if (!validUsername(username) || typeof authKey !== 'string' || authKey.length > 256) {
      return reply.code(400).send({ error: 'missing username or authKey' });
    }
    const att = recoveryAttempts.get(username.toLowerCase());
    if (att && att.count >= 5 && att.resetAt > now()) {
      return reply.code(429).send({ error: 'too many attempts, try again later' });
    }

    const user = db.getUserByUsername(username);
    const expected = user?.recovery_auth_hash;
    const ok = expected !== null && expected !== undefined && expected === sha256b64(Buffer.from(authKey, 'base64'));
    if (!ok) {
      const cur = att && att.resetAt > now() ? att : { count: 0, resetAt: now() + 15 * 60_000 };
      recoveryAttempts.set(username.toLowerCase(), { count: cur.count + 1, resetAt: cur.resetAt });
      return reply.code(401).send({ error: 'recovery failed' });
    }
    recoveryAttempts.delete(username.toLowerCase());

    startSession(db, config, reply, user!.id, true);
    return {
      user: toUserInfo(user!),
      recoveryWrappedMk: JSON.parse(user!.recovery_wrapped_mk!) as WrappedKey,
    };
  });

  // ---- Current user & keys ----

  app.get('/api/me', { preHandler: requireAuth }, async (request) => {
    const u = request.user!;
    return {
      user: toUserInfo(u),
      hasKeys: u.recovery_auth_hash !== null,
      wrappedPrivateKey: u.wrapped_private_key ? (JSON.parse(u.wrapped_private_key) as WrappedKey) : null,
      recoveryWrappedMk: u.recovery_wrapped_mk ? (JSON.parse(u.recovery_wrapped_mk) as WrappedKey) : null,
      sessionRecovery: request.sessionRecovery,
    };
  });

  app.put('/api/me/keys', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body as Record<string, unknown>;
    if (
      typeof b.publicKey !== 'string' || b.publicKey.length > 256 ||
      !validWrappedKey(b.wrappedPrivateKey) ||
      !validWrappedKey(b.recoveryWrappedMk) ||
      typeof b.recoveryAuthHash !== 'string' || b.recoveryAuthHash.length > 64
    ) {
      return reply.code(400).send({ error: 'invalid keys payload' });
    }
    db.setUserKeys(request.user!.id, {
      publicKey: b.publicKey,
      wrappedPrivateKey: b.wrappedPrivateKey as WrappedKey,
      recoveryWrappedMk: b.recoveryWrappedMk as WrappedKey,
      recoveryAuthHash: b.recoveryAuthHash,
    });
    return { ok: true };
  });

  // ---- Credential management (logged in) ----

  app.get('/api/me/credentials', { preHandler: requireAuth }, async (request) => {
    return db.listCredentials(request.user!.id).map(toCredentialInfo);
  });

  app.post('/api/me/credentials/options', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const existing = db.listCredentials(user.id);
    const options = await generateRegistrationOptions({
      rpName: config.appName,
      rpID: config.rpId,
      userName: user.username,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const regId = newId();
    db.putChallenge({
      id: regId,
      type: 'register',
      data: { challenge: options.challenge, username: user.username, inviteId: null, userId: user.id } satisfies RegChallenge,
    });
    return { regId, options };
  });

  app.post('/api/me/credentials/verify', { preHandler: requireAuth }, async (request, reply) => {
    const { regId, response, credentialName } = request.body as {
      regId?: unknown;
      response?: RegistrationResponseJSON;
      credentialName?: unknown;
    };
    if (typeof regId !== 'string' || !response) {
      return reply.code(400).send({ error: 'missing regId or response' });
    }
    const ch = db.takeChallenge<RegChallenge>(regId, 'register');
    if (!ch || ch.userId !== request.user!.id) {
      return reply.code(400).send({ error: 'unknown or expired challenge' });
    }
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'passkey verification failed' });
    }
    const { credential } = verification.registrationInfo;
    db.createCredential({
      id: credential.id,
      userId: request.user!.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      name: typeof credentialName === 'string' && credentialName.length <= 64 ? credentialName : 'Passkey',
    });
    return { credentialId: credential.id };
  });

  app.put('/api/me/credentials/:id/wrapped-mk', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { wrappedKey } = request.body as { wrappedKey?: unknown };
    const cred = db.getCredential(id);
    if (!cred || cred.user_id !== request.user!.id) return reply.code(404).send({ error: 'not found' });
    if (!validWrappedKey(wrappedKey)) return reply.code(400).send({ error: 'invalid wrapped key' });
    db.setCredentialWrappedMk(id, wrappedKey as WrappedKey);
    return { ok: true };
  });

  app.patch('/api/me/credentials/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name } = request.body as { name?: unknown };
    const cred = db.getCredential(id);
    if (!cred || cred.user_id !== request.user!.id) return reply.code(404).send({ error: 'not found' });
    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      return reply.code(400).send({ error: 'invalid name' });
    }
    db.renameCredential(id, name);
    return { ok: true };
  });

  app.delete('/api/me/credentials/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = db.getCredential(id);
    if (!cred || cred.user_id !== request.user!.id) return reply.code(404).send({ error: 'not found' });
    if (db.listCredentials(request.user!.id).length <= 1) {
      return reply.code(400).send({ error: 'cannot delete your only passkey' });
    }
    db.deleteCredential(id);
    return { ok: true };
  });
}
