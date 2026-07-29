//! **L2 — contact key transparency against a HOSTILE relay.**
//! (spec/key-transparency.md § Contact verification; spec/testing.md § L2)
//!
//! The real Rust core — real vault, real `RelayClient`, the real
//! `mailbox_drain` — driven against a relay the *test* controls byte for byte.
//! That control is the point: the claim under test is not "the happy path
//! works" but "a relay that lies is not believed", and a lying relay is
//! precisely what a genuine `server/` process will never be.
//!
//! What each case pins down:
//!   * a key the log published under a **signed** root → recorded, with the
//!     signed epoch;
//!   * a key the log contradicts → **nothing** persisted and **nothing** sealed
//!     back (the reply carries our delivery token, so ordering is the property);
//!   * a self-consistent `(proof, root)` pair for a root the relay never signed
//!     → refused, because the proof always agrees with the root it ships with;
//!   * 404 and an unreachable directory → recorded UNVERIFIED, never verified,
//!     and settled by the re-verification sweep on the next connect.
//!
//! The akd proofs are generated with the full `akd` crate (a dev-dependency),
//! so the bytes the core verifies are the bytes a real sidecar would produce.

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

use app_lib::vault::{Keychain, Vault};
use app_lib::{envelope, identity, message, relay_client::RelayClient};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

const MY_HANDLE: &str = "Me#0001";
const BOB_HANDLE: &str = "Bob#0002";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------- fake relay ---

/// How the fake relay answers `GET /api/relay/directory/:handle`.
#[derive(Clone)]
enum Directory404 {
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

struct RelayState {
    directory: Directory404,
    /// The signed root chain served at `/api/relay/kt/roots`.
    roots: Vec<serde_json::Value>,
    /// Rows returned by the next mailbox fetch.
    mailbox: Vec<serde_json::Value>,
    /// Everything the client POSTed to `/api/relay/mailbox/send` — the
    /// "did it seal a reply back?" evidence.
    sends: Vec<serde_json::Value>,
    acked: Vec<i64>,
}

struct FakeRelay {
    base: String,
    state: Arc<Mutex<RelayState>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl FakeRelay {
    /// Spawn the relay on a throwaway port. `signing` is its identity key — the
    /// one that signs KT roots and that the client pins at connect.
    fn start(signing: SigningKey, state: RelayState) -> FakeRelay {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr: SocketAddr = listener.local_addr().unwrap();
        let identity_pub_b64 = B64.encode(signing.verifying_key().to_bytes());
        // The client pins this at connect and checks every root signature with it.
        let state = Arc::new(Mutex::new(state));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let server_state = Arc::clone(&state);
        let server_stop = Arc::clone(&stop);
        let server_identity = identity_pub_b64.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if server_stop.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let Ok(mut sock) = conn else { continue };
                let _ = handle_conn(&mut sock, &server_state, &server_identity);
            }
        });

        FakeRelay { base: format!("http://{addr}"), state, stop }
    }

    fn fingerprint(&self) -> String {
        // Any stable string; the client only ever compares it with itself.
        "fake-relay-fp".to_string()
    }

    fn with<R>(&self, f: impl FnOnce(&mut RelayState) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }
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
    relay_identity_pub: &str,
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

    let (status, payload) = route(&method, &path, &body, state, relay_identity_pub);
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
    relay_identity_pub: &str,
) -> (u16, serde_json::Value) {
    let ok = |v: serde_json::Value| (200u16, v);
    match (method, path) {
        ("GET", "/api/relay/info") => ok(serde_json::json!({
            "identityFingerprint": "fake-relay-fp",
            "identityPubKey": relay_identity_pub,
        })),
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
            ok(serde_json::json!({ "relayFp": "fake-relay-fp", "roots": roots }))
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
struct Core {
    _dir: tempfile::TempDir,
    vault: Mutex<Vault>,
    relay: RelayClient,
}

impl Core {
    async fn connect(base: &str) -> Core {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_keychain(dir.path().to_path_buf(), Box::<MemKeychain>::default());
        vault.create("a long enough password").unwrap();
        let device = vault.device_signing_key().unwrap();
        let relay = RelayClient::default();
        relay.connect(base, &device).await.expect("fake relay connect");
        {
            let store = vault.store().unwrap();
            store.set_setting("identity.handle", MY_HANDLE).unwrap();
        }
        Core { _dir: dir, vault: Mutex::new(vault), relay }
    }

    fn relay_fp(&self) -> String {
        self.relay.status().relay_fp.expect("connected")
    }

    /// My per-relay sealing key — where a friend-accept is sealed to.
    fn sealing_pub(&self) -> [u8; 32] {
        let vault = self.vault.lock().unwrap();
        let fp = self.relay.status().relay_fp.unwrap();
        identity::derive_relay_identity(vault.mk().unwrap(), &fp).unwrap().sealing_public()
    }

    fn friends(&self) -> Vec<app_lib::store::FriendSummary> {
        let vault = self.vault.lock().unwrap();
        vault.store().unwrap().list_friends(&self.relay.status().relay_fp.unwrap()).unwrap()
    }
}

/// A "Bob" whose per-relay identity is derived exactly as the app derives one.
fn bob_identity(relay_fp: &str, seed: u8) -> identity::RelayIdentity {
    identity::derive_relay_identity(&[seed; 32], relay_fp).unwrap()
}

/// A sealed `friend-accept` from `sender` to `recipient_sealing`, as the invite
/// redeem leg produces.
fn friend_accept(sender: &identity::RelayIdentity, recipient_sealing: [u8; 32], handle: &str) -> Vec<u8> {
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
async fn publish(handle: &str, key: &[u8]) -> (String, u64, String, String) {
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

/// A signed root row exactly as `/api/relay/kt/roots` serves it.
fn signed_root(key: &SigningKey, epoch: i64, root: &str) -> serde_json::Value {
    let sig = key.sign(format!("kt-root|{root}|genesis").as_bytes());
    serde_json::json!({
        "epoch": epoch,
        "rootHash": root,
        "prevRootHash": null,
        "signature": B64.encode(sig.to_bytes()),
        "timestamp": now_ms(),
    })
}

fn mailbox_row(queue_id: i64, envelope: &[u8]) -> serde_json::Value {
    serde_json::json!({ "queueId": queue_id, "relayTs": now_ms(), "envelope": B64.encode(envelope) })
}

/// Collects the hard KT alarms the core raises.
#[derive(Default)]
struct Alarms(Mutex<Vec<String>>);

impl Alarms {
    fn sink(&self) -> impl Fn(&str, i64) + Send + Sync + '_ {
        move |reason: &str, _epoch: i64| self.0.lock().unwrap().push(reason.to_string())
    }
    fn seen(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

// ------------------------------------------------------------------ tests ---

/// Build the whole scene: a relay, a connected core, and Bob's accept queued.
/// `logged_key` is what the relay's transparency log publishes for Bob's
/// handle; `sign_root` says whether the relay signs the root it serves.
async fn scene(logged_key: Option<Vec<u8>>, sign_root: bool) -> (FakeRelay, Core, SigningKey) {
    let relay_key = SigningKey::from_bytes(&[42u8; 32]);
    // Boot with an empty directory; the entry needs the relay fingerprint, which
    // only exists once the relay is up.
    let relay = FakeRelay::start(
        relay_key.clone(),
        RelayState {
            directory: Directory404::NotFound,
            roots: Vec::new(),
            mailbox: Vec::new(),
            sends: Vec::new(),
            acked: Vec::new(),
        },
    );
    let core = Core::connect(&relay.base).await;
    let fp = core.relay_fp();
    assert_eq!(fp, relay.fingerprint());

    let bob = bob_identity(&fp, 9);
    let envelope = friend_accept(&bob, core.sealing_pub(), BOB_HANDLE);

    if let Some(key) = logged_key {
        let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &key).await;
        relay.with(|st| {
            st.directory = Directory404::Entry {
                identity_pub_b64: B64.encode(&key),
                epoch,
                root: root.clone(),
                proof_json: proof_json.clone(),
                vrf: vrf.clone(),
            };
            if sign_root {
                st.roots = vec![signed_root(&relay_key, 17, &root)];
            }
        });
    }
    relay.with(|st| st.mailbox = vec![mailbox_row(1, &envelope)]);
    (relay, core, relay_key)
}

#[tokio::test]
async fn a_log_verified_contact_is_recorded_with_the_signed_epoch() {
    let bob_key = bob_identity("fake-relay-fp", 9).signing_public().to_vec();
    let (relay, core, _k) = scene(Some(bob_key.clone()), true).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 1);
    assert_eq!(report.kt_rejected, 0);
    let friends = core.friends();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].handle, BOB_HANDLE);
    // The recorded epoch is the RELAY's signed epoch (17), not the akd counter.
    assert_eq!(friends[0].kt_verified_epoch, Some(17));
    // Verified ⇒ the handshake completes: the confirm went back.
    assert_eq!(relay.with(|st| st.sends.len()), 1);
    assert!(alarms.seen().is_empty());
}

#[tokio::test]
async fn a_contact_key_the_log_contradicts_persists_nothing_and_seals_nothing_back() {
    // The relay hands us an accept from a key it controls, while the log
    // publishes a different key for that handle — the MITM it exists to catch.
    let (relay, core, _k) = scene(Some(vec![3u8; 32]), true).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 0);
    assert_eq!(report.kt_rejected, 1);
    // Nothing persisted…
    assert!(core.friends().is_empty());
    // …and, the part that would leak, nothing sealed back: the friend-confirm
    // carries MY delivery token, so the check has to precede the reply.
    assert_eq!(relay.with(|st| st.sends.len()), 0);
    // The hard alarm fired.
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
    // The unusable envelope is still acked — re-draining it only re-rejects.
    assert_eq!(relay.with(|st| st.acked.clone()), vec![1]);
}

#[tokio::test]
async fn a_self_consistent_proof_under_an_unsigned_root_is_refused() {
    // The relay's own (proof, root) pair is internally valid and names the key
    // it wants us to trust — but it never signed that root. Believing the
    // response's root would make the whole check circular.
    let bob_key = bob_identity("fake-relay-fp", 9).signing_public().to_vec();
    let (relay, core, relay_key) = scene(Some(bob_key), false).await;
    // The relay does publish a root chain — just not one containing this root.
    relay.with(|st| st.roots = vec![signed_root(&relay_key, 4, &B64.encode([1u8; 32]))]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.kt_rejected, 1);
    assert!(core.friends().is_empty());
    assert_eq!(relay.with(|st| st.sends.len()), 0);
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}

#[tokio::test]
async fn a_handle_absent_from_the_log_is_unverified_but_not_blocked() {
    // 404 is indistinguishable from a publish that has not landed yet, and a
    // relay can always produce it — so it must not block. It must also never
    // count as a match.
    let (relay, core, _k) = scene(None, false).await;
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.friends, 1);
    assert_eq!(report.kt_rejected, 0);
    let friends = core.friends();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].kt_verified_epoch, None); // NOT verified
    assert_eq!(relay.with(|st| st.sends.len()), 1); // the handshake still completes
    assert!(alarms.seen().is_empty()); // absence is not an alarm
}

#[tokio::test]
async fn an_unreachable_directory_degrades_to_unverified_and_re_verifies_later() {
    let bob_key = bob_identity("fake-relay-fp", 9).signing_public().to_vec();
    let (relay, core, relay_key) = scene(Some(bob_key.clone()), true).await;
    // Keep the *entry* the relay would serve, but make the directory fail — the
    // offline / broken-directory case.
    let saved = relay.with(|st| {
        let saved = st.directory.clone();
        st.directory = Directory404::Unavailable;
        saved
    });
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(report.friends, 1); // adding a contact still works
    assert_eq!(core.friends()[0].kt_verified_epoch, None); // …but unverified
    assert!(alarms.seen().is_empty()); // unreachable is not an accusation

    // The relay comes back: the sweep run on the next connect settles it.
    relay.with(|st| st.directory = saved);
    let sweep = app_lib::verify_recorded_contacts(&core.vault, &core.relay, &alarms.sink())
        .await
        .unwrap();
    assert_eq!(sweep.verified, 1);
    assert_eq!(sweep.rejected, 0);
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(17));

    // And a *later* contradiction is caught by the same sweep, without
    // silently deleting the contact. (Clearing the proof is what a re-key would
    // do; it is how the contact re-enters the worklist.)
    let contact_id = core.friends()[0].contact_id.clone();
    let fp = core.relay_fp();
    {
        let vault = core.vault.lock().unwrap();
        vault.store().unwrap().kt_clear_contact_verified(&contact_id, &fp).unwrap();
    }
    let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &[8u8; 32]).await;
    relay.with(|st| {
        st.directory = Directory404::Entry {
            identity_pub_b64: B64.encode([8u8; 32]),
            epoch,
            root: root.clone(),
            proof_json,
            vrf,
        };
        st.roots = vec![signed_root(&relay_key, 18, &root)];
    });
    let sweep = app_lib::verify_recorded_contacts(&core.vault, &core.relay, &alarms.sink())
        .await
        .unwrap();
    assert_eq!(sweep.rejected, 1);
    assert_eq!(core.friends()[0].kt_verified_epoch, None);
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}
