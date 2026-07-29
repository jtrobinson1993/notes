//! **L2 — the real Rust core, two instances, against a REAL relay.**
//! (spec/testing.md § "L2 — Rust integration: two cores against a real relay")
//!
//! Everything here is production code except the plumbing: two independent
//! `Vault`s + `RelayClient`s in one process talk to a *spawned* `node
//! server/dist/relay-index.js` over real HTTP, walking register → invite →
//! friend handshake → DM → drain → ack → read state. No Tauri app, no webview,
//! no mocks: the only substitutions are a temp data dir and an in-memory
//! keychain (so a test never writes to the developer's OS keychain).
//!
//! What this layer is for is the set of claims neither L1 nor the relay's own
//! Vitest suite can make, because each only sees one half of the conversation:
//!   * the bytes B decrypts are the bytes A sent;
//!   * the relay never held those bytes — asserted against what is *actually on
//!     the relay's disk*, with a positive control so the scan can't pass
//!     vacuously;
//!   * ordering is the relay's delivery stamp, not the author's clock;
//!   * an ack really removes the envelope from the queue.
//!
//! **Skipping.** The relay is Node, so these tests skip (with a reason on
//! stderr — run with `cargo test -- --nocapture` to see it) when node/npm are
//! missing or the relay can't be built or booted. Set `ACCORD_L2_REQUIRE=1` to
//! turn every skip into a failure; that is what CI should do, so "green" can
//! never quietly mean "skipped".

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::SigningKey;

use app_lib::identity::{self, RelayIdentity};
use app_lib::relay_client::RelayClient;
use app_lib::store::MessageRow;
use app_lib::vault::{Keychain, Vault};
use app_lib::{envelope, keys, message};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The E2EE display names the two cores set. Deliberately unlike anything the
/// relay legitimately stores (handles are generated `Word#1234`), so the
/// "never on the relay's disk" scan can't be fooled by a coincidental
/// substring of a real handle.
const DISPLAY_A: &str = "l2-display-name-Ada";
const DISPLAY_B: &str = "l2-display-name-Bea";

// ---------------------------------------------------------------- harness ---

/// Report a skip. Panics instead when `ACCORD_L2_REQUIRE=1`, so CI cannot pass
/// by silently skipping the only layer that exercises the shipped engine.
fn skip(reason: &str) {
    if std::env::var("ACCORD_L2_REQUIRE").is_ok() {
        panic!("L2 required (ACCORD_L2_REQUIRE=1) but unavailable: {reason}");
    }
    eprintln!("SKIP (L2, real relay): {reason}");
}

macro_rules! relay_or_skip {
    () => {
        match Relay::start().await {
            Ok(r) => r,
            Err(reason) => return skip(&reason),
        }
    };
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .to_path_buf()
}

fn have(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Build the relay once per test binary (`npm run build -w shared && -w
/// server`), even when several tests want one. Cached so a second test doesn't
/// re-run tsc, and shared so two tests never build concurrently.
fn ensure_relay_built() -> Result<(), String> {
    static BUILT: OnceLock<Result<(), String>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            if !have("node") {
                return Err("`node` is not on PATH — the relay is a Node process".into());
            }
            if !have("npm") {
                return Err("`npm` is not on PATH — cannot build the relay".into());
            }
            let root = repo_root();
            if !root.join("server/package.json").exists() {
                return Err("server/ workspace not found next to src-tauri/".into());
            }
            for workspace in ["shared", "server"] {
                let out = Command::new("npm")
                    .args(["run", "build", "-w", workspace])
                    .current_dir(&root)
                    .output()
                    .map_err(|e| format!("npm run build -w {workspace} could not start: {e}"))?;
                if !out.status.success() {
                    return Err(format!(
                        "npm run build -w {workspace} failed:\n{}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
            }
            if !root.join("server/dist/relay-index.js").exists() {
                return Err("server/dist/relay-index.js missing after build".into());
            }
            Ok(())
        })
        .clone()
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no free port: {e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// A real relay process on a throwaway `DATA_DIR` and a free port. Killed on
/// drop — including when a test panics — so a failed run leaves nothing behind.
struct Relay {
    child: std::process::Child,
    base: String,
    data_dir: tempfile::TempDir,
}

impl Relay {
    async fn start() -> Result<Relay, String> {
        ensure_relay_built()?;
        let port = free_port()?;
        let base = format!("http://127.0.0.1:{port}");
        let data_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let log_path = data_dir.path().join("relay.log");
        let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let errlog = log.try_clone().map_err(|e| e.to_string())?;

        let child = Command::new("node")
            .arg("server/dist/relay-index.js")
            .current_dir(repo_root())
            // Only what the relay needs; nothing inherited that could point it
            // at the developer's real ./data.
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .env("DATA_DIR", data_dir.path())
            .env("APP_ORIGIN", &base)
            // Open registration so both cores can create accounts through the
            // production signup path. There is no test-auth bypass.
            .env("RELAY_REGISTRATION_MODE", "public")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(errlog))
            .spawn()
            .map_err(|e| format!("could not spawn the relay: {e}"))?;

        let mut relay = Relay { child, base, data_dir };
        relay.await_health(&log_path).await?;
        Ok(relay)
    }

    async fn await_health(&mut self, log_path: &Path) -> Result<(), String> {
        let http = reqwest::Client::new();
        let url = format!("{}/api/health", self.base);
        for _ in 0..300 {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!(
                    "relay exited before becoming healthy ({status}):\n{}",
                    tail(log_path)
                ));
            }
            if let Ok(res) = http.get(&url).send().await {
                if res.status().is_success() {
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(format!("relay never answered /api/health:\n{}", tail(log_path)))
    }

    /// Every byte the relay has actually written to disk — its SQLite file, the
    /// WAL, its own request log, anything else under `DATA_DIR`. This is what a
    /// "the relay never held the plaintext" claim has to be checked against;
    /// the log is deliberately included, since leaking content into a log would
    /// break the property just as thoroughly as storing it.
    fn on_disk(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    let mut buf = Vec::new();
                    if let Ok(mut f) = std::fs::File::open(&path) {
                        let _ = f.read_to_end(&mut buf);
                    }
                    out.push((path, buf));
                }
            }
        }
        let mut out = Vec::new();
        walk(self.data_dir.path(), &mut out);
        out
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines().rev().take(20).collect::<Vec<_>>().join("\n")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// In-memory keychain: tests must never touch the developer's OS keychain
/// (keyring's own mock doesn't share state across `Entry` instances).
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

// ------------------------------------------------------------------- core ---

/// One whole client: its own data dir, vault, device key and relay session —
/// i.e. what one installed copy of the app owns.
struct Core {
    _dir: tempfile::TempDir,
    vault: Mutex<Vault>,
    relay: RelayClient,
    device: SigningKey,
    handle: String,
    relay_fp: String,
    delivery_token: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Core {
    /// Onboard a brand-new account exactly as the app does: create the vault,
    /// register + enroll the device on the relay, persist the handle, publish
    /// directory keys, register the sealed-sender verifier.
    async fn onboard(base: &str, display_name: &str) -> Core {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_keychain(dir.path().to_path_buf(), Box::<MemKeychain>::default());
        vault.create("a long enough password").unwrap();
        let device = vault.device_signing_key().unwrap();
        let relay = RelayClient::default();

        let handle = relay.register(base, &device, None, None).await.unwrap();
        let relay_fp = relay.status().relay_fp.expect("registered ⇒ pinned relay");

        let (identity_pub, sealing_pub, delivery_token, verifier) = {
            let store = vault.store().unwrap();
            store.set_setting("identity.handle", &handle).unwrap();
            store.set_setting("profile.displayName", display_name).unwrap();
            let ident = identity::derive_relay_identity(vault.mk().unwrap(), &relay_fp).unwrap();
            let (token, verifier) = vault.delivery_token().unwrap();
            (
                B64.encode(ident.signing_public()),
                B64.encode(ident.sealing_public()),
                token,
                verifier,
            )
        };
        relay
            .directory_publish(&device, identity_pub, sealing_pub)
            .await
            .unwrap();
        relay.register_verifier(&device, verifier).await.unwrap();

        Core {
            _dir: dir,
            vault: Mutex::new(vault),
            relay,
            device,
            handle,
            relay_fp,
            delivery_token,
        }
    }

    fn identity(&self) -> RelayIdentity {
        let vault = self.vault.lock().unwrap();
        identity::derive_relay_identity(vault.mk().unwrap(), &self.relay_fp).unwrap()
    }

    /// Base64 identity key — the contact id both sides address each other by.
    fn contact_id(&self) -> String {
        B64.encode(self.identity().signing_public())
    }

    /// Run the real drain (`app_lib::mailbox_drain`), recording any KT alarm.
    async fn drain(&self) -> message::DrainReport {
        let alarms: Mutex<Vec<(String, i64)>> = Mutex::new(Vec::new());
        let report = app_lib::mailbox_drain(
            &self.vault,
            &self.relay,
            &|reason: &str, epoch: i64| alarms.lock().unwrap().push((reason.to_string(), epoch)),
        )
        .await
        .expect("drain");
        let raised = alarms.into_inner().unwrap();
        assert!(
            raised.is_empty(),
            "an honest relay must never raise a KT alarm: {raised:?}"
        );
        report
    }

    fn page(&self, conversation_id: &str) -> Vec<MessageRow> {
        let vault = self.vault.lock().unwrap();
        vault
            .store()
            .unwrap()
            .messages_page(conversation_id, None, None, 50)
            .unwrap()
    }

    fn unread(&self, conversation_id: &str) -> i64 {
        let vault = self.vault.lock().unwrap();
        vault.store().unwrap().conversation_unread(conversation_id).unwrap()
    }
}

/// The two client-side halves of the D4b friend handshake that live in
/// TypeScript (`web/src/lib/nativeInvites.ts`), reproduced against the same
/// core primitives: mint `hash(token)` at the relay, then redeem the raw token
/// by dropping a sealed friend-accept into the inviter's mailbox.
async fn mint_invite(inviter: &Core) -> String {
    use rand::RngCore as _;
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let token_hash = keys::sha256_b64url(token.as_bytes());
    inviter
        .relay
        .invite_mint(&inviter.device, token_hash, Some(3600))
        .await
        .expect("mint invite");
    token
}

async fn redeem_invite(invitee: &Core, token: &str, inviter_sealing_pub: [u8; 32]) {
    let display_name = {
        let vault = invitee.vault.lock().unwrap();
        vault.store().unwrap().get_setting("profile.displayName").unwrap()
    };
    let ident = invitee.identity();
    let payload = message::friend_payload(
        &invitee.handle,
        &invitee.delivery_token,
        &B64.encode(ident.sealing_public()),
        display_name.as_deref(),
    );
    let env = envelope::seal(
        &inviter_sealing_pub,
        &ident,
        message::KIND_FRIEND_ACCEPT,
        &payload,
        now_ms(),
    )
    .expect("seal friend-accept");
    invitee
        .relay
        .invite_redeem(token, env)
        .await
        .expect("redeem invite");
}

/// Register → invite → redeem → both drains: leaves A and B mutual friends.
async fn befriend(a: &Core, b: &Core) {
    let token = mint_invite(a).await;
    redeem_invite(b, &token, a.identity().sealing_public()).await;

    // A drains the accept: records B, and reciprocates a sealed friend-confirm.
    let ra = a.drain().await;
    assert_eq!(ra.friends, 1, "A should record exactly one new friend");
    assert_eq!(ra.acked, 1, "the accept is acked once durably stored");
    assert_eq!(ra.buffered, 0);

    // B drains the confirm: records A. Mutual (D4b).
    let rb = b.drain().await;
    assert_eq!(rb.friends, 1, "B should record the inviter from the confirm");
    assert_eq!(rb.acked, 1);
}

// ------------------------------------------------------------------ tests ---

/// The whole path in one go, because the point of L2 is that the pieces
/// *compose*: register → invite → friend both ways → DM → drain → ack → read.
#[tokio::test]
async fn two_cores_complete_the_friend_handshake_and_a_dm_round_trip() {
    let relay = relay_or_skip!();

    let a = Core::onboard(&relay.base, DISPLAY_A).await;
    let b = Core::onboard(&relay.base, DISPLAY_B).await;
    assert_ne!(a.handle, b.handle, "the relay must issue distinct handles");
    assert_eq!(a.relay_fp, b.relay_fp, "both cores pin the same relay identity");
    assert_ne!(
        a.contact_id(),
        b.contact_id(),
        "two accounts must derive different per-relay identities"
    );

    befriend(&a, &b).await;

    // Both sides now hold the other's addressing, keyed by identity — and the
    // E2EE display name the server never saw (the handle is the only identifier
    // the relay knows).
    let a_friends = {
        let vault = a.vault.lock().unwrap();
        vault.store().unwrap().list_friends(&a.relay_fp).unwrap()
    };
    assert_eq!(a_friends.len(), 1);
    assert_eq!(a_friends[0].contact_id, b.contact_id());
    assert_eq!(a_friends[0].handle, b.handle);
    assert_eq!(a_friends[0].display_name.as_deref(), Some(DISPLAY_B));

    let b_friends = {
        let vault = b.vault.lock().unwrap();
        vault.store().unwrap().list_friends(&b.relay_fp).unwrap()
    };
    assert_eq!(b_friends.len(), 1);
    assert_eq!(b_friends[0].contact_id, a.contact_id());
    assert_eq!(b_friends[0].display_name.as_deref(), Some(DISPLAY_A));

    // ---- A sends a DM through the real send path -------------------------
    // Deliberately not ASCII-only: what B decrypts must be byte-identical, not
    // merely "looks the same".
    const TEXT: &str = "l2-canary ✅ zero-knowledge — \u{1F510} \"quoted\" <b>&amp;</b> \n\ttabbed";
    let msg_id = app_lib::send_dm(&a.vault, &a.relay, &b.contact_id(), TEXT, None)
        .await
        .expect("send dm");

    let conversation_id = identity::dm_conversation_id(
        &a.identity().signing_public(),
        &b.identity().signing_public(),
    );

    // ---- what the relay is holding, before B acks ------------------------
    let queued = b.relay.mailbox_fetch(&b.device).await.expect("fetch");
    assert_eq!(queued.len(), 1, "exactly one envelope is queued for B");
    assert!(
        !contains(&queued[0].envelope, TEXT.as_bytes()),
        "the queued envelope must not contain the plaintext"
    );
    assert!(
        !contains(&queued[0].envelope, a.contact_id().as_bytes()),
        "sealed sender: the sender's identity key must not be readable in the envelope"
    );

    // The relay's own disk, not just the API view. The positive control (A's
    // handle, which the relay legitimately stores) proves the scan can find a
    // string that IS there — otherwise "no plaintext found" would be vacuous.
    let disk = relay.on_disk();
    assert!(
        disk.iter().any(|(_, bytes)| contains(bytes, a.handle.as_bytes())),
        "control failed: the scan cannot even find a handle the relay does store"
    );
    for (path, bytes) in &disk {
        assert!(
            !contains(bytes, TEXT.as_bytes()),
            "the relay wrote message plaintext to {}",
            path.display()
        );
        for name in [DISPLAY_A, DISPLAY_B] {
            assert!(
                !contains(bytes, name.as_bytes()),
                "the relay wrote an E2EE display name ({name}) to {}",
                path.display()
            );
        }
    }

    // ---- B drains: opens the envelope, stores the plaintext, acks ---------
    let report = b.drain().await;
    assert_eq!(report.ingested, 1);
    assert_eq!(report.acked, 1);
    assert_eq!(report.buffered, 0);

    let rows = b.page(&conversation_id);
    assert_eq!(rows.len(), 1, "B's DM with A holds exactly the one message");
    let got = &rows[0];
    assert_eq!(got.id, msg_id, "the sender-assigned id survives the round trip");
    assert_eq!(
        got.content.as_deref().map(str::as_bytes),
        Some(TEXT.as_bytes()),
        "B must decrypt byte-identical plaintext"
    );
    assert_eq!(
        got.sender_contact_id.as_deref(),
        Some(a.contact_id().as_str()),
        "the stored sender is the VERIFIED envelope sender"
    );
    assert!(!got.deleted);

    // Routing is derived from (me, verified sender) — both sides independently
    // compute the same conversation id, and A's own tee carries the relay's
    // stamp, so the two logs agree on the ordering key.
    let a_rows = a.page(&conversation_id);
    assert_eq!(a_rows.len(), 1);
    assert_eq!(a_rows[0].id, msg_id);
    assert_eq!(a_rows[0].sender_contact_id.as_deref(), Some("self"));
    assert_eq!(
        a_rows[0].relay_ts, got.relay_ts,
        "sender and recipient order by the same relay stamp"
    );

    // ---- the ack really removed the envelope ------------------------------
    let after = b.relay.mailbox_fetch(&b.device).await.expect("fetch");
    assert!(after.is_empty(), "acked envelopes must be gone from the queue");
    // …and a re-drain is a no-op rather than a duplicate (idempotent by id).
    let again = b.drain().await;
    assert_eq!(again.ingested, 0);
    assert_eq!(again.acked, 0);
    assert_eq!(b.page(&conversation_id).len(), 1);

    // ---- read state --------------------------------------------------------
    assert_eq!(b.unread(&conversation_id), 1, "an inbound message is unread");
    assert_eq!(a.unread(&conversation_id), 0, "my own message is never unread");
    {
        let vault = b.vault.lock().unwrap();
        vault
            .store()
            .unwrap()
            .mark_conversation_read(&conversation_id)
            .unwrap();
    }
    assert_eq!(b.unread(&conversation_id), 0);

    let activity = {
        let vault = b.vault.lock().unwrap();
        vault.store().unwrap().conversation_activity().unwrap()
    };
    let conv = activity
        .iter()
        .find(|c| c.conversation_id == conversation_id)
        .expect("the DM shows up in sidebar activity");
    assert_eq!(conv.last_ts, got.relay_ts);
    assert_eq!(conv.unread, 0);

    // ---- and back the other way (B's addressing of A is real too) ---------
    const REPLY: &str = "l2-reply ↩";
    let reply_id = app_lib::send_dm(&b.vault, &b.relay, &a.contact_id(), REPLY, None)
        .await
        .expect("send reply");
    let ra = a.drain().await;
    assert_eq!(ra.ingested, 1);
    let a_rows = a.page(&conversation_id);
    assert_eq!(a_rows.len(), 2);
    let reply = a_rows.iter().find(|r| r.id == reply_id).expect("reply landed");
    assert_eq!(reply.content.as_deref(), Some(REPLY));
    assert_eq!(reply.sender_contact_id.as_deref(), Some(b.contact_id().as_str()));
    assert_eq!(a.unread(&conversation_id), 1);
}

/// History order is the **relay's** delivery stamp, never the author's clock.
/// Proven by sending messages whose `sentAt` runs backwards while the relay
/// stamps them forwards: if anything ordered by `sentAt`, the page would come
/// back reversed.
#[tokio::test]
async fn history_is_ordered_by_the_relay_stamp_not_the_author_clock() {
    let relay = relay_or_skip!();
    let a = Core::onboard(&relay.base, DISPLAY_A).await;
    let b = Core::onboard(&relay.base, DISPLAY_B).await;
    befriend(&a, &b).await;

    let conversation_id = identity::dm_conversation_id(
        &a.identity().signing_public(),
        &b.identity().signing_public(),
    );
    let addressing = {
        let vault = a.vault.lock().unwrap();
        vault
            .store()
            .unwrap()
            .friend_addressing(&b.contact_id(), &a.relay_fp)
            .unwrap()
            .expect("B is a friend")
    };
    let sealing: [u8; 32] = addressing.sealing_pub.clone().try_into().unwrap();
    let ident = a.identity();

    // Author clocks descend (…, base-1, base-2); relay stamps ascend with the
    // order of the sends.
    let base_clock = now_ms();
    let mut sent: Vec<(String, i64)> = Vec::new(); // (id, relay_ts)
    for i in 0..3i64 {
        let id = format!("l2-ordered-{i}");
        let payload = message::ChatMessagePayload::new_text(
            id.clone(),
            conversation_id.clone(),
            None,
            format!("ordered-{i}"),
            base_clock - i * 1000,
            None,
        );
        let env = envelope::seal(
            &sealing,
            &ident,
            message::KIND_MSG,
            &payload.encode().unwrap(),
            payload.sent_at,
        )
        .unwrap();
        let relay_ts = a
            .relay
            .mailbox_send(&addressing.handle, &addressing.delivery_token, env)
            .await
            .expect("send");
        sent.push((id, relay_ts));
    }
    assert!(
        sent[0].1 < sent[1].1 && sent[1].1 < sent[2].1,
        "the relay stamps sends in arrival order: {sent:?}"
    );

    let report = b.drain().await;
    assert_eq!(report.ingested, 3);

    let rows = b.page(&conversation_id);
    assert_eq!(rows.len(), 3);
    // Newest first, by the relay's stamp — the exact reverse of the authors'
    // `sentAt`, which is what makes this assertion load-bearing.
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["l2-ordered-2", "l2-ordered-1", "l2-ordered-0"]);
    for (row, (id, relay_ts)) in rows.iter().zip(sent.iter().rev()) {
        assert_eq!(&row.id, id);
        assert_eq!(
            row.relay_ts, *relay_ts,
            "each row carries the relay's stamp for that send"
        );
    }
    assert!(
        rows.windows(2).all(|w| w[0].relay_ts > w[1].relay_ts),
        "strictly descending by relay_ts"
    );
    assert_eq!(b.unread(&conversation_id), 3);
}
