//! The on-device **used-emoji cache** (spec/chat.md § emoji, spec/local-store.md
//! § Emoji on device).
//!
//! Emote search is live and network-bound; an emoji you have *already been sent*
//! must render offline and without a round-trip. This is that store, and it is
//! deliberately the **same shape as the attachment cache** rather than a second
//! design: a metadata row in SQLCipher, opaque ciphertext in a `BlobStore`, an
//! `evicted` state that behaves exactly like a miss, and an upsert (not
//! insert-or-ignore) on the re-cache path.
//!
//! Two things it adds over attachments:
//!
//! * **A byte budget with LRU eviction.** Emotes arrive from other people's
//!   messages, so the set is not user-chosen and must be bounded on its own.
//!   Every read touches `last_used_at`, so the LRU order reflects what actually
//!   renders; every write evicts least-recently-used entries until the cache is
//!   back under budget.
//! * **Encryption at rest.** Attachment ciphertext already exists (it is what
//!   travels), but an emote image arrives as plaintext WebP from the relay. The
//!   *set of emotes you hold* is a fingerprint of what you have been sent, so it
//!   is encrypted with a fresh per-file key under the same AES-256-GCM helper
//!   attachments use, with the key in the SQLCipher-protected row — the vault's
//!   filesystem still never holds anything readable.

use crate::attachment::{decrypt_file, encrypt_file};
use crate::blobs::BlobStore;
use crate::store::{EmoteMeta, Store};

/// Default LRU byte budget: **64 MiB**.
///
/// 7TV 2x WebPs run ~10–40 KiB, so this holds on the order of 2,000–6,000
/// distinct emotes — far more than any real conversation history surfaces, and
/// the picker keeps a genuinely useful offline set. It is also bounded in the
/// adversarial direction: the relay caps a single emote image at 1 MiB and so do
/// we, so even all-hostile-maximum entries can never exceed the budget.
pub const DEFAULT_BUDGET_BYTES: i64 = 64 * 1024 * 1024;

/// Per-image ceiling, mirroring the relay's own cap. Enforced here too because
/// the relay is not trusted with how much of this device's disk it may fill.
pub const MAX_EMOTE_BYTES: usize = 1024 * 1024;

/// Settings key holding the budget override (bytes, decimal).
pub const BUDGET_SETTING: &str = "emote_cache_budget_bytes";

/// Settings key holding the random per-vault salt that blinds blob filenames.
const BLOB_SALT_SETTING: &str = "emote_blob_salt";

/// The on-disk name for an emote's blob — **not** its id.
///
/// A 7TV id is a *public* identifier for a specific emote, so naming files by
/// id would let anyone who can list `dataDir/emotes` read off the whole set of
/// emotes this device has been sent, defeating the point of encrypting the
/// bytes. Files are named `SHA-256(salt || id)` instead, under a random
/// per-vault salt held in the SQLCipher-protected settings table: opaque
/// without the DB key, and anyone holding that key can read `emote_cache`
/// directly anyway.
pub fn blob_name(store: &Store, id: &str) -> Result<String, String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let b64 = base64::engine::general_purpose::STANDARD;

    let salt = match store.get_setting(BLOB_SALT_SETTING) {
        Ok(Some(s)) => b64.decode(s).map_err(|_| "emote blob salt corrupt".to_string())?,
        Ok(None) => {
            let mut fresh = [0u8; 32];
            rand::RngCore::fill_bytes(&mut rand::rng(), &mut fresh);
            store
                .set_setting(BLOB_SALT_SETTING, &b64.encode(fresh))
                .map_err(|e| format!("emote blob salt write failed: {e}"))?;
            fresh.to_vec()
        }
        Err(e) => return Err(format!("emote blob salt read failed: {e}")),
    };

    let mut h = Sha256::new();
    h.update(&salt);
    h.update(id.as_bytes());
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 7TV ids are 26-char Crockford ULIDs (no I, L, O, U). They become filenames
/// and URL path segments, so the charset is checked before either.
pub fn valid_emote_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U')))
}

/// Shortcode names render as `:name:`, and the same pattern gates the registry
/// web-side — keep the two in agreement.
pub fn valid_emote_name(name: &str) -> bool {
    let n = name.len();
    (2..=40).contains(&n) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The configured budget, or the default. A non-numeric or non-positive value
/// is ignored rather than disabling the bound.
pub fn budget_bytes(store: &Store) -> i64 {
    store
        .get_setting(BUDGET_SETTING)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_BUDGET_BYTES)
}

/// Persist an emote's image bytes. Encrypts under a fresh per-file key, writes
/// the ciphertext, records the row, then evicts LRU entries until the cache is
/// back inside `budget`.
///
/// Callers pass only emotes **encountered in content** — search results are
/// browsing, not content, and caching them would let a picker session fill the
/// budget with emotes nobody ever sent.
pub fn cache_emote(
    store: &Store,
    blobs: &BlobStore,
    meta: &EmoteMeta,
    image: &[u8],
    now: i64,
) -> Result<(), String> {
    if !valid_emote_id(&meta.id) {
        return Err("invalid emote id".into());
    }
    if !valid_emote_name(&meta.name) {
        return Err("invalid emote name".into());
    }
    if image.is_empty() {
        return Err("empty emote image".into());
    }
    if image.len() > MAX_EMOTE_BYTES {
        return Err("emote image too large".into());
    }

    let name = blob_name(store, &meta.id)?;
    let enc = encrypt_file(image)?;
    let path = blobs
        .write(&name, &enc.ciphertext)
        .map_err(|e| format!("emote blob write failed: {e}"))?;
    if let Err(e) = store.upsert_emote(
        meta,
        &enc.key,
        &enc.iv,
        &path.to_string_lossy(),
        enc.ciphertext.len() as i64,
        now,
    ) {
        // Bytes with no row pointing at them would never be evicted.
        let _ = blobs.remove(&name);
        return Err(format!("emote metadata write failed: {e}"));
    }

    enforce_budget(store, blobs, budget_bytes(store));
    Ok(())
}

/// Read an emote's image back out of the cache, touching its LRU stamp on a hit.
/// `None` covers every "not cached" case — unknown, evicted, file gone, or bytes
/// that no longer decrypt — so the caller simply re-fetches.
pub fn cached_image(store: &Store, blobs: &BlobStore, id: &str, now: i64) -> Option<Vec<u8>> {
    let row = store.emote_row(id).ok()??;
    if row.state != "present" {
        return None;
    }
    let key: [u8; 32] = row.file_key.as_slice().try_into().ok()?;
    let iv: [u8; 12] = row.iv.as_slice().try_into().ok()?;
    let name = blob_name(store, id).ok()?;

    let ciphertext = match blobs.read(&name) {
        Ok(bytes) => bytes,
        Err(e) => {
            // The row claims present but the file is gone; correct it so the
            // state (and the byte accounting) stays honest, then re-fetch.
            log::warn!("emote {id}: cached blob unreadable ({e}); re-fetching");
            evict(store, blobs, id);
            return None;
        }
    };
    match decrypt_file(&ciphertext, &key, &iv) {
        Ok(image) => {
            // Touch *after* a successful read, so a broken entry never floats to
            // the top of the LRU by being asked for repeatedly.
            let _ = store.touch_emote(id, now);
            Some(image)
        }
        Err(e) => {
            log::warn!("emote {id}: cached blob did not decrypt ({e}); re-fetching");
            evict(store, blobs, id);
            None
        }
    }
}

/// Evict a single emote: file removed, row kept as `evicted` with zero bytes.
pub fn evict(store: &Store, blobs: &BlobStore, id: &str) {
    match blob_name(store, id) {
        Ok(name) => {
            if let Err(e) = blobs.remove(&name) {
                log::warn!("emote {id}: blob remove failed: {e}");
            }
        }
        Err(e) => log::warn!("emote {id}: blob name unavailable: {e}"),
    }
    if let Err(e) = store.set_emote_evicted(id) {
        log::warn!("emote {id}: eviction bookkeeping failed: {e}");
    }
}

/// Evict least-recently-used emotes until the cache fits inside `budget`.
/// Returns how many were evicted. Best-effort: a failure to reclaim one entry
/// must not fail the caching of another.
pub fn enforce_budget(store: &Store, blobs: &BlobStore, budget: i64) -> usize {
    let victims = match store.emote_lru_victims(budget) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("emote cache: could not compute eviction set: {e}");
            return 0;
        }
    };
    for id in &victims {
        evict(store, blobs, id);
    }
    victims.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::CachedEmote;

    /// A store + emote blob store on a temp dir, as the vault holds them.
    fn vault_like() -> (tempfile::TempDir, Store, BlobStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[11u8; 32]).unwrap();
        let blobs = BlobStore::new(dir.path().join("emotes"));
        (dir, store, blobs)
    }

    /// A valid 26-char Crockford ULID ending in `tag`.
    fn id(tag: &str) -> String {
        let mut s = "01H8XYZABCDEFGHJKMNPQRSTVW".to_string();
        s.truncate(26 - tag.len());
        s.push_str(tag);
        assert!(valid_emote_id(&s), "test id {s} must be valid");
        s
    }

    fn meta(id: &str, name: &str) -> EmoteMeta {
        EmoteMeta {
            id: id.to_string(),
            name: name.to_string(),
            mime: Some("image/webp".into()),
            width: Some(64),
            height: Some(64),
            animated: false,
        }
    }

    fn names(list: &[CachedEmote]) -> Vec<&str> {
        list.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn ids_and_names_are_charset_checked() {
        assert!(valid_emote_id("01H8XYZABCDEFGHJKMNPQRSTVW"));
        assert!(!valid_emote_id("01H8XYZABCDEFGHJKMNPQRSTV")); // 25 chars
        assert!(!valid_emote_id("01h8xyzabcdefghjkmnpqrstvw")); // lowercase
        assert!(!valid_emote_id("01H8XYZABCDEFGHIKMNPQRSTVW")); // 'I' not in Crockford
        assert!(!valid_emote_id("../../../etc/passwd"));
        assert!(valid_emote_name("pepeLaugh"));
        assert!(valid_emote_name("a_1"));
        assert!(!valid_emote_name("a"));
        assert!(!valid_emote_name("has space"));
        assert!(!valid_emote_name(&"x".repeat(41)));
    }

    #[test]
    fn caches_the_image_and_serves_it_back_without_the_relay() {
        let (_d, store, blobs) = vault_like();
        let image = b"RIFF....WEBPfake-emote-bytes".to_vec();
        let a = id("AAA");

        cache_emote(&store, &blobs, &meta(&a, "pepeLaugh"), &image, 1_000).unwrap();

        // Served from disk, byte-identical, with no network involved.
        assert_eq!(cached_image(&store, &blobs, &a, 1_001), Some(image.clone()));

        // What sits on the filesystem is ciphertext, not the image — the set of
        // emotes you hold is a fingerprint of what you've been sent.
        let on_disk = blobs.read(&blob_name(&store, &a).unwrap()).unwrap();
        assert_ne!(on_disk, image);
        assert!(on_disk.len() > image.len()); // + GCM tag

        // Row describes it well enough for the offline picker.
        assert_eq!(
            names(&store.list_cached_emotes().unwrap()),
            vec!["pepeLaugh"]
        );
        let row = store.emote_row(&a).unwrap().unwrap();
        assert_eq!(row.state, "present");
        assert_eq!(row.bytes, on_disk.len() as i64);
        assert_eq!(row.mime.as_deref(), Some("image/webp"));
    }

    #[test]
    fn an_unknown_emote_is_a_miss() {
        let (_d, store, blobs) = vault_like();
        assert!(cached_image(&store, &blobs, &id("ZZZ"), 1).is_none());
        assert!(store.list_cached_emotes().unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_ids_names_and_oversize_images_without_leaving_a_row() {
        let (_d, store, blobs) = vault_like();
        assert!(cache_emote(&store, &blobs, &meta("../escape", "ok"), b"x", 1).is_err());
        assert!(cache_emote(&store, &blobs, &meta(&id("BBB"), "no good"), b"x", 1).is_err());
        assert!(cache_emote(&store, &blobs, &meta(&id("CCC"), "ok"), b"", 1).is_err());
        // A relay that ignores its own 1 MiB cap does not get to fill our disk.
        let huge = vec![7u8; MAX_EMOTE_BYTES + 1];
        assert!(cache_emote(&store, &blobs, &meta(&id("DDD"), "huge"), &huge, 1).is_err());
        assert!(store.list_cached_emotes().unwrap().is_empty());
        assert_eq!(store.emote_cache_bytes().unwrap(), 0);
    }

    #[test]
    fn lru_evicts_the_least_recently_used_first() {
        let (_d, store, blobs) = vault_like();
        let image = vec![3u8; 1000];
        let (a, b, c) = (id("AAA"), id("BBB"), id("CCC"));
        // Budget fits two ~1016-byte entries, not three.
        store.set_setting(BUDGET_SETTING, "2100").unwrap();

        cache_emote(&store, &blobs, &meta(&a, "first"), &image, 1_000).unwrap();
        cache_emote(&store, &blobs, &meta(&b, "second"), &image, 2_000).unwrap();
        assert_eq!(names(&store.list_cached_emotes().unwrap()), vec!["second", "first"]);

        cache_emote(&store, &blobs, &meta(&c, "third"), &image, 3_000).unwrap();

        // `first` was the least recently used, so it is the one that went.
        assert_eq!(names(&store.list_cached_emotes().unwrap()), vec!["third", "second"]);
        assert!(cached_image(&store, &blobs, &a, 4_000).is_none());
        assert_eq!(store.emote_row(&a).unwrap().unwrap().state, "evicted");
        // Its bytes are gone from disk too, not just from the accounting.
        assert!(!blobs.exists(&blob_name(&store, &a).unwrap()));
        assert!(cached_image(&store, &blobs, &b, 4_001).is_some());
        assert!(cached_image(&store, &blobs, &c, 4_002).is_some());
    }

    #[test]
    fn a_touched_entry_survives_eviction() {
        let (_d, store, blobs) = vault_like();
        let image = vec![5u8; 1000];
        let (a, b, c) = (id("AAA"), id("BBB"), id("CCC"));
        store.set_setting(BUDGET_SETTING, "2100").unwrap();

        cache_emote(&store, &blobs, &meta(&a, "old"), &image, 1_000).unwrap();
        cache_emote(&store, &blobs, &meta(&b, "newer"), &image, 2_000).unwrap();

        // Reading `old` promotes it past `newer` — this is what makes the LRU
        // real rather than an insertion-order queue.
        assert!(cached_image(&store, &blobs, &a, 2_500).is_some());

        cache_emote(&store, &blobs, &meta(&c, "newest"), &image, 3_000).unwrap();

        assert_eq!(names(&store.list_cached_emotes().unwrap()), vec!["newest", "old"]);
        assert!(cached_image(&store, &blobs, &a, 3_100).is_some());
        assert!(cached_image(&store, &blobs, &b, 3_101).is_none());
    }

    #[test]
    fn an_evicted_entry_re_caches_cleanly() {
        let (_d, store, blobs) = vault_like();
        let image = vec![9u8; 512];
        let a = id("AAA");

        cache_emote(&store, &blobs, &meta(&a, "revive"), &image, 1_000).unwrap();
        evict(&store, &blobs, &a);
        assert!(cached_image(&store, &blobs, &a, 1_100).is_none());
        assert_eq!(store.emote_cache_bytes().unwrap(), 0);

        // Re-fetch → re-cache. This is exactly the case INSERT OR IGNORE would
        // leave broken: the row stuck `evicted` with a NULL path forever.
        cache_emote(&store, &blobs, &meta(&a, "revive"), &image, 2_000).unwrap();
        let row = store.emote_row(&a).unwrap().unwrap();
        assert_eq!(row.state, "present");
        assert_eq!(row.last_used_at, 2_000);
        assert!(row.bytes > 0);
        assert_eq!(cached_image(&store, &blobs, &a, 2_100), Some(image));
        assert_eq!(store.emote_cache_bytes().unwrap(), row.bytes);
    }

    #[test]
    fn a_present_row_whose_file_vanished_self_corrects() {
        let (_d, store, blobs) = vault_like();
        let image = vec![1u8; 256];
        let a = id("AAA");
        cache_emote(&store, &blobs, &meta(&a, "gone"), &image, 1_000).unwrap();

        // The file disappears underneath us (external deletion, disk repair).
        blobs.remove(&blob_name(&store, &a).unwrap()).unwrap();

        assert!(cached_image(&store, &blobs, &a, 1_100).is_none());
        // The row must not keep claiming `present`, or the byte budget is
        // enforced against bytes that are not actually there.
        assert_eq!(store.emote_row(&a).unwrap().unwrap().state, "evicted");
        assert_eq!(store.emote_cache_bytes().unwrap(), 0);
        assert!(store.list_cached_emotes().unwrap().is_empty());

        // And it re-caches like any other miss.
        cache_emote(&store, &blobs, &meta(&a, "gone"), &image, 1_200).unwrap();
        assert_eq!(cached_image(&store, &blobs, &a, 1_300), Some(image));
    }

    #[test]
    fn corrupt_bytes_are_treated_as_a_miss_not_an_error() {
        let (_d, store, blobs) = vault_like();
        let a = id("AAA");
        cache_emote(&store, &blobs, &meta(&a, "tamper"), &[4u8; 128], 1_000).unwrap();

        let file = blob_name(&store, &a).unwrap();
        let mut bad = blobs.read(&file).unwrap();
        bad[0] ^= 0xff;
        blobs.write(&file, &bad).unwrap();

        assert!(cached_image(&store, &blobs, &a, 1_100).is_none());
        assert_eq!(store.emote_row(&a).unwrap().unwrap().state, "evicted");
    }

    #[test]
    fn the_byte_budget_is_actually_enforced() {
        let (_d, store, blobs) = vault_like();
        let image = vec![2u8; 4_000];
        let budget = 20_000i64;
        store.set_setting(BUDGET_SETTING, &budget.to_string()).unwrap();

        // Way more emotes than fit — a hostile sender's worth.
        for n in 0..40u32 {
            let e = format!("{n:03}");
            cache_emote(&store, &blobs, &meta(&id(&e), &format!("e{n}")), &image, 1_000 + n as i64)
                .unwrap();
            assert!(
                store.emote_cache_bytes().unwrap() <= budget,
                "cache exceeded the budget after {n} inserts"
            );
        }

        let held = store.list_cached_emotes().unwrap();
        assert!(!held.is_empty());
        // Only the most recent survive, and the on-disk files match the rows.
        assert_eq!(names(&held), vec!["e39", "e38", "e37", "e36"]);
        let on_disk: i64 = held
            .iter()
            .map(|e| blobs.read(&blob_name(&store, &e.id).unwrap()).unwrap().len() as i64)
            .sum();
        assert_eq!(on_disk, store.emote_cache_bytes().unwrap());
    }

    /// The bytes are encrypted, but a filename is metadata too: 7TV ids are
    /// public, so naming files by id would let a directory listing read off
    /// every emote this device has been sent.
    #[test]
    fn blob_filenames_do_not_leak_which_emotes_are_held() {
        let (dir, store, blobs) = vault_like();
        let a = id("AAA");
        cache_emote(&store, &blobs, &meta(&a, "secretive"), &[6u8; 64], 1_000).unwrap();

        let listing: Vec<String> = walk(&dir.path().join("emotes"));
        assert_eq!(listing.len(), 1);
        assert!(!listing[0].contains(&a), "filename must not be the emote id");
        assert!(!listing[0].contains("secretive"));
        assert_eq!(listing[0], blob_name(&store, &a).unwrap());

        // The salt is per-vault, so the same emote lands on a different name in
        // a different vault — two devices' directories are not comparable.
        let (_d2, store2, blobs2) = vault_like();
        cache_emote(&store2, &blobs2, &meta(&a, "secretive"), &[6u8; 64], 1_000).unwrap();
        assert_ne!(blob_name(&store, &a).unwrap(), blob_name(&store2, &a).unwrap());

        // And it is stable across calls, or nothing would ever be readable.
        assert_eq!(blob_name(&store, &a).unwrap(), blob_name(&store, &a).unwrap());
    }

    /// File names of every regular file under `root`.
    fn walk(root: &std::path::Path) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(root) else {
            return out;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
        out
    }

    #[test]
    fn the_budget_is_configurable_and_falls_back_to_the_default() {
        let (_d, store, _blobs) = vault_like();
        assert_eq!(budget_bytes(&store), DEFAULT_BUDGET_BYTES);
        store.set_setting(BUDGET_SETTING, "1048576").unwrap();
        assert_eq!(budget_bytes(&store), 1024 * 1024);
        // Garbage or "unlimited" must not silently remove the bound.
        for bad in ["", "lots", "0", "-5"] {
            store.set_setting(BUDGET_SETTING, bad).unwrap();
            assert_eq!(budget_bytes(&store), DEFAULT_BUDGET_BYTES, "value {bad:?}");
        }
    }
}
