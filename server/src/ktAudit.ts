// Reference KT auditor — pure verification core (spec/key-transparency.md).
//
// Anyone can fetch a relay's signed epoch roots (`GET /api/relay/kt/roots`, or
// the `/.well-known/accord/kt-roots` alias) and its identity key
// (`GET /api/relay/info`) and independently prove the log is well-formed. This
// module is the engine; `ktAuditCli.ts` is the thin fetch-and-print wrapper.
//
// What this verifies today (works on the built log shape):
//   • the relay's delegation chain under its PINNED ROOT key, and every root's
//     signature under the online key that root's `keyVersion` names — so a
//     rotation doesn't invalidate the history, and an online key the root never
//     delegated to signs nothing an auditor will accept (`keysFromDelegations`),
//   • hash-chain linkage (each root's prevRootHash == the previous rootHash),
//   • strictly increasing epochs (no gaps counted as fatal, but see watch mode),
//   • watch mode: a previously-seen epoch whose rootHash *changed* (a rewrite),
//     and a stalled log (no fresh heartbeat epoch within a max gap).
//
// What it does NOT yet verify: cryptographic *consistency/extension* proofs
// (that epoch n+1's tree provably append-only-extends epoch n). The built root
// is a per-epoch Merkle snapshot over the re-sorted directory, which does not
// admit RFC-6962-style consistency proofs; that assurance awaits the AKD
// history-tree structure (key-transparency.md). Chain linkage + signatures
// still detect a silently *rewritten* published history, which is the property
// a third-party auditor most needs; we just don't (yet) get the stronger
// "no equivocation between two honestly-signed roots" guarantee.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { verifyDelegation } from './relayIdentity.js';

// DER SPKI header for a raw 32-byte Ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignedRoot {
  epoch: number;
  rootHash: string;
  prevRootHash: string | null;
  signature: string; // base64
  timestamp?: number;
  /** Delegation version of the online key that signed this root. Absent on a
   *  relay that has never rotated; then every root is under the current key. */
  keyVersion?: number;
}

/** How to find the signing key for a root: one key for the whole chain, or a
 *  per-root lookup (a relay that has rotated its online key). */
export type RootSigningKeys = string | ((root: SignedRoot) => string | undefined);

function keyFor(keys: RootSigningKeys, root: SignedRoot): string | undefined {
  return typeof keys === 'string' ? keys : keys(root);
}

/**
 * Build the per-root key lookup from a relay's delegation chain: every
 * delegation must verify against the PINNED ROOT key, and versions must
 * strictly increase. Returns null if either fails — a relay that serves a
 * delegation its root did not sign is lying about who may sign its log, and
 * nothing downstream should be verified against it.
 */
export function keysFromDelegations(
  rootPubKeyB64: string,
  delegations: unknown[],
): RootSigningKeys | null {
  const byVersion = new Map<number, string>();
  let highest = 0;
  for (const d of delegations) {
    if (!verifyDelegation(rootPubKeyB64, d)) return null;
    if (d.version <= highest && byVersion.size > 0) return null; // not strictly increasing
    highest = Math.max(highest, d.version);
    byVersion.set(d.version, d.onlineKey);
  }
  if (byVersion.size === 0) return null;
  const current = byVersion.get(highest)!;
  return (root: SignedRoot) =>
    root.keyVersion === undefined ? current : byVersion.get(root.keyVersion);
}

export interface ChainResult {
  ok: boolean;
  verifiedEpochs: number;
  error?: string;
}

/** Wrap a raw base64 Ed25519 identity key (from `/info`) as a KeyObject. */
export function relayIdentityKey(identityPubKeyB64: string) {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(identityPubKeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
}

/** The exact bytes the relay signs for one root (must mirror the publisher). */
export function rootSigningPayload(root: SignedRoot): Buffer {
  return Buffer.from(`kt-root|${root.rootHash}|${root.prevRootHash ?? 'genesis'}`);
}

/** Verify one root's signature under the online key that (claims to have)
 *  signed it. `keys` is either that key or the delegation lookup. */
export function verifyRootSignature(keys: RootSigningKeys, root: SignedRoot): boolean {
  const pub = keyFor(keys, root);
  if (!pub) return false; // a root naming a key version no delegation covers
  try {
    return edVerify(null, rootSigningPayload(root), relayIdentityKey(pub), Buffer.from(root.signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Verify a full (or partial) root chain, ascending by epoch. `expectedPrevHash`
 * is the rootHash the first root must chain onto — `null` for genesis, or a
 * saved checkpoint's rootHash when auditing incrementally.
 */
export function verifyRootChain(
  keys: RootSigningKeys,
  roots: SignedRoot[],
  expectedPrevHash: string | null = null,
): ChainResult {
  const sorted = [...roots].sort((a, b) => a.epoch - b.epoch);
  let prevHash = expectedPrevHash;
  let prevEpoch = Number.NEGATIVE_INFINITY;
  let verified = 0;
  for (const r of sorted) {
    if (r.epoch <= prevEpoch) {
      return { ok: false, verifiedEpochs: verified, error: `epoch ${r.epoch} not strictly increasing` };
    }
    if (r.prevRootHash !== prevHash) {
      return { ok: false, verifiedEpochs: verified, error: `broken chain link at epoch ${r.epoch}` };
    }
    if (!verifyRootSignature(keys, r)) {
      return { ok: false, verifiedEpochs: verified, error: `bad signature at epoch ${r.epoch}` };
    }
    prevHash = r.rootHash;
    prevEpoch = r.epoch;
    verified += 1;
  }
  return { ok: true, verifiedEpochs: verified };
}

/**
 * Watch-mode rewrite detection: given rootHashes seen at prior epochs and a
 * freshly fetched set, return the first epoch whose published rootHash changed
 * (a silent rewrite of history) — or `null` if every overlapping epoch matches.
 */
export function detectRewrite(
  seen: ReadonlyMap<number, string>,
  fresh: SignedRoot[],
): { epoch: number; was: string; now: string } | null {
  for (const r of fresh) {
    const was = seen.get(r.epoch);
    if (was !== undefined && was !== r.rootHash) {
      return { epoch: r.epoch, was, now: r.rootHash };
    }
  }
  return null;
}

/**
 * Watch-mode stall detection: the log must publish at least a heartbeat epoch
 * within `maxGapMs` (spec: at least daily). Returns true if the newest root is
 * older than that — a stalled or withheld log.
 */
export function detectStall(latestTimestamp: number | undefined, now: number, maxGapMs: number): boolean {
  if (latestTimestamp === undefined) return false; // empty log: nothing to stall
  return now - latestTimestamp > maxGapMs;
}
