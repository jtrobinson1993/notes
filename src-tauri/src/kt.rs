//! v8 key-transparency client verification (spec/key-transparency.md).
//!
//! The native client verifies the relay's **akd** proofs with the light
//! `akd_core`: **inclusion** (a directory lookup proves a handle→key binding
//! under a signed root) and **key-history** (self-audit: every key the log has
//! mapped the client's own handle to). Consistency/append-only verification is
//! the reference auditor's job (it needs the full `akd` crate); the client's own
//! equivocation defence is cheap `(epoch, root)`-equality gossip against its
//! cached `kt_state` (a later slice) — no akd needed for that.
//!
//! Proofs arrive from the relay as serde JSON (passed through from the sidecar);
//! roots + the VRF public key as standard base64.

use akd_core::hash::Digest;
use akd_core::verify::{key_history_verify, lookup_verify, HistoryVerificationParams};
use akd_core::{AkdLabel, HistoryProof, LookupProof, WhatsAppV1Configuration};
use base64::Engine as _;

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
