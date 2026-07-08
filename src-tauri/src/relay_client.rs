//! Relay auth client (spec/relay.md, D4 layer B).
//!
//! Speaks the challenge → signed-nonce → short-lived-token flow against the
//! relay and refreshes the token silently before expiry — no biometric
//! prompt, no vault involvement: only the device key (OS keychain) is used,
//! so the relay connection survives a locked vault.

use ed25519_dalek::{Signer, SigningKey};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Refresh when less than this remains — a request in flight never carries a
/// token about to lapse.
const REFRESH_MARGIN: Duration = Duration::from_secs(60);

pub fn device_public_key_b64(signing: &SigningKey) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes())
}

/// Sign the D4b payload `{nonce}|{relayFp}` — binding the relay's identity
/// into the signature kills cross-relay replay.
pub fn sign_challenge(signing: &SigningKey, nonce: &str, relay_fp: &str) -> String {
    use base64::Engine as _;
    let sig = signing.sign(format!("{nonce}|{relay_fp}").as_bytes());
    base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
}

pub fn token_needs_refresh(expires_at: Instant, now: Instant) -> bool {
    now + REFRESH_MARGIN >= expires_at
}

struct Session {
    base_url: String,
    relay_fp: String,
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct RelayClient {
    session: Mutex<Option<Session>>,
}

#[derive(serde::Deserialize)]
struct InfoResponse {
    #[serde(rename = "identityFingerprint")]
    identity_fingerprint: String,
}

#[derive(serde::Deserialize)]
struct ChallengeResponse {
    nonce: String,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    token: String,
    #[serde(rename = "expiresInSec")]
    expires_in_sec: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct RelayStatus {
    pub connected: bool,
    pub base_url: Option<String>,
    pub relay_fp: Option<String>,
}

impl RelayClient {
    /// Full handshake: pin the relay's fingerprint, prove the device key,
    /// store the bearer token.
    pub async fn connect(&self, base_url: &str, signing: &SigningKey) -> Result<(), String> {
        let http = reqwest::Client::new();
        let base = base_url.trim_end_matches('/');

        let info: InfoResponse = http
            .get(format!("{base}/api/relay/info"))
            .send()
            .await
            .map_err(|e| format!("relay unreachable: {e}"))?
            .json()
            .await
            .map_err(|e| format!("bad relay info: {e}"))?;

        let (token, expires_at) = Self::fetch_token(&http, base, &info.identity_fingerprint, signing).await?;
        *self.session.lock().unwrap() = Some(Session {
            base_url: base.to_string(),
            relay_fp: info.identity_fingerprint,
            token,
            expires_at,
        });
        Ok(())
    }

    async fn fetch_token(
        http: &reqwest::Client,
        base: &str,
        relay_fp: &str,
        signing: &SigningKey,
    ) -> Result<(String, Instant), String> {
        let challenge: ChallengeResponse = http
            .post(format!("{base}/api/relay/auth/challenge"))
            .send()
            .await
            .map_err(|e| format!("challenge failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("bad challenge: {e}"))?;

        let body = serde_json::json!({
            "pubKey": device_public_key_b64(signing),
            "nonce": challenge.nonce,
            "signature": sign_challenge(signing, &challenge.nonce, relay_fp),
        });
        let res = http
            .post(format!("{base}/api/relay/auth/token"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("token request failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused device auth (HTTP {})", res.status()));
        }
        let token: TokenResponse = res.json().await.map_err(|e| format!("bad token: {e}"))?;
        Ok((
            token.token,
            Instant::now() + Duration::from_secs(token.expires_in_sec),
        ))
    }

    /// A valid bearer token, silently refreshed when near expiry (D4 B).
    pub async fn bearer(&self, signing: &SigningKey) -> Result<String, String> {
        let (needs_refresh, base, fp) = {
            let guard = self.session.lock().unwrap();
            let s = guard.as_ref().ok_or("not connected to a relay")?;
            (
                token_needs_refresh(s.expires_at, Instant::now()),
                s.base_url.clone(),
                s.relay_fp.clone(),
            )
        };
        if needs_refresh {
            let http = reqwest::Client::new();
            let (token, expires_at) = Self::fetch_token(&http, &base, &fp, signing).await?;
            let mut guard = self.session.lock().unwrap();
            if let Some(s) = guard.as_mut() {
                s.token = token;
                s.expires_at = expires_at;
            }
        }
        let guard = self.session.lock().unwrap();
        Ok(guard.as_ref().ok_or("not connected to a relay")?.token.clone())
    }

    pub fn status(&self) -> RelayStatus {
        let guard = self.session.lock().unwrap();
        match guard.as_ref() {
            Some(s) => RelayStatus {
                connected: true,
                base_url: Some(s.base_url.clone()),
                relay_fp: Some(s.relay_fp.clone()),
            },
            None => RelayStatus {
                connected: false,
                base_url: None,
                relay_fp: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn challenge_signature_verifies_and_binds_the_relay() {
        let signing = SigningKey::from_bytes(&[3u8; 32]);
        use base64::Engine as _;
        let sig_b64 = sign_challenge(&signing, "nonce123", "relay-fp");
        let sig = base64::engine::general_purpose::STANDARD
            .decode(sig_b64)
            .unwrap();
        let sig = ed25519_dalek::Signature::from_slice(&sig).unwrap();
        signing
            .verifying_key()
            .verify(b"nonce123|relay-fp", &sig)
            .unwrap();
        // A different relay fp must not verify (no cross-relay replay).
        assert!(signing
            .verifying_key()
            .verify(b"nonce123|other-relay", &sig)
            .is_err());
    }

    #[test]
    fn refresh_margin() {
        let now = Instant::now();
        assert!(token_needs_refresh(now + Duration::from_secs(30), now));
        assert!(!token_needs_refresh(now + Duration::from_secs(300), now));
    }

    #[test]
    fn public_key_is_stable_b64() {
        let signing = SigningKey::from_bytes(&[5u8; 32]);
        let a = device_public_key_b64(&signing);
        assert_eq!(a, device_public_key_b64(&signing));
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD.decode(a).unwrap();
        assert_eq!(raw.len(), 32);
    }
}
