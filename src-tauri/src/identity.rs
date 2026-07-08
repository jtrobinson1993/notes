//! Per-relay derived identities (roadmap D4b, D13 "DERIVED" branch).
//!
//! Each relay sees a distinct identity keypair deterministically derived from
//! the one local master seed and that relay's pinned key fingerprint — so
//! independent relays cannot collude to correlate the same user, and a
//! re-derived identity is always recoverable from MK alone (which is exactly
//! why revocation can't rotate it — see D13a tier 2).

use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::StaticSecret;
use zeroize::Zeroizing;

use crate::keys::KeyError;

const INFO_RELAY_ED25519: &[u8] = b"accord/relay-id/ed25519/v1";
const INFO_RELAY_X25519: &[u8] = b"accord/relay-id/x25519/v1";

/// A relay-scoped identity: Ed25519 for signing (relay auth challenges, D4;
/// message/content signatures, D11) and X25519 for sealing (contact key
/// exchange, D5 directory entry).
pub struct RelayIdentity {
    pub signing: SigningKey,
    pub sealing: StaticSecret,
}

impl RelayIdentity {
    pub fn signing_public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sealing_public(&self) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&self.sealing).to_bytes()
    }
}

/// Derive the identity for a relay from MK + the relay's key fingerprint.
/// Deterministic: same (MK, fingerprint) → same keys, on any device.
pub fn derive_relay_identity(mk: &[u8; 32], relay_fp: &str) -> Result<RelayIdentity, KeyError> {
    Ok(RelayIdentity {
        signing: SigningKey::from_bytes(&*derive_seed(mk, INFO_RELAY_ED25519, relay_fp)?),
        sealing: StaticSecret::from(*derive_seed(mk, INFO_RELAY_X25519, relay_fp)?),
    })
}

fn derive_seed(
    mk: &[u8; 32],
    domain: &[u8],
    relay_fp: &str,
) -> Result<Zeroizing<[u8; 32]>, KeyError> {
    let hk = Hkdf::<Sha256>::new(None, mk);
    let info = [domain, b"|", relay_fp.as_bytes()].concat();
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(&info, out.as_mut()).map_err(|_| KeyError::Crypto)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    const MK: [u8; 32] = [42u8; 32];

    #[test]
    fn deterministic_per_relay() {
        let a1 = derive_relay_identity(&MK, "relay-a-fp").unwrap();
        let a2 = derive_relay_identity(&MK, "relay-a-fp").unwrap();
        assert_eq!(a1.signing_public(), a2.signing_public());
        assert_eq!(a1.sealing_public(), a2.sealing_public());
    }

    #[test]
    fn distinct_across_relays_and_from_other_mk() {
        let a = derive_relay_identity(&MK, "relay-a-fp").unwrap();
        let b = derive_relay_identity(&MK, "relay-b-fp").unwrap();
        // Unlinkability: nothing shared between the two relays' identities.
        assert_ne!(a.signing_public(), b.signing_public());
        assert_ne!(a.sealing_public(), b.sealing_public());
        // Signing and sealing keys are independently derived.
        assert_ne!(a.signing_public(), a.sealing_public());

        let other = derive_relay_identity(&[7u8; 32], "relay-a-fp").unwrap();
        assert_ne!(a.signing_public(), other.signing_public());
    }

    #[test]
    fn derived_identity_signs_and_verifies() {
        use ed25519_dalek::Signer;
        let id = derive_relay_identity(&MK, "relay-a-fp").unwrap();
        let msg = b"nonce|relay-a-fp";
        let sig = id.signing.sign(msg);
        id.signing.verifying_key().verify(msg, &sig).unwrap();
    }
}
