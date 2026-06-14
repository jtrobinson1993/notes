import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Headline E2E: the two-user, live-delivery chat flow (the "not yet verified"
// gap from spec/chat.md). Two browser contexts A + B:
//   A generates an invite → B redeems → A accepts → A opens a DM and sends a
//   message → B receives it live over the socket → unread badge on B → B opens
//   and the marker clears.
//
// AUTH-SEAM DECISION (spec/testing.md, Layer E):
//   Registration and unlock require a WebAuthn passkey whose PRF output wraps
//   the master key (MK). For E2E we need an authenticated context that also
//   holds a usable MK in memory (to unseal conversation keys). Two options:
//     1. Playwright's virtual authenticator
//        (CDPSession → WebAuthn.addVirtualAuthenticator). RISK: the PRF
//        extension may be unsupported by the virtual authenticator, so the
//        client can't derive the MK-wrap key.
//     2. An env-gated, test-only login endpoint (enabled only when e.g.
//        TEST_LOGIN=1) that seeds a session row and hands the client a known
//        MK, bypassing the ceremony.
//   RECOMMENDED: start with (1) on Chromium and assert PRF support in a probe;
//   fall back to (2) behind a hard env gate if PRF is missing. Both are pure
//   test-harness concerns and must never ship enabled in production.
//
// Until that seam lands this headline test is marked fixme so it shows up as
// outstanding work rather than silently passing.
// ---------------------------------------------------------------------------

test.fixme('two users: invite → redeem → accept → DM → live delivery → unread → read', async () => {
  // const a = await browser.newContext(); const b = await browser.newContext();
  // 1. seedAuth(a, 'alice'); seedAuth(b, 'bob');   // via the chosen auth seam
  // 2. alice: POST /api/friend-invites → token
  // 3. bob:   POST /api/friends/redeem { token }
  // 4. alice: accept the incoming request
  // 5. alice: open a DM (AppSidebar "New chat" → bob) and send "hello"
  // 6. bob:   assert the message arrives live (no reload) and an unread badge shows
  // 7. bob:   open the conversation → badge clears (read marker advances)
  expect(true).toBe(true);
});
