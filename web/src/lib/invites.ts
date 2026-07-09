// Self-describing friend invites (D4b; spec/relay.md § Invites, chat.md § v8
// friends). Pure helpers — no IPC/network. The invite is a bearer capability
// shared out-of-band (QR / link): the relay only ever stores hash(token), so
// possession of the invite string is what authorizes the one-time
// friend-accept drop on redeem. The inviter's pinned keys ride inside the
// invite so the invitee trusts the (in-person) invite channel rather than the
// relay's directory — TOFU against a key-swapping relay.

const INVITE_VERSION = 1;
const SCHEME = 'accord://friend?i=';

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh, high-entropy invite token (the bearer capability). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * `hash(token)` exactly as the relay stores it — SHA-256, base64url — so the
 * value minted here matches the server's
 * `createHash('sha256').update(token).digest('base64url')` and a later redeem
 * of the raw token resolves to it.
 */
export async function inviteTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return base64url(digest);
}

export interface InvitePayload {
  v: number;
  /** Relay HTTPS base URL to redeem against. */
  relayUrl: string;
  /** Pinned relay identity fingerprint (the invitee verifies the relay). */
  relayFp: string;
  /** The bearer capability (raw token; the relay holds only its hash). */
  token: string;
  /** Inviter handle (`Word#1234`). */
  handle: string;
  /** Inviter per-relay identity key (Ed25519, base64) — TOFU pin. */
  identityPub: string;
  /** Inviter sealing key (X25519, base64) — the invitee seals the accept here. */
  sealingPub: string;
}

/** Assemble a shareable invite string (QR / link) from the inviter's details. */
export function buildInvite(p: Omit<InvitePayload, 'v'>): string {
  const json = JSON.stringify({ v: INVITE_VERSION, ...p });
  return SCHEME + base64url(new TextEncoder().encode(json));
}

/** Parse + validate an invite string; throws on a bad/unknown/incomplete one. */
export function parseInvite(s: string): InvitePayload {
  if (!s.startsWith(SCHEME)) throw new Error('not an Accord invite');
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(fromBase64url(s.slice(SCHEME.length))));
  } catch {
    throw new Error('malformed invite');
  }
  const p = obj as Partial<InvitePayload>;
  if (p.v !== INVITE_VERSION) throw new Error(`unsupported invite version ${String(p.v)}`);
  const required: (keyof InvitePayload)[] = [
    'relayUrl',
    'relayFp',
    'token',
    'handle',
    'identityPub',
    'sealingPub',
  ];
  for (const k of required) {
    if (typeof p[k] !== 'string' || !(p[k] as string)) throw new Error(`invite missing ${k}`);
  }
  return {
    v: INVITE_VERSION,
    relayUrl: p.relayUrl as string,
    relayFp: p.relayFp as string,
    token: p.token as string,
    handle: p.handle as string,
    identityPub: p.identityPub as string,
    sealingPub: p.sealingPub as string,
  };
}
