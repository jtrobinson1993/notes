//! Attachment blob store (spec/local-store.md, D6).
//!
//! Files hold the attachment **ciphertext exactly as it travels** — encrypted
//! under the per-file random key that rides inside the E2E message/note. That
//! key lives in the `attachments` DB row (SQLCipher-protected), so the
//! filesystem never sees plaintext and this layer stays a dumb byte store:
//! two-level sharded paths, atomic writes (tmp + rename), delete-on-evict.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("blob not present")]
    Missing,
    #[error("invalid blob id")]
    BadId,
}

pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Ids come from message payloads — constrain to a safe charset before
    /// they touch the filesystem.
    fn path_for(&self, id: &str) -> Result<PathBuf, BlobError> {
        if id.len() < 3 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(BlobError::BadId);
        }
        Ok(self.root.join(&id[0..2]).join(id))
    }

    pub fn write(&self, id: &str, ciphertext: &[u8]) -> Result<PathBuf, BlobError> {
        let path = self.path_for(id)?;
        fs::create_dir_all(path.parent().expect("sharded path has a parent"))?;
        let tmp = path.with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(ciphertext)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(path)
    }

    pub fn read(&self, id: &str) -> Result<Vec<u8>, BlobError> {
        let path = self.path_for(id)?;
        if !path.exists() {
            return Err(BlobError::Missing);
        }
        Ok(fs::read(path)?)
    }

    pub fn remove(&self, id: &str) -> Result<(), BlobError> {
        let path = self.path_for(id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn exists(&self, id: &str) -> bool {
        self.path_for(id).map(|p| p.exists()).unwrap_or(false)
    }

    #[allow(dead_code)] // storage screen (D6 retention UI) consumes this later
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, BlobStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = BlobStore::new(dir.path().join("blobs"));
        (dir, s)
    }

    #[test]
    fn write_read_remove_roundtrip() {
        let (_d, s) = store();
        let data = vec![9u8; 4096];
        s.write("abc123", &data).unwrap();
        assert!(s.exists("abc123"));
        assert_eq!(s.read("abc123").unwrap(), data);
        s.remove("abc123").unwrap();
        assert!(!s.exists("abc123"));
        assert!(matches!(s.read("abc123"), Err(BlobError::Missing)));
        // Removing again is a no-op, not an error.
        s.remove("abc123").unwrap();
    }

    #[test]
    fn overwrite_is_atomic_and_idempotent() {
        let (_d, s) = store();
        s.write("abc123", b"first").unwrap();
        s.write("abc123", b"second").unwrap();
        assert_eq!(s.read("abc123").unwrap(), b"second");
        // No stray tmp file left behind.
        let shard = s.root.join("ab");
        let entries: Vec<_> = std::fs::read_dir(shard).unwrap().collect();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let (_d, s) = store();
        assert!(matches!(s.write("../evil", b"x"), Err(BlobError::BadId)));
        assert!(matches!(s.write("a/b", b"x"), Err(BlobError::BadId)));
        assert!(matches!(s.write("ab", b"x"), Err(BlobError::BadId)));
    }
}
