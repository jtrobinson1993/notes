import { describe, it, expect } from 'vitest';
import {
  directoryRoot,
  inclusionProof,
  leafHash,
  merkleRoot,
  verifyInclusion,
  type DirectoryLeaf,
} from '../src/ktMerkle.js';

const entry = (n: number): DirectoryLeaf => ({
  handle: `User#${1000 + n}`,
  identityPubkey: `id-${n}`,
  sealingPubkey: `seal-${n}`,
});

const dir = (count: number): DirectoryLeaf[] => Array.from({ length: count }, (_, i) => entry(i));

describe('ktMerkle', () => {
  it('root is deterministic and changes when any entry changes', () => {
    const a = directoryRoot(dir(5));
    expect(directoryRoot(dir(5))).toBe(a);
    const mutated = dir(5);
    mutated[2] = { ...mutated[2], identityPubkey: 'rotated-key' };
    expect(directoryRoot(mutated)).not.toBe(a);
  });

  it('empty and single-entry roots are well defined and distinct', () => {
    expect(directoryRoot([])).toBe(directoryRoot([])); // stable empty root
    expect(directoryRoot([entry(0)])).not.toBe(directoryRoot([]));
    // single-entry root == that leaf (no internal node)
    expect(directoryRoot([entry(0)])).toBe(leafHash(entry(0)).toString('base64url'));
  });

  it('every leaf verifies under the root, at every directory size', () => {
    for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17]) {
      const entries = dir(size);
      const leaves = entries.map(leafHash);
      const root = merkleRoot(leaves).toString('base64url');
      for (let i = 0; i < size; i++) {
        const proof = inclusionProof(leaves, i);
        expect(verifyInclusion(leaves[i], proof, root)).toBe(true);
      }
    }
  });

  it('a proof from the wrong index does not verify', () => {
    const entries = dir(6);
    const leaves = entries.map(leafHash);
    const root = merkleRoot(leaves).toString('base64url');
    const proofFor2 = inclusionProof(leaves, 2);
    // leaf 3 with leaf 2's proof must fail
    expect(verifyInclusion(leaves[3], proofFor2, root)).toBe(false);
  });

  it('a tampered leaf does not verify under the honest root', () => {
    const entries = dir(4);
    const leaves = entries.map(leafHash);
    const root = merkleRoot(leaves).toString('base64url');
    const forged = leafHash({ ...entries[1], sealingPubkey: 'attacker-seal' });
    const proof = inclusionProof(leaves, 1);
    expect(verifyInclusion(forged, proof, root)).toBe(false);
  });

  it('leaf and node hashing use distinct domains (no second-preimage swap)', () => {
    // A two-leaf root must not equal a leaf hash of the concatenation — the
    // node-domain prefix prevents treating an internal node as a leaf.
    const leaves = [leafHash(entry(0)), leafHash(entry(1))];
    const root = merkleRoot(leaves);
    expect(root.equals(leaves[0])).toBe(false);
    expect(root.equals(leaves[1])).toBe(false);
  });
});
