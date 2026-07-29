//! v8 key-transparency client verification (spec/key-transparency.md).
//!
//! The native client verifies the relay's **akd** proofs with the light
//! `akd_core`: **inclusion** (a directory lookup proves a handle→key binding
//! under a signed root) and **key-history** (self-audit: every key the log has
//! mapped the client's own handle to). Consistency/append-only verification is
//! the reference auditor's job (it needs the full `akd` crate); the client's own
//! equivocation defence is cheap `(epoch, root)`-equality gossip against its
//! cached `kt_state` — no akd needed for that.
//!
//! **A proof is only as good as the root it is checked against.** Both proof
//! kinds arrive alongside the root they verify under, and a hostile relay can
//! always make those two agree with each other. So every verification path here
//! resolves the root through `signed_root_epoch` first — the root must appear in
//! the relay's *signed*, hash-chained `/kt/roots` chain — and only then runs the
//! akd proof against it. `contact_verdict` is the decision that closes the MITM
//! gap: is the key we are about to trust for a handle the one the log published?
//!
//! Proofs arrive from the relay as serde JSON (passed through from the sidecar);
//! roots + the VRF public key as standard base64.

use akd_core::hash::Digest;
use akd_core::verify::{key_history_verify, lookup_verify, HistoryVerificationParams};
use akd_core::{AkdLabel, HistoryProof, LookupProof, WhatsAppV1Configuration};
use base64::Engine as _;

use crate::relay_client::{DirectoryEntry, SignedRoot};

/// The relay's KT configuration — must match the sidecar (`akd-sidecar`).
type Config = WhatsAppV1Configuration;

fn b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("bad base64: {e}"))
}

fn root32(root_b64: &str) -> Result<Digest, String> {
    b64(root_b64)?
        .try_into()
        .map_err(|_| "root hash must be 32 bytes".to_string())
}

/// Verify an akd **inclusion** proof for `handle` against the signed epoch root.
/// Returns the verified value (the identity key bytes); the caller checks it
/// equals the key the relay claims for the handle.
pub fn verify_lookup(
    vrf_pub_b64: &str,
    root_b64: &str,
    epoch: u64,
    handle: &str,
    proof_json: &str,
) -> Result<Vec<u8>, String> {
    let vrf_pub = b64(vrf_pub_b64)?;
    let root = root32(root_b64)?;
    let proof: LookupProof =
        serde_json::from_str(proof_json).map_err(|e| format!("malformed lookup proof: {e}"))?;
    let res = lookup_verify::<Config>(&vrf_pub, root, epoch, AkdLabel::from(handle), proof)
        .map_err(|e| format!("lookup proof invalid: {e:?}"))?;
    Ok(res.value.0)
}

/// Verify a **key-history** proof for `handle` (self-audit). Returns every value
/// (identity key) the log has mapped the handle to; the client checks each is a
/// key it actually minted.
pub fn verify_key_history(
    vrf_pub_b64: &str,
    root_b64: &str,
    epoch: u64,
    handle: &str,
    proof_json: &str,
) -> Result<Vec<Vec<u8>>, String> {
    let vrf_pub = b64(vrf_pub_b64)?;
    let root = root32(root_b64)?;
    let proof: HistoryProof =
        serde_json::from_str(proof_json).map_err(|e| format!("malformed history proof: {e}"))?;
    let results = key_history_verify::<Config>(
        &vrf_pub,
        root,
        epoch,
        AkdLabel::from(handle),
        proof,
        HistoryVerificationParams::default(),
    )
    .map_err(|e| format!("history proof invalid: {e:?}"))?;
    Ok(results.into_iter().map(|r| r.value.0).collect())
}

/// Verify the relay's signature over a KT epoch root, as gossiped by a contact
/// on E2E traffic (D5). The relay signs `kt-root|{root}|{prev}` (prev = "genesis"
/// for the first epoch) with its identity key — so a valid signature proves the
/// root is genuinely the relay's, and a contact can't fabricate one to frame an
/// honest relay. Only then does a `(epoch,root)` mismatch vs. our own view count
/// as the relay's equivocation (split view).
pub fn verify_signed_root(
    relay_pub_b64: &str,
    root_b64: &str,
    prev_b64: &str,
    sig_b64: &str,
) -> Result<bool, String> {
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    let pub_bytes: [u8; 32] = b64(relay_pub_b64)?
        .try_into()
        .map_err(|_| "relay key must be 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&pub_bytes).map_err(|e| format!("bad relay key: {e}"))?;
    let sig = Signature::from_slice(&b64(sig_b64)?).map_err(|e| format!("bad signature: {e}"))?;
    let prev = if prev_b64.is_empty() { "genesis" } else { prev_b64 };
    let payload = format!("kt-root|{root_b64}|{prev}");
    Ok(key.verify(payload.as_bytes(), &sig).is_ok())
}

/// Find `root_b64` among the relay's published epoch roots **and verify the
/// relay's signature over it**, returning that root's relay epoch.
///
/// This is the hinge of contact verification. An inclusion proof verifies
/// against whatever root it is handed, so taking the root from the same response
/// that carried the proof proves nothing — a hostile relay simply returns a
/// self-consistent `(proof, root)` pair for a key it chose. Only a root the
/// relay *signed* (`kt-root|{root}|{prev}`, the same signature gossip and the
/// reference auditor check) is a usable anchor, because that root is public,
/// chained, and gossiped: lying in it is equivocation everyone else can see.
///
/// `None` = the root was never signed by this relay → the response is a
/// fabrication and must be rejected, not downgraded to "unverified".
pub fn signed_root_epoch(relay_pub_b64: &str, roots: &[SignedRoot], root_b64: &str) -> Option<i64> {
    if root_b64.is_empty() {
        return None;
    }
    roots
        .iter()
        .find(|r| {
            r.root == root_b64 && verify_signed_root(relay_pub_b64, &r.root, &r.prev, &r.sig).unwrap_or(false)
        })
        .map(|r| r.epoch)
}

/// Why a contact could not be checked against the log. **Not** a failure of the
/// check — nothing contradicted the key, we just have no proof either way. The
/// contact is recorded UNVERIFIED and re-checked on the next relay connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unverified {
    /// The relay answered 404: it claims the handle has no directory entry.
    NotInLog,
    /// This relay runs the interim Merkle KT (or published no proof material) —
    /// there is no AKD proof for the client to verify.
    NoLogBackend,
    /// The directory or the roots endpoint could not be reached.
    RelayUnreachable,
    /// We hold no relay identity key, so no root signature can be checked.
    NoRelayKey,
}

/// Why a contact key was **rejected**. Every variant means the relay actively
/// served something that contradicts its own signed log, so the contact is not
/// recorded, nothing is sealed back, and the hard KT alarm is raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    /// The log binds this handle to a *different* identity key — the MITM case.
    KeyMismatch,
    /// The inclusion proof does not verify against the relay's own signed root.
    ProofInvalid,
    /// The root the proof was served with is not one the relay ever signed.
    RootUnsigned,
    /// The VRF public key changed under a pinned relay. A VRF key the client
    /// does not already trust lets the relay map any handle to any leaf, so a
    /// swap is treated as equivocation, not as a rotation.
    VrfKeyChanged,
}

impl Unverified {
    pub fn as_str(self) -> &'static str {
        match self {
            Unverified::NotInLog => "not-in-log",
            Unverified::NoLogBackend => "no-log-backend",
            Unverified::RelayUnreachable => "relay-unreachable",
            Unverified::NoRelayKey => "no-relay-key",
        }
    }
}

impl Rejected {
    pub fn as_str(self) -> &'static str {
        match self {
            Rejected::KeyMismatch => "key-mismatch",
            Rejected::ProofInvalid => "proof-invalid",
            Rejected::RootUnsigned => "root-unsigned",
            Rejected::VrfKeyChanged => "vrf-key-changed",
        }
    }
}

/// What the transparency log says about a contact key we are about to trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContactTrust {
    /// The log published exactly this key for this handle, under a root the
    /// relay signed at `epoch`.
    Verified { epoch: i64, root: String },
    /// No proof either way — proceed, but never as verified.
    Unverified(Unverified),
    /// The log contradicts the key — fail closed.
    Rejected(Rejected),
}

impl ContactTrust {
    /// The signed epoch to record against the contact, when verified.
    pub fn epoch(&self) -> Option<i64> {
        match self {
            ContactTrust::Verified { epoch, .. } => Some(*epoch),
            _ => None,
        }
    }
    pub fn rejected(&self) -> Option<Rejected> {
        match self {
            ContactTrust::Rejected(r) => Some(*r),
            _ => None,
        }
    }
}

/// Decide whether the log vouches for `expected_key` as `handle`'s identity key.
///
/// Pure: every input is already fetched, so the ordering that matters is
/// enforced structurally — the root's *signature* is resolved before the
/// inclusion proof is even parsed, and the proof is then verified against that
/// signed root rather than against the root the response asked us to use.
///
/// `pinned_vrf` is the VRF public key this client has already accepted for the
/// relay (trust-on-first-use). It is checked *before* the proof because the VRF
/// key is what maps a handle to a leaf: with a VRF key of its choosing a relay
/// can point `Alice#0001` at a leaf that legitimately holds the attacker's key,
/// and the inclusion proof against the genuine signed root would still verify.
pub fn contact_verdict(
    relay_pub_b64: &str,
    roots: &[SignedRoot],
    pinned_vrf: Option<&str>,
    handle: &str,
    expected_key: &[u8],
    entry: &DirectoryEntry,
) -> ContactTrust {
    if entry.kt.as_deref() != Some("akd") || entry.vrf_public_key.is_empty() || entry.proof_json.is_empty() {
        return ContactTrust::Unverified(Unverified::NoLogBackend);
    }
    if relay_pub_b64.is_empty() {
        return ContactTrust::Unverified(Unverified::NoRelayKey);
    }
    if let Some(pin) = pinned_vrf {
        if pin != entry.vrf_public_key {
            return ContactTrust::Rejected(Rejected::VrfKeyChanged);
        }
    }
    let Some(epoch) = signed_root_epoch(relay_pub_b64, roots, &entry.root) else {
        return ContactTrust::Rejected(Rejected::RootUnsigned);
    };
    match verify_lookup(&entry.vrf_public_key, &entry.root, entry.epoch, handle, &entry.proof_json) {
        Err(_) => ContactTrust::Rejected(Rejected::ProofInvalid),
        Ok(logged) if logged == expected_key => ContactTrust::Verified { epoch, root: entry.root.clone() },
        Ok(_) => ContactTrust::Rejected(Rejected::KeyMismatch),
    }
}

/// Verdict of a self-audit over a handle's verified key-history.
#[derive(Debug, PartialEq, Eq)]
pub enum SelfAudit {
    /// Every value the log mapped the handle to is a key the client minted.
    Clean,
    /// The log bound the handle to a key the client never minted — the relay
    /// equivocated on the client's own identity (a HARD alarm).
    Foreign(Vec<u8>),
}

/// Compare the keys a verified key-history proof revealed (`history_keys`)
/// against the keys the client actually minted (`my_keys`); flag any foreign
/// one. This is the self-audit decision — pure, so the network/verify plumbing
/// around it stays thin.
pub fn self_audit_verdict(history_keys: &[Vec<u8>], my_keys: &[Vec<u8>]) -> SelfAudit {
    for k in history_keys {
        if !my_keys.contains(k) {
            return SelfAudit::Foreign(k.clone());
        }
    }
    SelfAudit::Clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_signed_root_matches_the_relay_signing_scheme() {
        use base64::engine::general_purpose::STANDARD;
        use ed25519_dalek::{Signer as _, SigningKey};
        let key = SigningKey::from_bytes(&[42u8; 32]);
        let pub_b64 = STANDARD.encode(key.verifying_key().to_bytes());
        let root = STANDARD.encode([3u8; 32]);
        let prev = STANDARD.encode([2u8; 32]);

        // Sign exactly as the relay does (`kt-root|{root}|{prev}`).
        let sig = STANDARD.encode(key.sign(format!("kt-root|{root}|{prev}").as_bytes()).to_bytes());
        assert_eq!(verify_signed_root(&pub_b64, &root, &prev, &sig).unwrap(), true);

        // Genesis root (empty prev → "genesis").
        let gsig = STANDARD.encode(key.sign(format!("kt-root|{root}|genesis").as_bytes()).to_bytes());
        assert_eq!(verify_signed_root(&pub_b64, &root, "", &gsig).unwrap(), true);

        // A tampered root, or another relay's key, must not verify.
        assert_eq!(verify_signed_root(&pub_b64, &STANDARD.encode([9u8; 32]), &prev, &sig).unwrap(), false);
        let other = STANDARD.encode(SigningKey::from_bytes(&[7u8; 32]).verifying_key().to_bytes());
        assert_eq!(verify_signed_root(&other, &root, &prev, &sig).unwrap(), false);
    }

    #[test]
    fn self_audit_flags_only_a_key_i_never_minted() {
        let mine = vec![vec![1u8; 32]];
        // Only my key in the history → clean.
        assert_eq!(self_audit_verdict(&[vec![1u8; 32]], &mine), SelfAudit::Clean);
        // A rotation to a second key I also minted → clean.
        let mine2 = vec![vec![1u8; 32], vec![9u8; 32]];
        assert_eq!(self_audit_verdict(&[vec![1u8; 32], vec![9u8; 32]], &mine2), SelfAudit::Clean);
        // A foreign key the relay inserted → flagged.
        assert_eq!(
            self_audit_verdict(&[vec![1u8; 32], vec![2u8; 32]], &mine),
            SelfAudit::Foreign(vec![2u8; 32])
        );
        // Empty history → nothing to flag.
        assert_eq!(self_audit_verdict(&[], &mine), SelfAudit::Clean);
    }
    use akd::append_only_zks::AzksParallelismConfig;
    use akd::directory::Directory;
    use akd::ecvrf::HardCodedAkdVRF;
    use akd::storage::memory::AsyncInMemoryDatabase;
    use akd::storage::StorageManager;
    use akd::{AkdLabel as L, AkdValue, HistoryParams};

    type DirCfg = akd::WhatsAppV1Configuration;

    async fn directory() -> Directory<DirCfg, AsyncInMemoryDatabase, HardCodedAkdVRF> {
        let storage = StorageManager::new_no_cache(AsyncInMemoryDatabase::new());
        Directory::<DirCfg, _, _>::new(storage, HardCodedAkdVRF {}, AzksParallelismConfig::default())
            .await
            .unwrap()
    }
    fn enc(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn verify_lookup_accepts_a_real_proof_and_rejects_a_bad_root() {
        let mut dir = directory().await;
        let key = vec![7u8; 32];
        dir.publish(vec![(L::from("Alice#0001"), AkdValue(key.clone()))]).await.unwrap();
        let (proof, eh) = dir.lookup(L::from("Alice#0001")).await.unwrap();
        let vrf = dir.get_public_key().await.unwrap();

        let proof_json = serde_json::to_string(&proof).unwrap();
        let value = verify_lookup(&enc(vrf.as_bytes()), &enc(&eh.hash()), eh.epoch(), "Alice#0001", &proof_json).unwrap();
        assert_eq!(value, key); // verified identity key == the published one

        // A wrong root hash must not verify.
        assert!(verify_lookup(&enc(vrf.as_bytes()), &enc(&[0u8; 32]), eh.epoch(), "Alice#0001", &proof_json).is_err());
        // A proof for the wrong handle must not verify.
        assert!(verify_lookup(&enc(vrf.as_bytes()), &enc(&eh.hash()), eh.epoch(), "Bob#0002", &proof_json).is_err());
    }

    // ------------------------------------------------ contact verification ---
    //
    // The decision that closes the MITM gap. Every case below is built from a
    // REAL akd directory + REAL ed25519 root signatures, because the property
    // under test is precisely that a self-consistent but unsigned (proof, root)
    // pair is not enough.

    use ed25519_dalek::{Signer as _, SigningKey};

    /// A relay's signing key, and the signed-root chain it publishes.
    struct FakeRelay {
        key: SigningKey,
    }

    impl FakeRelay {
        fn new(seed: u8) -> Self {
            FakeRelay { key: SigningKey::from_bytes(&[seed; 32]) }
        }
        fn pub_b64(&self) -> String {
            enc(&self.key.verifying_key().to_bytes())
        }
        /// Sign `root` as epoch `epoch` exactly as the relay does.
        fn sign(&self, epoch: i64, root: &str, prev: &str) -> SignedRoot {
            let prev_payload = if prev.is_empty() { "genesis" } else { prev };
            let sig = self.key.sign(format!("kt-root|{root}|{prev_payload}").as_bytes());
            SignedRoot { epoch, root: root.into(), prev: prev.into(), sig: enc(&sig.to_bytes()) }
        }
    }

    fn entry(root: &str, epoch: u64, proof_json: &str, vrf: &str) -> DirectoryEntry {
        DirectoryEntry {
            identity_pub_b64: String::new(),
            sealing_pub_b64: String::new(),
            epoch,
            root: root.into(),
            proof_json: proof_json.into(),
            vrf_public_key: vrf.into(),
            kt: Some("akd".into()),
        }
    }

    /// Publish `key` for `handle` and return everything a lookup response carries.
    async fn published(handle: &str, key: &[u8]) -> (String, u64, String, String) {
        let mut dir = directory().await;
        dir.publish(vec![(L::from(handle), AkdValue(key.to_vec()))]).await.unwrap();
        let (proof, eh) = dir.lookup(L::from(handle)).await.unwrap();
        let vrf = dir.get_public_key().await.unwrap();
        (
            enc(&eh.hash()),
            eh.epoch(),
            serde_json::to_string(&proof).unwrap(),
            enc(vrf.as_bytes()),
        )
    }

    #[tokio::test]
    async fn a_key_the_log_published_under_a_signed_root_verifies() {
        let relay = FakeRelay::new(42);
        let key = vec![7u8; 32];
        let (root, epoch, proof, vrf) = published("Alice#0001", &key).await;
        // The relay signed this root as ITS epoch 5 (the akd epoch is a separate
        // counter — what gets recorded is the signed one).
        let roots = vec![relay.sign(5, &root, "")];

        let verdict = contact_verdict(
            &relay.pub_b64(),
            &roots,
            Some(&vrf),
            "Alice#0001",
            &key,
            &entry(&root, epoch, &proof, &vrf),
        );
        assert_eq!(verdict, ContactTrust::Verified { epoch: 5, root: root.clone() });
        assert_eq!(verdict.epoch(), Some(5));
    }

    #[tokio::test]
    async fn a_key_the_log_does_not_publish_is_rejected() {
        let relay = FakeRelay::new(42);
        // The log says Alice's key is 7s; we were handed 9s (the MITM case).
        let (root, epoch, proof, vrf) = published("Alice#0001", &[7u8; 32]).await;
        let roots = vec![relay.sign(1, &root, "")];

        let verdict = contact_verdict(
            &relay.pub_b64(),
            &roots,
            Some(&vrf),
            "Alice#0001",
            &[9u8; 32],
            &entry(&root, epoch, &proof, &vrf),
        );
        assert_eq!(verdict, ContactTrust::Rejected(Rejected::KeyMismatch));
    }

    #[tokio::test]
    async fn a_valid_proof_against_an_attacker_chosen_root_is_rejected() {
        // THE case this whole path exists for. The attacker runs their own akd
        // directory, so `(proof, root)` are perfectly self-consistent and the
        // proof verifies — against a root the relay never signed.
        let relay = FakeRelay::new(42);
        let honest = published("Alice#0001", &[7u8; 32]).await;
        let (evil_root, evil_epoch, evil_proof, vrf) = published("Alice#0001", &[9u8; 32]).await;
        // Sanity: the forged pair really does verify on its own terms — which is
        // exactly why the root's signature, not the proof, has to be the anchor.
        assert_eq!(
            verify_lookup(&vrf, &evil_root, evil_epoch, "Alice#0001", &evil_proof).unwrap(),
            vec![9u8; 32]
        );

        // Only the honest root is in the signed chain.
        let roots = vec![relay.sign(1, &honest.0, "")];
        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&vrf),
                "Alice#0001",
                &[9u8; 32],
                &entry(&evil_root, evil_epoch, &evil_proof, &vrf),
            ),
            ContactTrust::Rejected(Rejected::RootUnsigned)
        );

        // Same forged pair, now served with a root "signature" from a key that
        // is not the pinned relay's → still unsigned as far as we are concerned.
        let impostor = FakeRelay::new(7);
        let roots = vec![impostor.sign(1, &evil_root, "")];
        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&vrf),
                "Alice#0001",
                &[9u8; 32],
                &entry(&evil_root, evil_epoch, &evil_proof, &vrf),
            ),
            ContactTrust::Rejected(Rejected::RootUnsigned)
        );
    }

    #[tokio::test]
    async fn a_forged_proof_under_a_signed_root_is_rejected() {
        let relay = FakeRelay::new(42);
        let (root, epoch, proof, vrf) = published("Alice#0001", &[7u8; 32]).await;
        let roots = vec![relay.sign(3, &root, "")];

        // A proof for a different handle, replayed under the genuine root.
        let (_r2, _e2, other_proof, _v2) = published("Bob#0002", &[7u8; 32]).await;
        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&vrf),
                "Alice#0001",
                &[7u8; 32],
                &entry(&root, epoch, &other_proof, &vrf),
            ),
            ContactTrust::Rejected(Rejected::ProofInvalid)
        );

        // Garbage in place of a proof is a rejection, not a crash.
        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&vrf),
                "Alice#0001",
                &[7u8; 32],
                &entry(&root, epoch, "{\"not\":\"a proof\"}", &vrf),
            ),
            ContactTrust::Rejected(Rejected::ProofInvalid)
        );

        // A proof against a root that is merely *close* to the real one fails —
        // the root hash is what the Merkle path commits to.
        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&vrf),
                "Alice#0001",
                &[7u8; 32],
                &entry(&enc(&[0u8; 32]), epoch, &proof, &vrf),
            ),
            // Not even reached as a proof failure: an unknown root is unsigned.
            ContactTrust::Rejected(Rejected::RootUnsigned)
        );
    }

    #[tokio::test]
    async fn the_root_not_the_epoch_number_is_the_anchor() {
        // Documented akd_core behaviour, and the reason this client resolves the
        // ROOT through the signed chain rather than trusting the response's
        // epoch: `lookup_verify` does not bind its `epoch` argument tightly, so
        // a relay could restate the epoch freely. The root hash is the value the
        // proof actually commits to, and the root is what the relay signs.
        let (root, epoch, proof, vrf) = published("Alice#0001", &[7u8; 32]).await;
        assert!(verify_lookup(&vrf, &root, epoch + 1, "Alice#0001", &proof).is_ok());
        assert!(verify_lookup(&vrf, &enc(&[0u8; 32]), epoch, "Alice#0001", &proof).is_err());
    }

    #[tokio::test]
    async fn a_swapped_vrf_key_is_rejected_rather_than_trusted() {
        // The VRF key decides which leaf a handle maps to; a relay free to
        // change it could aim any handle at any leaf under a genuine root.
        let relay = FakeRelay::new(42);
        let (root, epoch, proof, vrf) = published("Alice#0001", &[7u8; 32]).await;
        let roots = vec![relay.sign(1, &root, "")];
        let pinned = enc(&[3u8; 32]); // what we accepted on first use

        assert_eq!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                Some(&pinned),
                "Alice#0001",
                &[7u8; 32],
                &entry(&root, epoch, &proof, &vrf),
            ),
            ContactTrust::Rejected(Rejected::VrfKeyChanged)
        );
        // With nothing pinned yet, first use is trust-on-first-use.
        assert!(matches!(
            contact_verdict(
                &relay.pub_b64(),
                &roots,
                None,
                "Alice#0001",
                &[7u8; 32],
                &entry(&root, epoch, &proof, &vrf),
            ),
            ContactTrust::Verified { .. }
        ));
    }

    #[tokio::test]
    async fn a_relay_with_no_akd_backend_is_unverified_not_verified() {
        let relay = FakeRelay::new(42);
        let (root, epoch, proof, vrf) = published("Alice#0001", &[7u8; 32]).await;
        let roots = vec![relay.sign(1, &root, "")];

        // Interim Merkle KT: no `kt: "akd"`, no VRF key, proofs this client
        // cannot verify. Never a match — but never a block either.
        let mut interim = entry(&root, epoch, &proof, &vrf);
        interim.kt = None;
        assert_eq!(
            contact_verdict(&relay.pub_b64(), &roots, Some(&vrf), "Alice#0001", &[7u8; 32], &interim),
            ContactTrust::Unverified(Unverified::NoLogBackend)
        );

        // No relay identity key ⇒ no signature to check ⇒ unverified, not trusted.
        assert_eq!(
            contact_verdict("", &roots, Some(&vrf), "Alice#0001", &[7u8; 32], &entry(&root, epoch, &proof, &vrf)),
            ContactTrust::Unverified(Unverified::NoRelayKey)
        );
    }

    #[tokio::test]
    async fn signed_root_epoch_only_accepts_a_root_this_relay_signed() {
        let relay = FakeRelay::new(42);
        let a = enc(&[1u8; 32]);
        let b = enc(&[2u8; 32]);
        let roots = vec![relay.sign(1, &a, ""), relay.sign(2, &b, &a)];

        assert_eq!(signed_root_epoch(&relay.pub_b64(), &roots, &a), Some(1));
        assert_eq!(signed_root_epoch(&relay.pub_b64(), &roots, &b), Some(2));
        // Unknown root, empty root, and a chain from another relay: all None.
        assert_eq!(signed_root_epoch(&relay.pub_b64(), &roots, &enc(&[3u8; 32])), None);
        assert_eq!(signed_root_epoch(&relay.pub_b64(), &roots, ""), None);
        assert_eq!(signed_root_epoch(&FakeRelay::new(7).pub_b64(), &roots, &a), None);
        // A root listed with a corrupted signature is not a signed root.
        let tampered = vec![SignedRoot { sig: enc(&[0u8; 64]), ..relay.sign(1, &a, "") }];
        assert_eq!(signed_root_epoch(&relay.pub_b64(), &tampered, &a), None);
    }

    #[tokio::test]
    async fn verify_key_history_returns_every_minted_key() {
        let mut dir = directory().await;
        dir.publish(vec![(L::from("Alice#0001"), AkdValue(vec![1u8; 32]))]).await.unwrap();
        dir.publish(vec![(L::from("Alice#0001"), AkdValue(vec![9u8; 32]))]).await.unwrap();
        let (proof, eh) = dir.key_history(&L::from("Alice#0001"), HistoryParams::Complete).await.unwrap();
        let vrf = dir.get_public_key().await.unwrap();

        let proof_json = serde_json::to_string(&proof).unwrap();
        let keys = verify_key_history(&enc(vrf.as_bytes()), &enc(&eh.hash()), eh.epoch(), "Alice#0001", &proof_json).unwrap();
        assert!(keys.contains(&vec![1u8; 32]));
        assert!(keys.contains(&vec![9u8; 32]));
    }
}
