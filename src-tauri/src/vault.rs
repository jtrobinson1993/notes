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
const KEYRING_DEVICE: &str = "device-key";

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
    /// D15: auth-key hashes for the relay escrow (public data — hashes of
    /// domain-separated keys the relay compares against on fetch).
    #[serde(default)]
    escrow: Option<EscrowMeta>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct EscrowMeta {
    password_auth_hash: String,
    recovery_auth_hash: String,
}

/// What the client uploads to the relay for escrow (D15).
pub struct EscrowUploadBundle {
    pub payload: String,
    pub kdf_params: String,
    pub password_auth_hash: String,
    pub recovery_auth_hash: String,
}

/// The relay escrow payload — mirror of what `escrow_bundle()` serializes.
#[derive(serde::Deserialize)]
struct EscrowPayload {
    #[serde(rename = "kdfSalt")]
    kdf_salt: [u8; 16],
    #[serde(rename = "kdfMKib")]
    kdf_m_kib: u32,
    #[serde(rename = "kdfT")]
    kdf_t: u32,
    #[serde(rename = "kdfP")]
    kdf_p: u32,
    #[serde(rename = "wrappedMkPassword")]
    wrapped_mk_password: WrappedKey,
    #[serde(rename = "wrappedMkRecovery")]
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
    blobs: crate::blobs::BlobStore,
}

impl Vault {
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_keychain(data_dir, Box::new(OsKeychain))
    }

    pub fn with_keychain(data_dir: PathBuf, keychain: Box<dyn Keychain>) -> Self {
        let blobs = crate::blobs::BlobStore::new(data_dir.join("blobs"));
        Self {
            data_dir,
            keychain,
            store: None,
            mk: None,
            blobs,
        }
    }

    /// The attachment blob store (opaque ciphertext files — usable without
    /// unlock, but every caller also needs the row from the locked store).
    pub fn blobs(&self) -> &crate::blobs::BlobStore {
        &self.blobs
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

        let pw_auth = keys::derive_auth_key(password_secret.as_ref(), keys::INFO_AUTH_PASSWORD)?;
        let rc_auth = keys::derive_auth_key(recovery_norm.as_bytes(), keys::INFO_AUTH_RECOVERY)?;
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
            escrow: Some(EscrowMeta {
                password_auth_hash: keys::sha256_b64url(pw_auth.as_ref()),
                recovery_auth_hash: keys::sha256_b64url(rc_auth.as_ref()),
            }),
        };
        std::fs::write(self.meta_path(), serde_json::to_vec_pretty(&meta)?)?;

        self.store = Some(Store::open(&self.db_path(), &sqlcipher_key)?);
        self.mk = Some(mk);
        Ok(recovery_code)
    }

    /// Cold-start restore (D15/D3a): rebuild the vault on a fresh device from
    /// a relay escrow payload + the account password. Unwraps MK from the
    /// escrow, then re-wraps it under a **new** local key set (fresh vault
    /// key + SQLCipher key in this device's keychain), producing a
    /// provisioned-but-empty vault. History arrives via device pairing/sync
    /// or a backup import — the escrow only restores identity (D8).
    pub fn restore_from_escrow(
        &mut self,
        escrow_payload: &str,
        password: &str,
    ) -> Result<(), VaultError> {
        if self.meta_path().exists() {
            return Err(VaultError::AlreadyInitialized);
        }
        let esc: EscrowPayload =
            serde_json::from_str(escrow_payload).map_err(VaultError::Meta)?;
        let secret = derive_password_secret_with(
            password,
            &esc.kdf_salt,
            esc.kdf_m_kib,
            esc.kdf_t,
            esc.kdf_p,
        )?;
        let mk = keys::unwrap(secret.as_ref(), INFO_MK_WRAP_PASSWORD, &esc.wrapped_mk_password)
            .map_err(|_| VaultError::WrongPassword)?;

        // Recovery code is not recoverable from escrow (it was random at
        // signup); a restored device keeps the escrow's recovery wrap so the
        // original code still works, and re-derives fresh local wraps.
        std::fs::create_dir_all(&self.data_dir)?;
        let sqlcipher_key = keys::random_key();
        let vault_key = keys::random_key();
        self.keychain_set(&self.keychain_user(KEYRING_SQLCIPHER), &sqlcipher_key)?;
        self.keychain_set(&self.keychain_user(KEYRING_VAULT), &vault_key)?;

        let mut kdf_salt = [0u8; 16];
        rand::rng().fill_bytes(&mut kdf_salt);
        let password_secret = derive_password_secret(password, &kdf_salt)?;
        let pw_auth = keys::derive_auth_key(password_secret.as_ref(), keys::INFO_AUTH_PASSWORD)?;

        let meta = VaultMeta {
            version: 1,
            kdf_salt,
            kdf_m_kib: KDF_M_KIB,
            kdf_t: KDF_T,
            kdf_p: KDF_P,
            wrapped_mk_vault: keys::wrap(vault_key.as_ref(), INFO_MK_WRAP_VAULT, &mk)?,
            wrapped_mk_password: keys::wrap(password_secret.as_ref(), INFO_MK_WRAP_PASSWORD, &mk)?,
            // Carry the original recovery wrap forward so the user's existing
            // recovery code still opens this device.
            wrapped_mk_recovery: esc.wrapped_mk_recovery,
            escrow: Some(EscrowMeta {
                password_auth_hash: keys::sha256_b64url(pw_auth.as_ref()),
                // Recovery auth hash is re-derivable only from the code, which
                // we don't have here; leave the escrow's value untouched by
                // not re-uploading until the user re-enters it.
                recovery_auth_hash: String::new(),
            }),
        };
        std::fs::write(self.meta_path(), serde_json::to_vec_pretty(&meta)?)?;

        self.store = Some(Store::open(&self.db_path(), &sqlcipher_key)?);
        self.mk = Some(mk);
        Ok(())
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

    /// The per-device Ed25519 identity key (D4b) — created on first use,
    /// lives in the OS keychain, never leaves the device. Deliberately
    /// usable while the vault is **locked**: it gates the relay handshake,
    /// not the data (D4 — pushes/sync survive a locked vault).
    pub fn device_signing_key(&self) -> Result<ed25519_dalek::SigningKey, VaultError> {
        let name = self.keychain_user(KEYRING_DEVICE);
        if let Ok(seed) = self.keychain_get(&name) {
            return Ok(ed25519_dalek::SigningKey::from_bytes(&seed));
        }
        let seed = keys::random_key();
        self.keychain_set(&name, &seed)?;
        Ok(ed25519_dalek::SigningKey::from_bytes(&seed))
    }

    /// The escrow bundle for the relay (D15): opaque payload (wrapped blobs
    /// + public KDF params), the **public KDF params** (served pre-auth so a
    /// cold-start device can derive its fetch key), and the auth-key hashes.
    /// Everything here is safe to hand to the relay — MK only appears wrapped
    /// under user secrets.
    pub fn escrow_bundle(&self) -> Result<EscrowUploadBundle, VaultError> {
        let meta = self.load_meta()?;
        let escrow = meta.escrow.clone().ok_or(VaultError::NotInitialized)?;
        let payload = serde_json::json!({
            "v": 1,
            "kdfSalt": meta.kdf_salt,
            "kdfMKib": meta.kdf_m_kib,
            "kdfT": meta.kdf_t,
            "kdfP": meta.kdf_p,
            "wrappedMkPassword": serde_json::to_value(&meta.wrapped_mk_password)?,
            "wrappedMkRecovery": serde_json::to_value(&meta.wrapped_mk_recovery)?,
        })
        .to_string();
        let kdf_params = serde_json::json!({
            "kdfSalt": meta.kdf_salt,
            "kdfMKib": meta.kdf_m_kib,
            "kdfT": meta.kdf_t,
            "kdfP": meta.kdf_p,
        })
        .to_string();
        Ok(EscrowUploadBundle {
            payload,
            kdf_params,
            password_auth_hash: escrow.password_auth_hash,
            recovery_auth_hash: escrow.recovery_auth_hash,
        })
    }

    /// Derive the base64 escrow **fetch auth key** from the password + the
    /// relay-served public KDF params (cold-start step 2). Pure — no vault
    /// state, runs before any vault exists. Matches the create-time
    /// derivation exactly, so the relay's stored hash compares equal.
    pub fn derive_escrow_auth_key_b64(
        password: &str,
        salt: &[u8],
        m_kib: u32,
        t: u32,
        p: u32,
    ) -> Result<String, VaultError> {
        use base64::Engine as _;
        let secret = derive_password_secret_with(password, salt, m_kib, t, p)?;
        let auth = keys::derive_auth_key(secret.as_ref(), keys::INFO_AUTH_PASSWORD)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(auth.as_ref()))
    }

    /// D6 delivery token + verifier, derived from the account's profile key.
    /// Returns `(token, verifier)`: the token goes sealed to friends; the
    /// verifier (its hash) is what the relay stores. Requires the vault unlocked.
    ///
    /// The profile key lives in the `profile.key` setting. On a greenfield
    /// account there's no migration to seed it, so we derive it from MK on first
    /// use and persist it — identical on every device with this account (a stable
    /// delivery token), and unchanged for accounts that already have one.
    pub fn delivery_token(&self) -> Result<(String, String), VaultError> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let store = self.store()?;
        let key_b64 = match store.get_setting("profile.key")? {
            Some(k) => k,
            None => {
                let derived = keys::derive_auth_key(self.mk()?.as_ref(), keys::INFO_PROFILE)?;
                let k = b64.encode(derived.as_ref());
                store.set_setting("profile.key", &k)?;
                k
            }
        };
        let profile_key = b64
            .decode(key_b64)
            .map_err(|_| VaultError::Keychain("corrupt profile key setting".into()))?;
        let raw = keys::derive_auth_key(&profile_key, keys::INFO_DELIVERY)?;
        let token = b64.encode(raw.as_ref());
        let verifier = keys::sha256_b64url(token.as_bytes());
        Ok((token, verifier))
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
    fn escrow_bundle_is_present_and_opaque() {
        let (_dir, mut vault) = new_vault();
        vault.create("a long enough password").unwrap();
        let bundle = vault.escrow_bundle().unwrap();
        assert_ne!(bundle.password_auth_hash, bundle.recovery_auth_hash); // separate domains
        let parsed: serde_json::Value = serde_json::from_str(&bundle.payload).unwrap();
        assert_eq!(parsed["v"], 1);
        assert!(parsed["wrappedMkPassword"]["ciphertext"].is_array());
        // The payload never carries the vault-key wrap (that one never
        // leaves the device) nor any raw key material.
        assert!(parsed.get("wrappedMkVault").is_none());
        // KDF params are exposed for the pre-auth cold-start fetch.
        let kdf: serde_json::Value = serde_json::from_str(&bundle.kdf_params).unwrap();
        assert!(kdf["kdfSalt"].is_array());
    }

    #[test]
    fn escrow_fetch_auth_key_matches_the_stored_hash() {
        // The cold-start fetch derivation must reproduce the create-time
        // auth key exactly, so the relay's stored hash compares equal.
        let (_dir, mut vault) = new_vault();
        vault.create("a long enough password").unwrap();
        let bundle = vault.escrow_bundle().unwrap();
        let kdf: serde_json::Value = serde_json::from_str(&bundle.kdf_params).unwrap();
        let salt: Vec<u8> = kdf["kdfSalt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let m = kdf["kdfMKib"].as_u64().unwrap() as u32;
        let t = kdf["kdfT"].as_u64().unwrap() as u32;
        let p = kdf["kdfP"].as_u64().unwrap() as u32;

        use base64::Engine as _;
        let auth_b64 =
            Vault::derive_escrow_auth_key_b64("a long enough password", &salt, m, t, p).unwrap();
        let auth_raw = base64::engine::general_purpose::STANDARD.decode(auth_b64).unwrap();
        // Server stores b64url(sha256(raw auth key)); it must equal the hash
        // captured at create time.
        assert_eq!(keys::sha256_b64url(&auth_raw), bundle.password_auth_hash);
    }

    #[test]
    fn restore_from_escrow_recovers_same_mk_on_a_fresh_device() {
        // Device 1: create, remember MK (via a settings marker), export escrow.
        let (_d1, mut v1) = new_vault();
        let recovery = v1.create("a long enough password").unwrap();
        v1.store().unwrap().set_setting("marker", "hello").unwrap();
        let payload = v1.escrow_bundle().unwrap().payload;

        // Device 2 (fresh keychain + data dir): restore from escrow + password.
        let (_d2, mut v2) = new_vault();
        assert_eq!(v2.status(), VaultStatus::Uninitialized);
        v2.restore_from_escrow(&payload, "a long enough password").unwrap();
        assert_eq!(v2.status(), VaultStatus::Unlocked);
        // Same MK ⇒ per-relay identities re-derive identically (the point).
        assert_eq!(v1.mk().unwrap().as_ref(), v2.mk().unwrap().as_ref());
        // Fresh store — escrow restores identity, not history (D8).
        assert!(v2.store().unwrap().get_setting("marker").unwrap().is_none());

        // Wrong password is rejected.
        let (_d3, mut v3) = new_vault();
        assert!(matches!(
            v3.restore_from_escrow(&payload, "the wrong password"),
            Err(VaultError::WrongPassword)
        ));

        // The original recovery code still opens the restored device.
        v2.lock();
        v2.unlock_recovery(&recovery).unwrap();
    }

    #[test]
    fn delivery_token_is_deterministic_and_verifier_matches_convention() {
        use base64::Engine as _;
        let (_dir, mut vault) = new_vault();
        vault.create("a long enough password").unwrap();
        let profile_key = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        vault.store().unwrap().set_setting("profile.key", &profile_key).unwrap();

        let (token_a, verifier_a) = vault.delivery_token().unwrap();
        let (token_b, verifier_b) = vault.delivery_token().unwrap();
        assert_eq!(token_a, token_b);
        assert_eq!(verifier_a, verifier_b);
        // Server-side convention: verifier = b64url(sha256(utf8(token))).
        assert_eq!(verifier_a, crate::keys::sha256_b64url(token_a.as_bytes()));
        // Locked vault → no token.
        vault.lock();
        assert!(vault.delivery_token().is_err());
    }

    #[test]
    fn delivery_token_derives_from_mk_when_unseeded_and_is_stable_across_devices() {
        // Greenfield accounts have no migration to seed `profile.key`. Regression
        // guard for the onboarding bug: delivery_token() must derive it from MK on
        // first use (not fail), persist it, and yield the SAME token on every
        // device with this account (same MK) so friends can always reach it.
        let (_d1, mut v1) = new_vault();
        let _ = v1.create("a long enough password").unwrap();
        assert!(v1.store().unwrap().get_setting("profile.key").unwrap().is_none());

        let (token1, _) = v1.delivery_token().unwrap();
        // First use persisted the derived key and is deterministic on repeat.
        assert!(v1.store().unwrap().get_setting("profile.key").unwrap().is_some());
        assert_eq!(token1, v1.delivery_token().unwrap().0);

        // A second device restored from escrow (same MK, fresh store with no
        // profile.key) derives the identical token.
        let payload = v1.escrow_bundle().unwrap().payload;
        let (_d2, mut v2) = new_vault();
        v2.restore_from_escrow(&payload, "a long enough password").unwrap();
        assert!(v2.store().unwrap().get_setting("profile.key").unwrap().is_none());
        assert_eq!(token1, v2.delivery_token().unwrap().0);
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
