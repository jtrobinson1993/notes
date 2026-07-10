//! v8 key-transparency directory backed by Meta's **`akd`** (AKD/CONIKS) — the
//! full-AKD upgrade over the relay's interim Merkle KT (see
//! `spec/key-transparency.md`). This is the directory *engine*; the Node relay
//! drives it over a localhost API (added in a later slice), and clients verify
//! its proofs via `akd_core` (native: direct Rust dep; web: WASM).
//!
//! First slice: an **in-memory** directory wrapping `akd::Directory` with the
//! production `WhatsAppV1Configuration`, exposing `publish` (handle → identity
//! key, one epoch per batch) and `lookup` (a VRF-blinded inclusion proof) plus
//! the VRF public key. Storage is in-memory for now — a persistent `Database`
//! impl over the relay's SQLite and a **real (persisted) VRF key** (vs the
//! `HardCodedAkdVRF` used here and in akd's own examples) are follow-up slices
//! and are REQUIRED before this is production-safe.

use akd::append_only_zks::AzksParallelismConfig;
use akd::directory::Directory;
use akd::ecvrf::HardCodedAkdVRF;
use akd::errors::AkdError;
use akd::storage::memory::AsyncInMemoryDatabase;
use akd::storage::StorageManager;
use akd::{AkdLabel, AkdValue, Digest, EpochHash, LookupProof};

/// Hash/label configuration — the same one WhatsApp KT runs in production.
pub type Config = akd::WhatsAppV1Configuration;

/// A key-transparency directory: `handle → identity pubkey`, with per-lookup
/// inclusion proofs and VRF-blinded labels.
pub struct KtDirectory {
    dir: Directory<Config, AsyncInMemoryDatabase, HardCodedAkdVRF>,
}

impl KtDirectory {
    /// Create an empty in-memory directory.
    pub async fn new() -> Result<Self, AkdError> {
        let storage = StorageManager::new_no_cache(AsyncInMemoryDatabase::new());
        let dir =
            Directory::<Config, _, _>::new(storage, HardCodedAkdVRF {}, AzksParallelismConfig::default())
                .await?;
        Ok(Self { dir })
    }

    /// Publish a batch of `handle → identity-key` bindings as one new epoch.
    /// Returns `(epoch, root_hash)` — the signed root the relay chains + serves.
    pub async fn publish(&mut self, entries: Vec<(String, Vec<u8>)>) -> Result<(u64, Digest), AkdError> {
        let updates = entries
            .into_iter()
            .map(|(handle, key)| (AkdLabel(handle.into_bytes()), AkdValue(key)))
            .collect();
        let EpochHash(epoch, root) = self.dir.publish(updates).await?;
        Ok((epoch, root))
    }

    /// Produce an inclusion/lookup proof for a handle at the current epoch,
    /// alongside the epoch's `(epoch, root_hash)` the client verifies against.
    pub async fn lookup(&self, handle: &str) -> Result<(LookupProof, EpochHash), AkdError> {
        self.dir.lookup(AkdLabel::from(handle)).await
    }

    /// The VRF public key bytes clients need to verify label blinding.
    pub async fn vrf_public_key(&self) -> Result<Vec<u8>, AkdError> {
        Ok(self.dir.get_public_key().await?.as_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Publish a binding, then prove + verify a lookup exactly as a client
    /// would (akd::client::lookup_verify against the epoch root + VRF pubkey).
    #[tokio::test]
    async fn publish_then_lookup_proof_verifies() {
        let mut kt = KtDirectory::new().await.unwrap();
        let key = vec![7u8; 32]; // an Ed25519 identity pubkey
        let (epoch, _root) = kt.publish(vec![("Alice#0001".into(), key.clone())]).await.unwrap();
        assert_eq!(epoch, 1);

        let (proof, epoch_hash) = kt.lookup("Alice#0001").await.unwrap();
        let vrf_pub = kt.vrf_public_key().await.unwrap();

        let result = akd::client::lookup_verify::<Config>(
            &vrf_pub,
            epoch_hash.hash(),
            epoch_hash.epoch(),
            AkdLabel::from("Alice#0001"),
            proof,
        )
        .expect("lookup proof should verify");

        // The verified value is exactly the published identity key.
        assert_eq!(result.value, AkdValue(key));
        assert_eq!(result.epoch, 1);
        assert_eq!(result.version, 1);
    }

    /// A lookup proof from one label must NOT verify against a different label
    /// (VRF-blinded: the proof is bound to its specific handle).
    #[tokio::test]
    async fn a_proof_does_not_verify_for_another_handle() {
        let mut kt = KtDirectory::new().await.unwrap();
        kt.publish(vec![
            ("Alice#0001".into(), vec![1u8; 32]),
            ("Bob#0002".into(), vec![2u8; 32]),
        ])
        .await
        .unwrap();

        let (proof, epoch_hash) = kt.lookup("Alice#0001").await.unwrap();
        let vrf_pub = kt.vrf_public_key().await.unwrap();

        // Verifying Alice's proof under Bob's label fails.
        let forged = akd::client::lookup_verify::<Config>(
            &vrf_pub,
            epoch_hash.hash(),
            epoch_hash.epoch(),
            AkdLabel::from("Bob#0002"),
            proof,
        );
        assert!(forged.is_err(), "a proof must not verify for a different handle");
    }

    /// Each publish advances the epoch (chained roots).
    #[tokio::test]
    async fn publishing_advances_the_epoch() {
        let mut kt = KtDirectory::new().await.unwrap();
        let (e1, r1) = kt.publish(vec![("Alice#0001".into(), vec![1u8; 32])]).await.unwrap();
        let (e2, r2) = kt.publish(vec![("Bob#0002".into(), vec![2u8; 32])]).await.unwrap();
        assert_eq!(e1, 1);
        assert_eq!(e2, 2);
        assert_ne!(r1, r2); // the root moves as the directory grows
    }
}
