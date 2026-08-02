// Key-transparency Merkle tree over the relay directory (spec/key-transparency.md).
//
// Upgrades the interim "flat sha256 over the whole sorted directory" root into a
// binary Merkle tree so the relay can hand each directory lookup a *per-entry
// inclusion proof*: the returned key is provably present under the signed epoch
// root, without downloading the whole directory. This is the "Inclusion/lookup
// on every directory fetch" proof from the spec. (VRF-blinded labels — hiding
// which handles exist — remain a further step toward the full AKD lineage; the
// leaves here are still handle-derived, so this is not yet privacy-preserving.)
//
// Second-preimage resistance: leaves and internal nodes use distinct hash
// domains (a 1-byte prefix), so no internal node can be passed off as a leaf.
// Odd nodes at a level are *carried* (promoted unchanged) rather than
// duplicated, which keeps proofs minimal and matches the root computation.

import { createHash } from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
// Distinct, stable root for an empty directory (no entries yet).
const EMPTY_ROOT = createHash('sha256').update('accord-kt-empty').digest();

export interface DirectoryLeaf {
  handle: string;
  identityPubkey: string;
  sealingPubkey: string;
}

/** One step of an inclusion path: a sibling hash and which side it sits on. */
export interface ProofStep {
  hash: string; // base64url sibling hash
  right: boolean; // true ⇒ sibling is the right child (accumulator is the left)
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** Domain-separated leaf hash — the same field layout the flat digest used. */
export function leafHash(e: DirectoryLeaf): Buffer {
  return createHash('sha256')
    .update(LEAF_PREFIX)
    .update(`${e.handle}|${e.identityPubkey}|${e.sealingPubkey}`)
    .digest();
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(NODE_PREFIX).update(left).update(right).digest();
}

/** Fold one level upward, carrying an unpaired final node unchanged. */
function nextLevel(level: Buffer[]): Buffer[] {
  const next: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    next.push(right ? nodeHash(left, right) : left);
  }
  return next;
}

/** Merkle root over already-ordered leaves. Empty ⇒ EMPTY_ROOT; single ⇒ leaf. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** base64url Merkle root over ordered directory entries (the signed epoch root). */
export function directoryRoot(entries: DirectoryLeaf[]): string {
  return b64url(merkleRoot(entries.map(leafHash)));
}

/** Inclusion path for the leaf at `index` within the ordered leaves. */
export function inclusionProof(leaves: Buffer[], index: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let idx = index;
  let level = leaves;
  while (level.length > 1) {
    if (idx % 2 === 0) {
      // Accumulator is the left child; a right sibling exists unless carried.
      const sib = level[idx + 1];
      if (sib) proof.push({ hash: b64url(sib), right: true });
    } else {
      proof.push({ hash: b64url(level[idx - 1]!), right: false });
    }
    idx = Math.floor(idx / 2);
    level = nextLevel(level);
  }
  return proof;
}

/** Verify a leaf sits under `root` (base64url) via its proof — the client check. */
export function verifyInclusion(leaf: Buffer, proof: ProofStep[], root: string): boolean {
  let acc = leaf;
  for (const step of proof) {
    const sib = Buffer.from(step.hash, 'base64url');
    acc = step.right ? nodeHash(acc, sib) : nodeHash(sib, acc);
  }
  return acc.equals(Buffer.from(root, 'base64url'));
}
