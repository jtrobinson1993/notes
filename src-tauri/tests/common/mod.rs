//! **The shared L2 harness: one installed core against a relay the test
//! controls byte for byte** (spec/testing.md § L2).
//!
//! The real Rust core — real vault, real `RelayClient`, the real
//! `mailbox_drain` — driven against a *hostile-capable* relay. That control is
//! the point: the claims under test are not "the happy path works" but "a relay
//! that lies is not believed" and "an envelope from the wrong person is not
//! obeyed", and neither is something a genuine `server/` process will ever do.
//!
//! Shared by `kt_contact_verify.rs` (the relay's own identity + contact keys)
//! and `group_invite_authz.rs` (who may hand me a group key). Not every case
//! uses every helper, hence the blanket `dead_code` allowance — each test binary
//! compiles its own copy of this module.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Write as _;
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};

use akd::append_only_zks::AzksParallelismConfig;
use akd::directory::Directory;
use akd::ecvrf::HardCodedAkdVRF;
use akd::storage::memory::AsyncInMemoryDatabase;
use akd::storage::StorageManager;
use akd::{AkdLabel, AkdValue};

use app_lib::store::Store;
use app_lib::vault::{Keychain, Vault};
use app_lib::{envelope, identity, message, relay_client::RelayClient};

pub const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub const MY_HANDLE: &str = "Me#0001";
pub const BOB_HANDLE: &str = "Bob#0002";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------- fake relay ---

/// How the fake relay answers `GET /api/relay/directory/:handle`.
#[derive(Clone)]
pub enum Directory404 {
    /// A full AKD answer: `(identityPubKey, epoch, rootHash, proof, vrf)`.
    Entry {
        identity_pub_b64: String,
        epoch: u64,
        root: String,
        proof_json: String,
        vrf: String,
    },
    /// "no such handle" — the relay claims the handle is not in the log.
    NotFound,
    /// The directory is broken/unreachable (5xx).
    Unavailable,
}

pub struct RelayState {
    pub directory: Directory404,
    /// The signed root chain served at `/api/relay/kt/roots`.
    pub roots: Vec<serde_json::Value>,
    /// Rows returned by the next mailbox fetch.
    pub mailbox: Vec<serde_json::Value>,
    /// Everything the client POSTed to `/api/relay/mailbox/send` — the
    /// "did it seal a reply back?" evidence.
    pub sends: Vec<serde_json::Value>,
    pub acked: Vec<i64>,
}

impl Default for RelayState {
    fn default() -> Self {
        RelayState {
            directory: Directory404::NotFound,
            roots: Vec::new(),
            mailbox: Vec::new(),
            sends: Vec::new(),
            acked: Vec::new(),
        }
    }
}

pub struct FakeRelay {
    pub base: String,
    /// What `/api/relay/info` advertises. Separately settable from the key that
    /// actually signs KT roots, so a test can serve an honest fingerprint next
    /// to a foreign key — the substitution the binding check exists to catch.
    info: Arc<Mutex<InfoView>>,
    /// The OFFLINE root. On a real relay this private half is in the operator's
    /// password manager and never on the server; here the test plays operator,
    /// which is what lets it mint the forged and rolled-back delegations that
    /// only an attacker would ever produce.
    root: SigningKey,
    state: Arc<Mutex<RelayState>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

/// The identity half of `GET /api/relay/info`, byte-controlled by the test.
#[derive(Clone)]
struct InfoView {
    /// `base64url(sha256(root pubkey))` — what clients pin.
    fingerprint: String,
    /// The **root** public key (standard base64).
    identity_pub_b64: String,
    /// The current root-signed delegation, and the whole published chain.
    delegation: serde_json::Value,
    delegations: Vec<serde_json::Value>,
}

impl FakeRelay {
    /// Spawn the relay on a throwaway port.
    ///
    /// `signing` is the **online** key — the delegated one that signs KT roots.
    /// The relay mints its own offline root (derived from `signing` so it is
    /// deterministic per test) and serves a valid v1 delegation naming
    /// `signing`. `/info` advertises the ROOT key and its genuine fingerprint
    /// until a test says otherwise (`serve_info` / `serve_delegation`).
    pub fn start(signing: SigningKey, state: RelayState) -> FakeRelay {
        let root = root_key_for(&signing);
        let identity_pub_b64 = B64.encode(root.verifying_key().to_bytes());
        let fingerprint = fingerprint_of(&identity_pub_b64);
        let delegation = delegation_json(&root, &fingerprint, 1, &signing);

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr: SocketAddr = listener.local_addr().unwrap();
        let info = Arc::new(Mutex::new(InfoView {
            fingerprint,
            identity_pub_b64,
            delegation: delegation.clone(),
            delegations: vec![delegation],
        }));
        let state = Arc::new(Mutex::new(state));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let server_state = Arc::clone(&state);
        let server_stop = Arc::clone(&stop);
        let server_info = Arc::clone(&info);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if server_stop.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let Ok(mut sock) = conn else { continue };
                let _ = handle_conn(&mut sock, &server_state, &server_info);
            }
        });

        FakeRelay { base: format!("http://{addr}"), info, root, state, stop }
    }

    /// A relay with an empty directory — enough to connect to.
    pub fn bare(signing: SigningKey) -> FakeRelay {
        FakeRelay::start(signing, RelayState::default())
    }

    /// The fingerprint the relay currently advertises.
    pub fn fingerprint(&self) -> String {
        self.info.lock().unwrap().fingerprint.clone()
    }

    /// The ROOT public key the relay serves as `identityPubKey`.
    pub fn root_pub_b64(&self) -> String {
        self.info.lock().unwrap().identity_pub_b64.clone()
    }

    /// Replace what `/api/relay/info` says about the relay's root identity. The
    /// delegation is left untouched, so a test that substitutes the identity is
    /// only ever exercising the binding/pin links.
    pub fn serve_info(&self, fingerprint: &str, identity_pub_b64: &str) {
        let mut info = self.info.lock().unwrap();
        info.fingerprint = fingerprint.into();
        info.identity_pub_b64 = identity_pub_b64.into();
    }

    /// Serve an arbitrary delegation + chain — how a test forges, tampers with,
    /// or rolls one back.
    pub fn serve_delegation(&self, current: serde_json::Value, chain: Vec<serde_json::Value>) {
        let mut info = self.info.lock().unwrap();
        info.delegation = current;
        info.delegations = chain;
    }

    /// Mint a genuine root-signed delegation at `version` naming `online`.
    pub fn mint_delegation(&self, version: i64, online: &SigningKey) -> serde_json::Value {
        delegation_json(&self.root, &self.fingerprint(), version, online)
    }

    /// The operator rotates the online key: a new root-signed delegation at
    /// `version`, appended to the published chain. Exactly what
    /// `npm run relay -- rotate-online-key` installs.
    pub fn rotate_online_key(&self, version: i64, online: &SigningKey) {
        let d = self.mint_delegation(version, online);
        let mut info = self.info.lock().unwrap();
        info.delegations.push(d.clone());
        info.delegation = d;
    }

    /// The delegation the relay currently advertises.
    pub fn current_delegation(&self) -> serde_json::Value {
        self.info.lock().unwrap().delegation.clone()
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut RelayState) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }
}

/// A deterministic offline root for an online key, so a test's relay identity is
/// reproducible without threading two keys through every call site.
pub fn root_key_for(online: &SigningKey) -> SigningKey {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"fake-relay-root");
    h.update(online.to_bytes());
    SigningKey::from_bytes(&h.finalize().into())
}

/// A root-signed delegation as JSON, byte-identical to what
/// `server/src/relayIdentity.ts::signDelegation` produces.
pub fn delegation_json(
    root: &SigningKey,
    root_fingerprint: &str,
    version: i64,
    online: &SigningKey,
) -> serde_json::Value {
    let online_key = B64.encode(online.verifying_key().to_bytes());
    // Fixed, not `now_ms()`: minting the same delegation twice must produce the
    // same bytes, or a chain assembled across two calls fails the "current is
    // the newest chain member" check on a millisecond boundary — a flake that
    // would look like a real refusal.
    let issued_at: i64 = 1_600_000_000_000; // 2020-09-13
    let not_after: i64 = 4_102_444_800_000; // 2100-01-01
    let payload = format!(
        "accord-relay-delegation|v1|{root_fingerprint}|{online_key}|{version}|{issued_at}|{not_after}"
    );
    serde_json::json!({
        "version": version,
        "onlineKey": online_key,
        "issuedAt": issued_at,
        "notAfter": not_after,
        "signature": B64.encode(root.sign(payload.as_bytes()).to_bytes()),
    })
}

/// `base64url(sha256(raw key))` — the relay's own definition of its
/// fingerprint (`server/src/relayAuth.ts::fingerprintB64url`), recomputed here
/// rather than imported so the test states the contract independently.
pub fn fingerprint_of(identity_pub_b64: &str) -> String {
    use sha2::{Digest, Sha256};
    let raw = B64.decode(identity_pub_b64).expect("standard base64 key");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(raw))
}

pub fn pub_b64(seed: u8) -> String {
    B64.encode(SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes())
}

impl Drop for FakeRelay {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        // Unblock `incoming()` so the thread notices the flag and exits.
        let _ = std::net::TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

/// Minimal HTTP/1.1: read one request, answer it, close. Enough for reqwest,
/// and it keeps the hostile-relay behaviour in plain sight rather than behind a
/// framework.
fn handle_conn(
    sock: &mut std::net::TcpStream,
    state: &Arc<Mutex<RelayState>>,
    info: &Arc<Mutex<InfoView>>,
) -> std::io::Result<()> {
    use std::io::Read as _;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let (head_end, mut body) = loop {
        let n = sock.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            break (pos + 4, buf[pos + 4..].to_vec());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let content_length = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim().eq_ignore_ascii_case("content-length")).then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while body.len() < content_length {
        let n = sock.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let path = target.split('?').next().unwrap_or_default().to_string();

    let (status, payload) = route(&method, &path, &body, state, info);
    let text = payload.to_string();
    write!(
        sock,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )?;
    sock.flush()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Percent-decode a path segment (handles carry a literal `#`).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn route(
    method: &str,
    path: &str,
    body: &serde_json::Value,
    state: &Arc<Mutex<RelayState>>,
    info: &Arc<Mutex<InfoView>>,
) -> (u16, serde_json::Value) {
    let ok = |v: serde_json::Value| (200u16, v);
    match (method, path) {
        ("GET", "/api/relay/info") => {
            let info = info.lock().unwrap().clone();
            ok(serde_json::json!({
                "identityFingerprint": info.fingerprint,
                "identityPubKey": info.identity_pub_b64,
                "delegation": info.delegation,
                "delegations": info.delegations,
            }))
        }
        ("POST", "/api/relay/auth/challenge") => ok(serde_json::json!({ "nonce": "nonce-1" })),
        ("POST", "/api/relay/auth/token") => {
            ok(serde_json::json!({ "token": "device-token", "expiresInSec": 3600 }))
        }
        ("GET", "/api/relay/mailbox") => {
            let rows = state.lock().unwrap().mailbox.clone();
            ok(serde_json::Value::Array(rows))
        }
        ("POST", "/api/relay/mailbox/ack") => {
            let ids: Vec<i64> = body
                .get("queueIds")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default();
            let mut st = state.lock().unwrap();
            st.mailbox.retain(|r| !ids.contains(&r["queueId"].as_i64().unwrap_or(-1)));
            let n = ids.len();
            st.acked.extend(ids);
            ok(serde_json::json!({ "acked": n }))
        }
        ("POST", "/api/relay/mailbox/send") => {
            state.lock().unwrap().sends.push(body.clone());
            ok(serde_json::json!({ "relayTs": now_ms() }))
        }
        ("GET", "/api/relay/kt/roots") => {
            let roots = state.lock().unwrap().roots.clone();
            let fp = info.lock().unwrap().fingerprint.clone();
            ok(serde_json::json!({ "relayFp": fp, "roots": roots }))
        }
        ("GET", p) if p.starts_with("/api/relay/directory/") => {
            let handle = percent_decode(p.trim_start_matches("/api/relay/directory/"));
            match state.lock().unwrap().directory.clone() {
                Directory404::NotFound => (404, serde_json::json!({ "error": "unknown handle" })),
                Directory404::Unavailable => (503, serde_json::json!({ "error": "directory down" })),
                Directory404::Entry { identity_pub_b64, epoch, root, proof_json, vrf } => ok(serde_json::json!({
                    "identityPubKey": identity_pub_b64,
                    "sealingPubKey": "",
                    "epoch": epoch,
                    "rootHash": root,
                    "proof": serde_json::from_str::<serde_json::Value>(&proof_json).unwrap(),
                    "vrfPublicKey": vrf,
                    "kt": "akd",
                    "handle": handle,
                })),
            }
        }
        _ => (404, serde_json::json!({ "error": "not routed by the fake relay" })),
    }
}

// -------------------------------------------------------------- the client --

/// In-memory keychain: a test must never touch the developer's OS keychain.
#[derive(Default)]
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

/// One installed copy of the app, connected to the fake relay.
pub struct Core {
    _dir: tempfile::TempDir,
    pub vault: Mutex<Vault>,
    pub relay: RelayClient,
}

impl Core {
    /// A fresh install: vault created (unlocked), no relay session yet.
    pub fn install() -> Core {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_keychain(dir.path().to_path_buf(), Box::<MemKeychain>::default());
        vault.create("a long enough password").unwrap();
        {
            let store = vault.store().unwrap();
            store.set_setting("identity.handle", MY_HANDLE).unwrap();
        }
        Core { _dir: dir, vault: Mutex::new(vault), relay: RelayClient::default() }
    }

    /// Connect through the **real** client path — anchor, verify the relay's
    /// identity, pin it — not `RelayClient::connect` directly, so every case
    /// here exercises the pinning the app actually performs.
    pub async fn connect_to(
        &self,
        base: &str,
        invite_fp: Option<&str>,
        alarms: &Alarms,
    ) -> Result<(), String> {
        let device = self.vault.lock().unwrap().device_signing_key().unwrap();
        app_lib::connect_to_relay(&self.vault, &self.relay, base, invite_fp, &device, &alarms.sink())
            .await
    }

    pub async fn connect(base: &str) -> Core {
        let core = Core::install();
        // First contact, no invite: trust-on-first-use — but the relay's
        // fingerprint must still bind to the key it serves.
        core.connect_to(base, None, &Alarms::default())
            .await
            .expect("fake relay connect");
        core
    }

    pub fn relay_fp(&self) -> String {
        self.relay.status().relay_fp.expect("connected")
    }

    /// My per-relay sealing key — where a friend-accept is sealed to.
    pub fn sealing_pub(&self) -> [u8; 32] {
        let vault = self.vault.lock().unwrap();
        let fp = self.relay.status().relay_fp.unwrap();
        identity::derive_relay_identity(vault.mk().unwrap(), &fp).unwrap().sealing_public()
    }

    pub fn friends(&self) -> Vec<app_lib::store::FriendSummary> {
        self.with_store(|s| s.list_friends(&self.relay.status().relay_fp.unwrap()).unwrap())
    }

    /// Read (or seed) the local store directly — for asserting on what a drain
    /// did, and for putting the core into a starting state a test needs.
    pub fn with_store<R>(&self, f: impl FnOnce(&Store) -> R) -> R {
        let vault = self.vault.lock().unwrap();
        let store = vault.store().unwrap();
        f(store)
    }

    /// The group key this core holds for `group_id`, if any.
    pub fn group_key(&self, group_id: &str) -> Option<Vec<u8>> {
        self.with_store(|s| s.group_key(group_id).unwrap())
    }
}

/// A "Bob" whose per-relay identity is derived exactly as the app derives one.
pub fn bob_identity(relay_fp: &str, seed: u8) -> identity::RelayIdentity {
    identity::derive_relay_identity(&[seed; 32], relay_fp).unwrap()
}

/// A sealed `friend-accept` from `sender` to `recipient_sealing`, as the invite
/// redeem leg produces.
pub fn friend_accept(
    sender: &identity::RelayIdentity,
    recipient_sealing: [u8; 32],
    handle: &str,
) -> Vec<u8> {
    let payload = message::friend_payload(
        handle,
        "bobs-delivery-token",
        &B64.encode(sender.sealing_public()),
        Some("Bob"),
    );
    envelope::seal(&recipient_sealing, sender, message::KIND_FRIEND_ACCEPT, &payload, now_ms()).unwrap()
}

/// Publish `handle → key` in a real akd directory and return what a lookup
/// response would carry, plus the root to sign.
pub async fn publish(handle: &str, key: &[u8]) -> (String, u64, String, String) {
    let storage = StorageManager::new_no_cache(AsyncInMemoryDatabase::new());
    let dir = Directory::<akd::WhatsAppV1Configuration, _, _>::new(
        storage,
        HardCodedAkdVRF {},
        AzksParallelismConfig::default(),
    )
    .await
    .unwrap();
    dir.publish(vec![(AkdLabel::from(handle), AkdValue(key.to_vec()))]).await.unwrap();
    let (proof, eh) = dir.lookup(AkdLabel::from(handle)).await.unwrap();
    let vrf = dir.get_public_key().await.unwrap();
    (
        B64.encode(eh.hash()),
        eh.epoch(),
        serde_json::to_string(&proof).unwrap(),
        B64.encode(vrf.as_bytes()),
    )
}

/// A signed root row exactly as `/api/relay/kt/roots` serves it, signed by the
/// relay's **online** key at delegation version 1 (the un-rotated relay).
pub fn signed_root(key: &SigningKey, epoch: i64, root: &str) -> serde_json::Value {
    signed_root_v(key, 1, epoch, root)
}

/// The same, stamped with the delegation `version` whose online key signed it —
/// what a relay that has rotated serves for its older epochs.
pub fn signed_root_v(key: &SigningKey, version: i64, epoch: i64, root: &str) -> serde_json::Value {
    let sig = key.sign(format!("kt-root|{root}|genesis").as_bytes());
    serde_json::json!({
        "epoch": epoch,
        "rootHash": root,
        "prevRootHash": null,
        "signature": B64.encode(sig.to_bytes()),
        "timestamp": now_ms(),
        "keyVersion": version,
    })
}

pub fn mailbox_row(queue_id: i64, envelope: &[u8]) -> serde_json::Value {
    serde_json::json!({ "queueId": queue_id, "relayTs": now_ms(), "envelope": B64.encode(envelope) })
}

/// Collects the hard KT alarms the core raises.
#[derive(Default)]
pub struct Alarms(Mutex<Vec<String>>);

impl Alarms {
    pub fn sink(&self) -> impl Fn(&str, i64) + Send + Sync + '_ {
        move |reason: &str, _epoch: i64| self.0.lock().unwrap().push(reason.to_string())
    }
    pub fn seen(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}
