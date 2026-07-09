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
    live_started: std::sync::atomic::AtomicBool,
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

#[derive(serde::Serialize)]
pub struct MailboxRow {
    pub queue_id: i64,
    pub relay_ts: i64,
    pub envelope: Vec<u8>,
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

    /// Mint a fresh device bearer without touching the shared session — used by
    /// the live-delivery task, which keeps its own independent WS token so it
    /// never contends with REST calls on the session mutex (D4 B).
    pub async fn issue_bearer_static(
        base_url: &str,
        relay_fp: &str,
        signing: &SigningKey,
    ) -> Result<String, String> {
        let http = reqwest::Client::new();
        let (token, _expires_at) =
            Self::fetch_token(&http, base_url.trim_end_matches('/'), relay_fp, signing).await?;
        Ok(token)
    }

    /// `(base_url, relay_fp)` of the live session, or None if not connected.
    pub fn session_info(&self) -> Option<(String, String)> {
        let guard = self.session.lock().unwrap();
        guard.as_ref().map(|s| (s.base_url.clone(), s.relay_fp.clone()))
    }

    /// Begin the live-delivery task at most once per process (idempotent).
    /// Returns true for the caller that wins the race, false afterwards.
    pub fn try_begin_live(&self) -> bool {
        !self.live_started.swap(true, std::sync::atomic::Ordering::SeqCst)
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

    /// Upload the D15 escrow bundle (device-token authed).
    pub async fn escrow_upload(
        &self,
        signing: &SigningKey,
        bundle: crate::vault::EscrowUploadBundle,
    ) -> Result<(), String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let kdf_params: serde_json::Value =
            serde_json::from_str(&bundle.kdf_params).map_err(|e| format!("bad kdf params: {e}"))?;
        let res = reqwest::Client::new()
            .put(format!("{base}/api/relay/escrow"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({
                "payload": bundle.payload,
                "kdfParams": kdf_params,
                "passwordAuthHash": bundle.password_auth_hash,
                "recoveryAuthHash": bundle.recovery_auth_hash,
            }))
            .send()
            .await
            .map_err(|e| format!("escrow upload failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused escrow (HTTP {})", res.status()));
        }
        Ok(())
    }

    /// Cold-start step 1 (sessionless): fetch the public KDF params by handle
    /// so the fresh device can derive its escrow fetch auth key.
    pub async fn escrow_kdf(
        base_url: &str,
        handle: &str,
    ) -> Result<(Vec<u8>, u32, u32, u32), String> {
        let base = base_url.trim_end_matches('/');
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/escrow/kdf"))
            .json(&serde_json::json!({ "handle": handle }))
            .send()
            .await
            .map_err(|e| format!("kdf fetch failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("kdf fetch refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct KdfResponse {
            #[serde(rename = "kdfSalt")]
            kdf_salt: Vec<u8>,
            #[serde(rename = "kdfMKib")]
            kdf_m_kib: u32,
            #[serde(rename = "kdfT")]
            kdf_t: u32,
            #[serde(rename = "kdfP")]
            kdf_p: u32,
        }
        let k: KdfResponse = res.json().await.map_err(|e| format!("bad kdf response: {e}"))?;
        Ok((k.kdf_salt, k.kdf_m_kib, k.kdf_t, k.kdf_p))
    }

    /// Publish this account's per-relay public keys to the directory (D5).
    pub async fn directory_publish(
        &self,
        signing: &SigningKey,
        identity_pub_b64: String,
        sealing_pub_b64: String,
    ) -> Result<(), String> {
        let bearer = self.bearer(signing).await?;
        let base = {
            let guard = self.session.lock().unwrap();
            guard.as_ref().ok_or("not connected to a relay")?.base_url.clone()
        };
        let res = reqwest::Client::new()
            .put(format!("{base}/api/relay/directory"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({
                "identityPubKey": identity_pub_b64,
                "sealingPubKey": sealing_pub_b64,
            }))
            .send()
            .await
            .map_err(|e| format!("directory publish failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused directory entry (HTTP {})", res.status()));
        }
        Ok(())
    }

    fn base_url(&self) -> Result<String, String> {
        let guard = self.session.lock().unwrap();
        Ok(guard.as_ref().ok_or("not connected to a relay")?.base_url.clone())
    }

    /// Register hash(delivery token) so friends' sealed sends are accepted (D6).
    pub async fn register_verifier(&self, signing: &SigningKey, verifier: String) -> Result<(), String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .put(format!("{base}/api/relay/verifier"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "verifier": verifier }))
            .send()
            .await
            .map_err(|e| format!("verifier registration failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused verifier (HTTP {})", res.status()));
        }
        Ok(())
    }

    /// Mint a friend invite (device-authed, D4b): store `hash(token)` + expiry
    /// for a future friend. Returns the absolute expiry (ms).
    pub async fn invite_mint(
        &self,
        signing: &SigningKey,
        token_hash: String,
        expires_in_sec: Option<u32>,
    ) -> Result<i64, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let mut body = serde_json::json!({ "tokenHash": token_hash });
        if let Some(s) = expires_in_sec {
            body["expiresInSec"] = serde_json::json!(s);
        }
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/invites"))
            .bearer_auth(bearer)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("invite mint failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused invite (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct MintResponse {
            #[serde(rename = "expiresAt")]
            expires_at: i64,
        }
        let body: MintResponse = res.json().await.map_err(|e| format!("bad mint response: {e}"))?;
        Ok(body.expires_at)
    }

    /// Redeem a friend invite (capability only — deliberately NO device token;
    /// requiring one would let the relay link the redeemer to the inviter = a
    /// social-graph edge, D4b/D6). Drops the pre-sealed friend-accept envelope
    /// into the inviter's mailbox and returns the relay stamp.
    pub async fn invite_redeem(&self, token: &str, envelope: Vec<u8>) -> Result<i64, String> {
        use base64::Engine as _;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/invites/redeem"))
            .json(&serde_json::json!({
                "token": token,
                "envelope": base64::engine::general_purpose::STANDARD.encode(&envelope),
            }))
            .send()
            .await
            .map_err(|e| format!("invite redeem failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("invite redeem refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct RedeemResponse {
            #[serde(rename = "relayTs")]
            relay_ts: i64,
        }
        let body: RedeemResponse =
            res.json().await.map_err(|e| format!("bad redeem response: {e}"))?;
        Ok(body.relay_ts)
    }

    /// Publish/replace a group's signed state record (D14, device-authed).
    pub async fn group_state_put(
        &self,
        signing: &SigningKey,
        group_id: &str,
        record: &str,
        admin_signature: &str,
    ) -> Result<(), String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .put(format!("{base}/api/relay/groups/{group_id}/state"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "record": record, "adminSignature": admin_signature }))
            .send()
            .await
            .map_err(|e| format!("group state put failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused group state (HTTP {})", res.status()));
        }
        Ok(())
    }

    /// Register a group's blob/send verifier = hash(group token) (D14, member).
    pub async fn group_verifier_put(
        &self,
        signing: &SigningKey,
        group_id: &str,
        verifier: &str,
    ) -> Result<(), String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .put(format!("{base}/api/relay/groups/{group_id}/verifier"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "verifier": verifier }))
            .send()
            .await
            .map_err(|e| format!("group verifier put failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("relay refused group verifier (HTTP {})", res.status()));
        }
        Ok(())
    }

    /// Group send (D6/D14): one group-key-sealed envelope, group-token authed
    /// (no device token — sender-anonymous). The relay fans it to all members.
    pub async fn group_send(
        &self,
        group_id: &str,
        group_token: &str,
        envelope: Vec<u8>,
    ) -> Result<i64, String> {
        use base64::Engine as _;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/groups/{group_id}/send"))
            .json(&serde_json::json!({
                "groupToken": group_token,
                "envelope": base64::engine::general_purpose::STANDARD.encode(&envelope),
            }))
            .send()
            .await
            .map_err(|e| format!("group send failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("group send refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "relayTs")]
            relay_ts: i64,
        }
        let body: Resp = res.json().await.map_err(|e| format!("bad group send response: {e}"))?;
        Ok(body.relay_ts)
    }

    /// Sealed send (D6): deliberately NO device token — the recipient's
    /// delivery token is the only credential, so the relay never learns who
    /// sent the envelope.
    pub async fn mailbox_send(
        &self,
        recipient_handle: &str,
        delivery_token: &str,
        envelope: Vec<u8>,
    ) -> Result<i64, String> {
        use base64::Engine as _;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/mailbox/send"))
            .json(&serde_json::json!({
                "deliveryToken": delivery_token,
                "recipientHandle": recipient_handle,
                "envelope": base64::engine::general_purpose::STANDARD.encode(&envelope),
            }))
            .send()
            .await
            .map_err(|e| format!("send failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("delivery refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct SendResponse {
            #[serde(rename = "relayTs")]
            relay_ts: i64,
        }
        let body: SendResponse = res.json().await.map_err(|e| format!("bad send response: {e}"))?;
        Ok(body.relay_ts)
    }

    pub async fn mailbox_fetch(&self, signing: &SigningKey) -> Result<Vec<MailboxRow>, String> {
        use base64::Engine as _;
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .get(format!("{base}/api/relay/mailbox"))
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| format!("mailbox fetch failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("mailbox fetch refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Row {
            #[serde(rename = "queueId")]
            queue_id: i64,
            #[serde(rename = "relayTs")]
            relay_ts: i64,
            envelope: String,
        }
        let rows: Vec<Row> = res.json().await.map_err(|e| format!("bad mailbox response: {e}"))?;
        rows.into_iter()
            .map(|r| {
                Ok(MailboxRow {
                    queue_id: r.queue_id,
                    relay_ts: r.relay_ts,
                    envelope: base64::engine::general_purpose::STANDARD
                        .decode(r.envelope)
                        .map_err(|_| "corrupt envelope encoding".to_string())?,
                })
            })
            .collect()
    }

    /// Hold-until-ack: only ack after the envelope is durably ingested.
    pub async fn mailbox_ack(&self, signing: &SigningKey, queue_ids: Vec<i64>) -> Result<u64, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/mailbox/ack"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "queueIds": queue_ids }))
            .send()
            .await
            .map_err(|e| format!("ack failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("ack refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct AckResponse {
            acked: u64,
        }
        let body: AckResponse = res.json().await.map_err(|e| format!("bad ack response: {e}"))?;
        Ok(body.acked)
    }

    /// Cold-start (D15/D3a): fetch the wrapped-MK escrow from a relay by
    /// proving the auth key. Static — no session needed (this runs before
    /// any vault exists on a fresh device).
    pub async fn escrow_fetch(
        base_url: &str,
        handle: &str,
        auth_kind: &str,
        auth_key_b64: &str,
    ) -> Result<String, String> {
        let base = base_url.trim_end_matches('/');
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/escrow/fetch"))
            .json(&serde_json::json!({
                "handle": handle,
                "authKind": auth_kind,
                "authKey": auth_key_b64,
            }))
            .send()
            .await
            .map_err(|e| format!("escrow fetch failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("escrow fetch refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct FetchResponse {
            payload: String,
        }
        let body: FetchResponse = res.json().await.map_err(|e| format!("bad escrow response: {e}"))?;
        Ok(body.payload)
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
