//! Key material + wrapping primitives (roadmap D13 hierarchy).
//!
//! MK is random per user and only ever rests **wrapped**: under the
//! keychain-held vault key (primary, D3), under Argon2id(password) (portable
//! fallback), and under KDF(recovery code) (break-glass). The SQLCipher key is
//! a separate per-device random key in the OS keychain and never leaves the
//! device. Wrap = HKDF-SHA256 (domain-separated, mirroring the web client's
//! INFO_* namespacing) → AES-256-GCM.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

pub const INFO_MK_WRAP_VAULT: &[u8] = b"accord/mk-wrap/vault-key/v1";
pub const INFO_MK_WRAP_PASSWORD: &[u8] = b"accord/mk-wrap/password/v1";
pub const INFO_MK_WRAP_RECOVERY: &[u8] = b"accord/mk-wrap/recovery/v1";
// The account's profile key, derived from MK (D13: one derivation tree). It's
// the root of the delivery token + display-name encryption. Deriving it from MK
// keeps it identical on every device with this account (stable delivery token),
// and it replaces the value the (now-removed) migration used to seed.
pub const INFO_PROFILE: &[u8] = b"accord/profile-key/v1";
// D6: delivery token = KDF(profile key, "delivery") — the sealed-sender
// capability friends present to the relay.
pub const INFO_DELIVERY: &[u8] = b"accord/delivery/v1";
pub const INFO_GROUP_TOKEN: &[u8] = b"accord/group-token/v1";

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("decryption failed (wrong secret or corrupt blob)")]
    Unwrap,
    #[error("crypto failure")]
    Crypto,
}

pub type Secret32 = Zeroizing<[u8; 32]>;

pub fn random_key() -> Secret32 {
    let mut k = Zeroizing::new([0u8; 32]);
    rand::rng().fill_bytes(k.as_mut());
    k
}

/// 160-bit recovery code, base32 in groups of 4 (matches the shipped web
/// format from accounts-and-crypto.md).
pub fn generate_recovery_code() -> String {
    let mut raw = [0u8; 20];
    rand::rng().fill_bytes(&mut raw);
    let b32 = data_encoding::BASE32_NOPAD.encode(&raw);
    b32.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

/// Canonical form for KDF input: strip separators, uppercase.
pub fn normalize_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Auth/derivation key: HKDF of a secret under an auth-only domain — never a
/// wrap domain, so a key handed out as a capability (a delivery or group token)
/// can never unwrap anything.
pub fn derive_auth_key(secret: &[u8], info: &[u8]) -> Result<Secret32, KeyError> {
    derive_wrap_key(secret, info)
}

/// b64url(SHA-256(bytes)) — the form the relay stores for auth-key checks.
pub fn sha256_b64url(bytes: &[u8]) -> String {
    use sha2::Digest;
    data_encoding::BASE64URL_NOPAD.encode(&sha2::Sha256::digest(bytes))
}

/// From a group key: `(token, verifier)` for group send/blobs (D6/D14). The
/// token (base64, derived under a group-token domain) is what members present to
/// the relay; the verifier — `sha256(token)` base64url, matching the server's
/// hashing — is what an admin registers. All members derive the same pair from
/// the shared group key, mirroring the D6 delivery-token convention.
pub fn group_token_verifier(group_key: &[u8]) -> Result<(String, String), KeyError> {
    use base64::Engine as _;
    let raw = derive_auth_key(group_key, INFO_GROUP_TOKEN)?;
    let token = base64::engine::general_purpose::STANDARD.encode(raw.as_ref());
    let verifier = sha256_b64url(token.as_bytes());
    Ok((token, verifier))
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct WrappedKey {
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

fn derive_wrap_key(secret: &[u8], info: &[u8]) -> Result<Secret32, KeyError> {
    let hk = Hkdf::<Sha256>::new(None, secret);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info, out.as_mut()).map_err(|_| KeyError::Crypto)?;
    Ok(out)
}

pub fn wrap(secret: &[u8], info: &[u8], plaintext: &[u8; 32]) -> Result<WrappedKey, KeyError> {
    let wrap_key = derive_wrap_key(secret, info)?;
    let cipher = Aes256Gcm::new_from_slice(wrap_key.as_ref()).map_err(|_| KeyError::Crypto)?;
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
        .map_err(|_| KeyError::Crypto)?;
    Ok(WrappedKey { nonce, ciphertext })
}

pub fn unwrap(secret: &[u8], info: &[u8], wrapped: &WrappedKey) -> Result<Secret32, KeyError> {
    let wrap_key = derive_wrap_key(secret, info)?;
    let cipher = Aes256Gcm::new_from_slice(wrap_key.as_ref()).map_err(|_| KeyError::Crypto)?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&wrapped.nonce), wrapped.ciphertext.as_slice())
        .map_err(|_| KeyError::Unwrap)?;
    let mut out = Zeroizing::new([0u8; 32]);
    if plain.len() != 32 {
        return Err(KeyError::Unwrap);
    }
    out.copy_from_slice(&plain);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_unwrap_roundtrip_and_domain_separation() {
        let mk = random_key();
        let secret = b"some wrapping secret";
        let wrapped = wrap(secret, INFO_MK_WRAP_PASSWORD, &mk).unwrap();
        let back = unwrap(secret, INFO_MK_WRAP_PASSWORD, &wrapped).unwrap();
        assert_eq!(mk.as_ref(), back.as_ref());
        // Same secret, different domain → must not unwrap.
        assert!(unwrap(secret, INFO_MK_WRAP_RECOVERY, &wrapped).is_err());
        // Wrong secret → must not unwrap.
        assert!(unwrap(b"other secret", INFO_MK_WRAP_PASSWORD, &wrapped).is_err());
    }

    #[test]
    fn group_token_is_deterministic_and_verifier_matches_convention() {
        let group_key = [5u8; 32];
        let (token, verifier) = group_token_verifier(&group_key).unwrap();
        // Deterministic: every member derives the same pair.
        assert_eq!(group_token_verifier(&group_key).unwrap(), (token.clone(), verifier.clone()));
        // Verifier = sha256(token) base64url, as the relay stores/compares it.
        assert_eq!(verifier, sha256_b64url(token.as_bytes()));
        // A different group key → a different token.
        assert_ne!(group_token_verifier(&[6u8; 32]).unwrap().0, token);
    }

    #[test]
    fn recovery_code_format_and_normalization() {
        let code = generate_recovery_code();
        // 160 bits → 32 base32 chars → 8 groups of 4.
        assert_eq!(code.split('-').count(), 8);
        assert!(code.split('-').all(|g| g.len() == 4));
        let norm = normalize_recovery_code(&code.to_lowercase().replace('-', " "));
        assert_eq!(norm, code.replace('-', ""));
    }
}
