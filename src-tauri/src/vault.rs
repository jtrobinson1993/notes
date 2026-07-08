//! Vault lifecycle: locked ↔ unlocked (roadmap D3/D4 layer A).
//!
//! Skeleton scope: the **password (Argon2id) path** — the portable fallback
//! from D3. The primary path (random SQLCipher key in the OS keychain,
//! biometric-gated, D13) replaces this as the default in a later phase; the
//! password then wraps MK for escrow (D15) rather than deriving the DB key.
//! Params mirror the shipped web client (`password.ts`): m≈19 MiB, t=2, p=1.

use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use std::path::PathBuf;
use zeroize::Zeroizing;

use crate::store::{Store, StoreError};

const KDF_M_KIB: u32 = 19 * 1024;
const KDF_T: u32 = 2;
const KDF_P: u32 = 1;
const SALT_LEN: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("wrong password")]
    WrongPassword,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("kdf error")]
    Kdf,
}

#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    Uninitialized,
    Locked,
    Unlocked,
}

pub struct Vault {
    data_dir: PathBuf,
    store: Option<Store>,
}

impl Vault {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            store: None,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.data_dir.join("vault.db")
    }

    fn salt_path(&self) -> PathBuf {
        self.data_dir.join("vault.salt")
    }

    pub fn status(&self) -> VaultStatus {
        if self.store.is_some() {
            VaultStatus::Unlocked
        } else if self.db_path().exists() {
            VaultStatus::Locked
        } else {
            VaultStatus::Uninitialized
        }
    }

    /// Unlock (or first-run create) via the password path.
    pub fn unlock_password(&mut self, password: &str) -> Result<(), VaultError> {
        if self.store.is_some() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.data_dir)?;
        let salt = self.load_or_create_salt()?;
        let key = derive_key(password, &salt)?;
        let store = Store::open(&self.db_path(), &key).map_err(|e| match e {
            StoreError::BadKey => VaultError::WrongPassword,
            e => VaultError::Store(e),
        })?;
        self.store = Some(store);
        Ok(())
    }

    /// Drop the open store (and with it the key material held by SQLCipher).
    pub fn lock(&mut self) {
        self.store = None;
    }

    pub fn store(&self) -> Result<&Store, VaultError> {
        self.store.as_ref().ok_or(VaultError::Locked)
    }

    fn load_or_create_salt(&self) -> Result<Vec<u8>, VaultError> {
        let path = self.salt_path();
        if path.exists() {
            Ok(std::fs::read(&path)?)
        } else {
            let mut salt = vec![0u8; SALT_LEN];
            rand::rng().fill_bytes(&mut salt);
            std::fs::write(&path, &salt)?;
            Ok(salt)
        }
    }
}

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let params =
        Params::new(KDF_M_KIB, KDF_T, KDF_P, Some(32)).map_err(|_| VaultError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| VaultError::Kdf)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_unlock_lock_reunlock() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().to_path_buf());
        assert_eq!(vault.status(), VaultStatus::Uninitialized);

        vault.unlock_password("correct horse battery staple").unwrap();
        assert_eq!(vault.status(), VaultStatus::Unlocked);
        vault.store().unwrap().set_setting("a", "1").unwrap();

        vault.lock();
        assert_eq!(vault.status(), VaultStatus::Locked);
        assert!(vault.store().is_err());

        vault.unlock_password("correct horse battery staple").unwrap();
        assert_eq!(
            vault.store().unwrap().get_setting("a").unwrap().as_deref(),
            Some("1")
        );
    }

    #[test]
    fn wrong_password_rejected_after_init() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::new(dir.path().to_path_buf());
        vault.unlock_password("right password here!").unwrap();
        vault.lock();
        assert!(matches!(
            vault.unlock_password("wrong password here!"),
            Err(VaultError::WrongPassword)
        ));
    }
}
