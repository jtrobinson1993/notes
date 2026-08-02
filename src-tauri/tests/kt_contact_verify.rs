//! **L2 — contact key transparency against a HOSTILE relay.**
//! (spec/key-transparency.md § Contact verification; spec/testing.md § L2)
//!
//! The real Rust core — real vault, real `RelayClient`, the real
//! `mailbox_drain` — driven against a relay the *test* controls byte for byte
//! (the shared harness in `common/`). That control is the point: the claim under
//! test is not "the happy path works" but "a relay that lies is not believed",
//! and a lying relay is precisely what a genuine `server/` process will never be.
//!
//! What each case pins down:
//!   * a key the log published under a **signed** root → recorded, with the
//!     signed epoch;
//!   * a key the log contradicts → **nothing** persisted and **nothing** sealed
//!     back (the reply carries our delivery token, so ordering is the property);
//!   * a self-consistent `(proof, root)` pair for a root the relay never signed
//!     → refused, because the proof always agrees with the root it ships with;
//!   * 404 and an unreachable directory → recorded UNVERIFIED, never verified,
//!     and settled by the re-verification sweep on the next connect;
//!   * and, under it all, the **relay's own identity**: the fingerprint must
//!     bind the key it serves, and it must match what this account pinned.
//!
//! The akd proofs are generated with the full `akd` crate (a dev-dependency),
//! so the bytes the core verifies are the bytes a real sidecar would produce.

mod common;

use base64::Engine as _;
use ed25519_dalek::SigningKey;

use common::{
    bob_identity, fingerprint_of, friend_accept, mailbox_row, publish, pub_b64, signed_root, Alarms,
    Core, Directory404, FakeRelay, RelayState, B64, BOB_HANDLE,
};

// ------------------------------------------------------------------ tests ---

/// What the relay's transparency log publishes for Bob's handle.
enum Logged {
    /// Bob's real key — the honest case.
    Bobs,
    /// Somebody else's key — the relay contradicts the accept it delivered.
    Foreign(Vec<u8>),
    /// No entry at all (404).
    Absent,
}

/// Build the whole scene: a relay, a connected core, and Bob's accept queued.
/// `sign_root` says whether the relay signs the root it serves.
async fn scene(logged: Logged, sign_root: bool) -> (FakeRelay, Core, SigningKey) {
    let relay_key = SigningKey::from_bytes(&[42u8; 32]);
    // Boot with an empty directory; the entry needs the relay fingerprint, which
    // only exists once the relay is up.
    let relay = FakeRelay::start(
        relay_key.clone(),
        RelayState {
            directory: Directory404::NotFound,
            roots: Vec::new(),
            mailbox: Vec::new(),
            sends: Vec::new(),
            acked: Vec::new(),
        },
    );
    let core = Core::connect(&relay.base).await;
    let fp = core.relay_fp();
    assert_eq!(fp, relay.fingerprint());

    let bob = bob_identity(&fp, 9);
    let envelope = friend_accept(&bob, core.sealing_pub(), BOB_HANDLE);

    let logged_key = match logged {
        Logged::Bobs => Some(bob.signing_public().to_vec()),
        Logged::Foreign(k) => Some(k),
        Logged::Absent => None,
    };
    if let Some(key) = logged_key {
        let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &key).await;
        relay.with(|st| {
            st.directory = Directory404::Entry {
                identity_pub_b64: B64.encode(&key),
                epoch,
                root: root.clone(),
                proof_json: proof_json.clone(),
                vrf: vrf.clone(),
            };
            if sign_root {
                st.roots = vec![signed_root(&relay_key, 17, &root)];
            }
        });
    }
    relay.with(|st| st.mailbox = vec![mailbox_row(1, &envelope)]);
    (relay, core, relay_key)
}

#[tokio::test]
async fn a_log_verified_contact_is_recorded_with_the_signed_epoch() {
    let (relay, core, _k) = scene(Logged::Bobs, true).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 1);
    assert_eq!(report.kt_rejected, 0);
    let friends = core.friends();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].handle, BOB_HANDLE);
    // The recorded epoch is the RELAY's signed epoch (17), not the akd counter.
    assert_eq!(friends[0].kt_verified_epoch, Some(17));
    // Verified ⇒ the handshake completes: the confirm went back.
    assert_eq!(relay.with(|st| st.sends.len()), 1);
    assert!(alarms.seen().is_empty());
}

#[tokio::test]
async fn a_contact_key_the_log_contradicts_persists_nothing_and_seals_nothing_back() {
    // The relay hands us an accept from a key it controls, while the log
    // publishes a different key for that handle — the MITM it exists to catch.
    let (relay, core, _k) = scene(Logged::Foreign(vec![3u8; 32]), true).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 0);
    assert_eq!(report.kt_rejected, 1);
    // Nothing persisted…
    assert!(core.friends().is_empty());
    // …and, the part that would leak, nothing sealed back: the friend-confirm
    // carries MY delivery token, so the check has to precede the reply.
    assert_eq!(relay.with(|st| st.sends.len()), 0);
    // The hard alarm fired.
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
    // The unusable envelope is still acked — re-draining it only re-rejects.
    assert_eq!(relay.with(|st| st.acked.clone()), vec![1]);
}

#[tokio::test]
async fn a_self_consistent_proof_under_an_unsigned_root_is_refused() {
    // The relay's own (proof, root) pair is internally valid and names the key
    // it wants us to trust — but it never signed that root. Believing the
    // response's root would make the whole check circular.
    let (relay, core, relay_key) = scene(Logged::Bobs, false).await;
    // The relay does publish a root chain — just not one containing this root.
    relay.with(|st| st.roots = vec![signed_root(&relay_key, 4, &B64.encode([1u8; 32]))]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.kt_rejected, 1);
    assert!(core.friends().is_empty());
    assert_eq!(relay.with(|st| st.sends.len()), 0);
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}

#[tokio::test]
async fn a_handle_absent_from_the_log_is_unverified_but_not_blocked() {
    // 404 is indistinguishable from a publish that has not landed yet, and a
    // relay can always produce it — so it must not block. It must also never
    // count as a match.
    let (relay, core, _k) = scene(Logged::Absent, false).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 1);
    assert_eq!(report.kt_rejected, 0);
    let friends = core.friends();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].kt_verified_epoch, None); // NOT verified
    assert_eq!(relay.with(|st| st.sends.len()), 1); // the handshake still completes
    assert!(alarms.seen().is_empty()); // absence is not an alarm
}

#[tokio::test]
async fn an_unreachable_directory_degrades_to_unverified_and_re_verifies_later() {
    let (relay, core, relay_key) = scene(Logged::Bobs, true).await;
    // Keep the *entry* the relay would serve, but make the directory fail — the
    // offline / broken-directory case.
    let saved = relay.with(|st| {
        let saved = st.directory.clone();
        st.directory = Directory404::Unavailable;
        saved
    });
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(report.friends, 1); // adding a contact still works
    assert_eq!(core.friends()[0].kt_verified_epoch, None); // …but unverified
    assert!(alarms.seen().is_empty()); // unreachable is not an accusation

    // The relay comes back: the sweep run on the next connect settles it.
    relay.with(|st| st.directory = saved);
    let sweep = app_lib::verify_recorded_contacts(&core.vault, &core.relay, &alarms.sink())
        .await
        .unwrap();
    assert_eq!(sweep.verified, 1);
    assert_eq!(sweep.rejected, 0);
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(17));

    // And a *later* contradiction is caught by the same sweep, without
    // silently deleting the contact. (Clearing the proof is what a re-key would
    // do; it is how the contact re-enters the worklist.)
    let contact_id = core.friends()[0].contact_id.clone();
    let fp = core.relay_fp();
    {
        let vault = core.vault.lock().unwrap();
        vault.store().unwrap().kt_clear_contact_verified(&contact_id, &fp).unwrap();
    }
    let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &[8u8; 32]).await;
    relay.with(|st| {
        st.directory = Directory404::Entry {
            identity_pub_b64: B64.encode([8u8; 32]),
            epoch,
            root: root.clone(),
            proof_json,
            vrf,
        };
        st.roots = vec![signed_root(&relay_key, 18, &root)];
    });
    let sweep = app_lib::verify_recorded_contacts(&core.vault, &core.relay, &alarms.sink())
        .await
        .unwrap();
    assert_eq!(sweep.rejected, 1);
    assert_eq!(core.friends()[0].kt_verified_epoch, None);
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}

// ------------------------------------------- the relay's own identity (D4) ---
//
// Everything above verifies *contact* keys against the relay's signed log. That
// is circular unless the relay itself is anchored: the same relay serves the
// identity key those root signatures are checked against. These cases pin the
// anchor.

#[tokio::test]
async fn a_fingerprint_that_does_not_bind_the_served_key_is_refused() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let honest_fp = relay.fingerprint();
    // The pinned/served identity key is the relay's OFFLINE ROOT — the online
    // key it delegates to is a different key entirely, and is never pinned.
    let honest_key = relay.root_pub_b64();
    assert_ne!(honest_key, pub_b64(42));
    let alarms = Alarms::default();

    // (a) A fingerprint that is simply not the digest of the key served with it.
    relay.serve_info("some-other-fingerprint", &honest_key);
    let core = Core::install();
    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_INVALID"), "{err}");

    // (b) THE ATTACK: the *genuine* fingerprint — satisfying any pin, keeping
    // the account's derived identity and contact ids stable — served next to a
    // foreign identity key. That key is what every KT root signature is checked
    // against, so a relay that got away with this would sign its own forged
    // directory and every contact verdict would come back Verified. Pinning the
    // fingerprint alone cannot see it; the binding can.
    relay.serve_info(&honest_fp, &pub_b64(99));
    let err = core.connect_to(&relay.base, Some(&honest_fp), &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_INVALID"), "{err}");

    // Both refusals are hard alarms, and neither left a session or a pin behind.
    assert_eq!(alarms.seen(), vec!["relay-identity-changed".to_string(); 2]);
    assert!(core.relay.session_info().is_none());

    // The honest relay still connects afterwards (the refusals poisoned nothing).
    relay.serve_info(&honest_fp, &honest_key);
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
    assert_eq!(core.relay_fp(), honest_fp);
}

#[tokio::test]
async fn first_contact_pins_and_a_later_identity_change_is_refused_and_alarms() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let honest_fp = relay.fingerprint();
    let alarms = Alarms::default();
    let core = Core::install();

    // First contact: nothing to compare against, so the identity is pinned.
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
    // A second connect to the same identity is ordinary.
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
    assert!(alarms.seen().is_empty());
    assert_eq!(core.relay_fp(), honest_fp);

    // Now the relay presents a different identity — internally consistent, so
    // only the pin can catch it.
    let impostor = pub_b64(7);
    relay.serve_info(&fingerprint_of(&impostor), &impostor);
    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_CHANGED"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-identity-changed".to_string()]);
    // Not silently re-pinned: the live session still names the pinned relay…
    assert_eq!(core.relay_fp(), honest_fp);
    // …and the impostor is refused again on every retry.
    assert!(core
        .connect_to(&relay.base, None, &alarms)
        .await
        .unwrap_err()
        .starts_with("RELAY_IDENTITY_CHANGED"));
}

#[tokio::test]
async fn an_invite_fingerprint_outranks_the_relay_and_is_checked_at_redeem() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let honest_fp = relay.fingerprint();
    let alarms = Alarms::default();
    let core = Core::install();

    // An invite naming a relay identity this address does not serve: refused at
    // first contact, before the trust-on-first-use pin can be taken. This is the
    // case a pin cannot cover — the very first connection.
    let wrong_fp = fingerprint_of(&pub_b64(7));
    let err = core.connect_to(&relay.base, Some(&wrong_fp), &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_CHANGED"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-identity-changed".to_string()]);
    assert!(core.relay.session_info().is_none());

    // The same invite with the relay's real fingerprint connects and pins it.
    core.connect_to(&relay.base, Some(&honest_fp), &alarms).await.unwrap();

    // Redeeming an invite for some *other* relay is refused even though this
    // session is perfectly healthy: the invite's log is not this relay's log.
    let err = app_lib::require_invite_relay(&core.relay, &wrong_fp, &alarms.sink()).unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_CHANGED"), "{err}");
    // …and an invite for this relay passes.
    app_lib::require_invite_relay(&core.relay, &honest_fp, &alarms.sink()).unwrap();
}

#[tokio::test]
async fn a_pinned_account_refuses_an_invite_that_names_a_different_relay() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let alarms = Alarms::default();
    let core = Core::install();
    core.connect_to(&relay.base, None, &alarms).await.unwrap();

    // Hold both anchors and they disagree: one of the two channels is lying, so
    // the connect is refused rather than resolved in either's favour.
    let err = core
        .connect_to(&relay.base, Some(&fingerprint_of(&pub_b64(7))), &alarms)
        .await
        .unwrap_err();
    assert!(err.starts_with("RELAY_IDENTITY_CHANGED"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-identity-changed".to_string()]);
}

// ------------------------------------- the delegation: root → online key (D4) ---
//
// The pinned identity is an OFFLINE ROOT whose private half never touches the
// relay; it signs one kind of statement, a delegation naming the ONLINE key that
// signs KT roots. These cases pin the third and fourth links of the chain: the
// delegation must verify under the pin and must never go backwards, and the KT
// roots must verify under the key it names — not under the pin, and not under
// anything else the relay served.

/// The happy chain, stated end to end: the key that validates KT roots came out
/// of a delegation, and it is *not* the key the client pinned.
#[tokio::test]
async fn a_valid_chain_connects_and_verifies_contacts_under_the_delegated_key() {
    let (relay, core, relay_key) = scene(Logged::Bobs, true).await;
    let alarms = Alarms::default();

    // What the client pinned is the ROOT; what signed the roots is the online key.
    assert_eq!(core.relay_fp(), fingerprint_of(&relay.root_pub_b64()));
    assert_ne!(relay.root_pub_b64(), B64.encode(relay_key.verifying_key().to_bytes()));
    let delegated = relay.current_delegation()["onlineKey"].as_str().unwrap().to_string();
    assert_eq!(delegated, B64.encode(relay_key.verifying_key().to_bytes()));

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(report.friends, 1);
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(17));
    assert!(alarms.seen().is_empty());
}

/// A delegation signed by *some other* root — the forgery a breached relay
/// would need in order to name a key of its own. The pin is what refuses it.
#[tokio::test]
async fn a_delegation_signed_by_the_wrong_key_is_refused() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let alarms = Alarms::default();
    let core = Core::install();

    // Signed with an attacker root, but naming the relay's genuine fingerprint
    // and its genuine online key — everything except the signer is honest.
    let attacker_root = SigningKey::from_bytes(&[13u8; 32]);
    let forged = common::delegation_json(
        &attacker_root,
        &relay.fingerprint(),
        1,
        &SigningKey::from_bytes(&[42u8; 32]),
    );
    relay.serve_delegation(forged.clone(), vec![forged]);

    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_DELEGATION_INVALID"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-delegation-invalid".to_string()]);
    // Nothing was pinned and no session was left behind: fail closed.
    assert!(core.relay.session_info().is_none());
}

/// One byte changed in an otherwise genuine delegation. Every field is inside
/// the signed bytes, so re-pointing it at another online key breaks it.
#[tokio::test]
async fn a_tampered_delegation_is_refused() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let alarms = Alarms::default();
    let core = Core::install();

    let mut tampered = relay.current_delegation();
    tampered["onlineKey"] = serde_json::json!(pub_b64(66));
    relay.serve_delegation(tampered.clone(), vec![tampered]);

    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_DELEGATION_INVALID"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-delegation-invalid".to_string()]);
    assert!(core.relay.session_info().is_none());

    // A relay that serves no delegation at all is refused the same way: the
    // pinned root then vouches for no signing key, so nothing it signs counts.
    relay.serve_delegation(serde_json::Value::Null, vec![]);
    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_DELEGATION_INVALID"), "{err}");
}

/// **Anti-rollback.** After an operator rotates, the superseded delegation is
/// still genuinely root-signed — forever. Replaying it is how an attacker who
/// kept the revoked online key gets believed again, and only the version
/// high-water mark this client persisted can refuse it.
#[tokio::test]
async fn a_rolled_back_delegation_version_is_refused_and_alarms() {
    let relay = FakeRelay::bare(SigningKey::from_bytes(&[42u8; 32]));
    let alarms = Alarms::default();
    let core = Core::install();

    let v1 = relay.current_delegation();
    core.connect_to(&relay.base, None, &alarms).await.unwrap();

    // The operator rotates to a fresh online key (v2) — the revocation.
    let v2_key = SigningKey::from_bytes(&[77u8; 32]);
    relay.rotate_online_key(2, &v2_key);
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
    assert!(alarms.seen().is_empty());

    // THE ATTACK: serve v1 again. Its signature is perfect; its key is revoked.
    relay.serve_delegation(v1.clone(), vec![v1.clone()]);
    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_DELEGATION_ROLLBACK"), "{err}");
    assert_eq!(alarms.seen(), vec!["relay-delegation-rollback".to_string()]);

    // Equivocation at the version we already hold: a *different* online key
    // presented as "v2". Also a rollback — only our memory of v2 can see it.
    let fake_v2 = relay.mint_delegation(2, &SigningKey::from_bytes(&[88u8; 32]));
    relay.serve_delegation(fake_v2.clone(), vec![v1, fake_v2]);
    let err = core.connect_to(&relay.base, None, &alarms).await.unwrap_err();
    assert!(err.starts_with("RELAY_DELEGATION_ROLLBACK"), "{err}");

    // The honest relay still connects: the refusals poisoned no state.
    relay.serve_delegation(
        relay.mint_delegation(2, &v2_key),
        vec![relay.mint_delegation(1, &SigningKey::from_bytes(&[42u8; 32])), relay.mint_delegation(2, &v2_key)],
    );
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
}

/// The whole point of the split: rotating the online key is a **legitimate,
/// silent** operation for a pinned client. Nothing re-pins, nothing alarms, and
/// contact verification keeps working under the new key.
#[tokio::test]
async fn a_legitimate_online_key_rotation_is_accepted_silently() {
    let (relay, core, _old_key) = scene(Logged::Bobs, true).await;
    let alarms = Alarms::default();
    let pinned = core.relay_fp();

    // Drain once under v1 so Bob is a recorded, verified contact.
    app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(17));

    // The operator rotates. The relay re-signs its current root with the new
    // online key and stamps it v2 (what the next directory change publishes).
    let v2_key = SigningKey::from_bytes(&[77u8; 32]);
    relay.rotate_online_key(2, &v2_key);
    let root = match relay.with(|st| st.directory.clone()) {
        Directory404::Entry { root, .. } => root,
        _ => unreachable!("the scene published an entry"),
    };
    relay.with(|st| st.roots = vec![common::signed_root_v(&v2_key, 2, 21, &root)]);

    // Reconnect: accepted, no alarm, and the pin is untouched — a rotation is
    // not an identity change.
    core.connect_to(&relay.base, None, &alarms).await.unwrap();
    assert!(alarms.seen().is_empty());
    assert_eq!(core.relay_fp(), pinned);

    // …and the sweep re-verifies Bob under the NEW key's signature.
    let contact_id = core.friends()[0].contact_id.clone();
    {
        let vault = core.vault.lock().unwrap();
        vault.store().unwrap().kt_clear_contact_verified(&contact_id, &pinned).unwrap();
    }
    let sweep = app_lib::verify_recorded_contacts(&core.vault, &core.relay, &alarms.sink())
        .await
        .unwrap();
    assert_eq!((sweep.verified, sweep.rejected), (1, 0));
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(21));
    assert!(alarms.seen().is_empty());
}

/// **The check that carries the security.** A KT root signed by the pinned ROOT
/// key — the very key the client anchored on — is still not a signed root,
/// because no delegation names it. If this passed, the split would buy nothing:
/// the online key would be "whatever verifies", and a breached relay would just
/// sign with something the client already trusts.
#[tokio::test]
async fn kt_roots_signed_by_the_pinned_root_key_do_not_verify() {
    let (relay, core, _online) = scene(Logged::Bobs, true).await;
    let alarms = Alarms::default();

    // Re-sign the very same root with the relay's OFFLINE ROOT key, stamped as
    // the current delegation version so nothing else about it looks odd.
    let root = match relay.with(|st| st.directory.clone()) {
        Directory404::Entry { root, .. } => root,
        _ => unreachable!("the scene published an entry"),
    };
    let root_key = common::root_key_for(&SigningKey::from_bytes(&[42u8; 32]));
    assert_eq!(B64.encode(root_key.verifying_key().to_bytes()), relay.root_pub_b64());
    relay.with(|st| st.roots = vec![common::signed_root_v(&root_key, 1, 17, &root)]);

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    // The root is a fabrication → the contact is rejected, nothing persisted,
    // nothing sealed back, hard alarm.
    assert_eq!(report.kt_rejected, 1);
    assert!(core.friends().is_empty());
    assert_eq!(relay.with(|st| st.sends.len()), 0);
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}
