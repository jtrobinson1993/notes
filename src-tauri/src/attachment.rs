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
}
