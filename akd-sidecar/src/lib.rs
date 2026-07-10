//! v8 key-transparency directory backed by Meta's **`akd`** (AKD/CONIKS) — the
//! full-AKD upgrade over the relay's interim Merkle KT (see
//! `spec/key-transparency.md`). This is the directory *engine*; the Node relay
//! drives it over a localhost API (added in a later slice), and clients verify
//! its proofs via `akd_core` (native: direct Rust dep; web: WASM).
//!
//! First slice: an **in-memory** directory wrapping `akd::Directory` with the
//! production `WhatsAppV1Configuration`, exposing `publish` (handle → identity
//! key, one epoch per batch) and `lookup` (a VRF-blinded inclusion proof) plus
//! the VRF public key. Storage is in-memory for now — a persistent `Database`
//! impl over the relay's SQLite and a **real (persisted) VRF key** (vs the
//! `HardCodedAkdVRF` used here and in akd's own examples) are follow-up slices
//! and are REQUIRED before this is production-safe.

use std::sync::Arc;

use akd::append_only_zks::AzksParallelismConfig;
use akd::directory::Directory;
use akd::ecvrf::HardCodedAkdVRF;
use akd::errors::AkdError;
use akd::storage::memory::AsyncInMemoryDatabase;
use akd::storage::StorageManager;
use akd::{AkdLabel, AkdValue, AppendOnlyProof, Digest, EpochHash, HistoryParams, HistoryProof, LookupProof};
use axum::extract::{Path, State};
use axum::http::{header::AUTHORIZATION, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{middleware, Json, Router};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Hash/label configuration — the same one WhatsApp KT runs in production.
pub type Config = akd::WhatsAppV1Configuration;

/// A key-transparency directory: `handle → identity pubkey`, with per-lookup
/// inclusion proofs and VRF-blinded labels.
pub struct KtDirectory {
    dir: Directory<Config, AsyncInMemoryDatabase, HardCodedAkdVRF>,
}

impl KtDirectory {
    /// Create an empty in-memory directory.
    pub async fn new() -> Result<Self, AkdError> {
        let storage = StorageManager::new_no_cache(AsyncInMemoryDatabase::new());
        let dir =
            Directory::<Config, _, _>::new(storage, HardCodedAkdVRF {}, AzksParallelismConfig::default())
                .await?;
        Ok(Self { dir })
    }

    /// Publish a batch of `handle → identity-key` bindings as one new epoch.
    /// Returns `(epoch, root_hash)` — the signed root the relay chains + serves.
    pub async fn publish(&mut self, entries: Vec<(String, Vec<u8>)>) -> Result<(u64, Digest), AkdError> {
        let updates = entries
            .into_iter()
            .map(|(handle, key)| (AkdLabel(handle.into_bytes()), AkdValue(key)))
            .collect();
        let EpochHash(epoch, root) = self.dir.publish(updates).await?;
        Ok((epoch, root))
    }

    /// Produce an inclusion/lookup proof for a handle at the current epoch,
    /// alongside the epoch's `(epoch, root_hash)` the client verifies against.
    pub async fn lookup(&self, handle: &str) -> Result<(LookupProof, EpochHash), AkdError> {
        self.dir.lookup(AkdLabel::from(handle)).await
    }

    /// The VRF public key bytes clients need to verify label blinding.
    pub async fn vrf_public_key(&self) -> Result<Vec<u8>, AkdError> {
        Ok(self.dir.get_public_key().await?.as_bytes().to_vec())
    }

    /// Append-only (consistency) proof that the directory only *grew* from
    /// epoch `start` to `end` — verified against the per-epoch root hashes
    /// (`akd::auditor::audit_verify`). This is the guarantee the interim Merkle
    /// KT can't provide.
    pub async fn audit(&self, start: u64, end: u64) -> Result<AppendOnlyProof, AkdError> {
        self.dir.audit(start, end).await
    }

    /// Complete key-history proof for a handle (self-audit: every version the
    /// log ever mapped it to), with the current `(epoch, root)`.
    pub async fn key_history(&self, handle: &str) -> Result<(HistoryProof, EpochHash), AkdError> {
        self.dir.key_history(&AkdLabel::from(handle), HistoryParams::Complete).await
    }
}

// ---- HTTP sidecar (localhost API the Node relay calls) ----
// The relay proxies publish (on directory PUT) + lookup (per fetch) here; media
// is unrelated. Proofs are serialized with serde JSON so both client verifiers
// (native `akd_core`, web WASM `akd_core`) can deserialize them uniformly (the
// protobuf wire format is std-only and wouldn't work in the nostd WASM build).

#[derive(Clone)]
struct AppState {
    kt: Arc<Mutex<KtDirectory>>,
    /// Shared secret the relay presents (Bearer). `None` disables the check
    /// (tests) — production always sets one, since even a localhost API must not
    /// be drivable by a co-tenant.
    token: Arc<Option<String>>,
}

#[derive(Deserialize)]
struct PublishReq {
    entries: Vec<PublishEntry>,
}
#[derive(Deserialize)]
struct PublishEntry {
    handle: String,
    /// base64 identity pubkey bytes.
    key: String,
}
#[derive(Serialize)]
struct PublishResp {
    epoch: u64,
    /// base64 signed root hash for the new epoch.
    root: String,
}
#[derive(Serialize)]
struct LookupResp {
    /// serde-serialized `LookupProof` (the client deserializes + verifies it).
    proof: LookupProof,
    epoch: u64,
    root: String,
}
#[derive(Serialize)]
struct VrfKeyResp {
    /// base64 VRF public key.
    key: String,
}
#[derive(Serialize)]
struct AuditResp {
    /// serde-serialized `AppendOnlyProof`; the caller verifies it against the
    /// per-epoch root hashes it already holds (from the roots endpoint).
    proof: AppendOnlyProof,
}
#[derive(Serialize)]
struct HistoryResp {
    /// serde-serialized `HistoryProof`.
    proof: HistoryProof,
    epoch: u64,
    root: String,
}

/// Build the sidecar router over a shared directory. `token` (if set) is the
/// Bearer secret every request must present.
pub fn router(kt: Arc<Mutex<KtDirectory>>, token: Option<String>) -> Router {
    let state = AppState { kt, token: Arc::new(token) };
    Router::new()
        .route("/publish", post(publish))
        .route("/lookup/:handle", get(lookup))
        .route("/vrf-public-key", get(vrf_key))
        .route("/audit/:start/:end", get(audit))
        .route("/key-history/:handle", get(key_history))
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state)
}

async fn require_token(
    State(st): State<AppState>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> Result<Response, StatusCode> {
    if let Some(expected) = st.token.as_ref() {
        let presented = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
        if presented != Some(format!("Bearer {expected}").as_str()) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(req).await)
}

type ApiErr = (StatusCode, String);

async fn publish(State(st): State<AppState>, Json(req): Json<PublishReq>) -> Result<Json<PublishResp>, ApiErr> {
    let mut entries = Vec::with_capacity(req.entries.len());
    for e in req.entries {
        let key = B64.decode(&e.key).map_err(|_| (StatusCode::BAD_REQUEST, "bad base64 key".into()))?;
        entries.push((e.handle, key));
    }
    let mut kt = st.kt.lock().await;
    let (epoch, root) = kt.publish(entries).await.map_err(server_err)?;
    Ok(Json(PublishResp { epoch, root: B64.encode(root) }))
}

async fn lookup(State(st): State<AppState>, Path(handle): Path<String>) -> Result<Json<LookupResp>, ApiErr> {
    let kt = st.kt.lock().await;
    // A lookup for an absent/unpublished handle can't be proven → 404.
    let (proof, epoch_hash) = kt
        .lookup(&handle)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(Json(LookupResp { proof, epoch: epoch_hash.epoch(), root: B64.encode(epoch_hash.hash()) }))
}

async fn vrf_key(State(st): State<AppState>) -> Result<Json<VrfKeyResp>, ApiErr> {
    let kt = st.kt.lock().await;
    let key = kt.vrf_public_key().await.map_err(server_err)?;
    Ok(Json(VrfKeyResp { key: B64.encode(key) }))
}

async fn audit(State(st): State<AppState>, Path((start, end)): Path<(u64, u64)>) -> Result<Json<AuditResp>, ApiErr> {
    let kt = st.kt.lock().await;
    let proof = kt.audit(start, end).await.map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(AuditResp { proof }))
}

async fn key_history(State(st): State<AppState>, Path(handle): Path<String>) -> Result<Json<HistoryResp>, ApiErr> {
    let kt = st.kt.lock().await;
    let (proof, epoch_hash) = kt
        .key_history(&handle)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(Json(HistoryResp { proof, epoch: epoch_hash.epoch(), root: B64.encode(epoch_hash.hash()) }))
}

fn server_err(e: AkdError) -> ApiErr {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Publish a binding, then prove + verify a lookup exactly as a client
    /// would (akd::client::lookup_verify against the epoch root + VRF pubkey).
    #[tokio::test]
    async fn publish_then_lookup_proof_verifies() {
        let mut kt = KtDirectory::new().await.unwrap();
        let key = vec![7u8; 32]; // an Ed25519 identity pubkey
        let (epoch, _root) = kt.publish(vec![("Alice#0001".into(), key.clone())]).await.unwrap();
        assert_eq!(epoch, 1);

        let (proof, epoch_hash) = kt.lookup("Alice#0001").await.unwrap();
        let vrf_pub = kt.vrf_public_key().await.unwrap();

        let result = akd::client::lookup_verify::<Config>(
            &vrf_pub,
            epoch_hash.hash(),
            epoch_hash.epoch(),
            AkdLabel::from("Alice#0001"),
            proof,
        )
        .expect("lookup proof should verify");

        // The verified value is exactly the published identity key.
        assert_eq!(result.value, AkdValue(key));
        assert_eq!(result.epoch, 1);
        assert_eq!(result.version, 1);
    }

    /// A lookup proof from one label must NOT verify against a different label
    /// (VRF-blinded: the proof is bound to its specific handle).
    #[tokio::test]
    async fn a_proof_does_not_verify_for_another_handle() {
        let mut kt = KtDirectory::new().await.unwrap();
        kt.publish(vec![
            ("Alice#0001".into(), vec![1u8; 32]),
            ("Bob#0002".into(), vec![2u8; 32]),
        ])
        .await
        .unwrap();

        let (proof, epoch_hash) = kt.lookup("Alice#0001").await.unwrap();
        let vrf_pub = kt.vrf_public_key().await.unwrap();

        // Verifying Alice's proof under Bob's label fails.
        let forged = akd::client::lookup_verify::<Config>(
            &vrf_pub,
            epoch_hash.hash(),
            epoch_hash.epoch(),
            AkdLabel::from("Bob#0002"),
            proof,
        );
        assert!(forged.is_err(), "a proof must not verify for a different handle");
    }

    /// Each publish advances the epoch (chained roots).
    #[tokio::test]
    async fn publishing_advances_the_epoch() {
        let mut kt = KtDirectory::new().await.unwrap();
        let (e1, r1) = kt.publish(vec![("Alice#0001".into(), vec![1u8; 32])]).await.unwrap();
        let (e2, r2) = kt.publish(vec![("Bob#0002".into(), vec![2u8; 32])]).await.unwrap();
        assert_eq!(e1, 1);
        assert_eq!(e2, 2);
        assert_ne!(r1, r2); // the root moves as the directory grows
    }

    /// The append-only (consistency) proof verifies epoch 2 extends epoch 1 —
    /// the guarantee the interim Merkle KT can't give.
    #[tokio::test]
    async fn audit_proof_verifies_append_only_between_epochs() {
        let mut kt = KtDirectory::new().await.unwrap();
        let (_e1, r1) = kt.publish(vec![("Alice#0001".into(), vec![1u8; 32])]).await.unwrap();
        let (_e2, r2) = kt.publish(vec![("Bob#0002".into(), vec![2u8; 32])]).await.unwrap();
        let proof = kt.audit(1, 2).await.unwrap();
        akd::auditor::audit_verify::<Config>(vec![r1, r2], proof)
            .await
            .expect("append-only proof should verify against the two epoch roots");
    }

    /// A key-history proof surfaces every version the log mapped a handle to.
    #[tokio::test]
    async fn key_history_proof_shows_every_version() {
        let mut kt = KtDirectory::new().await.unwrap();
        kt.publish(vec![("Alice#0001".into(), vec![1u8; 32])]).await.unwrap(); // v1 @ epoch 1
        kt.publish(vec![("Alice#0001".into(), vec![9u8; 32])]).await.unwrap(); // v2 @ epoch 2

        let (proof, eh) = kt.key_history("Alice#0001").await.unwrap();
        let vrf = kt.vrf_public_key().await.unwrap();
        let results = akd::client::key_history_verify::<Config>(
            &vrf,
            eh.hash(),
            eh.epoch(),
            AkdLabel::from("Alice#0001"),
            proof,
            akd::HistoryVerificationParams::default(),
        )
        .expect("history proof should verify");
        // Both the original and the rotated key are proven in the history.
        assert!(results.iter().any(|r| r.value == AkdValue(vec![1u8; 32])));
        assert!(results.iter().any(|r| r.value == AkdValue(vec![9u8; 32])));
    }

    // ---- HTTP layer ----
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    async fn send(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    fn authed(method: &str, uri: &str, body: Option<serde_json::Value>) -> Request<Body> {
        let mut b = Request::builder().method(method).uri(uri).header(AUTHORIZATION, "Bearer secret");
        let body = match body {
            Some(v) => {
                b = b.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        b.body(body).unwrap()
    }

    #[tokio::test]
    async fn http_publish_lookup_roundtrips_and_the_proof_verifies() {
        let kt = Arc::new(Mutex::new(KtDirectory::new().await.unwrap()));
        let app = router(kt, Some("secret".into()));

        let key = B64.encode([9u8; 32]);
        let (st, _) = send(
            &app,
            authed("POST", "/publish", Some(serde_json::json!({ "entries": [{ "handle": "Alice#0001", "key": key }] }))),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        let (st, look) = send(&app, authed("GET", "/lookup/Alice%230001", None)).await;
        assert_eq!(st, StatusCode::OK);
        let (_, vrf) = send(&app, authed("GET", "/vrf-public-key", None)).await;

        // Reconstruct the client's view purely from the JSON wire responses and
        // verify — proving the serde wire format round-trips into a real proof.
        let proof: LookupProof = serde_json::from_value(look["proof"].clone()).unwrap();
        let root: Digest = B64
            .decode(look["root"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let epoch = look["epoch"].as_u64().unwrap();
        let vrf_pub = B64.decode(vrf["key"].as_str().unwrap()).unwrap();

        let result = akd::client::lookup_verify::<Config>(
            &vrf_pub,
            root,
            epoch,
            AkdLabel::from("Alice#0001"),
            proof,
        )
        .expect("wire-serialized proof should verify");
        assert_eq!(result.value, AkdValue(vec![9u8; 32]));
    }

    #[tokio::test]
    async fn http_requires_the_bearer_token() {
        let kt = Arc::new(Mutex::new(KtDirectory::new().await.unwrap()));
        let app = router(kt, Some("secret".into()));
        // No auth header → 401.
        let req = Request::builder().method("GET").uri("/vrf-public-key").body(Body::empty()).unwrap();
        let (st, _) = send(&app, req).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        // Wrong token → 401.
        let bad = Request::builder()
            .method("GET")
            .uri("/vrf-public-key")
            .header(AUTHORIZATION, "Bearer nope")
            .body(Body::empty())
            .unwrap();
        let (st, _) = send(&app, bad).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn http_audit_and_key_history_endpoints_serve_proofs() {
        let kt = Arc::new(Mutex::new(KtDirectory::new().await.unwrap()));
        let app = router(kt, Some("secret".into()));
        for key in [[1u8; 32], [9u8; 32]] {
            send(
                &app,
                authed("POST", "/publish", Some(serde_json::json!({ "entries": [{ "handle": "Alice#0001", "key": B64.encode(key) }] }))),
            )
            .await;
        }
        let (st, audit) = send(&app, authed("GET", "/audit/1/2", None)).await;
        assert_eq!(st, StatusCode::OK);
        assert!(audit.get("proof").is_some());

        let (st, hist) = send(&app, authed("GET", "/key-history/Alice%230001", None)).await;
        assert_eq!(st, StatusCode::OK);
        assert!(hist.get("proof").is_some());
        assert_eq!(hist["epoch"].as_u64().unwrap(), 2);
    }

    #[tokio::test]
    async fn http_lookup_of_an_unpublished_handle_is_404() {
        let kt = Arc::new(Mutex::new(KtDirectory::new().await.unwrap()));
        let app = router(kt, Some("secret".into()));
        // Publish someone so the tree has an epoch, then look up a different one.
        send(
            &app,
            authed("POST", "/publish", Some(serde_json::json!({ "entries": [{ "handle": "Alice#0001", "key": B64.encode([1u8;32]) }] }))),
        )
        .await;
        let (st, _) = send(&app, authed("GET", "/lookup/Ghost%230000", None)).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }
}
