//! **The relay's delegation chain: pinned root → delegation → online key.**
//! (spec/relay.md § Relay identity: an offline root and an online signing key;
//! spec/key-transparency.md § The relay identity key is the anchor under the
//! anchor.)
//!
//! The relay used to have one Ed25519 keypair doing two jobs: signing every
//! key-transparency (KT) epoch root, and being the anchor clients pin. That
//! makes a relay-server breach unrecoverable — the attacker signs forged KT
//! roots, and the operator cannot revoke the anchor with the anchor.
//!
//! So the identity is split, certificate-authority style:
//!
//! * the **root** keypair, whose private half never touches the relay. It signs
//!   exactly one kind of statement — a **delegation** naming the current online
//!   key. Its public half is what `identityPubKey` serves, what
//!   `identityFingerprint` digests, and what an invite's `relayFp` identifies;
//! * the **online** keypair, which lives on the relay and signs KT roots.
//!
//! This module owns the client half of that: parsing the relay-served records,
//! verifying them **against the pinned root**, and turning a verified chain into
//! [`DelegatedKeys`] — the only value in the client from which a KT-root signing
//! key can be obtained. That type is the structural guarantee behind the whole
//! split: `kt::signed_root_epoch` and the gossip check take a `DelegatedKeys`,
//! so there is no way to reach them with a key the relay merely served loose.
//!
//! ## The signed bytes (mirror of `server/src/relayIdentity.ts`)
//!
//! ```text
//! accord-relay-delegation|v1|{rootFingerprint}|{onlineKey}|{version}|{issuedAt}|{notAfter}
//! ```
//!
//! UTF-8, no trailing newline, Ed25519 pure. `rootFingerprint` is
//! `base64url(sha256(raw root pubkey))`, `onlineKey` the raw 32-byte key in
//! **standard** base64, the rest decimal integers (`issuedAt`/`notAfter` in
//! milliseconds). The `accord-relay-delegation|v1` prefix is a domain separator
//! distinct from every other signature in the system — KT roots sign
//! `kt-root|{root}|{prev}`, device auth signs `{nonce}|{fingerprint}` — so no
//! signature can be lifted from one context into another. The root fingerprint
//! is *inside* the signed bytes, so a delegation cannot be replayed onto a
//! different relay.

use std::collections::BTreeMap;

use base64::Engine as _;

/// Domain separator for the delegation signature. Must equal the server's
/// `DELEGATION_CONTEXT`.
pub const DELEGATION_CONTEXT: &str = "accord-relay-delegation|v1";

/// Error prefixes the webview turns into catalogued, user-facing errors. Part of
/// the IPC contract (`web/src/lib/nativeErrors.ts`).
pub const ERR_DELEGATION_INVALID: &str = "RELAY_DELEGATION_INVALID";
/// A delegation whose `version` went **backwards** (or changed key at the same
/// version). Separate from [`ERR_DELEGATION_INVALID`] because it is not a broken
/// relay — it is an attacker replaying a superseded, genuinely-root-signed
/// delegation to reinstate an online key the operator revoked.
pub const ERR_DELEGATION_ROLLBACK: &str = "RELAY_DELEGATION_ROLLBACK";

/// A root-signed statement naming the relay's current online signing key.
///
/// Every field is relay-supplied and untrusted until [`verify_delegation`] has
/// checked the signature against the **pinned** root key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delegation {
    /// Monotonic anti-rollback counter: only ever increases for a given relay.
    pub version: i64,
    /// The delegated Ed25519 public key, raw 32 bytes in **standard** base64 —
    /// the same encoding `kt::verify_signed_root` decodes.
    pub online_key: String,
    pub issued_at: i64,
    /// Hard deadline. An expired delegation is refused, so a relay that loses
    /// its root key stops being trusted rather than coasting forever.
    pub not_after: i64,
    /// Ed25519 signature by the ROOT key over [`delegation_payload`], base64.
    pub signature: String,
}

/// The exact bytes a delegation signs (see the module header).
pub fn delegation_payload(root_fingerprint: &str, d: &Delegation) -> String {
    format!(
        "{DELEGATION_CONTEXT}|{root_fingerprint}|{}|{}|{}|{}",
        d.online_key, d.version, d.issued_at, d.not_after
    )
}

fn b64_len(s: &str) -> Option<usize> {
    base64::engine::general_purpose::STANDARD.decode(s).ok().map(|v| v.len())
}

/// Parse one relay-served JSON delegation, **refusing anything malformed before
/// a signature is checked**. Shape errors are rejected here so a record can
/// never reach the verifier as, say, `version: "1"` or a 16-byte key — the same
/// discipline as the server's `isWellFormedDelegation`.
pub fn parse_delegation(v: &serde_json::Value) -> Option<Delegation> {
    let version = v.get("version")?.as_i64()?;
    let issued_at = v.get("issuedAt")?.as_i64()?;
    let not_after = v.get("notAfter")?.as_i64()?;
    let online_key = v.get("onlineKey")?.as_str()?.to_string();
    let signature = v.get("signature")?.as_str()?.to_string();
    if version < 1 || not_after <= issued_at {
        return None;
    }
    if b64_len(&online_key) != Some(32) || b64_len(&signature) != Some(64) {
        return None;
    }
    Some(Delegation { version, online_key, issued_at, not_after, signature })
}

/// Verify a delegation against the pinned ROOT public key (standard base64) and
/// its fingerprint. Fails closed on a wrong root, a wrong fingerprint, or a
/// single tampered byte — every field is inside the signed bytes.
pub fn verify_delegation(root_pub_b64: &str, root_fingerprint: &str, d: &Delegation) -> bool {
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(root_pub_b64) else {
        return false;
    };
    let Ok(raw): Result<[u8; 32], _> = raw.try_into() else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&raw) else { return false };
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(&d.signature) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else { return false };
    key.verify(delegation_payload(root_fingerprint, d).as_bytes(), &sig).is_ok()
}

/// **Every online key the pinned root vouches for**, indexed by delegation
/// version.
///
/// Only [`verify_chain`] constructs one, and it only does so from delegations
/// that verified against the pinned root. That is deliberate and load-bearing:
/// it is the type-level reason a KT root signature cannot accidentally be
/// checked against the pinned root itself, or against a key the relay served
/// next to the roots. If a `DelegatedKeys` hands you a key, the offline root
/// signed for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegatedKeys {
    by_version: BTreeMap<i64, String>,
    current: Delegation,
}

impl DelegatedKeys {
    /// The delegation in force — the highest version in the verified chain.
    pub fn current(&self) -> &Delegation {
        &self.current
    }

    /// The key to check a root stamped `key_version` against.
    ///
    /// `None` (the root carried no `keyVersion`) resolves to the **current**
    /// key, matching the reference auditor (`ktAudit.ts::keysFromDelegations`) —
    /// a relay that never rotated signs everything with one key. A version no
    /// delegation covers resolves to `None`, so the root counts as unsigned.
    pub fn key_for(&self, key_version: Option<i64>) -> Option<&str> {
        match key_version {
            None => Some(self.current.online_key.as_str()),
            Some(v) => self.by_version.get(&v).map(String::as_str),
        }
    }

    /// Every delegated key, newest first. For **gossip**, which carries no
    /// `keyVersion`: a friend may legitimately have seen a root signed before
    /// the relay rotated, and a signature under any key the root delegated to is
    /// still the relay's own signature. Never used for the roots chain, which
    /// stamps its version and is resolved exactly.
    pub fn all_keys(&self) -> impl Iterator<Item = &str> {
        self.by_version.values().rev().map(String::as_str)
    }
}

/// Verify a whole delegation chain against the pinned root and reduce it to the
/// keys it vouches for.
///
/// `chain` is the relay's `delegations` array (ascending) and `current` its
/// `delegation`. Refusals, all fail-closed:
///
/// * an empty chain, or any member that does not verify under the pinned root —
///   a relay only ever holds root-signed delegations, so one that does not
///   verify means tampering, not a quirk;
/// * versions that are not **strictly increasing** in the order served — two
///   delegations at one version would be the root equivocating about which key
///   is v2 (mirrors `ktAudit.ts::keysFromDelegations`);
/// * a `current` that is not the last (highest) member of the chain, so the
///   relay cannot advertise a fresh delegation while quietly serving roots under
///   a chain that never mentions it;
/// * a `current` past its `not_after`.
pub fn verify_chain(
    root_pub_b64: &str,
    root_fingerprint: &str,
    chain: &[Delegation],
    current: &Delegation,
    now_ms: i64,
) -> Result<DelegatedKeys, String> {
    if chain.is_empty() {
        return Err(format!("{ERR_DELEGATION_INVALID}: the relay served no delegation"));
    }
    let mut by_version = BTreeMap::new();
    let mut highest: Option<i64> = None;
    for d in chain {
        if !verify_delegation(root_pub_b64, root_fingerprint, d) {
            return Err(format!(
                "{ERR_DELEGATION_INVALID}: delegation v{} is not signed by the pinned relay root",
                d.version
            ));
        }
        if let Some(prev) = highest {
            if d.version <= prev {
                return Err(format!(
                    "{ERR_DELEGATION_INVALID}: the delegation chain is not strictly increasing (v{prev} then v{})",
                    d.version
                ));
            }
        }
        highest = Some(d.version);
        by_version.insert(d.version, d.online_key.clone());
    }
    if chain.last() != Some(current) {
        return Err(format!(
            "{ERR_DELEGATION_INVALID}: the relay's current delegation (v{}) is not the newest one in the chain it published",
            current.version
        ));
    }
    if current.not_after <= now_ms {
        return Err(format!(
            "{ERR_DELEGATION_INVALID}: the relay's delegation expired at {} (now {now_ms})",
            current.not_after
        ));
    }
    Ok(DelegatedKeys { by_version, current: current.clone() })
}

/// The anti-rollback floor this account already holds for a relay: the highest
/// delegation version it has ever accepted, and the key that version named.
///
/// Persisted with the relay pin (`lib.rs::RelayPin`, setting
/// `relay.identity.<baseUrl>` in the per-account vault) because it is the same
/// kind of fact: something about this relay that only ever gets stricter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DelegationFloor {
    /// Highest version accepted so far; 0 = never seen a delegation.
    pub min_version: i64,
    /// The online key `min_version` named, when we recorded it.
    pub online_key: Option<String>,
}

/// **Anti-rollback.** Refuse a delegation older than the highest this account
/// has already accepted from this relay, and refuse a *different* key at the
/// version we already know.
///
/// Without this the split buys nothing after a revocation: the old delegation is
/// genuinely root-signed forever, so an attacker who kept a revoked online key
/// simply replays it and is believed again. The equal-version check closes the
/// same hole from the other side — a root that names two different keys as "v3"
/// is equivocating, and only the client's memory of what v3 was can see it.
pub fn check_rollback(floor: &DelegationFloor, current: &Delegation) -> Result<(), String> {
    if current.version < floor.min_version {
        return Err(format!(
            "{ERR_DELEGATION_ROLLBACK}: the relay served delegation v{}, older than v{} this account already accepted",
            current.version, floor.min_version
        ));
    }
    if current.version == floor.min_version {
        if let Some(known) = &floor.online_key {
            if known != &current.online_key {
                return Err(format!(
                    "{ERR_DELEGATION_ROLLBACK}: the relay served a different online key at delegation v{} than the one this account accepted",
                    current.version
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use sha2::{Digest, Sha256};

    fn root(seed: u8) -> (SigningKey, String, String) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let pub_b64 = STANDARD.encode(key.verifying_key().to_bytes());
        let fp = URL_SAFE_NO_PAD.encode(Sha256::digest(key.verifying_key().to_bytes()));
        (key, pub_b64, fp)
    }

    fn online(seed: u8) -> String {
        STANDARD.encode(SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes())
    }

    /// Sign a delegation the way `server/src/relayIdentity.ts::signDelegation` does.
    fn sign(key: &SigningKey, fp: &str, version: i64, online_key: &str, not_after: i64) -> Delegation {
        let mut d = Delegation {
            version,
            online_key: online_key.to_string(),
            issued_at: 1_000,
            not_after,
            signature: STANDARD.encode([0u8; 64]),
        };
        d.signature = STANDARD.encode(key.sign(delegation_payload(fp, &d).as_bytes()).to_bytes());
        d
    }

    #[test]
    fn the_signed_bytes_match_the_server_layout() {
        let d = Delegation {
            version: 2,
            online_key: "KEY".into(),
            issued_at: 10,
            not_after: 20,
            signature: String::new(),
        };
        assert_eq!(
            delegation_payload("FP", &d),
            "accord-relay-delegation|v1|FP|KEY|2|10|20"
        );
    }

    #[test]
    fn parse_refuses_a_malformed_record_before_any_signature_check() {
        let good = serde_json::json!({
            "version": 1, "onlineKey": online(9), "issuedAt": 1, "notAfter": 2,
            "signature": STANDARD.encode([0u8; 64]),
        });
        assert!(parse_delegation(&good).is_some());

        let bad = |patch: serde_json::Value| {
            let mut v = good.clone();
            for (k, val) in patch.as_object().unwrap() {
                v[k] = val.clone();
            }
            assert!(parse_delegation(&v).is_none(), "should refuse {v}");
        };
        bad(serde_json::json!({ "version": "1" })); // a string, not a number
        bad(serde_json::json!({ "version": 0 })); // versions start at 1
        bad(serde_json::json!({ "notAfter": 1 })); // not after <= issued at
        bad(serde_json::json!({ "onlineKey": STANDARD.encode([1u8; 16]) })); // short key
        bad(serde_json::json!({ "signature": STANDARD.encode([0u8; 32]) })); // short sig
        bad(serde_json::json!({ "onlineKey": "not base64!!" }));
        assert!(parse_delegation(&serde_json::json!({ "version": 1 })).is_none());
    }

    #[test]
    fn a_delegation_verifies_only_under_the_root_that_signed_it() {
        let (key, pub_b64, fp) = root(1);
        let d = sign(&key, &fp, 1, &online(9), 9_999);
        assert!(verify_delegation(&pub_b64, &fp, &d));

        // A different root — the "attacker mints their own delegation" case.
        let (_k2, other_pub, other_fp) = root(2);
        assert!(!verify_delegation(&other_pub, &other_fp, &d));
        // The genuine root key with somebody else's fingerprint: the fingerprint
        // is inside the signed bytes, so it cannot be swapped either.
        assert!(!verify_delegation(&pub_b64, &other_fp, &d));
    }

    #[test]
    fn every_field_is_covered_by_the_signature() {
        let (key, pub_b64, fp) = root(1);
        let d = sign(&key, &fp, 3, &online(9), 9_999);
        for tampered in [
            Delegation { version: 4, ..d.clone() },
            Delegation { online_key: online(8), ..d.clone() },
            Delegation { issued_at: 2, ..d.clone() },
            Delegation { not_after: 10_000, ..d.clone() },
            Delegation { signature: STANDARD.encode([7u8; 64]), ..d.clone() },
        ] {
            assert!(!verify_delegation(&pub_b64, &fp, &tampered), "{tampered:?} must not verify");
        }
    }

    #[test]
    fn a_verified_chain_resolves_a_key_per_version_and_nothing_else() {
        let (key, pub_b64, fp) = root(1);
        let v1 = sign(&key, &fp, 1, &online(9), 9_999);
        let v2 = sign(&key, &fp, 2, &online(8), 9_999);
        let keys = verify_chain(&pub_b64, &fp, &[v1.clone(), v2.clone()], &v2, 0).unwrap();

        assert_eq!(keys.key_for(Some(1)), Some(online(9).as_str()));
        assert_eq!(keys.key_for(Some(2)), Some(online(8).as_str()));
        // An unstamped root falls back to the CURRENT key, never to "any".
        assert_eq!(keys.key_for(None), Some(online(8).as_str()));
        // A version nothing delegated is not a key — the root counts as unsigned.
        assert_eq!(keys.key_for(Some(3)), None);
        assert_eq!(keys.current(), &v2);
        // The pinned ROOT key is never reachable as a signing key.
        assert!(!keys.all_keys().any(|k| k == pub_b64));
        assert_eq!(keys.all_keys().collect::<Vec<_>>(), vec![online(8), online(9)]);
    }

    #[test]
    fn a_chain_is_refused_when_any_link_is_wrong() {
        let (key, pub_b64, fp) = root(1);
        let (other, _op, _of) = root(2);
        let v1 = sign(&key, &fp, 1, &online(9), 9_999);
        let v2 = sign(&key, &fp, 2, &online(8), 9_999);

        // Empty.
        let e = verify_chain(&pub_b64, &fp, &[], &v1, 0).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_INVALID), "{e}");

        // One member signed by a key that is not the pinned root.
        let forged = sign(&other, &fp, 2, &online(7), 9_999);
        let e = verify_chain(&pub_b64, &fp, &[v1.clone(), forged.clone()], &forged, 0).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_INVALID), "{e}");

        // Not strictly increasing: two "v1"s naming different keys.
        let v1b = sign(&key, &fp, 1, &online(7), 9_999);
        let e = verify_chain(&pub_b64, &fp, &[v1.clone(), v1b.clone()], &v1b, 0).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_INVALID), "{e}");
        // …and out of order.
        let e = verify_chain(&pub_b64, &fp, &[v2.clone(), v1.clone()], &v1, 0).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_INVALID), "{e}");

        // A current delegation that is not the newest chain member: a relay
        // advertising v2 while its published chain stops at v1.
        let e = verify_chain(&pub_b64, &fp, std::slice::from_ref(&v1), &v2, 0).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_INVALID), "{e}");

        // Expired.
        let e = verify_chain(&pub_b64, &fp, std::slice::from_ref(&v1), &v1, 9_999).unwrap_err();
        assert!(e.contains("expired"), "{e}");
        // …and one millisecond before it expires is still fine.
        verify_chain(&pub_b64, &fp, std::slice::from_ref(&v1), &v1, 9_998).unwrap();
    }

    #[test]
    fn a_rolled_back_or_equivocating_version_is_refused() {
        let (key, _pub_b64, fp) = root(1);
        let v1 = sign(&key, &fp, 1, &online(9), 9_999);
        let v2 = sign(&key, &fp, 2, &online(8), 9_999);

        // No floor yet: anything goes (first contact).
        check_rollback(&DelegationFloor::default(), &v1).unwrap();

        let floor = DelegationFloor { min_version: 2, online_key: Some(online(8)) };
        // The replay: v1 is genuinely root-signed forever, and naming a revoked
        // key. Only the remembered floor can refuse it.
        let e = check_rollback(&floor, &v1).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_ROLLBACK), "{e}");
        // The same version we know, unchanged: an ordinary reconnect.
        check_rollback(&floor, &v2).unwrap();
        // The same version naming a DIFFERENT key: the root equivocating.
        let v2b = sign(&key, &fp, 2, &online(7), 9_999);
        let e = check_rollback(&floor, &v2b).unwrap_err();
        assert!(e.starts_with(ERR_DELEGATION_ROLLBACK), "{e}");
        // A legitimate rotation moves forward.
        let v3 = sign(&key, &fp, 3, &online(6), 9_999);
        check_rollback(&floor, &v3).unwrap();
    }
}
