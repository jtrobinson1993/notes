// Reference KT auditor — pure verification core (spec/key-transparency.md).
//
// Anyone can fetch a relay's signed epoch roots (`GET /api/relay/kt/roots`, or
// the `/.well-known/accord/kt-roots` alias) and its identity key
// (`GET /api/relay/info`) and independently prove the log is well-formed. This
// module is the engine; `ktAuditCli.ts` is the thin fetch-and-print wrapper.
//
// What this verifies today (works on the built log shape):
//   • every root's signature under the relay identity key,
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

// DER SPKI header for a raw 32-byte Ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignedRoot {
  epoch: number;
  rootHash: string;
  prevRootHash: string | null;
  signature: string; // base64
  timestamp?: number;
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

/** Verify one root's signature under the relay identity key. */
export function verifyRootSignature(identityPubKeyB64: string, root: SignedRoot): boolean {
  try {
    return edVerify(
      null,
      rootSigningPayload(root),
      relayIdentityKey(identityPubKeyB64),
      Buffer.from(root.signature, 'base64'),
    );
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
  identityPubKeyB64: string,
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
    if (!verifyRootSignature(identityPubKeyB64, r)) {
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
