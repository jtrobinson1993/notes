//! v8 attachment content crypto (D6/chat.md § media). Each file is encrypted
//! under a FRESH random per-file key (AES-256-GCM); the key + IV ride inside the
//! E2E message payload and never reach the relay, which only stores the opaque
//! ciphertext (the blob store). Symmetric so a group attachment is one blob for
//! all members (the per-file key travels in the group-sealed message).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::RngCore;

use crate::blobs::BlobStore;
use crate::store::{AttachmentMeta, Store};

/// An encrypted file + the key material to put in the message payload.
pub struct EncryptedFile {
    pub ciphertext: Vec<u8>,
    pub key: [u8; 32],
    pub iv: [u8; 12],
}

/// Encrypt file bytes under a fresh per-file key.
pub fn encrypt_file(plaintext: &[u8]) -> Result<EncryptedFile, String> {
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    let mut iv = [0u8; 12];
    rand::rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "attachment crypto init".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext)
        .map_err(|_| "attachment encrypt failed".to_string())?;
    Ok(EncryptedFile { ciphertext, key, iv })
}

/// Decrypt attachment ciphertext with the per-file key + IV from the message.
pub fn decrypt_file(ciphertext: &[u8], key: &[u8; 32], iv: &[u8; 12]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "attachment crypto init".to_string())?;
    cipher
        .decrypt(Nonce::from_slice(iv), ciphertext)
        .map_err(|_| "attachment decrypt failed".to_string())
}

// ---- the on-device cache (spec/local-store.md § Attachments on device) ----
//
// The relay deletes a blob once every recipient acks it, and on TTL regardless,
// so the relay is not a durable store: media that is only ever fetched over the
// network becomes permanently unavailable. Both transfer paths therefore keep
// the ciphertext locally on the way through — the same bytes that travel, still
// encrypted under the per-file key, with the key held in the SQLCipher row.

/// Persist an attachment's ciphertext locally. Returns whether the copy was
/// kept; callers treat `false` as "not cached" and carry on, because by the time
/// this runs the transfer has already succeeded and failing the user-visible
/// operation over a cache miss would be worse than re-fetching later.
pub fn cache_locally(
    store: &Store,
    blobs: &BlobStore,
    meta: &AttachmentMeta,
    ciphertext: &[u8],
) -> bool {
    let path = match blobs.write(&meta.id, ciphertext) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("attachment {}: local blob write failed: {e}", meta.id);
            return false;
        }
    };
    if let Err(e) = store.upsert_attachment(meta, &path.to_string_lossy()) {
        log::warn!("attachment {}: local metadata write failed: {e}", meta.id);
        // Bytes on disk with no row pointing at them would never be evicted.
        let _ = blobs.remove(&meta.id);
        return false;
    }
    true
}

/// Read an attachment's ciphertext back out of the local store, if this device
/// still holds it. `None` covers every "not cached" case — unknown id, evicted,
/// or a row whose file has gone missing — so the caller simply re-fetches.
pub fn cached_ciphertext(store: &Store, blobs: &BlobStore, id: &str) -> Option<Vec<u8>> {
    let meta = store.attachment_meta(id).ok()??;
    if meta.state != "present" {
        return None;
    }
    match blobs.read(id) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            // The row claims present but the file is gone; correct it so the
            // state stays honest, then let the caller re-fetch.
            log::warn!("attachment {id}: cached blob unreadable ({e}); re-fetching");
            let _ = store.set_attachment_state(id, "evicted");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip_and_wrong_key() {
        let plain = b"the quick brown fox jumps over the lazy dog";
        let enc = encrypt_file(plain).unwrap();
        assert_ne!(enc.ciphertext, plain); // actually encrypted
        assert_eq!(decrypt_file(&enc.ciphertext, &enc.key, &enc.iv).unwrap(), plain);
        // Wrong key → AEAD failure, not garbage.
        assert!(decrypt_file(&enc.ciphertext, &[0u8; 32], &enc.iv).is_err());
        // Tampered ciphertext → failure.
        let mut bad = enc.ciphertext.clone();
        bad[0] ^= 1;
        assert!(decrypt_file(&bad, &enc.key, &enc.iv).is_err());
    }

    #[test]
    fn each_file_gets_a_distinct_key() {
        let a = encrypt_file(b"x").unwrap();
        let b = encrypt_file(b"x").unwrap();
        assert_ne!(a.key, b.key);
        assert_ne!(a.iv, b.iv);
    }

    // ---- the on-device cache ----

    /// A store + blob store on a temp dir, as the vault would hold them.
    fn vault_like() -> (tempfile::TempDir, Store, BlobStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[9u8; 32]).unwrap();
        let blobs = BlobStore::new(dir.path().join("blobs"));
        (dir, store, blobs)
    }

    fn meta_for(id: &str, enc: &EncryptedFile, size: usize) -> AttachmentMeta {
        AttachmentMeta {
            id: id.to_string(),
            owner_kind: "dm".into(),
            owner_id: "contact-1".into(),
            file_key: enc.key.to_vec(),
            iv: Some(enc.iv.to_vec()),
            thumb: None,
            size: Some(size as i64),
            mime: Some("image/webp".into()),
            content_hash: None,
        }
    }

    #[test]
    fn caches_ciphertext_and_serves_it_back_without_the_relay() {
        let (_d, store, blobs) = vault_like();
        let plain = b"a picture of a dog";
        let enc = encrypt_file(plain).unwrap();

        assert!(cache_locally(&store, &blobs, &meta_for("blob-aaa", &enc, plain.len()), &enc.ciphertext));

        // Served from disk, and it is the *ciphertext* that was stored — the
        // filesystem never sees plaintext.
        let got = cached_ciphertext(&store, &blobs, "blob-aaa").expect("cached");
        assert_eq!(got, enc.ciphertext);
        assert_ne!(got, plain.to_vec());
        assert_eq!(decrypt_file(&got, &enc.key, &enc.iv).unwrap(), plain);

        // The row records what the message ref carried, so a later fetch can
        // decrypt from the cache alone.
        let row = store.attachment_meta("blob-aaa").unwrap().unwrap();
        assert_eq!(row.state, "present");
        assert_eq!(row.file_key, enc.key.to_vec());
        assert_eq!(row.iv, Some(enc.iv.to_vec()));
        assert_eq!(row.size, Some(plain.len() as i64));
    }

    #[test]
    fn unknown_attachment_is_not_cached() {
        let (_d, store, blobs) = vault_like();
        assert!(cached_ciphertext(&store, &blobs, "never-seen").is_none());
    }

    #[test]
    fn evicted_attachment_reports_uncached_then_re_caches() {
        let (_d, store, blobs) = vault_like();
        let enc = encrypt_file(b"evict me").unwrap();
        cache_locally(&store, &blobs, &meta_for("blob-bbb", &enc, 8), &enc.ciphertext);

        // Local reclamation: bytes gone, row remembers the attachment existed.
        blobs.remove("blob-bbb").unwrap();
        store.set_attachment_state("blob-bbb", "evicted").unwrap();
        assert!(cached_ciphertext(&store, &blobs, "blob-bbb").is_none());

        // Re-fetching from the relay must restore the row to a usable state —
        // this is the case INSERT OR IGNORE would silently leave broken, with
        // the row stuck on `evicted` and a NULL path.
        assert!(cache_locally(&store, &blobs, &meta_for("blob-bbb", &enc, 8), &enc.ciphertext));
        let row = store.attachment_meta("blob-bbb").unwrap().unwrap();
        assert_eq!(row.state, "present");
        assert_eq!(cached_ciphertext(&store, &blobs, "blob-bbb"), Some(enc.ciphertext.clone()));
    }

    #[test]
    fn a_present_row_whose_file_vanished_self_corrects() {
        let (_d, store, blobs) = vault_like();
        let enc = encrypt_file(b"gone").unwrap();
        cache_locally(&store, &blobs, &meta_for("blob-ccc", &enc, 4), &enc.ciphertext);

        // The file disappears underneath us (external deletion, disk repair).
        blobs.remove("blob-ccc").unwrap();

        assert!(cached_ciphertext(&store, &blobs, "blob-ccc").is_none());
        // The row must not keep claiming `present`, or eviction accounting and
        // the UI's "downloaded" state both lie.
        assert_eq!(store.attachment_meta("blob-ccc").unwrap().unwrap().state, "evicted");
    }

    #[test]
    fn a_rejected_blob_id_leaves_no_row_behind() {
        let (_d, store, blobs) = vault_like();
        let enc = encrypt_file(b"x").unwrap();
        // Blob ids come from message payloads; the store guards the charset.
        let bad = meta_for("../escape", &enc, 1);
        assert!(!cache_locally(&store, &blobs, &bad, &enc.ciphertext));
        assert!(store.attachment_meta("../escape").unwrap().is_none());
    }
}
