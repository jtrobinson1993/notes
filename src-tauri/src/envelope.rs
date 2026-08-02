//! Envelope v1 (spec/relay.md § Envelope versioning; D6 sealed sender, D11
//! content signatures).
//!
//! Outer (what the relay holds — opaque): `{v, eph, nonce, ct}` — a sealed
//! box to the recipient's X25519 sealing key (ephemeral ECDH → HKDF-SHA256 →
//! AES-256-GCM). Inner plaintext: `{kind, payload, senderIdentityPub, sig,
//! sentAt}` — the sender's identity certificate rides *inside* the
//! ciphertext (the relay never sees it), and `sig` covers `kind|payload` so
//! a member serving history later can never forge content (D11 backfill
//! integrity). Unknown major versions are surfaced as `UnknownVersion` — the
//! caller buffers the raw envelope and re-decodes after an app update,
//! never drops it.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::Engine as _;
use ed25519_dalek::{Signer, Verifier};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

use crate::identity::RelayIdentity;

const INFO_ENVELOPE: &[u8] = b"accord/envelope/v1";
const SIG_DOMAIN: &[u8] = b"accord/envelope-sig/v1|";

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("unknown envelope version {0} — buffer and retry after update")]
    UnknownVersion(u32),
    #[error("malformed envelope")]
    Malformed,
    #[error("decryption failed (not addressed to this identity?)")]
    Decrypt,
    #[error("content signature invalid")]
    BadSignature,
    #[error("crypto failure")]
    Crypto,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Outer {
    v: u32,
    eph: String,
    nonce: String,
    ct: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Inner {
    kind: String,
    payload_b64: String,
    sender_identity_pub: String,
    sig: String,
    sent_at: i64,
}

/// The verified result of opening an envelope.
#[derive(serde::Serialize)]
pub struct Opened {
    pub kind: String,
    pub payload: Vec<u8>,
    /// b64 Ed25519 — verify against the D5 directory before trusting.
    pub sender_identity_pub: String,
    pub sent_at: i64,
}

fn derive_box_key(shared: &[u8; 32], eph_pub: &PublicKey) -> Result<[u8; 32], EnvelopeError> {
    // Salt with the ephemeral public key so each envelope's key is unique
    // even if an ECDH output were ever repeated.
    let hk = Hkdf::<Sha256>::new(Some(eph_pub.as_bytes()), shared);
    let mut out = [0u8; 32];
    hk.expand(INFO_ENVELOPE, &mut out).map_err(|_| EnvelopeError::Crypto)?;
    Ok(out)
}

pub fn seal(
    recipient_sealing_pub: &[u8; 32],
    sender: &RelayIdentity,
    kind: &str,
    payload: &[u8],
    sent_at: i64,
) -> Result<Vec<u8>, EnvelopeError> {
    let sig = sender
        .signing
        .sign(&[SIG_DOMAIN, kind.as_bytes(), b"|", payload].concat());
    let inner = serde_json::to_vec(&Inner {
        kind: kind.to_string(),
        payload_b64: b64().encode(payload),
        sender_identity_pub: b64().encode(sender.signing_public()),
        sig: b64().encode(sig.to_bytes()),
        sent_at,
    })
    .map_err(|_| EnvelopeError::Crypto)?;

    let eph = EphemeralSecret::random();
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_sealing_pub));
    let key = derive_box_key(shared.as_bytes(), &eph_pub)?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| EnvelopeError::Crypto)?;
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), inner.as_slice())
        .map_err(|_| EnvelopeError::Crypto)?;

    serde_json::to_vec(&Outer {
        v: 1,
        eph: b64().encode(eph_pub.as_bytes()),
        nonce: b64().encode(nonce),
        ct: b64().encode(ct),
    })
    .map_err(|_| EnvelopeError::Crypto)
}

pub fn open(my_sealing: &StaticSecret, envelope: &[u8]) -> Result<Opened, EnvelopeError> {
    let outer: Outer = serde_json::from_slice(envelope).map_err(|_| EnvelopeError::Malformed)?;
    if outer.v != 1 {
        return Err(EnvelopeError::UnknownVersion(outer.v));
    }
    let eph_raw: [u8; 32] = b64()
        .decode(&outer.eph)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(EnvelopeError::Malformed)?;
    let nonce = b64().decode(&outer.nonce).map_err(|_| EnvelopeError::Malformed)?;
    let ct = b64().decode(&outer.ct).map_err(|_| EnvelopeError::Malformed)?;

    let eph_pub = PublicKey::from(eph_raw);
    let shared = my_sealing.diffie_hellman(&eph_pub);
    let key = derive_box_key(shared.as_bytes(), &eph_pub)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| EnvelopeError::Crypto)?;
    let inner_bytes = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| EnvelopeError::Decrypt)?;

    let inner: Inner = serde_json::from_slice(&inner_bytes).map_err(|_| EnvelopeError::Malformed)?;
    let payload = b64().decode(&inner.payload_b64).map_err(|_| EnvelopeError::Malformed)?;

    let sender_pub_raw: [u8; 32] = b64()
        .decode(&inner.sender_identity_pub)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(EnvelopeError::Malformed)?;
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&sender_pub_raw)
        .map_err(|_| EnvelopeError::Malformed)?;
    let sig_raw = b64().decode(&inner.sig).map_err(|_| EnvelopeError::Malformed)?;
    let sig = ed25519_dalek::Signature::from_slice(&sig_raw).map_err(|_| EnvelopeError::Malformed)?;
    verifying
        .verify(
            &[SIG_DOMAIN, inner.kind.as_bytes(), b"|", &payload].concat(),
            &sig,
        )
        .map_err(|_| EnvelopeError::BadSignature)?;

    Ok(Opened {
        kind: inner.kind,
        payload,
        sender_identity_pub: inner.sender_identity_pub,
        sent_at: inner.sent_at,
    })
}

// ---- group envelope (D6/D14): symmetric, one envelope for all members ----
//
// Unlike the DM envelope (ephemeral X25519 → per-recipient), a group message is
// encrypted ONCE under the shared group key and fanned out by the relay to all
// members. The inner plaintext + signed sender cert are identical, so members
// still verify who sent it (D11); only the outer wrapping differs.

const INFO_GROUP_ENVELOPE: &[u8] = b"accord/group-envelope/v1";

#[derive(serde::Serialize, serde::Deserialize)]
struct GroupOuter {
    v: u32,
    nonce: String,
    ct: String,
}

/// Derive the AES key from the group key (domain-separated — the group key also
/// derives the group token, so never used raw as the content key).
fn group_content_key(group_key: &[u8; 32]) -> Result<[u8; 32], EnvelopeError> {
    let hk = Hkdf::<Sha256>::new(None, group_key);
    let mut out = [0u8; 32];
    hk.expand(INFO_GROUP_ENVELOPE, &mut out).map_err(|_| EnvelopeError::Crypto)?;
    Ok(out)
}

/// Verify the signed sender cert inside a decrypted `Inner` and return `Opened`.
fn verify_inner(inner: Inner) -> Result<Opened, EnvelopeError> {
    let payload = b64().decode(&inner.payload_b64).map_err(|_| EnvelopeError::Malformed)?;
    let sender_pub_raw: [u8; 32] = b64()
        .decode(&inner.sender_identity_pub)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(EnvelopeError::Malformed)?;
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&sender_pub_raw)
        .map_err(|_| EnvelopeError::Malformed)?;
    let sig_raw = b64().decode(&inner.sig).map_err(|_| EnvelopeError::Malformed)?;
    let sig = ed25519_dalek::Signature::from_slice(&sig_raw).map_err(|_| EnvelopeError::Malformed)?;
    verifying
        .verify(&[SIG_DOMAIN, inner.kind.as_bytes(), b"|", &payload].concat(), &sig)
        .map_err(|_| EnvelopeError::BadSignature)?;
    Ok(Opened {
        kind: inner.kind,
        payload,
        sender_identity_pub: inner.sender_identity_pub,
        sent_at: inner.sent_at,
    })
}

pub fn seal_group(
    group_key: &[u8; 32],
    sender: &RelayIdentity,
    kind: &str,
    payload: &[u8],
    sent_at: i64,
) -> Result<Vec<u8>, EnvelopeError> {
    let sig = sender
        .signing
        .sign(&[SIG_DOMAIN, kind.as_bytes(), b"|", payload].concat());
    let inner = serde_json::to_vec(&Inner {
        kind: kind.to_string(),
        payload_b64: b64().encode(payload),
        sender_identity_pub: b64().encode(sender.signing_public()),
        sig: b64().encode(sig.to_bytes()),
        sent_at,
    })
    .map_err(|_| EnvelopeError::Crypto)?;

    let key = group_content_key(group_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| EnvelopeError::Crypto)?;
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), inner.as_slice())
        .map_err(|_| EnvelopeError::Crypto)?;

    serde_json::to_vec(&GroupOuter {
        v: 1,
        nonce: b64().encode(nonce),
        ct: b64().encode(ct),
    })
    .map_err(|_| EnvelopeError::Crypto)
}

pub fn open_group(group_key: &[u8; 32], envelope: &[u8]) -> Result<Opened, EnvelopeError> {
    let outer: GroupOuter = serde_json::from_slice(envelope).map_err(|_| EnvelopeError::Malformed)?;
    if outer.v != 1 {
        return Err(EnvelopeError::UnknownVersion(outer.v));
    }
    let nonce = b64().decode(&outer.nonce).map_err(|_| EnvelopeError::Malformed)?;
    let ct = b64().decode(&outer.ct).map_err(|_| EnvelopeError::Malformed)?;
    let key = group_content_key(group_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| EnvelopeError::Crypto)?;
    let inner_bytes = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| EnvelopeError::Decrypt)?;
    let inner: Inner = serde_json::from_slice(&inner_bytes).map_err(|_| EnvelopeError::Malformed)?;
    verify_inner(inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::derive_relay_identity;

    const MK_A: [u8; 32] = [1u8; 32];
    const MK_B: [u8; 32] = [2u8; 32];
    const FP: &str = "relay-fp";

    #[test]
    fn seal_open_roundtrip_verifies_sender() {
        let alice = derive_relay_identity(&MK_A, FP).unwrap();
        let bob = derive_relay_identity(&MK_B, FP).unwrap();

        let env = seal(&bob.sealing_public(), &alice, "msg", b"hello bob", 42).unwrap();
        let opened = open(&bob.sealing, &env).unwrap();
        assert_eq!(opened.kind, "msg");
        assert_eq!(opened.payload, b"hello bob");
        assert_eq!(opened.sent_at, 42);
        use base64::Engine as _;
        assert_eq!(
            opened.sender_identity_pub,
            base64::engine::general_purpose::STANDARD.encode(alice.signing_public())
        );
    }

    #[test]
    fn group_seal_open_roundtrip_and_wrong_key() {
        let alice = derive_relay_identity(&MK_A, FP).unwrap();
        let group_key = [7u8; 32];
        let env = seal_group(&group_key, &alice, "msg", b"hello group", 9).unwrap();

        let opened = open_group(&group_key, &env).unwrap();
        assert_eq!(opened.kind, "msg");
        assert_eq!(opened.payload, b"hello group");
        assert_eq!(opened.sent_at, 9);
        use base64::Engine as _;
        assert_eq!(
            opened.sender_identity_pub,
            base64::engine::general_purpose::STANDARD.encode(alice.signing_public())
        );

        // A member without the right group key can't open it.
        assert!(matches!(open_group(&[8u8; 32], &env), Err(EnvelopeError::Decrypt)));
    }

    #[test]
    fn group_tamper_and_unknown_version_rejected() {
        let alice = derive_relay_identity(&MK_A, FP).unwrap();
        let group_key = [3u8; 32];
        let env = seal_group(&group_key, &alice, "msg", b"payload", 0).unwrap();

        let mut outer: serde_json::Value = serde_json::from_slice(&env).unwrap();
        let ct = outer["ct"].as_str().unwrap().to_string();
        outer["ct"] = serde_json::Value::String(format!(
            "{}{}",
            if ct.starts_with('A') { "B" } else { "A" },
            &ct[1..]
        ));
        let tampered = serde_json::to_vec(&outer).unwrap();
        assert!(matches!(open_group(&group_key, &tampered), Err(EnvelopeError::Decrypt)));

        let mut future: serde_json::Value = serde_json::from_slice(&env).unwrap();
        future["v"] = serde_json::Value::from(2);
        let future = serde_json::to_vec(&future).unwrap();
        assert!(matches!(
            open_group(&group_key, &future),
            Err(EnvelopeError::UnknownVersion(2))
        ));
    }

    #[test]
    fn wrong_recipient_cannot_open() {
        let alice = derive_relay_identity(&MK_A, FP).unwrap();
        let bob = derive_relay_identity(&MK_B, FP).unwrap();
        let env = seal(&bob.sealing_public(), &alice, "msg", b"secret", 0).unwrap();
        // Alice (or anyone but Bob) fails to decrypt.
        assert!(matches!(open(&alice.sealing, &env), Err(EnvelopeError::Decrypt)));
    }

    #[test]
    fn tampered_ciphertext_and_unknown_version_are_rejected() {
        let alice = derive_relay_identity(&MK_A, FP).unwrap();
        let bob = derive_relay_identity(&MK_B, FP).unwrap();
        let env = seal(&bob.sealing_public(), &alice, "msg", b"payload", 0).unwrap();

        // Flip a ciphertext byte inside the JSON.
        let mut outer: serde_json::Value = serde_json::from_slice(&env).unwrap();
        let ct = outer["ct"].as_str().unwrap().to_string();
        outer["ct"] = serde_json::Value::String(format!(
            "{}{}",
            if ct.starts_with('A') { "B" } else { "A" },
            &ct[1..]
        ));
        let tampered = serde_json::to_vec(&outer).unwrap();
        assert!(matches!(open(&bob.sealing, &tampered), Err(EnvelopeError::Decrypt)));

        // Future version → UnknownVersion (buffer, never drop).
        let mut future: serde_json::Value = serde_json::from_slice(&env).unwrap();
        future["v"] = serde_json::Value::from(2);
        let future = serde_json::to_vec(&future).unwrap();
        assert!(matches!(
            open(&bob.sealing, &future),
            Err(EnvelopeError::UnknownVersion(2))
        ));
    }
}
