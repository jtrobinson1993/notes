//! Vault lifecycle: locked ↔ unlocked (roadmap D3/D4 layer A, D13 hierarchy).
//!
//! At rest: the **SQLCipher key** and the **vault key** are per-device random
//! keys in the OS keychain; **MK** rests only wrapped — under the vault key
//! (primary unlock), Argon2id(password) (portable fallback), and the recovery
//! code (break-glass) — in a plaintext-metadata sidecar (`vault.meta.json`).
//! Biometric gating of the keychain items (Secure Enclave access control) is
//! per-platform hardening layered on later; storage location already matches
//! the D13 tree. KDF params mirror the web client (m≈19 MiB, t=2, p=1).

use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use std::path::PathBuf;
use zeroize::Zeroizing;

use crate::keys::{
    self, KeyError, Secret32, WrappedKey, INFO_MK_WRAP_PASSWORD, INFO_MK_WRAP_RECOVERY,
    INFO_MK_WRAP_VAULT,
};
use crate::store::{Store, StoreError};

const KDF_M_KIB: u32 = 19 * 1024;
const KDF_T: u32 = 2;
const KDF_P: u32 = 1;
const KEYRING_SERVICE: &str = "dev.accord.app";
const KEYRING_SQLCIPHER: &str = "sqlcipher-key";
const KEYRING_VAULT: &str = "vault-key";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("vault already initialized")]
    AlreadyInitialized,
    #[error("vault not initialized")]
    NotInitialized,
    #[error("wrong password")]
    WrongPassword,
    #[error("wrong recovery code")]
    WrongRecoveryCode,
    #[error("OS keychain unavailable: {0}")]
    Keychain(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("metadata corrupt: {0}")]
    Meta(#[from] serde_json::Error),
    #[error("crypto error: {0}")]
    Key(#[from] KeyError),
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

/// Plaintext sidecar: wrapped blobs + KDF params. Holds no secrets — every
/// field is either public parameters or MK wrapped under a strong secret.
#[derive(serde::Serialize, serde::Deserialize)]
struct VaultMeta {
    version: u32,
    kdf_salt: [u8; 16],
    kdf_m_kib: u32,
    kdf_t: u32,
    kdf_p: u32,
    wrapped_mk_vault: WrappedKey,
    wrapped_mk_password: WrappedKey,
    wrapped_mk_recovery: WrappedKey,
}

/// Minimal keychain abstraction: the OS secure store in production, an
/// in-memory map in tests (keyring's own mock doesn't share state across
/// `Entry` instances).
pub trait Keychain: Send {
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn get(&self, name: &str) -> Result<String, String>;
}

struct OsKeychain;

impl Keychain for OsKeychain {
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, name)
            .and_then(|e| e.set_password(value))
            .map_err(|e| e.to_string())
    }
    fn get(&self, name: &str) -> Result<String, String> {
        keyring::Entry::new(KEYRING_SERVICE, name)
            .and_then(|e| e.get_password())
            .map_err(|e| e.to_string())
    }
}

pub struct Vault {
    data_dir: PathBuf,
    keychain: Box<dyn Keychain>,
    store: Option<Store>,
    mk: Option<Secret32>,
}

impl Vault {
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_keychain(data_dir, Box::new(OsKeychain))
    }

    pub fn with_keychain(data_dir: PathBuf, keychain: Box<dyn Keychain>) -> Self {
        Self {
            data_dir,
            keychain,
            store: None,
            mk: None,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.data_dir.join("vault.db")
    }

    /// Keychain entries are namespaced by data dir, so distinct profiles (and
    /// parallel tests on the mock store) never collide.
    fn keychain_user(&self, name: &str) -> String {
        use sha2::{Digest, Sha256};
        let h = Sha256::digest(self.data_dir.to_string_lossy().as_bytes());
        format!("{name}@{:02x}{:02x}{:02x}{:02x}", h[0], h[1], h[2], h[3])
    }

    fn meta_path(&self) -> PathBuf {
        self.data_dir.join("vault.meta.json")
    }

    pub fn status(&self) -> VaultStatus {
        if self.store.is_some() {
            VaultStatus::Unlocked
        } else if self.meta_path().exists() {
            VaultStatus::Locked
        } else {
            VaultStatus::Uninitialized
        }
    }

    /// First-run initialization. Generates the whole D13 local key set and
    /// returns the **recovery code** — shown to the user exactly once.
    pub fn create(&mut self, password: &str) -> Result<String, VaultError> {
        if self.meta_path().exists() {
            return Err(VaultError::AlreadyInitialized);
        }
        std::fs::create_dir_all(&self.data_dir)?;

        let mk = keys::random_key();
        let sqlcipher_key = keys::random_key();
        let vault_key = keys::random_key();
        self.keychain_set(&self.keychain_user(KEYRING_SQLCIPHER), &sqlcipher_key)?;
        self.keychain_set(&self.keychain_user(KEYRING_VAULT), &vault_key)?;

        let mut kdf_salt = [0u8; 16];
        rand::rng().fill_bytes(&mut kdf_salt);
        let password_secret = derive_password_secret(password, &kdf_salt)?;

        let recovery_code = keys::generate_recovery_code();
        let recovery_norm = keys::normalize_recovery_code(&recovery_code);

        let meta = VaultMeta {
            version: 1,
            kdf_salt,
            kdf_m_kib: KDF_M_KIB,
            kdf_t: KDF_T,
            kdf_p: KDF_P,
            wrapped_mk_vault: keys::wrap(vault_key.as_ref(), INFO_MK_WRAP_VAULT, &mk)?,
            wrapped_mk_password: keys::wrap(
                password_secret.as_ref(),
                INFO_MK_WRAP_PASSWORD,
                &mk,
            )?,
            wrapped_mk_recovery: keys::wrap(
                recovery_norm.as_bytes(),
                INFO_MK_WRAP_RECOVERY,
                &mk,
            )?,
        };
        std::fs::write(self.meta_path(), serde_json::to_vec_pretty(&meta)?)?;

        self.store = Some(Store::open(&self.db_path(), &sqlcipher_key)?);
        self.mk = Some(mk);
        Ok(recovery_code)
    }

    /// Primary unlock (D3): keychain only — no user secret. Biometric gating
    /// wraps this call at the platform layer later.
    pub fn unlock_keychain(&mut self) -> Result<(), VaultError> {
        if self.store.is_some() {
            return Ok(());
        }
        let meta = self.load_meta()?;
        let vault_key = self.keychain_get(&self.keychain_user(KEYRING_VAULT))?;
        let mk = keys::unwrap(vault_key.as_ref(), INFO_MK_WRAP_VAULT, &meta.wrapped_mk_vault)
            .map_err(|_| VaultError::Keychain("vault key does not match metadata".into()))?;
        self.open_with(mk)
    }

    /// Portable fallback (D3): password unwraps MK; SQLCipher key still comes
    /// from this device's keychain (the DB never travels by file copy — new
    /// devices arrive via pairing or backup restore).
    pub fn unlock_password(&mut self, password: &str) -> Result<(), VaultError> {
        if self.store.is_some() {
            return Ok(());
        }
        let meta = self.load_meta()?;
        let secret = derive_password_secret_with(
            password,
            &meta.kdf_salt,
            meta.kdf_m_kib,
            meta.kdf_t,
            meta.kdf_p,
        )?;
        let mk = keys::unwrap(secret.as_ref(), INFO_MK_WRAP_PASSWORD, &meta.wrapped_mk_password)
            .map_err(|_| VaultError::WrongPassword)?;
        self.open_with(mk)
    }

    /// Break-glass unlock via the recovery code.
    pub fn unlock_recovery(&mut self, code: &str) -> Result<(), VaultError> {
        if self.store.is_some() {
            return Ok(());
        }
        let meta = self.load_meta()?;
        let norm = keys::normalize_recovery_code(code);
        let mk = keys::unwrap(norm.as_bytes(), INFO_MK_WRAP_RECOVERY, &meta.wrapped_mk_recovery)
            .map_err(|_| VaultError::WrongRecoveryCode)?;
        self.open_with(mk)
    }

    fn open_with(&mut self, mk: Secret32) -> Result<(), VaultError> {
        let sqlcipher_key = self.keychain_get(&self.keychain_user(KEYRING_SQLCIPHER))?;
        self.store = Some(Store::open(&self.db_path(), &sqlcipher_key)?);
        self.mk = Some(mk);
        Ok(())
    }

    /// Drop the open store and zeroize MK.
    pub fn lock(&mut self) {
        self.store = None;
        self.mk = None;
    }

    pub fn store(&self) -> Result<&Store, VaultError> {
        self.store.as_ref().ok_or(VaultError::Locked)
    }

    #[allow(dead_code)] // consumed by identity derivation (D4b) next
    pub fn mk(&self) -> Result<&Secret32, VaultError> {
        self.mk.as_ref().ok_or(VaultError::Locked)
    }

    fn load_meta(&self) -> Result<VaultMeta, VaultError> {
        if !self.meta_path().exists() {
            return Err(VaultError::NotInitialized);
        }
        Ok(serde_json::from_slice(&std::fs::read(self.meta_path())?)?)
    }
}

fn derive_password_secret(password: &str, salt: &[u8]) -> Result<Secret32, VaultError> {
    derive_password_secret_with(password, salt, KDF_M_KIB, KDF_T, KDF_P)
}

fn derive_password_secret_with(
    password: &str,
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Secret32, VaultError> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|_| VaultError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| VaultError::Kdf)?;
    Ok(out)
}

impl Vault {
    fn keychain_set(&self, name: &str, key: &Secret32) -> Result<(), VaultError> {
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        self.keychain.set(name, &hex).map_err(VaultError::Keychain)
    }

    fn keychain_get(&self, name: &str) -> Result<Secret32, VaultError> {
        let hex = self.keychain.get(name).map_err(VaultError::Keychain)?;
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| VaultError::Keychain("corrupt keychain entry".into()))?;
        let mut out = Zeroizing::new([0u8; 32]);
        if bytes.len() != 32 {
            return Err(VaultError::Keychain("corrupt keychain entry".into()));
        }
        out.copy_from_slice(&bytes);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct MemKeychain(Mutex<HashMap<String, String>>);

    impl Keychain for MemKeychain {
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn get(&self, name: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(name)
                .cloned()
                .ok_or_else(|| "no matching entry".into())
        }
    }

    fn new_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::with_keychain(
            dir.path().to_path_buf(),
            Box::new(MemKeychain(Mutex::new(HashMap::new()))),
        );
        (dir, vault)
    }

    #[test]
    fn create_then_all_three_unlock_paths() {
        let (_dir, mut vault) = new_vault();
        assert_eq!(vault.status(), VaultStatus::Uninitialized);

        let recovery = vault.create("a long enough password").unwrap();
        assert_eq!(vault.status(), VaultStatus::Unlocked);
        vault.store().unwrap().set_setting("k", "v").unwrap();

        // Keychain (primary) path.
        vault.lock();
        assert_eq!(vault.status(), VaultStatus::Locked);
        vault.unlock_keychain().unwrap();
        assert_eq!(
            vault.store().unwrap().get_setting("k").unwrap().as_deref(),
            Some("v")
        );

        // Password (portable) path.
        vault.lock();
        vault.unlock_password("a long enough password").unwrap();

        // Recovery (break-glass) path — case/separator-insensitive.
        vault.lock();
        vault
            .unlock_recovery(&recovery.to_lowercase().replace('-', " "))
            .unwrap();
    }

    #[test]
    fn wrong_secrets_rejected() {
        let (_dir, mut vault) = new_vault();
        vault.create("correct password!").unwrap();
        vault.lock();
        assert!(matches!(
            vault.unlock_password("incorrect password"),
            Err(VaultError::WrongPassword)
        ));
        assert!(matches!(
            vault.unlock_recovery("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH"),
            Err(VaultError::WrongRecoveryCode)
        ));
        assert!(matches!(
            vault.create("another password"),
            Err(VaultError::AlreadyInitialized)
        ));
    }

    #[test]
    fn mk_is_available_unlocked_and_cleared_on_lock() {
        let (_dir, mut vault) = new_vault();
        vault.create("a long enough password").unwrap();
        assert!(vault.mk().is_ok());
        vault.lock();
        assert!(vault.mk().is_err());
    }
}
