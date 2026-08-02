import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildInvite,
  generateInviteToken,
  inviteTokenHash,
  parseInvite,
  type InvitePayload,
} from '../../src/lib/invites';

const sample: Omit<InvitePayload, 'v'> = {
  relayUrl: 'https://relay.example',
  relayFp: 'RELAYFP',
  token: 'the-token',
  handle: 'Word#1234',
  identityPub: 'aWRlbnRpdHk=',
  sealingPub: 'c2VhbGluZw==',
};

describe('friend invites (payload layer)', () => {
  it('generates url-safe, high-entropy, distinct tokens', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, unpadded
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes → 43 base64url chars
  });

  it('hashes tokens identically to the relay (sha256 base64url)', async () => {
    for (const token of ['the-token', generateInviteToken(), '']) {
      const expected = createHash('sha256').update(token).digest('base64url');
      expect(await inviteTokenHash(token)).toBe(expected);
    }
  });

  it('round-trips build → parse', () => {
    const parsed = parseInvite(buildInvite(sample));
    expect(parsed).toEqual({ v: 1, ...sample });
  });

  it('rejects a non-invite string', () => {
    expect(() => parseInvite('https://example.com')).toThrow(/not an Accord invite/);
  });

  it('rejects a malformed body', () => {
    expect(() => parseInvite('accord://friend?i=not-valid-base64-json!!')).toThrow(/malformed/);
  });

  it('rejects an unsupported version', () => {
    const bad = buildInvite(sample).replace(
      /i=.*/,
      'i=' + Buffer.from(JSON.stringify({ v: 99, ...sample })).toString('base64url'),
    );
    expect(() => parseInvite(bad)).toThrow(/unsupported invite version 99/);
  });

  it('rejects a missing field', () => {
    const { sealingPub: _omit, ...partial } = sample;
    const bad =
      'accord://friend?i=' + Buffer.from(JSON.stringify({ v: 1, ...partial })).toString('base64url');
    expect(() => parseInvite(bad)).toThrow(/invite missing sealingPub/);
  });
});
