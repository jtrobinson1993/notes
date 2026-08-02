// Friend invite orchestration (D4b) — ties the pure payload layer (invites.ts)
// to the Rust core's relay IPC. Kept out of invites.ts so that module stays
// pure/testable. The friends-store recording (adding the friend on both sides,
// processing the inbound friend-accept envelope on drain, reciprocating the
// delivery token) is deliberately NOT here yet — that's the legacy
// friends-store cutover.

import {
  accountSetLabel,
  envelopeSeal,
  relayConnect,
  relayDirectoryPublish,
  relayInviteMint,
  relayInviteRedeem,
  relayMyDirectoryKeys,
  relayRegister,
  relayRegisterFriendAccept,
  relayRegisterVerifier,
  settingsGet,
  settingsSet,
} from './native';
import { buildInvite, generateInviteToken, inviteTokenHash, parseInvite } from './invites';
import { rememberRelayUrl } from './nativeRelay';
import { coreErrorCode, rethrowCoreError, toastCoreError } from './nativeErrors';

/** True if a register was refused because this device is already enrolled (a
 *  prior onboarding attempt got past the register step). Recoverable. */
function isAlreadyRegistered(e: unknown): boolean {
  return /already registered/i.test(String(e));
}

/** The core fails closed on two kinds of impostor, and neither is a hiccup to
 *  retry past: the relay's key-transparency log publishes a different identity
 *  key for the inviter's handle (`KT_CONTACT_KEY_MISMATCH` — the invite is not
 *  from who it claims), or the relay itself is not the one the invite/pin names
 *  (`RELAY_IDENTITY_*`). Both are surfaced as catalogued errors rather than raw
 *  core strings: the user needs the explanation, not the internals. */
function isImpostor(e: unknown): boolean {
  return coreErrorCode(e) !== null;
}

/**
 * The essential onboarding step: create the account + enroll this device, and
 * return our handle. If the device is already enrolled (a prior attempt
 * succeeded at register but stumbled afterward), recover by connecting with it
 * and reading our stored handle — an already-registered device must never
 * dead-end on the onboarding wall.
 */
async function ensureAccount(
  relayUrl: string,
  token?: string,
  handleChoice?: string,
  relayFp?: string,
): Promise<string> {
  try {
    return await relayRegister(relayUrl, token, handleChoice, relayFp);
  } catch (e) {
    // An impostor relay must not be retried past — and it is not the
    // "already enrolled" case, whatever the message order.
    if (isImpostor(e)) rethrowCoreError(e);
    if (!isAlreadyRegistered(e)) throw e;
    // The device is enrolled → authenticate with it, still holding the relay to
    // the invite's fingerprint.
    await relayConnect(relayUrl, relayFp).catch(rethrowCoreError);
    const handle = await settingsGet(MY_HANDLE_KEY);
    if (!handle) throw e; // nothing stored to recover with — surface the original
    return handle;
  }
}

/** Identity chosen in the signup wizard: the picked Word#1234 handle and the
 *  required display name. */
export interface SignupIdentity {
  handle?: string;
  displayName?: string;
}

/** Persist my identity locally after registration: the server-assigned handle
 *  and (if set at signup) the display name. E2EE distribution of the display name
 *  to friends comes with the friends cutover; for now it's shown in my own UI. */
async function persistIdentity(handle: string, displayName?: string): Promise<void> {
  await settingsSet(MY_HANDLE_KEY, handle);
  await accountSetLabel(handle); // so the account switcher shows my handle
  if (displayName?.trim()) await settingsSet(MY_DISPLAY_NAME_KEY, displayName.trim());
}

/**
 * Best-effort: publish our directory keys + register our sealed-sender verifier.
 * Never throws — the account + device already exist, so a hiccup here must not
 * strand onboarding; `reconnectRelay` re-runs (idempotently) on the next connect.
 */
async function publishSelf(): Promise<void> {
  try {
    await relayDirectoryPublish();
    await relayRegisterVerifier();
  } catch (e) {
    console.warn('post-registration publish incomplete (will retry on connect):', e);
  }
}

/** Seal a friend-accept/confirm payload (my handle + delivery token + sealing
 *  key) to a peer's sealing key — the shared shape both the invite redeem and
 *  the post-register handshake deliver. */
async function sealFriendAccept(recipientSealingPub: string, me: { handle: string; deliveryToken: string }): Promise<number[]> {
  const keys = await relayMyDirectoryKeys();
  // Carry my display name (if set) so the friend's list shows my real name, not
  // just my handle — the E2EE half of profile sharing over the D4b handshake.
  const displayName = (await settingsGet(MY_DISPLAY_NAME_KEY)) || undefined;
  const payload = Array.from(
    new TextEncoder().encode(
      JSON.stringify({ handle: me.handle, displayName, deliveryToken: me.deliveryToken, sealingPub: keys.sealing_pub }),
    ),
  );
  return envelopeSeal(recipientSealingPub, FRIEND_ACCEPT_KIND, payload);
}

/**
 * Onboard a brand-new account by redeeming a friend invite: create the account
 * on the inviter's relay (the invite token gates signup), publish our directory
 * keys, register our sealed-sender verifier, then deliver the friend-accept back
 * through the invite's one-shot follow-up leg. The inviter reciprocates a
 * friend-confirm via the mailbox, which our drain records — completing D4b.
 * Resolves with our new handle and the inviter's (for the friends list).
 */
export async function registerViaInvite(
  inviteStr: string,
  identity?: SignupIdentity,
): Promise<{ handle: string; inviterHandle: string }> {
  const inv = parseInvite(inviteStr);
  // `inv.relayFp` is the anchor: it came through the human invite channel, so
  // it is the only thing about the relay that the relay did not tell us.
  const handle = await ensureAccount(inv.relayUrl, inv.token, identity?.handle, inv.relayFp);
  await persistIdentity(handle, identity?.displayName);
  await rememberRelayUrl(inv.relayUrl); // so a later cold start reconnects
  // Publish + friend handshake are best-effort: the account already exists, so a
  // failure here must not strand onboarding (it reaches the app; the handshake
  // retries). The friend-accept needs the delivery token from the verifier.
  try {
    await relayDirectoryPublish();
    const deliveryToken = await relayRegisterVerifier();
    const envelope = await sealFriendAccept(inv.sealingPub, { handle, deliveryToken });
    // The core verifies the invite's pinned key against the transparency log
    // before delivering this (it carries our delivery token).
    await relayRegisterFriendAccept(envelope, inv.handle, inv.identityPub);
  } catch (e) {
    // A KT / relay-identity mismatch is NOT a hiccup to retry past — the invite
    // is not from who it claims, or the relay is not the one it named. The
    // account exists either way, so we surface it and let the user land in the
    // app without that "friend".
    if (!toastCoreError(e)) {
      console.warn('post-registration setup / friend handshake incomplete (retry on connect):', e);
    }
  }
  return { handle, inviterHandle: inv.handle };
}

/**
 * Onboard a brand-new account by relay address (no friend invite): create the
 * account, publish directory keys, register the verifier. Used for public relays
 * (no code) and for **operator-seeded** invite-only relays, where the operator
 * hands out a bare registration `code` (from the relay CLI) alongside the URL —
 * including the operator's own first account. No friend handshake; friends are
 * added later via the normal in-app invite flow.
 */
export async function registerOnRelay(
  relayUrl: string,
  code?: string,
  identity?: SignupIdentity,
): Promise<{ handle: string }> {
  const handle = await ensureAccount(relayUrl, code?.trim() || undefined, identity?.handle);
  await persistIdentity(handle, identity?.displayName);
  await rememberRelayUrl(relayUrl); // so a later cold start reconnects
  await publishSelf(); // best-effort; never strands an already-registered device
  return { handle };
}

/** Device setting: my own handle, so the drain can name me when it reciprocates
 *  a friend-confirm. Captured here because invite creation is the point where
 *  the UI knows my handle and also the prerequisite for ever reciprocating. */
const MY_HANDLE_KEY = 'identity.handle';

/** Device setting: my chosen display name (the E2EE real name shown to contacts).
 *  Stored locally at signup; friend distribution lands with the friends cutover. */
const MY_DISPLAY_NAME_KEY = 'profile.displayName';

/** Envelope `kind` for the sealed friend-accept dropped on redeem. */
export const FRIEND_ACCEPT_KIND = 'friend-accept';

/**
 * Create a shareable friend invite: mint `hash(token)` at the relay, then
 * assemble the self-describing invite embedding my pinned directory keys.
 * `relayUrl`/`relayFp` come from the connected relay; `handle` is my handle.
 */
export async function createFriendInvite(opts: {
  handle: string;
  relayUrl: string;
  relayFp: string;
  expiresInSec?: number;
}): Promise<{ invite: string; expiresAt: number }> {
  const token = generateInviteToken();
  const expiresAt = await relayInviteMint(await inviteTokenHash(token), opts.expiresInSec);
  await settingsSet(MY_HANDLE_KEY, opts.handle); // so the drain can reciprocate
  const keys = await relayMyDirectoryKeys();
  const invite = buildInvite({
    relayUrl: opts.relayUrl,
    relayFp: opts.relayFp,
    token,
    handle: opts.handle,
    identityPub: keys.identity_pub,
    sealingPub: keys.sealing_pub,
  });
  return { invite, expiresAt };
}

/**
 * Redeem an invite: seal a friend-accept (my handle + delivery token) to the
 * inviter's pinned sealing key and drop it through the one-time capability.
 * Resolves with the inviter's handle (to friend locally) and the relay stamp.
 * The inviter reciprocates its own delivery token on drain.
 */
export async function redeemFriendInvite(
  inviteStr: string,
  me: { handle: string; deliveryToken: string },
): Promise<{ inviterHandle: string; relayTs: number }> {
  const inv = parseInvite(inviteStr);
  // Include my sealing key so the inviter can reciprocate (seal a friend-confirm
  // back to me); the whole payload is signed by the envelope.
  const envelope = await sealFriendAccept(inv.sealingPub, me);
  // The core checks the invite's relay fingerprint against the connected relay,
  // then the invite's pinned identity key against that relay's transparency log,
  // and refuses to send on either mismatch — fail closed before the delivery
  // token inside the envelope can reach an impostor.
  const relayTs = await relayInviteRedeem(
    inv.token,
    envelope,
    inv.handle,
    inv.identityPub,
    inv.relayFp,
  ).catch(rethrowCoreError);
  return { inviterHandle: inv.handle, relayTs };
}
