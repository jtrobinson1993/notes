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

/// A handle's KT key-history proof + what to verify it against (self-audit).
pub struct KtHistory {
    pub proof_json: String,
    pub epoch: u64,
    pub root: String,
    pub vrf_public_key: String,
}

/// A signed KT epoch root the client gossips to friends (split-view detection).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedRoot {
    pub epoch: i64,
    pub root: String,
    pub prev: String,
    pub sig: String,
}

/// A handle's directory entry plus the KT material needed to verify it: the
/// relay's claimed keys, the inclusion proof, and the (epoch, root) the proof is
/// against. **Every field here is relay-supplied and untrusted** — the root only
/// counts once its *signature* has been checked against the relay's identity key
/// (`kt::signed_root_epoch`), which is why the raw response is handed to the
/// verifier rather than interpreted here.
#[derive(Clone, Debug)]
pub struct DirectoryEntry {
    pub identity_pub_b64: String,
    pub sealing_pub_b64: String,
    /// The akd epoch the inclusion proof is for.
    pub epoch: u64,
    /// base64 akd root the proof verifies against.
    pub root: String,
    pub proof_json: String,
    pub vrf_public_key: String,
    /// `Some("akd")` when the relay runs the full AKD backend; `None` on the
    /// interim Merkle KT, whose proofs this client cannot verify.
    pub kt: Option<String>,
}

/// Cap on consecutive *no-progress* reconnects before a resumable download
/// gives up — a stream that keeps advancing between drops is never capped.
const RESUME_MAX_STALLS: u32 = 5;

/// Download a blob body, resuming across transport drops. On the first request
/// we ask for the whole object; if the stream dies part-way we reconnect with
/// `Range: bytes=<have>-` and the relay answers `206` continuing from that
/// offset (it advertises `accept-ranges: bytes`). A `200` on a resume means the
/// server ignored the range, so we restart the buffer to stay correct. Bounded
/// only against *stalls* (a reconnect that yields no new bytes); genuine
/// progress resets the counter, so a large file over a flaky link still lands.
async fn download_resumable(url: &str, bearer: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt as _;
    let client = reqwest::Client::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stalls = 0u32;
    loop {
        let mut req = client.get(url).bearer_auth(bearer);
        if !buf.is_empty() {
            req = req.header("range", format!("bytes={}-", buf.len()));
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("blob download failed: {e}"))?;
        let status = res.status();
        if !buf.is_empty() && status == reqwest::StatusCode::OK {
            // Range ignored — the body is the whole object again.
            buf.clear();
        } else if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!("blob download refused (HTTP {status})"));
        }
        let before = buf.len();
        let mut stream = res.bytes_stream();
        let mut interrupted = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => buf.extend_from_slice(&bytes),
                Err(_) => {
                    interrupted = true;
                    break;
                }
            }
        }
        if !interrupted {
            return Ok(buf);
        }
        if buf.len() > before {
            stalls = 0; // made progress this attempt
        } else {
            stalls += 1;
            if stalls >= RESUME_MAX_STALLS {
                return Err("blob download failed: too many interruptions".into());
            }
        }
    }
}

struct Session {
    base_url: String,
    relay_fp: String,
    /// base64 relay identity (Ed25519) public key — verifies KT root signatures.
    identity_pub: String,
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
    #[serde(rename = "identityPubKey", default)]
    identity_pub_key: String,
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

/// One emote as the picker consumes it. `url` is absolute **against this
/// relay** — the whole point of the proxy is that no client ever resolves a
/// third-party CDN host.
#[derive(serde::Serialize)]
pub struct EmoteSearchResult {
    pub id: String,
    pub name: String,
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub animated: bool,
}

#[derive(serde::Serialize)]
pub struct EmoteSearchResponse {
    pub results: Vec<EmoteSearchResult>,
    pub next: Option<String>,
}

/// The relay's own shape (its `url` is a site-relative capability path).
#[derive(serde::Deserialize)]
struct RawEmoteSearch {
    #[serde(default)]
    results: Vec<RawEmote>,
    #[serde(default)]
    next: Option<String>,
}

#[derive(serde::Deserialize)]
struct RawEmote {
    id: String,
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    width: i64,
    #[serde(default)]
    height: i64,
    #[serde(default)]
    animated: bool,
}

/// Validate the relay-supplied image path before it becomes a URL the webview
/// will load. **The relay does not get to choose the origin**: only a
/// site-relative `/api/relay/emote/<sig>/<id>.webp` for the emote actually being
/// described is accepted, so a compromised or hostile relay cannot hand back a
/// third-party CDN link and re-create exactly the IP leak the proxy exists to
/// prevent. Also drops anything whose id/name the client would refuse to render
/// anyway. Returns the path to join onto the relay base, or None to drop the
/// result.
fn emote_url_path(url: &str, id: &str, name: &str) -> Option<String> {
    if !crate::emoji::valid_emote_id(id) || !crate::emoji::valid_emote_name(name) {
        return None;
    }
    let rest = url.strip_prefix("/api/relay/emote/")?;
    let (sig, file) = rest.split_once('/')?;
    // The capability must be an opaque base64url token, and the file must be
    // the emote we were told this result is.
    if sig.is_empty()
        || sig.len() > 64
        || !sig
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || file != format!("{id}.webp")
    {
        return None;
    }
    Some(format!("/api/relay/emote/{sig}/{id}.webp"))
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
            identity_pub: info.identity_pub_key,
            token,
            expires_at,
        });
        Ok(())
    }

    /// Bootstrap this device's account: create it and enroll the device in one
    /// call, then store the returned bearer as our live session (so a following
    /// `connect` is unnecessary — we're authed immediately). `invite_token` is
    /// required on an invite-only relay. `handle` is the Word#1234 the user picked
    /// from the client-generated candidates (the relay validates + claims it).
    /// Returns the server-assigned handle.
    pub async fn register(
        &self,
        base_url: &str,
        signing: &SigningKey,
        invite_token: Option<&str>,
        handle: Option<&str>,
    ) -> Result<String, String> {
        let http = reqwest::Client::new();
        let base = base_url.trim_end_matches('/').to_string();

        let info: InfoResponse = http
            .get(format!("{base}/api/relay/info"))
            .send()
            .await
            .map_err(|e| format!("relay unreachable: {e}"))?
            .json()
            .await
            .map_err(|e| format!("bad relay info: {e}"))?;

        let mut body = serde_json::json!({
            "pubKey": device_public_key_b64(signing),
            "name": "Accord device",
        });
        if let Some(tok) = invite_token {
            body["inviteToken"] = serde_json::json!(tok);
        }
        if let Some(h) = handle {
            body["handle"] = serde_json::json!(h);
        }
        let res = http
            .post(format!("{base}/api/relay/register"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("registration failed: {e}"))?;
        if !res.status().is_success() {
            // Surface the relay's own message (e.g. "an invite is required")
            // so onboarding can show why registration was refused.
            let status = res.status();
            let msg = res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("HTTP {status}"));
            return Err(format!("registration refused: {msg}"));
        }

        #[derive(serde::Deserialize)]
        struct RegisterResponse {
            handle: String,
            token: String,
            #[serde(rename = "expiresInSec")]
            expires_in_sec: u64,
        }
        let reg: RegisterResponse =
            res.json().await.map_err(|e| format!("bad register response: {e}"))?;

        *self.session.lock().unwrap() = Some(Session {
            base_url: base,
            relay_fp: info.identity_fingerprint,
            identity_pub: info.identity_pub_key,
            token: reg.token,
            expires_at: Instant::now() + Duration::from_secs(reg.expires_in_sec),
        });
        Ok(reg.handle)
    }

    /// The account's first authed leg of the D4b handshake (invite signups only):
    /// deliver the sealed friend-accept to whoever invited us. Returns whether the
    /// relay actually delivered it (false = no pending inviter / already claimed).
    pub async fn register_friend_accept(
        &self,
        signing: &SigningKey,
        envelope: Vec<u8>,
    ) -> Result<bool, String> {
        use base64::Engine as _;
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/register/friend-accept"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({
                "envelope": base64::engine::general_purpose::STANDARD.encode(&envelope),
            }))
            .send()
            .await
            .map_err(|e| format!("friend-accept delivery failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("friend-accept refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            delivered: bool,
        }
        let body: Resp = res.json().await.map_err(|e| format!("bad friend-accept response: {e}"))?;
        Ok(body.delivered)
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

    /// base64 relay identity public key (verifies KT root signatures), if known.
    pub fn relay_identity_pub(&self) -> Option<String> {
        let guard = self.session.lock().unwrap();
        guard.as_ref().map(|s| s.identity_pub.clone()).filter(|k| !k.is_empty())
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

    /// Change my public handle (device-authed). Returns the server-confirmed
    /// handle. The relay refreshes the KT root; friends are unaffected (they
    /// address me by identity key + delivery token).
    pub async fn change_handle(&self, signing: &SigningKey, handle: &str) -> Result<String, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/handle"))
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "handle": handle }))
            .send()
            .await
            .map_err(|e| format!("handle change failed: {e}"))?;
        if !res.status().is_success() {
            let status = res.status();
            let msg = res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("HTTP {status}"));
            return Err(format!("handle change refused: {msg}"));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            handle: String,
        }
        let body: Resp = res.json().await.map_err(|e| format!("bad handle response: {e}"))?;
        Ok(body.handle)
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

    /// Fetch a group's current signed state record (D14, member device-authed).
    pub async fn group_state_get(
        &self,
        signing: &SigningKey,
        group_id: &str,
    ) -> Result<(String, i64), String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .get(format!("{base}/api/relay/groups/{group_id}/state"))
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| format!("group state get failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("group state unavailable (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            record: String,
            version: i64,
        }
        let body: Resp = res.json().await.map_err(|e| format!("bad group state: {e}"))?;
        Ok((body.record, body.version))
    }

    // ---- v8 voice SFU control proxy (spec/voice.md § v8) ----
    // The webview's mediasoup-client can't hold the device token (keys stay in
    // the core), so its SFU control calls are proxied here — device-token authed
    // — while media/RTP flows webview↔SFU directly. Payloads are opaque mediasoup
    // blobs (serde_json::Value passthrough); the relay + mediasoup-client agree
    // on their shape.

    /// Join a call's SFU room → `{ routerRtpCapabilities, peers }`.
    pub async fn sfu_join(&self, signing: &SigningKey, call_id: &str) -> Result<serde_json::Value, String> {
        self.sfu_post(signing, call_id, "join", None).await
    }

    /// Create a WebRtcTransport (`direction` = send|recv) → its ICE/DTLS params.
    pub async fn sfu_transport(
        &self,
        signing: &SigningKey,
        call_id: &str,
        direction: &str,
    ) -> Result<serde_json::Value, String> {
        self.sfu_post(signing, call_id, "transport", Some(serde_json::json!({ "direction": direction }))).await
    }

    /// Connect a transport (DTLS handshake).
    pub async fn sfu_connect(
        &self,
        signing: &SigningKey,
        call_id: &str,
        transport_id: &str,
        dtls_parameters: serde_json::Value,
    ) -> Result<(), String> {
        self.sfu_post(
            signing,
            call_id,
            "transport/connect",
            Some(serde_json::json!({ "transportId": transport_id, "dtlsParameters": dtls_parameters })),
        )
        .await
        .map(|_| ())
    }

    /// Produce mic audio → `{ producerId }`.
    pub async fn sfu_produce(
        &self,
        signing: &SigningKey,
        call_id: &str,
        transport_id: &str,
        rtp_parameters: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.sfu_post(
            signing,
            call_id,
            "produce",
            Some(serde_json::json!({ "transportId": transport_id, "rtpParameters": rtp_parameters })),
        )
        .await
    }

    /// Consume a peer's producer → `{ id, rtpParameters }`.
    pub async fn sfu_consume(
        &self,
        signing: &SigningKey,
        call_id: &str,
        transport_id: &str,
        producer_id: &str,
        rtp_capabilities: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.sfu_post(
            signing,
            call_id,
            "consume",
            Some(serde_json::json!({
                "transportId": transport_id, "producerId": producer_id, "rtpCapabilities": rtp_capabilities,
            })),
        )
        .await
    }

    /// Leave the call's SFU room.
    pub async fn sfu_leave(&self, signing: &SigningKey, call_id: &str) -> Result<(), String> {
        self.sfu_post(signing, call_id, "leave", None).await.map(|_| ())
    }

    /// Shared device-token-authed POST to an SFU room subpath; returns the JSON
    /// body (or Null for empty responses).
    async fn sfu_post(
        &self,
        signing: &SigningKey,
        call_id: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let mut req = reqwest::Client::new()
            .post(format!("{base}/api/relay/voice/rooms/{call_id}/{path}"))
            .bearer_auth(bearer);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| format!("sfu {path} failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("sfu {path} refused (HTTP {})", res.status()));
        }
        Ok(res.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null))
    }

    // ---- 7TV emote content proxy (spec/relay.md § content proxies) ----
    // The relay makes the outbound request so no client IP ever reaches 7TV.
    // Both legs run through the core for the same reason the SFU calls do: the
    // device token stays on this side of the IPC boundary.

    /// Proxied emote search. An empty query returns the relay's top emotes —
    /// the picker's default set. Image URLs come back **absolute against this
    /// relay**; results the relay describes badly are dropped, not rendered.
    pub async fn emote_search(
        &self,
        signing: &SigningKey,
        query: &str,
        page: u32,
        limit: u32,
    ) -> Result<EmoteSearchResponse, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .get(format!("{base}/api/relay/emotes/search"))
            .bearer_auth(bearer)
            .query(&[
                ("q", query.to_string()),
                ("page", page.to_string()),
                ("limit", limit.to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("emote search failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("emote search refused (HTTP {})", res.status()));
        }
        let body: RawEmoteSearch = res
            .json()
            .await
            .map_err(|e| format!("bad emote search response: {e}"))?;
        let results = body
            .results
            .into_iter()
            .filter_map(|e| {
                let path = emote_url_path(&e.url, &e.id, &e.name)?;
                Some(EmoteSearchResult {
                    id: e.id,
                    name: e.name,
                    url: format!("{base}{path}"),
                    width: e.width,
                    height: e.height,
                    animated: e.animated,
                })
            })
            .collect();
        Ok(EmoteSearchResponse { results, next: body.next })
    }

    /// Fetch one emote's image bytes through the relay. The capability segment
    /// only exists so an `<img src>` can authenticate; the core has the device
    /// token, which the relay accepts as the alternative credential, so a
    /// content-encountered emote needs no search round-trip first.
    pub async fn emote_image(&self, signing: &SigningKey, id: &str) -> Result<(Vec<u8>, String), String> {
        use futures_util::StreamExt as _;
        if !crate::emoji::valid_emote_id(id) {
            return Err("invalid emote id".into());
        }
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .get(format!("{base}/api/relay/emote/device/{id}.webp"))
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| format!("emote fetch failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("emote fetch refused (HTTP {})", res.status()));
        }
        let mime = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or(v).trim().to_ascii_lowercase())
            .unwrap_or_default();
        if !mime.starts_with("image/") {
            return Err("emote response was not an image".into());
        }
        // Streamed cap, not a trusted content-length: a relay that ignores its
        // own 1 MiB ceiling must not be able to stream this device out of disk
        // or memory.
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("emote fetch interrupted: {e}"))?;
            if buf.len() + bytes.len() > crate::emoji::MAX_EMOTE_BYTES {
                return Err("emote image too large".into());
            }
            buf.extend_from_slice(&bytes);
        }
        if buf.is_empty() {
            return Err("emote image was empty".into());
        }
        Ok((buf, mime))
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

    /// Upload attachment ciphertext to a friend's DM blob store (D6): authorized
    /// by the recipient's delivery token (sender-anonymous). Returns the blobId.
    pub async fn blob_upload(
        &self,
        recipient_handle: &str,
        delivery_token: &str,
        ciphertext: Vec<u8>,
    ) -> Result<String, String> {
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/blobs"))
            .header("content-type", "application/octet-stream")
            .header("x-delivery-token", delivery_token)
            .header("x-recipient-handle", recipient_handle)
            .body(ciphertext)
            .send()
            .await
            .map_err(|e| format!("blob upload failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("blob upload refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "blobId")]
            blob_id: String,
        }
        Ok(res.json::<Resp>().await.map_err(|e| format!("bad blob resp: {e}"))?.blob_id)
    }

    /// Fetch a handle's KT key-history proof for self-audit (D5, full-AKD only;
    /// unauthenticated — KT is public). Returns the serde-JSON proof + the epoch,
    /// root, and VRF public key the client verifies it against.
    pub async fn directory_history(&self, handle: &str) -> Result<KtHistory, String> {
        let base = self.base_url()?;
        let mut url = reqwest::Url::parse(&format!("{base}/api/relay/directory"))
            .map_err(|e| format!("bad relay url: {e}"))?;
        // `push` percent-encodes the segment (handles contain '#').
        url.path_segments_mut()
            .map_err(|_| "relay url cannot be a base".to_string())?
            .push(handle)
            .push("history");
        let res = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("kt history fetch failed: {e}"))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("no key history for handle (interim KT or unknown)".into());
        }
        if !res.status().is_success() {
            return Err(format!("kt history refused (HTTP {})", res.status()));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| format!("bad kt history: {e}"))?;
        Ok(KtHistory {
            proof_json: v.get("proof").map(|p| p.to_string()).unwrap_or_default(),
            epoch: v.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0),
            root: v.get("rootHash").and_then(|r| r.as_str()).unwrap_or_default().to_string(),
            vrf_public_key: v.get("vrfPublicKey").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
        })
    }

    /// Look a handle up in the relay's key directory (D5). Unauthenticated — the
    /// directory and its proofs are public. `Ok(None)` means the relay answered
    /// **404**: it claims the handle has no entry (see
    /// key-transparency.md — that is "unverified", never "verified").
    ///
    /// Nothing here is trusted: the caller verifies the returned root's relay
    /// signature *first* and only then runs the inclusion proof against it.
    pub async fn directory_lookup(&self, handle: &str) -> Result<Option<DirectoryEntry>, String> {
        let base = self.base_url()?;
        let mut url = reqwest::Url::parse(&format!("{base}/api/relay/directory"))
            .map_err(|e| format!("bad relay url: {e}"))?;
        // `push` percent-encodes the segment (handles contain '#').
        url.path_segments_mut()
            .map_err(|_| "relay url cannot be a base".to_string())?
            .push(handle);
        let res = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("directory lookup failed: {e}"))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(format!("directory lookup refused (HTTP {})", res.status()));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| format!("bad directory entry: {e}"))?;
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        Ok(Some(DirectoryEntry {
            identity_pub_b64: s("identityPubKey"),
            sealing_pub_b64: s("sealingPubKey"),
            epoch: v.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0),
            root: s("rootHash"),
            proof_json: v.get("proof").map(|p| p.to_string()).unwrap_or_default(),
            vrf_public_key: s("vrfPublicKey"),
            kt: v.get("kt").and_then(|k| k.as_str()).map(str::to_string),
        }))
    }

    /// The relay's signed KT epoch roots since `since` (0 = all). Unauthenticated
    /// (KT roots are public). Signatures are **not** checked here — that is
    /// `kt::signed_root_epoch`'s job, against the pinned relay identity key.
    pub async fn kt_roots(&self, since: i64) -> Result<Vec<SignedRoot>, String> {
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .get(format!("{base}/api/relay/kt/roots?since={since}"))
            .send()
            .await
            .map_err(|e| format!("kt roots fetch failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("kt roots refused (HTTP {})", res.status()));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| format!("bad kt roots: {e}"))?;
        let rows = v.get("roots").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        Ok(rows
            .iter()
            .map(|r| SignedRoot {
                epoch: r.get("epoch").and_then(|e| e.as_i64()).unwrap_or(0),
                root: r.get("rootHash").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
                prev: r.get("prevRootHash").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
                sig: r.get("signature").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
            })
            .collect())
    }

    /// Fetch the relay's latest signed KT epoch root (for gossip). `None` if the
    /// log is empty.
    pub async fn latest_kt_root(&self) -> Result<Option<SignedRoot>, String> {
        let mut roots = self.kt_roots(0).await?;
        Ok(roots.pop())
    }

    /// Download attachment ciphertext (device-authed; only the recipient).
    /// Resumable: if the transport drops mid-body it reconnects from where it
    /// left off (D6 large-media follow-up — see `download_resumable`).
    pub async fn blob_download(&self, signing: &SigningKey, blob_id: &str) -> Result<Vec<u8>, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        download_resumable(&format!("{base}/api/relay/blobs/{blob_id}"), &bearer).await
    }

    /// Upload a group attachment blob (group-token authed, D6/D14).
    pub async fn group_blob_upload(
        &self,
        group_id: &str,
        group_token: &str,
        ciphertext: Vec<u8>,
    ) -> Result<String, String> {
        let base = self.base_url()?;
        let res = reqwest::Client::new()
            .post(format!("{base}/api/relay/groups/{group_id}/blobs"))
            .header("content-type", "application/octet-stream")
            .header("x-group-token", group_token)
            .body(ciphertext)
            .send()
            .await
            .map_err(|e| format!("group blob upload failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("group blob upload refused (HTTP {})", res.status()));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "blobId")]
            blob_id: String,
        }
        Ok(res.json::<Resp>().await.map_err(|e| format!("bad group blob resp: {e}"))?.blob_id)
    }

    /// Download a group attachment blob (device-authed member, D6/D14).
    pub async fn group_blob_download(
        &self,
        signing: &SigningKey,
        group_id: &str,
        blob_id: &str,
    ) -> Result<Vec<u8>, String> {
        let bearer = self.bearer(signing).await?;
        let base = self.base_url()?;
        download_resumable(
            &format!("{base}/api/relay/groups/{group_id}/blobs/{blob_id}"),
            &bearer,
        )
        .await
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

    /// A hostile or compromised relay must not be able to point the webview at
    /// a third-party host — that would re-create the exact IP leak the emote
    /// proxy exists to prevent.
    #[test]
    fn emote_urls_are_pinned_to_the_relay_origin() {
        let id = "01H8XYZABCDEFGHJKMNPQRSTVW";
        let good = format!("/api/relay/emote/AbC_-123/{id}.webp");
        assert_eq!(
            emote_url_path(&good, id, "pepeLaugh").as_deref(),
            Some(good.as_str())
        );

        for bad in [
            format!("https://cdn.7tv.app/emote/{id}/2x.webp"),
            format!("//cdn.7tv.app/api/relay/emote/sig/{id}.webp"),
            format!("http://evil.example/api/relay/emote/sig/{id}.webp"),
            format!("/api/relay/emote/../../evil/{id}.webp"),
            format!("/api/relay/emote/sig/{id}.webp?x=https://evil.example"),
            "/api/relay/emote/sig/01H8XYZABCDEFGHJKMNPQRSTVX.webp".to_string(), // id mismatch
            format!("/api/relay/og?url=https://evil.example/{id}.webp"),
        ] {
            assert!(
                emote_url_path(&bad, id, "pepeLaugh").is_none(),
                "must reject {bad}"
            );
        }

        // Ids and names the client would refuse to render are dropped up front.
        assert!(emote_url_path(&good, id, "not a name").is_none());
        assert!(emote_url_path("/api/relay/emote/sig/x.webp", "x", "ok").is_none());
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
