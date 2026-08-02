// The core's modules are `pub` so the **L2 integration tests**
// (`src-tauri/tests/`, spec/testing.md § L2) can drive the real engine —
// vault, identity, envelope, relay client, store — against a real spawned
// relay. Nothing outside this crate links it as a library, so the wider
// surface costs nothing; a private module would instead force L2 to
// re-implement the client, which would test the test.
pub mod accounts;
pub mod attachment;
pub mod blobs;
pub mod delegation;
pub mod emoji;
pub mod envelope;
pub mod identity;
pub mod kt;
pub mod keys;
pub mod message;
pub mod relay_client;
pub mod relay_live;
pub mod store;
pub mod vault;
pub mod voice_live;

use std::sync::Mutex;
use tauri::Manager;
use accounts::{AccountManager, Registry};
use vault::{Vault, VaultStatus};

type VaultState<'a> = tauri::State<'a, Mutex<Vault>>;
type AccountState<'a> = tauri::State<'a, Mutex<AccountManager>>;

/// The accounts on this device + which is active (for the switcher).
#[tauri::command]
fn account_list(accounts: AccountState) -> Registry {
    accounts.lock().unwrap().registry()
}

/// Switch to another account: persist the choice and restart so the new account
/// gets a fresh vault + relay/live-delivery tasks (single-session by design).
#[tauri::command]
fn account_switch(id: String, app: tauri::AppHandle, accounts: AccountState) -> Result<(), String> {
    if !accounts.lock().unwrap().set_active(&id) {
        return Err("unknown account".into());
    }
    app.restart();
}

/// Add a new (empty) account and switch to it — the restart lands on onboarding.
#[tauri::command]
fn account_add(app: tauri::AppHandle, accounts: AccountState) -> Result<(), String> {
    accounts.lock().unwrap().add();
    app.restart();
}

/// Label the active account with its handle (called after onboarding / a handle
/// change) so the switcher shows real names.
#[tauri::command]
fn account_set_label(label: String, accounts: AccountState) -> Result<(), String> {
    accounts.lock().unwrap().set_active_label(&label);
    Ok(())
}

#[tauri::command]
fn vault_status(vault: VaultState) -> VaultStatus {
    vault.lock().unwrap().status()
}

/// First-run setup; returns the recovery code (display once, never persist).
#[tauri::command]
fn vault_create(password: String, vault: VaultState) -> Result<String, String> {
    vault
        .lock()
        .unwrap()
        .create(&password)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_unlock_keychain(vault: VaultState) -> Result<(), String> {
    vault
        .lock()
        .unwrap()
        .unlock_keychain()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_unlock(password: String, vault: VaultState) -> Result<(), String> {
    vault
        .lock()
        .unwrap()
        .unlock_password(&password)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_unlock_recovery(code: String, vault: VaultState) -> Result<(), String> {
    vault
        .lock()
        .unwrap()
        .unlock_recovery(&code)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_lock(vault: VaultState) {
    vault.lock().unwrap().lock();
}

#[tauri::command]
fn settings_get(key: String, vault: VaultState) -> Result<Option<String>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(key: String, value: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.set_setting(&key, &value).map_err(|e| e.to_string())
}

// ---- relay identity pinning (spec/relay.md § Pinning the relay identity) ----

/// Hard alarm reason: the relay's identity is not the one this account is
/// anchored to. Same tier as a KT equivocation — the relay identity key is what
/// every KT root signature is checked against, so a substituted one invalidates
/// the entire transparency story.
const ALARM_RELAY_IDENTITY: &str = "relay-identity-changed";

/// Hard alarm reason: the relay could not show a current, root-signed delegation
/// naming its online signing key. Without one, nothing the relay signed means
/// anything — the pinned root vouches for no key at all.
const ALARM_RELAY_DELEGATION: &str = "relay-delegation-invalid";

/// Hard alarm reason: the relay served an **older** delegation than one this
/// account already accepted (or a different online key at the same version).
/// A superseded delegation is genuinely root-signed forever, so replaying one is
/// how an attacker who kept a revoked online key gets believed again. Its own
/// reason string because it is not a broken relay — it is an attack in progress.
const ALARM_RELAY_ROLLBACK: &str = "relay-delegation-rollback";

/// Where an account's pinned relay identity lives: the vault store is
/// per-account, and the key is the relay's base URL (an account can in principle
/// know more than one relay).
///
/// Normalised — trailing slash dropped, lowercased — so a differently-spelled
/// URL for the same relay cannot slip past the pin into a fresh
/// trust-on-first-use. Over-merging is the safe direction here: two URLs sharing
/// a pin means more anchoring, not less.
fn relay_pin_key(base_url: &str) -> String {
    format!("relay.identity.{}", base_url.trim_end_matches('/').to_lowercase())
}

/// The pinned identity, as stored in that setting.
#[derive(serde::Serialize, serde::Deserialize)]
struct RelayPin {
    fp: String,
    /// The **root** key the fingerprint binds. Redundant with `fp` by
    /// construction (the connect-time binding check enforces it), stored anyway
    /// so a pin is self-describing and comparable without a network round-trip.
    #[serde(default)]
    identity_pub: String,
    /// **The anti-rollback high-water mark**: the highest delegation `version`
    /// this account has ever accepted from this relay. It only ever increases.
    /// Without it, an attacker holding a revoked online key replays the old,
    /// still-validly-root-signed delegation that named it and is trusted again —
    /// so a rotation would revoke nothing.
    #[serde(default)]
    delegation_version: i64,
    /// The online key `delegation_version` named. A *different* key at the same
    /// version is the root equivocating about which key is in force, which only
    /// a client that remembers can see.
    #[serde(default)]
    delegation_online_key: String,
}

/// What we will hold this relay to, and where that came from.
struct RelayAnchor {
    /// The fingerprint the relay must present, or None on genuine first contact.
    expected: Option<String>,
    /// Whether a pin setting already exists (so a successful connect knows
    /// whether it is writing a first pin or confirming one).
    pinned: bool,
    /// The delegation version floor this relay must meet or beat.
    floor: delegation::DelegationFloor,
}

/// Resolve the anchor for `base_url`: the invite's fingerprint if we have one,
/// otherwise this account's stored pin, otherwise the relay row an older account
/// already has. Returns `Err` when they disagree, or when the pin cannot be read
/// at all — a pin we cannot check is a pin we cannot enforce, so a locked vault
/// fails the connect closed rather than proceeding unanchored.
fn relay_anchor(
    vault: &Mutex<Vault>,
    base_url: &str,
    invite_fp: Option<&str>,
) -> Result<RelayAnchor, String> {
    let vault = vault.lock().unwrap();
    let store = vault
        .store()
        .map_err(|_| "cannot check the relay's identity while the vault is locked".to_string())?;
    let pin: Option<RelayPin> = store
        .get_setting(&relay_pin_key(base_url))
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::from_str(&v).ok());
    // An account that predates the pin setting still recorded the relay it
    // belongs to (its whole identity is derived from that fingerprint), so use
    // that as the anchor rather than re-TOFUing on upgrade. Only when there is
    // exactly one — this account belongs to exactly one relay today, and a
    // multi-relay account (D4c) would need the row matched by URL.
    let recorded = match &pin {
        Some(_) => None,
        None => match store.relay_identities().map_err(|e| e.to_string())?.as_slice() {
            [(_, fp)] => Some(fp.clone()),
            _ => None,
        },
    };
    let stored = pin.as_ref().map(|p| p.fp.clone()).or(recorded);
    let expected = match (invite_fp, stored) {
        // The invite is authoritative — but if we already hold a pin they must
        // agree, or one of the two channels is lying.
        (Some(inv), Some(known)) if inv != known => {
            return Err(format!(
                "{}: the invite names relay {inv}, but this account is pinned to {known}",
                relay_client::ERR_IDENTITY_MISMATCH
            ))
        }
        (Some(inv), _) => Some(inv.to_string()),
        (None, known) => known,
    };
    // The rollback floor comes only from a pin this account wrote: it is a
    // memory of what we accepted, and nothing the relay says can raise it.
    let floor = pin
        .as_ref()
        .filter(|p| p.delegation_version > 0)
        .map(|p| delegation::DelegationFloor {
            min_version: p.delegation_version,
            online_key: (!p.delegation_online_key.is_empty())
                .then(|| p.delegation_online_key.clone()),
        })
        .unwrap_or_default();
    Ok(RelayAnchor { expected, pinned: pin.is_some(), floor })
}

/// Record the verified identity on first contact, or confirm it against the
/// existing pin, and **raise the delegation high-water mark**. Never re-pins
/// silently: a disagreement on the root is an error.
///
/// The high-water mark is the one part of a pin that legitimately moves, and it
/// moves in one direction only (`max`) — an accepted rotation raises it, and a
/// later connect can then never be talked back down to the revoked key. It is
/// written *after* a successful connect, so a refused connection never advances
/// it and a failed handshake never strands the account above a version the relay
/// can still serve.
fn pin_relay_identity(
    vault: &Mutex<Vault>,
    base_url: &str,
    identity: &relay_client::RelayIdentity,
    anchor: &RelayAnchor,
) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault
        .store()
        .map_err(|_| "cannot pin the relay's identity while the vault is locked".to_string())?;
    let key = relay_pin_key(base_url);
    let mut floor_version = anchor.floor.min_version;
    if anchor.pinned {
        let stored: Option<RelayPin> = store
            .get_setting(&key)
            .map_err(|e| e.to_string())?
            .and_then(|v| serde_json::from_str(&v).ok());
        if let Some(p) = stored {
            // `connect` already refused a fingerprint that isn't `expected`;
            // this also holds the *key* to the pin, so a relay cannot keep the
            // pinned fingerprint while swapping the key it is derived from.
            if p.fp != identity.fingerprint
                || (!p.identity_pub.is_empty() && p.identity_pub != identity.identity_pub)
            {
                return Err(format!(
                    "{}: this relay's identity is not the one pinned for this account",
                    relay_client::ERR_IDENTITY_MISMATCH
                ));
            }
            // Re-read rather than trusting the anchor snapshot: another connect
            // may have raised it since, and the mark must never go down.
            floor_version = floor_version.max(p.delegation_version);
        }
    }
    let current = identity.kt_keys.current();
    if current.version < floor_version {
        // Only reachable if a concurrent connect raised the mark between
        // `relay_anchor` and here (the connect itself already refused anything
        // below the anchor's floor). Leave the stricter record alone rather than
        // writing a `(version, key)` pair that disagrees with itself.
        return Ok(());
    }
    let pin = RelayPin {
        fp: identity.fingerprint.clone(),
        identity_pub: identity.identity_pub.clone(),
        delegation_version: current.version,
        delegation_online_key: current.online_key.clone(),
    };
    store
        .set_setting(&key, &serde_json::to_string(&pin).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Raise the hard alarm for an identity failure and pass the error through
/// unchanged (the webview maps its code to a catalogued message).
///
/// Every link of the chain lands here — a substituted root, a fingerprint that
/// does not bind its key, a delegation that will not verify, and a rolled-back
/// delegation version — because they all mean the same thing to the user: the
/// key-transparency log this app checks contacts against cannot be trusted.
fn alarm_on_identity_error(err: String, on_kt_alarm: KtAlarmSink<'_>) -> String {
    let reason = if err.starts_with(relay_client::ERR_IDENTITY_MISMATCH)
        || err.starts_with(relay_client::ERR_IDENTITY_INVALID)
    {
        Some(ALARM_RELAY_IDENTITY)
    } else if err.starts_with(delegation::ERR_DELEGATION_ROLLBACK) {
        Some(ALARM_RELAY_ROLLBACK)
    } else if err.starts_with(delegation::ERR_DELEGATION_INVALID) {
        Some(ALARM_RELAY_DELEGATION)
    } else {
        None
    };
    if let Some(reason) = reason {
        log::error!("relay identity refused: {err}");
        on_kt_alarm(reason, 0);
    }
    err
}

/// **Connect to a relay, holding it to this account's anchor.** The core half of
/// the `relay_connect` command — separated so the L2 tests can drive it against
/// a byte-controlled relay (`tests/kt_contact_verify.rs`) without a Tauri app.
///
/// Order matters: resolve the anchor, refuse anything that disagrees *before*
/// the authenticated handshake, and only pin after the relay's identity has
/// checked out. Every refusal raises the hard alarm through `on_kt_alarm`.
pub async fn connect_to_relay(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    url: &str,
    invite_fp: Option<&str>,
    signing: &ed25519_dalek::SigningKey,
    on_kt_alarm: KtAlarmSink<'_>,
) -> Result<(), String> {
    let anchor =
        relay_anchor(vault, url, invite_fp).map_err(|e| alarm_on_identity_error(e, on_kt_alarm))?;
    let identity = relay
        .connect(url, signing, anchor.expected.as_deref(), Some(&anchor.floor))
        .await
        .map_err(|e| alarm_on_identity_error(e, on_kt_alarm))?;
    pin_relay_identity(vault, url, &identity, &anchor)
        .map_err(|e| alarm_on_identity_error(e, on_kt_alarm))
}

/// The same anchoring around signup (`relay_register`'s core half). Returns the
/// server-assigned handle.
pub async fn register_on_relay(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    url: &str,
    invite_token: Option<&str>,
    handle_choice: Option<&str>,
    invite_fp: Option<&str>,
    signing: &ed25519_dalek::SigningKey,
    on_kt_alarm: KtAlarmSink<'_>,
) -> Result<String, String> {
    let anchor =
        relay_anchor(vault, url, invite_fp).map_err(|e| alarm_on_identity_error(e, on_kt_alarm))?;
    let registration = relay
        .register(
            url,
            signing,
            invite_token,
            handle_choice,
            anchor.expected.as_deref(),
            Some(&anchor.floor),
        )
        .await
        .map_err(|e| alarm_on_identity_error(e, on_kt_alarm))?;
    pin_relay_identity(vault, url, &registration.identity, &anchor)
        .map_err(|e| alarm_on_identity_error(e, on_kt_alarm))?;
    Ok(registration.handle)
}

/// **The invite's relay must be the relay we are talking to.** An invite's
/// `relayFp` arrived out-of-band through the human invite channel, so it is the
/// authority; the connected session's fingerprint is not, whatever pinned it.
/// Checking a contact key against a transparency log proves nothing if the log
/// belongs to some other relay, so this gates that check rather than following
/// it. Separated from the command for the L2 tests.
pub fn require_invite_relay(
    relay: &relay_client::RelayClient,
    invite_fp: &str,
    on_kt_alarm: KtAlarmSink<'_>,
) -> Result<(), String> {
    let (_base, session_fp) = relay.session_info().ok_or("not connected to a relay")?;
    if invite_fp != session_fp {
        return Err(alarm_on_identity_error(
            format!(
                "{}: the invite is for relay {invite_fp}, but this device is connected to {session_fp}",
                relay_client::ERR_IDENTITY_MISMATCH
            ),
            on_kt_alarm,
        ));
    }
    Ok(())
}

/// The webview's alarm sink: emits `kt:alarm` for the non-dismissable banner.
fn app_kt_alarm(app: &tauri::AppHandle) -> impl Fn(&str, i64) + Send + Sync + '_ {
    move |reason: &str, epoch: i64| {
        use tauri::Emitter as _;
        let _ = app.emit(
            "kt:alarm",
            KtAuditReport { ok: false, reason: Some(reason.to_string()), epoch },
        );
    }
}

// ---- relay auth (D4/D4b client half) ----

#[tauri::command]
fn device_public_key(vault: VaultState) -> Result<String, String> {
    let vault = vault.lock().unwrap();
    let key = vault.device_signing_key().map_err(|e| e.to_string())?;
    Ok(relay_client::device_public_key_b64(&key))
}

/// Connect to a relay, **checking its identity against our anchor first**.
///
/// `expect_relay_fp` is an invite's `relayFp` where the caller has one: it
/// travelled the human invite channel, so it is the one anchor the relay did not
/// supply, and it outranks the stored pin. With no invite the stored pin (or, on
/// an account that predates it, the recorded relay row) is the anchor; with
/// neither, this is first contact and the identity is pinned trust-on-first-use.
#[tauri::command]
async fn relay_connect(
    url: String,
    expect_relay_fp: Option<String>,
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
    voice: tauri::State<'_, voice_live::VoiceSignal>,
) -> Result<(), String> {
    // Take the key before any await: the vault mutex must not cross it.
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    connect_to_relay(
        &vault,
        &relay,
        &url,
        expect_relay_fp.as_deref(),
        &signing,
        &app_kt_alarm(&app),
    )
    .await?;
    // Start the live-delivery link once: it holds a WS and emits `relay:mail`
    // nudges so the webview drains its mailbox without polling (best-effort;
    // REST fetch stays authoritative).
    if relay.try_begin_live() {
        if let Some((base, fp)) = relay.session_info() {
            tauri::async_runtime::spawn(relay_live::run_forever(
                base,
                fp,
                signing.clone(),
                app.clone(),
            ));
        }
    }
    // Start the voice signaling link once (same device-token auth), holding a WS
    // to /api/relay/voice that pumps join/signal/leave up and emits `voice:frame`
    // for inbound peer signaling.
    if let Some(rx) = voice.begin() {
        if let Some((base, fp)) = relay.session_info() {
            tauri::async_runtime::spawn(voice_live::run_forever(base, fp, signing, app, rx));
        }
    }
    Ok(())
}

/// Create this device's account on `url` and enroll the device in one call,
/// leaving us authenticated (no separate `relay_connect` needed). `invite_token`
/// is the bare invite token (extracted from a friend invite by the caller) —
/// required on an invite-only relay, except for the first account. Persists the
/// server-assigned handle and brings up the live-delivery + voice links, exactly
/// like `relay_connect`. Returns the handle.
///
/// `expect_relay_fp` is the invite's `relayFp` (see `relay_connect`). Signup is
/// where it matters most: the whole account identity is derived from the relay
/// fingerprint, so an unanchored signup against an impostor produces a
/// consistent-looking account belonging to the wrong relay. A signup with no
/// invite (`registerOnRelay`) has no anchor and stays trust-on-first-use —
/// see spec/relay.md § Pinning the relay identity.
#[tauri::command]
async fn relay_register(
    url: String,
    invite_token: Option<String>,
    handle_choice: Option<String>,
    expect_relay_fp: Option<String>,
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
    voice: tauri::State<'_, voice_live::VoiceSignal>,
) -> Result<String, String> {
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    let handle = register_on_relay(
        &vault,
        &relay,
        &url,
        invite_token.as_deref(),
        handle_choice.as_deref(),
        expect_relay_fp.as_deref(),
        &signing,
        &app_kt_alarm(&app),
    )
    .await?;
    // Persist my handle so the rest of the app (KT self-audit, invite creation,
    // friend reciprocation) can name me without another round-trip.
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.set_setting("identity.handle", &handle).map_err(|e| e.to_string())?;
    }
    // We're authed now: bring up the same links `relay_connect` does.
    if relay.try_begin_live() {
        if let Some((base, fp)) = relay.session_info() {
            tauri::async_runtime::spawn(relay_live::run_forever(base, fp, signing.clone(), app.clone()));
        }
    }
    if let Some(rx) = voice.begin() {
        if let Some((base, fp)) = relay.session_info() {
            tauri::async_runtime::spawn(voice_live::run_forever(base, fp, signing, app, rx));
        }
    }
    Ok(handle)
}

/// Invite signups only: deliver the sealed friend-accept to whoever invited us
/// (the follow-up leg of the D4b handshake, now that we hold a device token).
/// Returns whether the relay delivered it.
///
/// KT (D5): the invite's pinned `identity_pub` is checked against the
/// transparency log for `handle` **before** the envelope leaves this device —
/// the accept carries my delivery token, so a verdict reached afterwards would
/// arrive too late to matter.
#[tauri::command]
async fn relay_register_friend_accept(
    envelope: Vec<u8>,
    handle: String,
    identity_pub: String,
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<bool, String> {
    require_contact_key_ok(&app, &vault, &relay, &handle, &identity_pub).await?;
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.register_friend_accept(&signing, envelope).await
}

/// Derive this account's per-relay identity (D4b) and publish it to the
/// relay's key directory (D5). Requires the vault unlocked (MK) and a
/// connected relay (its fingerprint is the derivation input).
#[tauri::command]
async fn relay_directory_publish(
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (device, id_pub, seal_pub) = {
        let vault = vault.lock().unwrap();
        let device = vault.device_signing_key().map_err(|e| e.to_string())?;
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        (
            device,
            b64.encode(ident.signing_public()),
            b64.encode(ident.sealing_public()),
        )
    };
    relay.directory_publish(&device, id_pub, seal_pub).await
}

/// Report of a KT self-audit (D5): did the relay's log only ever bind my handle
/// to keys I minted, and are its roots consistent (no split view)?
#[derive(serde::Serialize, Clone)]
struct KtAuditReport {
    ok: bool,
    /// Alarm reason when `!ok`: "self-audit-failed" (foreign key), "split-view"
    /// (inconsistent roots), or "contact-key-mismatch" (the log contradicts a
    /// contact key we were asked to trust).
    reason: Option<String>,
    epoch: i64,
}

/// Alarm reason for "the log does not vouch for a contact key we were about to
/// trust". Every `kt::Rejected` variant lands here: whether the relay served a
/// different key, an unverifiable proof, a root it never signed, or a swapped
/// VRF key, the user-facing fact is the same — this contact's key is not the one
/// the transparency log published.
const ALARM_CONTACT_KEY: &str = "contact-key-mismatch";

/// Where a relay's pinned VRF public key lives (per relay, in the vault).
fn kt_vrf_pin_key(relay_fp: &str) -> String {
    format!("kt.vrfPub.{relay_fp}")
}

/// A contact key we are about to trust, to be checked against the log.
pub struct ContactKeyCheck {
    pub handle: String,
    pub identity_pub: Vec<u8>,
}

/// **The directory-lookup path (D5).** Ask the relay's transparency log which
/// identity key it published for each handle and compare it with the key we were
/// handed (an invite's TOFU pin, or the verified sender of a friend-accept).
///
/// Order is the whole point, and it is enforced in `kt::contact_verdict`: the
/// root that the inclusion proof is checked against must first appear in the
/// relay's **signed** `/kt/roots` chain — the same signature the gossip path
/// verifies. A proof always verifies against the root it shipped with, so
/// trusting that root would let a hostile relay serve a self-consistent
/// `(proof, root)` pair for a key it chose.
///
/// Infallible by design: a relay we cannot reach yields `Unverified`, never a
/// block — Accord has to keep working offline. Only an *active* contradiction
/// (`Rejected`) fails closed, and this is where its hard alarm is raised, so
/// every caller reports it identically.
pub async fn verify_contact_keys(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    checks: &[ContactKeyCheck],
    on_kt_alarm: KtAlarmSink<'_>,
) -> Vec<kt::ContactTrust> {
    use kt::{ContactTrust, Unverified};
    if checks.is_empty() {
        return Vec::new();
    }
    let unverified = |u: Unverified| vec![ContactTrust::Unverified(u); checks.len()];

    let Some((_base, relay_fp)) = relay.session_info() else {
        return unverified(Unverified::RelayUnreachable);
    };
    // Root signatures are checked against the ONLINE key the pinned offline root
    // delegated to — established and verified at connect (`verified_identity` →
    // `delegation::verify_chain`), never against the pinned root itself and
    // never against a key the relay served alongside the roots.
    let Some(kt_keys) = relay.kt_signing_keys() else {
        return unverified(Unverified::NoRelayKey);
    };
    // The VRF public key is pinned per relay on first use. It decides which leaf
    // a handle maps to, so a relay free to swap it could aim any handle at a leaf
    // holding a key of its choosing and still produce a valid proof under a
    // genuinely signed root. It is not covered by the relay's root signature
    // (see key-transparency.md § Contact verification), hence TOFU.
    let pinned_vrf = {
        let vault = vault.lock().unwrap();
        vault
            .store()
            .ok()
            .and_then(|s| s.get_setting(&kt_vrf_pin_key(&relay_fp)).ok().flatten())
    };
    let roots = match relay.kt_roots(0).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("kt: signed roots unavailable ({e}) — contacts stay unverified");
            return unverified(Unverified::RelayUnreachable);
        }
    };

    let mut verdicts = Vec::with_capacity(checks.len());
    let mut vrf_to_pin: Option<String> = None;
    let mut observed: Vec<(i64, String)> = Vec::new();
    for c in checks {
        let verdict = match relay.directory_lookup(&c.handle).await {
            Ok(Some(entry)) => {
                let v = kt::contact_verdict(
                    &kt_keys,
                    &roots,
                    pinned_vrf.as_deref(),
                    &c.handle,
                    &c.identity_pub,
                    &entry,
                );
                // Only ever pin a VRF key that just produced a proof verifying
                // under a root the relay signed.
                if pinned_vrf.is_none() && matches!(v, ContactTrust::Verified { .. }) {
                    vrf_to_pin.get_or_insert(entry.vrf_public_key.clone());
                }
                v
            }
            // 404: the relay says the handle has no entry. Never a match — but
            // not a block either (key-transparency.md § The 404 case).
            Ok(None) => ContactTrust::Unverified(Unverified::NotInLog),
            Err(e) => {
                log::warn!("kt: directory lookup failed ({e}) — {} stays unverified", c.handle);
                ContactTrust::Unverified(Unverified::RelayUnreachable)
            }
        };
        if let ContactTrust::Verified { epoch, root } = &verdict {
            observed.push((*epoch, root.clone()));
        }
        if let Some(r) = verdict.rejected() {
            log::error!("kt: REJECTED contact key for {} ({})", c.handle, r.as_str());
        }
        verdicts.push(verdict);
    }

    // Store side-effects last, so the vault mutex never spans an await.
    let mut split_epoch = None;
    {
        let vault = vault.lock().unwrap();
        if let Ok(store) = vault.store() {
            if let Some(vrf) = &vrf_to_pin {
                if let Err(e) = store.set_setting(&kt_vrf_pin_key(&relay_fp), vrf) {
                    log::warn!("kt: could not pin the relay VRF key: {e}");
                }
            }
            // Every root we verified is also evidence for split-view detection:
            // a different root at an epoch we have already seen is equivocation.
            // (Before the relay row exists — the very first drain of a new
            // account — the insert is refused by the FK and the observation is
            // simply skipped; the verdict above is unaffected.)
            for (epoch, root) in &observed {
                match store.kt_observe_root(&relay_fp, *epoch, root) {
                    Ok(store::KtObserve::SplitView { .. }) => split_epoch = Some(*epoch),
                    Ok(_) => {}
                    Err(e) => log::debug!("kt: could not record observed root: {e}"),
                }
            }
        }
    }
    if let Some(epoch) = split_epoch {
        on_kt_alarm("split-view", epoch);
    }
    if let Some(i) = verdicts.iter().position(|v| v.rejected().is_some()) {
        // A hard alarm, raised centrally so every caller reports it the same.
        on_kt_alarm(ALARM_CONTACT_KEY, verdicts[i].epoch().unwrap_or(0));
    }
    verdicts
}

/// Verify one contact key before anything is sealed to it or recorded (invite
/// redeem / register-time friend-accept). `Err` = fail closed.
async fn require_contact_key_ok(
    app: &tauri::AppHandle,
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    handle: &str,
    identity_pub_b64: &str,
) -> Result<(), String> {
    use base64::Engine as _;
    let identity_pub = base64::engine::general_purpose::STANDARD
        .decode(identity_pub_b64)
        .map_err(|_| "bad contact identity key".to_string())?;
    if identity_pub.len() != 32 {
        return Err("bad contact identity key".into());
    }
    let checks = [ContactKeyCheck { handle: handle.to_string(), identity_pub }];
    let verdicts = verify_contact_keys(vault, relay, &checks, &app_kt_alarm(app)).await;
    match verdicts.first().and_then(|v| v.rejected()) {
        // The catalogued code the webview turns into a user-facing error.
        Some(r) => Err(format!("KT_CONTACT_KEY_MISMATCH: {}", r.as_str())),
        None => Ok(()),
    }
}

/// Self-audit my own handle against the relay's KT log (D5, full-AKD): fetch its
/// key-history proof, **check the root's relay signature**, verify the proof
/// against that signed root, and confirm every key it mapped my handle to is one
/// I actually minted. Also records the root (split-view detection) and, on a
/// clean pass, advances my verified root. A failure emits a hard `kt:alarm`.
///
/// The signature check is not optional: a history proof verifies against
/// whatever root it is handed, so a relay could otherwise answer with a
/// self-consistent (proof, root) pair for a directory that hides a foreign key
/// — the self-audit would pass while the relay equivocates.
#[tauri::command]
async fn kt_self_audit(
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<KtAuditReport, String> {
    let (_base_url, relay_fp) = relay.session_info().ok_or("not connected to a relay")?;
    // My handle + identity key (the akd value is the identity pubkey).
    let (handle, my_key) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let handle = store
            .get_setting("identity.handle")
            .map_err(|e| e.to_string())?
            .ok_or("no local handle — finish onboarding first")?;
        (handle, ident.signing_public().to_vec())
    };

    let hist = relay.directory_history(&handle).await?;
    // Anchor first: the root must be one this relay actually signed, and the
    // *relay* epoch of that signed root is what the client records — the akd
    // epoch in the proof is the sidecar's own counter and does not line up with
    // the signed root chain that gossip and the auditor speak in.
    let kt_keys = relay
        .kt_signing_keys()
        .ok_or("no delegated relay signing key — cannot verify the KT root signature")?;
    let roots = relay.kt_roots(0).await?;
    let epoch = kt::signed_root_epoch(&kt_keys, &roots, &hist.root)
        .ok_or("KT root is not signed by this relay")?;
    // Same reasoning as contact verification: an unpinned VRF key lets the relay
    // choose which leaf a handle resolves to.
    if let Some(pin) = {
        let vault = vault.lock().unwrap();
        vault
            .store()
            .ok()
            .and_then(|s| s.get_setting(&kt_vrf_pin_key(&relay_fp)).ok().flatten())
    } {
        if pin != hist.vrf_public_key {
            use tauri::Emitter as _;
            let report = KtAuditReport { ok: false, reason: Some("self-audit-failed".into()), epoch };
            let _ = app.emit("kt:alarm", report.clone());
            return Ok(report);
        }
    }
    let keys = kt::verify_key_history(&hist.vrf_public_key, &hist.root, hist.epoch, &handle, &hist.proof_json)?;
    let verdict = kt::self_audit_verdict(&keys, std::slice::from_ref(&my_key));

    let observe = {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.kt_observe_root(&relay_fp, epoch, &hist.root).map_err(|e| e.to_string())?
    };

    let reason = match (&verdict, &observe) {
        (kt::SelfAudit::Foreign(_), _) => Some("self-audit-failed".to_string()),
        (_, store::KtObserve::SplitView { .. }) => Some("split-view".to_string()),
        _ => None,
    };
    if reason.is_none() {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.kt_set_verified(&relay_fp, epoch, &hist.root).map_err(|e| e.to_string())?;
        // First clean audit pins the relay's VRF key (see `verify_contact_keys`).
        let pin = kt_vrf_pin_key(&relay_fp);
        if store.get_setting(&pin).ok().flatten().is_none() && !hist.vrf_public_key.is_empty() {
            let _ = store.set_setting(&pin, &hist.vrf_public_key);
        }
    } else {
        use tauri::Emitter as _;
        let _ = app.emit("kt:alarm", KtAuditReport { ok: false, reason: reason.clone(), epoch });
    }
    Ok(KtAuditReport { ok: reason.is_none(), reason, epoch })
}

/// Outcome of the contact re-verification sweep.
#[derive(serde::Serialize, Clone, Default, Debug)]
pub struct KtContactSweep {
    /// Contacts newly proven against the log on this pass.
    pub verified: usize,
    /// Contacts still unproven (relay unreachable, handle absent from the log,
    /// or an interim-KT relay). They stay recorded, and stay unverified.
    pub unverified: usize,
    /// Contacts the log actively contradicted — their verification is cleared
    /// and a hard alarm is raised. The friendship itself is left alone; the
    /// alarm, not a silent deletion, is what the user acts on.
    pub rejected: usize,
}

/// Re-check every contact whose key was never proven against the log (D5).
/// Run on relay connect: an add that happened offline, or while the relay's
/// directory was unavailable, is recorded UNVERIFIED and settled here.
#[tauri::command]
async fn kt_verify_contacts(
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<KtContactSweep, String> {
    verify_recorded_contacts(&vault, &relay, &app_kt_alarm(&app)).await
}

/// The sweep itself, free of Tauri state so the **real** one can be driven by
/// the L2 integration tests as well as by the command above.
pub async fn verify_recorded_contacts(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    on_kt_alarm: KtAlarmSink<'_>,
) -> Result<KtContactSweep, String> {
    let (_base, relay_fp) = relay.session_info().ok_or("not connected to a relay")?;
    let pending = {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.kt_unverified_contacts(&relay_fp).map_err(|e| e.to_string())?
    };
    if pending.is_empty() {
        return Ok(KtContactSweep::default());
    }
    let checks: Vec<ContactKeyCheck> = pending
        .iter()
        .map(|c| ContactKeyCheck { handle: c.handle.clone(), identity_pub: c.identity_pub.clone() })
        .collect();
    let verdicts = verify_contact_keys(vault, relay, &checks, on_kt_alarm).await;

    let mut sweep = KtContactSweep::default();
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    for (c, verdict) in pending.iter().zip(verdicts.iter()) {
        match verdict {
            kt::ContactTrust::Verified { epoch, .. } => {
                store
                    .kt_mark_contact_verified(&c.contact_id, &relay_fp, &c.identity_pub, *epoch)
                    .map_err(|e| e.to_string())?;
                sweep.verified += 1;
            }
            kt::ContactTrust::Rejected(_) => {
                store
                    .kt_clear_contact_verified(&c.contact_id, &relay_fp)
                    .map_err(|e| e.to_string())?;
                sweep.rejected += 1;
            }
            kt::ContactTrust::Unverified(_) => sweep.unverified += 1,
        }
    }
    Ok(sweep)
}

/// Seal an E2E envelope to a recipient's sealing key (envelope v1).
#[tauri::command]
fn envelope_seal(
    recipient_sealing_pub: String,
    kind: String,
    payload: Vec<u8>,
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let recipient: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(&recipient_sealing_pub)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or("bad recipient key")?;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let mk = vault.mk().map_err(|e| e.to_string())?;
    let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
    envelope::seal(&recipient, &ident, &kind, &payload, now_ms()).map_err(|e| e.to_string())
}

/// Open an envelope addressed to this account's per-relay identity.
#[tauri::command]
fn envelope_open(
    envelope_bytes: Vec<u8>,
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<envelope::Opened, String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let mk = vault.mk().map_err(|e| e.to_string())?;
    let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
    envelope::open(&ident.sealing, &envelope_bytes).map_err(|e| e.to_string())
}

/// Derive the delivery token from the profile key and register its hash
/// with the relay (D6). Returns the token — the caller seals it to friends.
#[tauri::command]
async fn relay_register_verifier(
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    let (signing, token, verifier) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let (token, verifier) = vault.delivery_token().map_err(|e| e.to_string())?;
        (signing, token, verifier)
    };
    relay.register_verifier(&signing, verifier).await?;
    Ok(token)
}

/// Change my public handle to a client-picked generated candidate. Persists the
/// server-confirmed handle locally so the chrome updates. Friends are unaffected
/// (identity-keyed); only what non-contacts see by handle changes.
#[tauri::command]
async fn relay_change_handle(
    handle: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    let confirmed = relay.change_handle(&signing, &handle).await?;
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.set_setting("identity.handle", &confirmed).map_err(|e| e.to_string())?;
    }
    Ok(confirmed)
}

#[tauri::command]
async fn relay_send(
    recipient_handle: String,
    delivery_token: String,
    envelope: Vec<u8>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<i64, String> {
    relay.mailbox_send(&recipient_handle, &delivery_token, envelope).await
}

#[tauri::command]
async fn relay_mailbox_fetch(
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<Vec<relay_client::MailboxRow>, String> {
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.mailbox_fetch(&signing).await
}

#[tauri::command]
async fn relay_mailbox_ack(
    queue_ids: Vec<i64>,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<u64, String> {
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.mailbox_ack(&signing, queue_ids).await
}

/// Drain the sealed-sender mailbox into the local log (D6/D11): fetch queued
/// envelopes, open+verify each, decode `msg` payloads, ingest idempotently
/// (ordering = the relay delivery stamp; sender = the verified envelope cert),
/// then ack what we durably stored or permanently can't use. Version-skew and
/// not-yet-handled kinds are left queued to redeliver after an app update
/// ("buffer, never drop"). Triggered by the `relay:mail` live nudge or on
/// reconnect; safe to call repeatedly.
#[tauri::command]
async fn relay_mailbox_drain(
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<message::DrainReport, String> {
    mailbox_drain(&vault, &relay, &app_kt_alarm(&app)).await
}

/// Where the drain reports a hard KT alarm (`reason`, `epoch`). In the app this
/// emits `kt:alarm` to the webview; the L2 integration tests pass a recorder.
pub type KtAlarmSink<'a> = &'a (dyn Fn(&str, i64) + Send + Sync);

/// The drain itself, free of Tauri state so the **real** one can be driven by
/// the L2 integration tests (spec/testing.md § L2) as well as by the command
/// above. `vault`/`relay` are the same values the command holds — a
/// `tauri::State` derefs to them.
pub async fn mailbox_drain(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    on_kt_alarm: KtAlarmSink<'_>,
) -> Result<message::DrainReport, String> {
    let (base_url, relay_fp) = relay.session_info().ok_or("not connected to a relay")?;
    // Take the device key (for fetch/ack), the sealing secret (to open
    // envelopes), and my identity pub (to persist the relay row) before any
    // await — the vault mutex must not cross it.
    // Take, before any await (the vault mutex must not cross it): the device
    // key (fetch/ack), my full relay identity (open + reciprocal seal), my
    // delivery token (to hand to new friends), and my identity pub (relay row).
    let (signing, ident, my_delivery_token, group_keys) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let (token, _verifier) = vault.delivery_token().map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        // My group keys (to open group envelopes, which the DM open can't).
        let mut group_keys: Vec<(String, [u8; 32])> = Vec::new();
        for g in store.list_groups().map_err(|e| e.to_string())? {
            if let Some(k) = store.group_key(&g.group_id).map_err(|e| e.to_string())? {
                if let Ok(k32) = <[u8; 32]>::try_from(k.as_slice()) {
                    group_keys.push((g.group_id, k32));
                }
            }
        }
        (signing, ident, token, group_keys)
    };
    let my_identity_pub = ident.signing_public().to_vec();

    let rows = relay.mailbox_fetch(&signing).await?;
    let mut imports = Vec::new();
    let mut friends = Vec::new();
    let mut deletes = Vec::new();
    let mut edits = Vec::new();
    let mut reacts = Vec::new();
    let mut group_invites = Vec::new();
    let mut call_rings = Vec::new();
    let mut kt_gossips = Vec::new();
    let mut ack_ids = Vec::new();
    let mut buffered = 0usize;
    for row in rows {
        // A v8 envelope is either a DM (per-recipient X25519 seal) or a group
        // envelope (symmetric under a shared group key). Try the DM open first;
        // on failure, try each of my group keys — a hit means it's a group
        // message for that group. `group_id` is Some for group envelopes.
        let opened_result: Result<envelope::Opened, envelope::EnvelopeError>;
        let mut group_id: Option<String> = None;
        match envelope::open(&ident.sealing, &row.envelope) {
            Ok(o) => opened_result = Ok(o),
            Err(envelope::EnvelopeError::UnknownVersion(v)) => {
                opened_result = Err(envelope::EnvelopeError::UnknownVersion(v));
            }
            Err(e) => {
                let mut found = None;
                for (gid, gkey) in &group_keys {
                    if let Ok(o) = envelope::open_group(gkey, &row.envelope) {
                        found = Some((o, gid.clone()));
                        break;
                    }
                }
                match found {
                    Some((o, gid)) => {
                        opened_result = Ok(o);
                        group_id = Some(gid);
                    }
                    None => opened_result = Err(e),
                }
            }
        }
        match message::disposition(opened_result, row.relay_ts) {
            message::Disposition::Ingest(m) => {
                let mut m = *m;
                if let Some(gid) = group_id {
                    // Group: the key that opened it identifies the conversation.
                    m.conversation_id = gid;
                } else if let Some(sender_b64) = m.sender_contact_id.clone() {
                    // DM: route by the verified sender, not the payload's claimed
                    // conversation_id — a message from a sender always lands in
                    // *my DM with that sender* (spoof-proof).
                    use base64::Engine as _;
                    if let Ok(sender_raw) =
                        base64::engine::general_purpose::STANDARD.decode(&sender_b64)
                    {
                        m.conversation_id =
                            identity::dm_conversation_id(&my_identity_pub, &sender_raw);
                    }
                }
                imports.push(m);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::Friend(f) => {
                friends.push(*f);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::Delete(d) => {
                deletes.push(*d);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::Edit(e) => {
                edits.push(*e);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::React(r) => {
                reacts.push(*r);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::GroupInvite(g) => {
                group_invites.push(*g);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::CallOffer(c) => {
                // A ring is ephemeral — always ack (never re-buffer). The UI
                // decides whether it's still fresh enough to ring, from relay_ts.
                call_rings.push(message::CallRing {
                    call_id: c.call_id,
                    caller_id: c.caller_id,
                    relay_ts: row.relay_ts,
                    media_key: c.media_key,
                });
                ack_ids.push(row.queue_id);
            }
            message::Disposition::KtGossip(g) => {
                // Ephemeral: always ack. The relay-signature check + split-view
                // detection run after the store block (need the relay key).
                kt_gossips.push(*g);
                ack_ids.push(row.queue_id);
            }
            message::Disposition::Discard => ack_ids.push(row.queue_id),
            message::Disposition::Buffer => buffered += 1,
        }
    }

    // KT (D5) — check every inbound contact key against the transparency log
    // BEFORE anything is recorded and, critically, before any reply is sealed:
    // a friend-accept is answered with my delivery token, so verifying after
    // replying would hand that token to an impostor whatever the verdict said.
    // `verify_contact_keys` never fails the drain; an unreachable relay leaves
    // the contact unverified, to be re-checked on the next connect.
    let friend_trust = verify_contact_keys(
        vault,
        relay,
        &friends
            .iter()
            .map(|f| ContactKeyCheck { handle: f.handle.clone(), identity_pub: f.identity_pub.clone() })
            .collect::<Vec<_>>(),
        on_kt_alarm,
    )
    .await;
    // Fail closed on a contradiction: the rejected sender is neither recorded
    // nor answered. Their envelope is still acked — it is permanently
    // unusable, and re-draining it would only replay the same rejection.
    let mut kt_rejected = 0usize;
    let mut friend_epochs: Vec<Option<i64>> = Vec::with_capacity(friends.len());
    let friends: Vec<message::FriendAcceptData> = friends
        .into_iter()
        .zip(friend_trust.iter())
        .filter_map(|(f, trust)| match trust.rejected() {
            Some(r) => {
                log::error!("kt: refusing friend {} — {}", f.handle, r.as_str());
                kt_rejected += 1;
                None
            }
            None => {
                friend_epochs.push(trust.epoch());
                Some(f)
            }
        })
        .collect();

    // Persist first; only ack once durably stored (hold-until-ack). Friends
    // (D4b): record the verified sender's addressing so we can reach them, and
    // read my own handle (persisted at invite creation) for reciprocation.
    let friend_count = friends.len();
    let (ingested, my_handle, my_display_name) = {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        let my_handle = store.get_setting("identity.handle").map_err(|e| e.to_string())?;
        let my_display_name = store.get_setting("profile.displayName").map_err(|e| e.to_string())?;
        // Persist the relay row so friend + conversation rows can FK to it.
        store
            .upsert_relay(&relay_fp, &base_url, &relay_fp, &my_identity_pub)
            .map_err(|e| e.to_string())?;
        for (f, kt_epoch) in friends.iter().zip(friend_epochs.iter()) {
            store
                .record_friend(&store::FriendRecord {
                    contact_id: f.contact_id.clone(),
                    display_name: f.display_name.clone(),
                    relay_id: relay_fp.clone(),
                    handle: f.handle.clone(),
                    identity_pub: f.identity_pub.clone(),
                    sealing_pub: f.sealing_pub.clone(),
                    delivery_token: f.delivery_token.clone(),
                    // Some(epoch) only when the log proved this exact key.
                    kt_verified_epoch: *kt_epoch,
                })
                .map_err(|e| e.to_string())?;
        }
        // Messages FK to a conversation row — ensure each exists first (v8 DMs).
        for m in &imports {
            store
                .ensure_conversation(&m.conversation_id, "dm", &relay_fp)
                .map_err(|e| e.to_string())?;
        }
        let ingested = store.import_messages(imports).map_err(|e| e.to_string())?;
        // Deletes (D11): tombstone only if the verified sender is the message's
        // original author (a friend can't delete my messages). Unknown target →
        // skip (edit/delete of a not-yet-seen message is dropped; sends precede
        // their deletes in FIFO delivery).
        for d in &deletes {
            let author = store.message_sender(&d.target_id).map_err(|e| e.to_string())?;
            if author.as_deref() == Some(d.editor_id.as_str()) {
                store.message_apply_delete(&d.target_id).map_err(|e| e.to_string())?;
            }
        }
        // Edits (D11): same author-only authority as deletes.
        for e in &edits {
            let author = store.message_sender(&e.target_id).map_err(|e| e.to_string())?;
            if author.as_deref() == Some(e.editor_id.as_str()) {
                store
                    .message_apply_edit(&e.target_id, Some(&e.content), e.edited_at)
                    .map_err(|e| e.to_string())?;
            }
        }
        // Reactions (D11): any friend may react to a message they can see; the
        // reactor is the verified sender.
        for r in &reacts {
            if r.add {
                store
                    .add_reaction(&r.target_id, &r.reactor_id, &r.emoji)
                    .map_err(|e| e.to_string())?;
            } else {
                store
                    .remove_reaction(&r.target_id, &r.reactor_id, &r.emoji)
                    .map_err(|e| e.to_string())?;
            }
        }
        (ingested, my_handle, my_display_name)
    };

    // Group invites (D14) — deliberately AFTER the store block above, so a
    // friend recorded in this very drain is already visible: the inviter can
    // legitimately send their friend-confirm and a group-invite back to back
    // (they hold my delivery token from the moment I redeemed their invite),
    // and both land in the same fetch.
    let groups = admit_group_invites(vault, relay, &relay_fp, group_invites, on_kt_alarm).await;

    // KT gossip (D5): verify each friend's gossiped root against the online keys
    // the pinned root delegated to, then record it — a *different* root at an
    // epoch we've seen means the relay showed two logs (split view), a hard
    // alarm. A gossip carries no key version, so any delegated key counts (a
    // friend may have seen a root signed before the relay rotated). A signature
    // under none of them is ignored — a friend can't frame an honest relay.
    if !kt_gossips.is_empty() {
        if let Some(kt_keys) = relay.kt_signing_keys() {
            let mut split_epoch: Option<i64> = None;
            {
                let vault = vault.lock().unwrap();
                let store = vault.store().map_err(|e| e.to_string())?;
                for g in &kt_gossips {
                    if kt::gossiped_root_is_signed(&kt_keys, &g.root, &g.prev, &g.sig) {
                        if let Ok(store::KtObserve::SplitView { .. }) =
                            store.kt_observe_root(&relay_fp, g.epoch, &g.root)
                        {
                            split_epoch = Some(g.epoch);
                        }
                    }
                }
            }
            if let Some(epoch) = split_epoch {
                on_kt_alarm("split-view", epoch);
            }
        }
    }

    // Reciprocate: on a friend-accept (not a confirm), seal a friend-confirm
    // with my addressing back to the new friend's sealing key and send it via
    // their now-known delivery token, so they record me too → mutual (D4b).
    // Best-effort; a dropped confirm is retried by the invitee re-drawing later.
    //
    // `friends` here is the KT-admitted list: a sender the log contradicted was
    // dropped above, so this reply — which carries MY delivery token — is never
    // sealed to a key the transparency log refused to vouch for.
    if let Some(handle) = my_handle {
        use base64::Engine as _;
        let my_sealing_b64 = base64::engine::general_purpose::STANDARD.encode(ident.sealing_public());
        for f in &friends {
            if !f.reciprocate {
                continue;
            }
            let recipient: [u8; 32] = match f.sealing_pub.clone().try_into() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let payload = message::friend_payload(
                &handle,
                &my_delivery_token,
                &my_sealing_b64,
                my_display_name.as_deref(),
            );
            match envelope::seal(&recipient, &ident, message::KIND_FRIEND_CONFIRM, &payload, now_ms()) {
                Ok(env) => {
                    let _ = relay.mailbox_send(&f.handle, &f.delivery_token, env).await;
                }
                Err(e) => log::warn!("friend-confirm seal failed: {e}"),
            }
        }
    }
    let acked = if ack_ids.is_empty() {
        0
    } else {
        relay.mailbox_ack(&signing, ack_ids).await? as usize
    };
    Ok(message::DrainReport {
        ingested,
        acked,
        buffered,
        friends: friend_count,
        calls: call_rings,
        kt_rejected,
        groups_joined: groups.joined,
        group_invites_rejected: groups.rejected,
    })
}

/// A `group-invite` tried to replace the key of a group I am already in. Not a
/// key-transparency failure in the AKD sense, but the same class of event and
/// the same response: a hard, non-dismissable alarm, because the only thing it
/// can mean is that someone with mailbox reach is trying to make me seal my
/// future group messages under a key they hold.
const ALARM_GROUP_REKEY: &str = "group-rekey-refused";

/// What a drain's `group-invite` envelopes did.
#[derive(Default)]
struct GroupAdmission {
    /// Invites that created a new local group (I am now a member).
    joined: usize,
    /// Invites refused outright: not from a current friend, from a friend the
    /// transparency log contradicts, or an attempt to re-key a known group.
    /// Nothing was written for any of them.
    rejected: usize,
}

/// Constant-time byte equality. Used to compare a locally-held group key with
/// an attacker-supplied one, so a prefix match is not observable in how long
/// the drain takes.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// **Who may hand me a group key (D14).** A `group-invite` is an ordinary
/// mailbox envelope, so opening one proves only that *somebody* wrote it with
/// the secret key inside it. Three rules turn that into authority, and all
/// three fail closed:
///
/// 1. **Never a re-key.** If I already hold a key for the group id, the invite
///    is refused. Identical bytes are a benign duplicate (an admin can re-add a
///    member, and add-member re-sends the same key) and are a silent no-op;
///    *different* bytes are an attempted takeover of the conversation and raise
///    a hard alarm. A legitimate rotation would have to arrive through the
///    signed group-state record — and no rotation flow exists yet (chat.md
///    § Groups), so this closes nothing that works today.
/// 2. **From a current friend on this relay.** The inviter is the VERIFIED
///    envelope sender, matched against `contact_relays` for this relay with
///    `is_friend = 1`. That is what makes friends-of-friends the only route into
///    a group: a stranger — or the relay itself, which can enqueue anything —
///    cannot mint membership.
/// 3. **Whose key the transparency log does not contradict.** The same verdict
///    policy as every other contact-key check (`verify_contact_keys`): a
///    contradiction is refused and alarms; an *unprovable* key (relay offline,
///    handle not in the log, a relay running interim KT) is accepted, because
///    requiring `Verified` would make groups stop working whenever the directory
///    is unreachable while adding nothing — the friendship itself was admitted
///    under exactly this policy, and rule 1 means the worst a wrongly-admitted
///    invite can do is create a *new* conversation I can leave, never touch an
///    existing one.
async fn admit_group_invites(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    relay_fp: &str,
    invites: Vec<message::GroupInviteData>,
    on_kt_alarm: KtAlarmSink<'_>,
) -> GroupAdmission {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = GroupAdmission::default();
    if invites.is_empty() {
        return out;
    }

    // Phase 1 — everything the local store can decide, under one lock and
    // before any await (the vault mutex must not cross one).
    let mut candidates: Vec<(message::GroupInviteData, ContactKeyCheck)> = Vec::new();
    let mut rekey_attempt = false;
    {
        let vault = vault.lock().unwrap();
        let store = match vault.store() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("group-invite: store unavailable ({e}) — {} left unapplied", invites.len());
                out.rejected += invites.len();
                return out;
            }
        };
        for g in invites {
            // Rule 1 — a bare invite may never re-key a group I'm already in.
            match store.group_key(&g.group_id) {
                Ok(Some(existing)) => {
                    if ct_eq(&existing, &g.group_key) {
                        log::debug!("group-invite: already in {} (same key) — no-op", g.group_id);
                    } else {
                        log::error!(
                            "group-invite: REFUSED an attempt to re-key {} — the stored key is unchanged",
                            g.group_id
                        );
                        rekey_attempt = true;
                        out.rejected += 1;
                    }
                    continue;
                }
                Ok(None) => {}
                Err(e) => {
                    log::warn!("group-invite: could not read the stored key for {} ({e})", g.group_id);
                    out.rejected += 1;
                    continue;
                }
            }
            // Rule 2 — the verified sender must be a current friend here.
            let friend = match store.friend_addressing(&g.inviter_id, relay_fp) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::error!(
                        "group-invite: REFUSED {} — the sender is not a friend on this relay",
                        g.group_id
                    );
                    out.rejected += 1;
                    continue;
                }
                Err(e) => {
                    log::warn!("group-invite: friend lookup failed for {} ({e})", g.group_id);
                    out.rejected += 1;
                    continue;
                }
            };
            // The contact id *is* the base64 identity key, but the row is what
            // the KT check will be run against, so require them to agree rather
            // than assume it.
            if b64.encode(&friend.identity_pub) != g.inviter_id {
                log::error!("group-invite: REFUSED {} — sender key does not match the friend row", g.group_id);
                out.rejected += 1;
                continue;
            }
            let check =
                ContactKeyCheck { handle: friend.handle.clone(), identity_pub: friend.identity_pub };
            candidates.push((g, check));
        }
    }
    if candidates.is_empty() {
        if rekey_attempt {
            on_kt_alarm(ALARM_GROUP_REKEY, 0);
        }
        return out;
    }

    // Phase 2 — rule 3, against the relay's signed log. Raises its own hard
    // alarm on a contradiction.
    let checks: Vec<ContactKeyCheck> = candidates
        .iter()
        .map(|(_, c)| ContactKeyCheck { handle: c.handle.clone(), identity_pub: c.identity_pub.clone() })
        .collect();
    let verdicts = verify_contact_keys(vault, relay, &checks, on_kt_alarm).await;
    // One verdict per check is the contract; a mismatch would make `zip` drop
    // candidates silently, so refuse the lot instead of guessing.
    if verdicts.len() != candidates.len() {
        log::error!("group-invite: {} checks returned {} verdicts — refusing all", checks.len(), verdicts.len());
        out.rejected += candidates.len();
        if rekey_attempt {
            on_kt_alarm(ALARM_GROUP_REKEY, 0);
        }
        return out;
    }

    // Phase 3 — persist what survived.
    {
        let vault_guard = vault.lock().unwrap();
        let store = match vault_guard.store() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("group-invite: store unavailable ({e}) — nothing joined");
                out.rejected += candidates.len();
                drop(vault_guard);
                if rekey_attempt {
                    on_kt_alarm(ALARM_GROUP_REKEY, 0);
                }
                return out;
            }
        };
        for ((g, check), verdict) in candidates.into_iter().zip(verdicts.iter()) {
            if let Some(r) = verdict.rejected() {
                log::error!(
                    "group-invite: REFUSED {} — the log contradicts {}'s key ({})",
                    g.group_id,
                    check.handle,
                    r.as_str()
                );
                out.rejected += 1;
                continue;
            }
            match store.insert_group(&g.group_id, &g.group_key, g.name.as_deref()) {
                Ok(true) => {
                    if let Err(e) = store.ensure_conversation(&g.group_id, "group", relay_fp) {
                        log::warn!("group-invite: joined {} but no conversation row ({e})", g.group_id);
                    }
                    out.joined += 1;
                }
                // INSERT-only, so `false` means the group appeared between phase
                // 1 and now: two invites for the same new id in one batch. The
                // second is still never allowed to re-key — and if it carried a
                // *different* key, that race was itself a takeover attempt.
                Ok(false) => {
                    out.rejected += 1;
                    if !matches!(store.group_key(&g.group_id), Ok(Some(k)) if ct_eq(&k, &g.group_key)) {
                        log::error!(
                            "group-invite: REFUSED a second, conflicting key for {} in one batch",
                            g.group_id
                        );
                        rekey_attempt = true;
                    }
                }
                Err(e) => {
                    log::warn!("group-invite: could not store {} ({e})", g.group_id);
                    out.rejected += 1;
                }
            }
        }
    }
    if rekey_attempt {
        on_kt_alarm(ALARM_GROUP_REKEY, 0);
    }
    out
}

/// Mint a friend invite (D4b): the client hashes its own random token and this
/// stores `hash(token)` + expiry at the relay. Returns the absolute expiry (ms).
#[tauri::command]
async fn relay_invite_mint(
    token_hash: String,
    expires_in_sec: Option<u32>,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<i64, String> {
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.invite_mint(&signing, token_hash, expires_in_sec).await
}

/// Redeem a friend invite (D4b): drop the pre-sealed friend-accept envelope
/// into the inviter's mailbox. Capability only — no device key involved.
///
/// KT (D5): the invite's TOFU pin (`handle` + `identity_pub`) is checked against
/// the transparency log first. The accept seals my delivery token to the
/// inviter, so the check has to gate the *send*: if the log publishes a
/// different key for that handle, the invite is not from who it claims and the
/// redeem fails closed.
///
/// `relay_fp` is the invite's own `relayFp`, and it gates everything above:
/// checking a contact key against a transparency log is meaningless if the log
/// belongs to a different relay than the invite named. The invite's fingerprint
/// reached us out-of-band, so it — not the connected session — is the
/// authority; a disagreement is refused before the envelope (which carries my
/// delivery token) is sent.
#[tauri::command]
async fn relay_invite_redeem(
    token: String,
    envelope: Vec<u8>,
    handle: String,
    identity_pub: String,
    relay_fp: String,
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<i64, String> {
    require_invite_relay(&relay, &relay_fp, &app_kt_alarm(&app))?;
    require_contact_key_ok(&app, &vault, &relay, &handle, &identity_pub).await?;
    relay.invite_redeem(&token, envelope).await
}

/// This account's per-relay directory keys (b64) for assembling a friend invite
/// (embeds the inviter's pinned keys). Requires the vault unlocked + a relay.
#[tauri::command]
fn relay_my_directory_keys(
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<MyDirectoryKeys, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let mk = vault.mk().map_err(|e| e.to_string())?;
    let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
    Ok(MyDirectoryKeys {
        identity_pub: b64.encode(ident.signing_public()),
        sealing_pub: b64.encode(ident.sealing_public()),
    })
}

#[derive(serde::Serialize)]
struct MyDirectoryKeys {
    identity_pub: String,
    sealing_pub: String,
}

/// v8 friends on the connected relay (D4b) — for the friends list + starting DMs.
#[tauri::command]
fn friends_list(
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<Vec<store::FriendSummary>, String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.list_friends(&relay_fp).map_err(|e| e.to_string())
}

/// A friend's addressing (seal + send) on the connected relay, or None.
#[tauri::command]
fn friend_addressing(
    contact_id: String,
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<Option<store::FriendAddressing>, String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .friend_addressing(&contact_id, &relay_fp)
        .map_err(|e| e.to_string())
}

/// The deterministic v8 DM conversation id for a friend (both sides compute the
/// same one), ensuring the local conversation row exists so it can be opened.
#[tauri::command]
fn dm_conversation_id_for(
    contact_id: String,
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    let status = relay.status();
    let relay_fp = status.relay_fp.ok_or("not connected to a relay")?;
    let base_url = status.base_url.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let mk = vault.mk().map_err(|e| e.to_string())?;
    let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
    let store = vault.store().map_err(|e| e.to_string())?;
    let addressing = store
        .friend_addressing(&contact_id, &relay_fp)
        .map_err(|e| e.to_string())?
        .ok_or("not a friend on this relay")?;
    let conv_id = identity::dm_conversation_id(&ident.signing_public(), &addressing.identity_pub);
    store
        .upsert_relay(&relay_fp, &base_url, &relay_fp, &ident.signing_public())
        .map_err(|e| e.to_string())?;
    store
        .ensure_conversation(&conv_id, "dm", &relay_fp)
        .map_err(|e| e.to_string())?;
    Ok(conv_id)
}

/// Mark a DM conversation read up to its newest message (local unread, D11).
#[tauri::command]
fn dm_mark_read(conversation_id: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .mark_conversation_read(&conversation_id)
        .map_err(|e| e.to_string())
}

/// Unread inbound message count for a DM conversation (D11).
#[tauri::command]
fn dm_unread(conversation_id: String, vault: VaultState) -> Result<i64, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .conversation_unread(&conversation_id)
        .map_err(|e| e.to_string())
}

/// Every conversation's last-message stamp + unread count (D11) — one call, so
/// the sidebar can order chats by most recent activity without a query per row.
#[tauri::command]
fn conversation_activity(vault: VaultState) -> Result<Vec<store::ConversationActivity>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.conversation_activity().map_err(|e| e.to_string())
}

/// Create a group I own (D14): publish my directory keys, PUT a genesis
/// group-state record (me = owner, signed by my identity), register the group
/// verifier derived from a fresh group key, and store the key + a local group
/// conversation. Returns the group id. Add members separately.
#[tauri::command]
async fn group_create(
    name: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    use rand::RngCore as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let status = relay.status();
    let relay_fp = status.relay_fp.ok_or("not connected to a relay")?;
    let base_url = status.base_url.ok_or("not connected to a relay")?;

    let (signing, ident) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        (signing, ident)
    };
    let my_identity_b64 = b64.encode(ident.signing_public());
    // My directory entry must exist for the group verifier's member check.
    relay
        .directory_publish(&signing, my_identity_b64.clone(), b64.encode(ident.sealing_public()))
        .await?;

    let group_key = keys::random_key();
    let group_id = {
        let mut idb = [0u8; 16];
        rand::rng().fill_bytes(&mut idb);
        format!("grp:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(idb))
    };
    // Genesis record, signed by my identity (the owner).
    let record = serde_json::json!({
        "groupId": group_id,
        "version": 1,
        "members": [{ "identityPubKey": my_identity_b64, "role": "owner" }],
    })
    .to_string();
    let admin_sig = b64.encode(ident.signing.sign(record.as_bytes()).to_bytes());
    relay.group_state_put(&signing, &group_id, &record, &admin_sig).await?;

    let (_token, verifier) =
        keys::group_token_verifier(group_key.as_ref()).map_err(|e| e.to_string())?;
    relay.group_verifier_put(&signing, &group_id, &verifier).await?;

    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store
            .upsert_relay(&relay_fp, &base_url, &relay_fp, &ident.signing_public())
            .map_err(|e| e.to_string())?;
        // The id is 128 fresh random bits, so a collision here is not a
        // duplicate-create — it is a bug or a corrupted store, and silently
        // keeping the old key would leave the group unusable. Fail loudly.
        if !store
            .insert_group(&group_id, group_key.as_ref(), Some(&name))
            .map_err(|e| e.to_string())?
        {
            return Err("a group with this id already exists locally".into());
        }
        store
            .ensure_conversation(&group_id, "group", &relay_fp)
            .map_err(|e| e.to_string())?;
    }
    Ok(group_id)
}

/// Seal an envelope under a group's key and fan it out to all members
/// (D6/D14). Shared by the group edit/delete/react commands.
async fn group_seal_fanout(
    vault: &VaultState<'_>,
    relay: &tauri::State<'_, relay_client::RelayClient>,
    group_id: &str,
    kind: &str,
    payload: &[u8],
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, group_key) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let group_key = store
            .group_key(group_id)
            .map_err(|e| e.to_string())?
            .ok_or("not a member of this group")?;
        (ident, group_key)
    };
    let (token, _v) = keys::group_token_verifier(&group_key).map_err(|e| e.to_string())?;
    let key32: [u8; 32] = group_key
        .as_slice()
        .try_into()
        .map_err(|_| "stored group key is malformed".to_string())?;
    let env = envelope::seal_group(&key32, &ident, kind, payload, now_ms()).map_err(|e| e.to_string())?;
    relay.group_send(group_id, &token, env).await?;
    Ok(())
}

/// Delete a message I sent in a group (D11): fan out a delete + tombstone local.
#[tauri::command]
async fn relay_group_delete_message(
    group_id: String,
    message_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({ "id": message_id }))
        .map_err(|e| e.to_string())?;
    group_seal_fanout(&vault, &relay, &group_id, message::KIND_DELETE, &payload).await?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.message_apply_delete(&message_id).map_err(|e| e.to_string())
}

/// Edit a message I sent in a group (D11): fan out an edit + update local.
#[tauri::command]
async fn relay_group_edit_message(
    group_id: String,
    message_id: String,
    content: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let edited_at = now_ms();
    let payload = serde_json::to_vec(
        &serde_json::json!({ "id": message_id, "content": content, "editedAt": edited_at }),
    )
    .map_err(|e| e.to_string())?;
    group_seal_fanout(&vault, &relay, &group_id, message::KIND_EDIT, &payload).await?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .message_apply_edit(&message_id, Some(&content), edited_at)
        .map_err(|e| e.to_string())
}

/// React to a group message (D11): fan out the reaction + apply local (self).
#[tauri::command]
async fn relay_group_react(
    group_id: String,
    message_id: String,
    emoji: String,
    add: bool,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({
        "id": message_id, "emoji": emoji, "op": if add { "add" } else { "remove" },
    }))
    .map_err(|e| e.to_string())?;
    group_seal_fanout(&vault, &relay, &group_id, message::KIND_REACT, &payload).await?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    if add {
        store.add_reaction(&message_id, "self", &emoji).map_err(|e| e.to_string())
    } else {
        store.remove_reaction(&message_id, "self", &emoji).map_err(|e| e.to_string())
    }
}

/// An attachment reference embedded in a message payload (D6): the blobId at the
/// relay + the per-file key/iv (which never reach the relay) + display metadata.
#[derive(serde::Serialize, serde::Deserialize)]
struct AttachmentRef {
    #[serde(rename = "blobId")]
    blob_id: String,
    /// base64 per-file AES key.
    key: String,
    /// base64 AES-GCM IV.
    iv: String,
    mime: String,
    name: String,
    size: usize,
}

/// Cache an attachment's ciphertext in the unlocked vault (best-effort — see
/// `attachment::cache_locally`).
fn cache_attachment_locally(
    vault: &VaultState<'_>,
    id: &str,
    kind: &str,
    target_id: &str,
    key: &[u8],
    iv: &[u8],
    mime: &str,
    plaintext_len: usize,
    ciphertext: &[u8],
) -> bool {
    let meta = store::AttachmentMeta {
        id: id.to_string(),
        owner_kind: kind.to_string(),
        owner_id: target_id.to_string(),
        file_key: key.to_vec(),
        iv: Some(iv.to_vec()),
        thumb: None,
        size: Some(plaintext_len as i64),
        mime: Some(mime.to_string()),
        content_hash: None,
    };
    let Ok(guard) = vault.lock() else { return false };
    let Ok(store) = guard.store() else { return false };
    attachment::cache_locally(store, guard.blobs(), &meta, ciphertext)
}

/// Encrypt a file with a fresh per-file key and upload the ciphertext to the
/// blob store (D6). `kind` = "dm" (uploads with the friend's delivery token) or
/// "group" (uploads with the group token). Returns the ref to embed in a message.
///
/// The ciphertext is also kept locally, so the sender can still open what they
/// sent once the relay has dropped the blob.
#[tauri::command]
async fn attachment_upload(
    kind: String,
    target_id: String,
    bytes: Vec<u8>,
    mime: String,
    name: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<AttachmentRef, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let size = bytes.len();
    let enc = attachment::encrypt_file(&bytes)?;

    let blob_id = if kind == "group" {
        let group_key = {
            let vault = vault.lock().unwrap();
            let store = vault.store().map_err(|e| e.to_string())?;
            store
                .group_key(&target_id)
                .map_err(|e| e.to_string())?
                .ok_or("not a member of this group")?
        };
        let (token, _v) = keys::group_token_verifier(&group_key).map_err(|e| e.to_string())?;
        relay.group_blob_upload(&target_id, &token, enc.ciphertext.clone()).await?
    } else {
        let (handle, delivery_token) = {
            let vault = vault.lock().unwrap();
            let store = vault.store().map_err(|e| e.to_string())?;
            let a = store
                .friend_addressing(&target_id, &relay_fp)
                .map_err(|e| e.to_string())?
                .ok_or("not a friend on this relay")?;
            (a.handle, a.delivery_token)
        };
        relay.blob_upload(&handle, &delivery_token, enc.ciphertext.clone()).await?
    };

    cache_attachment_locally(
        &vault,
        &blob_id,
        &kind,
        &target_id,
        &enc.key,
        &enc.iv,
        &mime,
        size,
        &enc.ciphertext,
    );

    Ok(AttachmentRef {
        blob_id,
        key: b64.encode(enc.key),
        iv: b64.encode(enc.iv),
        mime,
        name,
        size,
    })
}

/// Read an attachment's ciphertext from the unlocked vault (see
/// `attachment::cached_ciphertext`).
fn cached_attachment_bytes(vault: &VaultState<'_>, id: &str) -> Option<Vec<u8>> {
    let guard = vault.lock().ok()?;
    let store = guard.store().ok()?;
    attachment::cached_ciphertext(store, guard.blobs(), id)
}

/// Decrypt + return an attachment (D6). `kind` "dm"/"group" selects the blob
/// route; the per-file key/iv come from the message's AttachmentRef.
///
/// **Local store first.** The relay drops blobs once every recipient acks (and
/// on TTL regardless), so a fetch that always hit the network would fail
/// permanently on old media. A cached copy is decrypted locally — no network,
/// works offline — and anything fetched from the relay is persisted on the way
/// through, so it is only downloaded once.
#[tauri::command]
async fn attachment_fetch(
    kind: String,
    target_id: String,
    attachment: AttachmentRef,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let key: [u8; 32] = b64
        .decode(&attachment.key)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or("bad attachment key")?;
    let iv: [u8; 12] = b64
        .decode(&attachment.iv)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or("bad attachment iv")?;

    if let Some(ciphertext) = cached_attachment_bytes(&vault, &attachment.blob_id) {
        return attachment::decrypt_file(&ciphertext, &key, &iv);
    }

    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    let ciphertext = if kind == "group" {
        relay.group_blob_download(&signing, &target_id, &attachment.blob_id).await?
    } else {
        relay.blob_download(&signing, &attachment.blob_id).await?
    };

    // Decrypt before caching: ciphertext that doesn't authenticate under this
    // ref is not worth keeping, and a bad blob shouldn't overwrite a good row.
    let plaintext = attachment::decrypt_file(&ciphertext, &key, &iv)?;
    cache_attachment_locally(
        &vault,
        &attachment.blob_id,
        &kind,
        &target_id,
        &key,
        &iv,
        &attachment.mime,
        plaintext.len(),
        &ciphertext,
    );
    Ok(plaintext)
}

/// Add a friend to a group I administer (D14): add them to the signed group
/// record (version bump, re-signed by me) and hand them the group key via a
/// DM-sealed group-invite. Requires the vault unlocked + the group key locally.
#[tauri::command]
async fn group_add_member(
    group_id: String,
    contact_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (signing, ident, group_key, group_name, addressing) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let group_key = store
            .group_key(&group_id)
            .map_err(|e| e.to_string())?
            .ok_or("not a member of this group")?;
        let group_name = store
            .list_groups()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|g| g.group_id == group_id)
            .and_then(|g| g.name);
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (signing, ident, group_key, group_name, addressing)
    };

    // 1. Add the friend to the signed group-state record. The record comes from
    // the relay and I am about to sign it, so it is checked first — it must be
    // *this* group's record and it must name me an admin.
    let (record, _version) = relay.group_state_get(&signing, &group_id).await?;
    let my_identity_b64 = b64.encode(ident.signing_public());
    let friend_identity_b64 = b64.encode(&addressing.identity_pub);
    let new_record =
        message::group_record_add_member(&record, &group_id, &my_identity_b64, &friend_identity_b64)
            .map_err(|e| e.to_string())?;
    let admin_sig = b64.encode(ident.signing.sign(new_record.as_bytes()).to_bytes());
    relay.group_state_put(&signing, &group_id, &new_record, &admin_sig).await?;

    // 2. Hand the friend the group key via a DM-sealed group-invite.
    let invite = serde_json::json!({
        "groupId": group_id, "groupKey": b64.encode(&group_key), "name": group_name,
    })
    .to_string();
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope = envelope::seal(
        &sealing,
        &ident,
        message::KIND_GROUP_INVITE,
        invite.as_bytes(),
        now_ms(),
    )
    .map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;
    Ok(())
}

/// Groups I'm a member of (D14) — for the group list.
#[tauri::command]
fn group_list(vault: VaultState) -> Result<Vec<store::GroupSummary>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.list_groups().map_err(|e| e.to_string())
}

/// Send a text message to a group (D6/D14): seal one envelope under the shared
/// group key, deliver via the group token (relay fans out to all members), and
/// tee the same id locally. Returns the message id. My own fanned-out copy
/// dedups against the tee by id.
#[tauri::command]
async fn relay_send_group_message(
    group_id: String,
    content: String,
    attachments_json: Option<String>,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    use base64::Engine as _;
    use rand::RngCore as _;
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, group_key) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let group_key = store
            .group_key(&group_id)
            .map_err(|e| e.to_string())?
            .ok_or("not a member of this group")?;
        (ident, group_key)
    };
    let (group_token, _verifier) =
        keys::group_token_verifier(&group_key).map_err(|e| e.to_string())?;
    let key32: [u8; 32] = group_key
        .as_slice()
        .try_into()
        .map_err(|_| "stored group key is malformed".to_string())?;

    let msg_id = {
        let mut b = [0u8; 16];
        rand::rng().fill_bytes(&mut b);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    };
    let sent_at = now_ms();
    let payload =
        message::ChatMessagePayload::new_text(msg_id.clone(), group_id, None, content, sent_at, attachments_json);
    let bytes = payload.encode().map_err(|e| e.to_string())?;
    let envelope = envelope::seal_group(&key32, &ident, message::KIND_MSG, &bytes, sent_at)
        .map_err(|e| e.to_string())?;
    let relay_ts = relay.group_send(&payload.conversation_id, &group_token, envelope).await?;

    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store
            .import_messages(vec![payload.into_import(relay_ts, Some("self".into()))])
            .map_err(|e| e.to_string())?;
    }
    Ok(msg_id)
}

/// Unfriend, local half (D4b): drop the friend flag + their addressing so we can
/// no longer reach them. The caller also rotates the profile key + re-issues
/// tokens to remaining friends (a follow-up flow).
#[tauri::command]
fn friend_remove(
    contact_id: String,
    vault: VaultState,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .remove_friend(&contact_id, &relay_fp)
        .map_err(|e| e.to_string())
}

/// Send a v8 text message to a friend (D6/D11): compose a ChatMessagePayload,
/// seal it to the friend's sealing key, deliver it via their delivery token, and
/// tee the same id into the local log so it renders immediately. Returns the
/// message id. The recipient's drain ingests the same payload (idempotent by id).
#[tauri::command]
async fn relay_send_message(
    contact_id: String,
    content: String,
    attachments_json: Option<String>,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<String, String> {
    send_dm(&vault, &relay, &contact_id, &content, attachments_json).await
}

/// The DM send itself, free of Tauri state so the **real** send path can be
/// driven by the L2 integration tests as well as by the command above.
pub async fn send_dm(
    vault: &Mutex<Vault>,
    relay: &relay_client::RelayClient,
    contact_id: &str,
    content: &str,
    attachments_json: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let status = relay.status();
    let relay_fp = status.relay_fp.ok_or("not connected to a relay")?;
    let base_url = status.base_url.ok_or("not connected to a relay")?;
    // Identity (to seal), the friend's addressing, and the derived DM
    // conversation id (both sides compute the same one) — before any await.
    let (ident, addressing, conversation_id) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        let conversation_id =
            identity::dm_conversation_id(&ident.signing_public(), &addressing.identity_pub);
        store
            .upsert_relay(&relay_fp, &base_url, &relay_fp, &ident.signing_public())
            .map_err(|e| e.to_string())?;
        store
            .ensure_conversation(&conversation_id, "dm", &relay_fp)
            .map_err(|e| e.to_string())?;
        (ident, addressing, conversation_id)
    };

    let msg_id = {
        let mut b = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut b);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    };
    let sent_at = now_ms();
    let payload = message::ChatMessagePayload::new_text(
        msg_id.clone(),
        conversation_id,
        None,
        content.to_string(),
        sent_at,
        attachments_json,
    );
    let bytes = payload.encode().map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope =
        envelope::seal(&sealing, &ident, message::KIND_MSG, &bytes, sent_at).map_err(|e| e.to_string())?;
    let relay_ts = relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;

    // Tee the same message into the local log (sender = self marker) so it shows
    // instantly; keyed by the same id, so a later drain of our own copy dedups.
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store
            .import_messages(vec![payload.into_import(relay_ts, Some("self".into()))])
            .map_err(|e| e.to_string())?;
    }
    Ok(msg_id)
}

/// Delete a v8 message I sent (D11): seal a delete envelope to the friend,
/// deliver it, and tombstone my local copy. The recipient's drain applies it
/// only because the delete's verified sender matches the message's author.
#[tauri::command]
async fn relay_delete_message(
    contact_id: String,
    message_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, addressing) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (ident, addressing)
    };
    let payload = serde_json::to_vec(&serde_json::json!({ "id": message_id }))
        .map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope =
        envelope::seal(&sealing, &ident, message::KIND_DELETE, &payload, now_ms()).map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store.message_apply_delete(&message_id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Edit a v8 message I sent (D11): seal an edit envelope to the friend, deliver
/// it, and update my local copy. The recipient applies it only because the
/// edit's verified sender matches the message's author.
#[tauri::command]
async fn relay_edit_message(
    contact_id: String,
    message_id: String,
    content: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, addressing) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (ident, addressing)
    };
    let edited_at = now_ms();
    let payload = serde_json::to_vec(
        &serde_json::json!({ "id": message_id, "content": content, "editedAt": edited_at }),
    )
    .map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope =
        envelope::seal(&sealing, &ident, message::KIND_EDIT, &payload, edited_at).map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        store
            .message_apply_edit(&message_id, Some(&content), edited_at)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// React to a v8 message (D11): seal a reaction to the friend, deliver it, and
/// apply it locally (reactor = self). `add` toggles add vs remove.
#[tauri::command]
async fn relay_react(
    contact_id: String,
    message_id: String,
    emoji: String,
    add: bool,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, addressing) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (ident, addressing)
    };
    let payload = serde_json::to_vec(&serde_json::json!({
        "id": message_id, "emoji": emoji, "op": if add { "add" } else { "remove" },
    }))
    .map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope =
        envelope::seal(&sealing, &ident, message::KIND_REACT, &payload, now_ms()).map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;
    {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        if add {
            store.add_reaction(&message_id, "self", &emoji).map_err(|e| e.to_string())?;
        } else {
            store.remove_reaction(&message_id, "self", &emoji).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The caller's own view of a placed ring: the call id to `join` + the base64
/// frame key it minted (which it also sealed to the callee inside the offer).
#[derive(serde::Serialize)]
struct PlacedCall {
    #[serde(rename = "callId")]
    call_id: String,
    #[serde(rename = "mediaKey")]
    media_key: String,
}

/// Place a voice call ring (v8 voice, single-relay). Mint a fresh 256-bit call
/// id + a 256-bit frame key, seal a call-offer `{callId, mediaKey}` into the
/// friend's mailbox, and return both so the caller can `join` the signaling
/// socket and set its send frame key. The callee drains the ring (getting the
/// same key), joins, and answers. The key rides inside the already-sealed
/// envelope, so the SFU never sees it.
#[tauri::command]
async fn relay_call_offer(
    contact_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<PlacedCall, String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let (ident, addressing) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (ident, addressing)
    };
    // Fresh, unguessable call id — the routing capability, base64url so it
    // matches the signaling socket's call-id charset.
    use base64::Engine as _;
    use rand::RngCore as _;
    let mut raw = [0u8; 24];
    rand::rng().fill_bytes(&mut raw);
    let call_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    // Fresh 256-bit frame key for the call's E2EE (standard base64, 32 bytes).
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    let media_key = base64::engine::general_purpose::STANDARD.encode(key);
    let payload = serde_json::to_vec(&serde_json::json!({ "callId": call_id, "mediaKey": media_key }))
        .map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope =
        envelope::seal(&sealing, &ident, message::KIND_CALL_OFFER, &payload, now_ms())
            .map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await?;
    Ok(PlacedCall { call_id, media_key })
}

/// Gossip my latest-seen signed KT root to a friend (D5): seal a `kt-gossip`
/// beacon into their mailbox so they can detect a split view (the relay serving
/// us different logs). Best-effort — call opportunistically (e.g. after messaging
/// a friend). No-op error if the relay has no signed root yet.
#[tauri::command]
async fn kt_gossip_send(
    contact_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let relay_fp = relay.status().relay_fp.ok_or("not connected to a relay")?;
    let root = match relay.latest_kt_root().await? {
        Some(r) if !r.root.is_empty() && !r.sig.is_empty() => r,
        _ => return Ok(()), // nothing to gossip yet
    };
    let (ident, addressing) = {
        let vault = vault.lock().unwrap();
        let mk = vault.mk().map_err(|e| e.to_string())?;
        let ident = identity::derive_relay_identity(mk, &relay_fp).map_err(|e| e.to_string())?;
        let store = vault.store().map_err(|e| e.to_string())?;
        let addressing = store
            .friend_addressing(&contact_id, &relay_fp)
            .map_err(|e| e.to_string())?
            .ok_or("not a friend on this relay")?;
        (ident, addressing)
    };
    let payload = serde_json::to_vec(&serde_json::json!({
        "epoch": root.epoch, "root": root.root, "prev": root.prev, "sig": root.sig,
    }))
    .map_err(|e| e.to_string())?;
    let sealing: [u8; 32] = addressing
        .sealing_pub
        .clone()
        .try_into()
        .map_err(|_| "friend has a malformed sealing key".to_string())?;
    let envelope = envelope::seal(&sealing, &ident, message::KIND_KT_GOSSIP, &payload, now_ms())
        .map_err(|e| e.to_string())?;
    relay
        .mailbox_send(&addressing.handle, &addressing.delivery_token, envelope)
        .await
        .map(|_| ())
}

/// Join a call's signaling room (v8 voice): enqueue a `join` on the voice link
/// so the relay puts this device in the call and starts relaying peer frames.
#[tauri::command]
fn voice_join(call_id: String, voice: tauri::State<'_, voice_live::VoiceSignal>) -> Result<(), String> {
    voice.enqueue(voice_live::join_frame(&call_id));
    Ok(())
}

/// Send an opaque (E2E-sealed) SDP/ICE payload to the call's peers.
#[tauri::command]
fn voice_signal(
    call_id: String,
    payload: serde_json::Value,
    voice: tauri::State<'_, voice_live::VoiceSignal>,
) -> Result<(), String> {
    voice.enqueue(voice_live::signal_frame(&call_id, payload));
    Ok(())
}

/// Leave a call's signaling room (hangup); peers get a `peer-leave`.
#[tauri::command]
fn voice_leave(call_id: String, voice: tauri::State<'_, voice_live::VoiceSignal>) -> Result<(), String> {
    voice.enqueue(voice_live::leave_frame(&call_id));
    Ok(())
}

// v8 voice SFU control proxy (device-token authed; the webview's mediasoup-client
// routes control through these so the token never leaves the core; media/RTP
// flows webview↔SFU directly). Opaque mediasoup JSON blobs pass straight through.
macro_rules! sfu_signing {
    ($vault:expr) => {{
        let vault = $vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    }};
}

#[tauri::command]
async fn sfu_join(
    call_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<serde_json::Value, String> {
    let signing = sfu_signing!(vault);
    relay.sfu_join(&signing, &call_id).await
}

#[tauri::command]
async fn sfu_transport(
    call_id: String,
    direction: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<serde_json::Value, String> {
    let signing = sfu_signing!(vault);
    relay.sfu_transport(&signing, &call_id, &direction).await
}

#[tauri::command]
async fn sfu_connect(
    call_id: String,
    transport_id: String,
    dtls_parameters: serde_json::Value,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let signing = sfu_signing!(vault);
    relay.sfu_connect(&signing, &call_id, &transport_id, dtls_parameters).await
}

#[tauri::command]
async fn sfu_produce(
    call_id: String,
    transport_id: String,
    rtp_parameters: serde_json::Value,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<serde_json::Value, String> {
    let signing = sfu_signing!(vault);
    relay.sfu_produce(&signing, &call_id, &transport_id, rtp_parameters).await
}

#[tauri::command]
async fn sfu_consume(
    call_id: String,
    transport_id: String,
    producer_id: String,
    rtp_capabilities: serde_json::Value,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<serde_json::Value, String> {
    let signing = sfu_signing!(vault);
    relay.sfu_consume(&signing, &call_id, &transport_id, &producer_id, rtp_capabilities).await
}

#[tauri::command]
async fn sfu_leave(
    call_id: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let signing = sfu_signing!(vault);
    relay.sfu_leave(&signing, &call_id).await
}

/// All reactions on a conversation's messages (the UI groups by emoji, D11).
#[tauri::command]
fn conversation_reactions(
    conversation_id: String,
    vault: VaultState,
) -> Result<Vec<store::ReactionRow>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .conversation_reactions(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn relay_status(
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> relay_client::RelayStatus {
    relay.status()
}

// ---- chat history (local log, D11) ----

#[tauri::command]
fn messages_page(
    conversation_id: String,
    channel_id: Option<String>,
    before_ts: Option<i64>,
    before_id: Option<String>,
    limit: u32,
    vault: VaultState,
) -> Result<Vec<store::MessageRow>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    let before = match (before_ts, before_id) {
        (Some(ts), Some(id)) => Some((ts, id)),
        _ => None,
    };
    store
        .messages_page(&conversation_id, channel_id.as_deref(), before, limit.min(500))
        .map_err(|e| e.to_string())
}

/// Live-ingest for new traffic while the legacy WS is still the transport:
/// keeps the local log current after migration (idempotent batch insert).
#[tauri::command]
fn messages_ingest(batch: Vec<store::ImportMessage>, vault: VaultState) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_messages(batch).map_err(|e| e.to_string())
}

#[tauri::command]
fn message_edit(
    id: String,
    content: Option<String>,
    edited_at: i64,
    vault: VaultState,
) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .message_apply_edit(&id, content.as_deref(), edited_at)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn message_delete(id: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.message_apply_delete(&id).map_err(|e| e.to_string())
}

// ---- notes CRUD (local-first read/write path, D2) ----

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn notes_list(vault: VaultState) -> Result<Vec<store::NoteMeta>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.list_notes().map_err(|e| e.to_string())
}

#[tauri::command]
fn note_get(id: String, vault: VaultState) -> Result<store::NoteDoc, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .get_note(&id)
        .map_err(|e| e.to_string())?
        .ok_or("unknown note".into())
}

#[tauri::command]
fn note_create(id: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.create_note(&id, now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
fn notes_load_all(vault: VaultState) -> Result<Vec<store::NoteDoc>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.load_notes_with_docs().map_err(|e| e.to_string())
}

#[tauri::command]
fn note_save(
    id: String,
    title: String,
    search_text: String,
    tags_json: String,
    ydoc_state: Vec<u8>,
    vault: VaultState,
) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store
        .save_note(&id, &title, &search_text, &tags_json, &ydoc_state, now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn note_delete(id: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.delete_note(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn notes_search(query: String, vault: VaultState) -> Result<Vec<store::NoteMeta>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.search_notes(&query).map_err(|e| e.to_string())
}

// ---- attachments (encrypted blob files + SQLCipher-held per-file keys) ----

#[derive(serde::Serialize)]
struct AttachmentGetResponse {
    meta: store::AttachmentRow,
    /// Ciphertext bytes; `None` when evicted/expired (meta still describes it).
    bytes: Option<Vec<u8>>,
}

#[tauri::command]
fn attachment_put(
    meta: store::AttachmentMeta,
    bytes: Vec<u8>,
    vault: VaultState,
) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    let path = vault.blobs().write(&meta.id, &bytes).map_err(|e| e.to_string())?;
    store
        .insert_attachment(&meta, &path.to_string_lossy())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn attachment_get(id: String, vault: VaultState) -> Result<AttachmentGetResponse, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    let meta = store
        .attachment_meta(&id)
        .map_err(|e| e.to_string())?
        .ok_or("unknown attachment")?;
    let bytes = if meta.state == "present" {
        Some(vault.blobs().read(&id).map_err(|e| e.to_string())?)
    } else {
        None
    };
    Ok(AttachmentGetResponse { meta, bytes })
}

/// Cheap existence probe so the migrator can skip already-imported blobs.
#[tauri::command]
fn attachment_has(id: String, vault: VaultState) -> Result<bool, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.has_attachment(&id).map_err(|e| e.to_string())
}

/// Local, per-device space reclamation (D6 retention — NOT delete-for-everyone).
#[tauri::command]
fn attachment_evict(id: String, vault: VaultState) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    vault.blobs().remove(&id).map_err(|e| e.to_string())?;
    store.set_attachment_state(&id, "evicted").map_err(|e| e.to_string())
}

// ---- emoji (relay-proxied 7TV search + the on-device used-emoji cache) ----
//
// Both legs go through the core so the **device token never crosses IPC**, the
// same reason the SFU control calls are proxied here. Search results are
// *browsing*: the picker renders them straight from the relay's capability URL
// and nothing is cached. Only emotes actually **encountered in content** get
// their bytes persisted, via `emote_get`/`emote_cache_put`.

/// An emote's bytes plus what the renderer needs to lay it out.
#[derive(serde::Serialize)]
struct EmoteImage {
    id: String,
    name: String,
    mime: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    animated: bool,
    bytes: Vec<u8>,
    /// True when this call had to go to the relay (the caller's per-message
    /// fetch cap counts these).
    fetched: bool,
}

/// Proxied 7TV search — device-token authed inside the core. An empty query
/// returns the relay's top emotes, which is the picker's default set.
#[tauri::command]
async fn emote_search(
    query: String,
    page: Option<u32>,
    limit: Option<u32>,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<relay_client::EmoteSearchResponse, String> {
    if query.chars().count() > 100 {
        return Err("emote query too long".into());
    }
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    let page = page.unwrap_or(1).clamp(1, 1000);
    let limit = limit.unwrap_or(60).clamp(1, 100);
    relay.emote_search(&signing, &query, page, limit).await
}

/// Persist an emote's image bytes the caller already holds. Used when the
/// composer inserts an emote it just rendered, so the sender's own copy is
/// cached without a second fetch.
#[tauri::command]
fn emote_cache_put(
    meta: store::EmoteMeta,
    bytes: Vec<u8>,
    vault: VaultState,
) -> Result<(), String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    emoji::cache_emote(store, vault.emote_blobs(), &meta, &bytes, now_ms())
}

/// The bytes for a known emote: cache first, relay on a miss.
///
/// A hit needs no network and works offline; a miss fetches through the relay's
/// image proxy (so 7TV never sees this device) and caches the result on the way
/// through, evicting least-recently-used entries to stay inside the byte budget.
/// Reading touches the LRU stamp, so the emotes that actually render are the
/// ones that survive.
#[tauri::command]
async fn emote_get(
    id: String,
    name: String,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<EmoteImage, String> {
    if !emoji::valid_emote_id(&id) {
        return Err("invalid emote id".into());
    }
    if !emoji::valid_emote_name(&name) {
        return Err("invalid emote name".into());
    }

    // Cache hit: no relay, no token, no network.
    {
        let guard = vault.lock().unwrap();
        let store = guard.store().map_err(|e| e.to_string())?;
        if let Some(bytes) = emoji::cached_image(store, guard.emote_blobs(), &id, now_ms()) {
            let row = store.emote_row(&id).map_err(|e| e.to_string())?;
            return Ok(EmoteImage {
                name: row.as_ref().map(|r| r.name.clone()).unwrap_or(name),
                mime: row.as_ref().and_then(|r| r.mime.clone()),
                width: row.as_ref().and_then(|r| r.width),
                height: row.as_ref().and_then(|r| r.height),
                animated: row.as_ref().is_some_and(|r| r.animated),
                id,
                bytes,
                fetched: false,
            });
        }
    }

    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    let (bytes, mime) = relay.emote_image(&signing, &id).await?;

    // Caching is best-effort: the image is already in hand, so failing the
    // render over a cache write would be strictly worse than re-fetching later.
    let meta = store::EmoteMeta {
        id: id.clone(),
        name: name.clone(),
        mime: Some(mime.clone()),
        width: None,
        height: None,
        animated: false,
    };
    {
        let guard = vault.lock().unwrap();
        if let Ok(store) = guard.store() {
            if let Err(e) = emoji::cache_emote(store, guard.emote_blobs(), &meta, &bytes, now_ms()) {
                log::warn!("emote {id}: not cached: {e}");
            }
        }
    }
    Ok(EmoteImage {
        id,
        name,
        mime: Some(mime),
        width: None,
        height: None,
        animated: false,
        bytes,
        fetched: true,
    })
}

/// Every emote this device can render with no relay at all, most recently used
/// first — what the picker falls back to offline.
#[tauri::command]
fn emote_cached_list(vault: VaultState) -> Result<Vec<store::CachedEmote>, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.list_cached_emotes().map_err(|e| e.to_string())
}

// ---- legacy import (vestigial; slated for the post-launch cleanup in
// spec/roadmap.md — the v8 launch is greenfield, with no migration) ----
// The webview decrypts with the existing v1 crypto and streams plaintext
// batches down; each command is transactional and idempotent.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Multi-account: open the *active* account's vault (its own data dir).
            // First run creates a default account that uses app_data_dir directly,
            // preserving any existing single-account vault.
            let base_dir = app.path().app_data_dir()?;
            let manager = AccountManager::load(base_dir);
            app.manage(Mutex::new(Vault::new(manager.active_data_dir())));
            app.manage(Mutex::new(manager));
            app.manage(relay_client::RelayClient::default());
            app.manage(voice_live::VoiceSignal::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            account_list,
            account_switch,
            account_add,
            account_set_label,
            vault_status,
            vault_create,
            vault_unlock_keychain,
            vault_unlock,
            vault_unlock_recovery,
            vault_lock,
            settings_get,
            settings_set,
            device_public_key,
            relay_connect,
            relay_register,
            relay_register_friend_accept,
            relay_status,
            relay_invite_mint,
            relay_invite_redeem,
            relay_my_directory_keys,
            friends_list,
            friend_addressing,
            friend_remove,
            dm_conversation_id_for,
            dm_mark_read,
            dm_unread,
            conversation_activity,
            group_create,
            group_add_member,
            group_list,
            relay_send_group_message,
            relay_group_delete_message,
            relay_group_edit_message,
            relay_group_react,
            attachment_upload,
            attachment_fetch,
            relay_directory_publish,
            relay_register_verifier,
            relay_change_handle,
            relay_send,
            envelope_seal,
            envelope_open,
            relay_mailbox_fetch,
            relay_mailbox_ack,
            relay_mailbox_drain,
            relay_send_message,
            relay_delete_message,
            relay_edit_message,
            relay_react,
            relay_call_offer,
            voice_join,
            voice_signal,
            voice_leave,
            sfu_join,
            sfu_transport,
            sfu_connect,
            sfu_produce,
            sfu_consume,
            sfu_leave,
            kt_self_audit,
            kt_verify_contacts,
            kt_gossip_send,
            conversation_reactions,
            messages_page,
            messages_ingest,
            message_edit,
            message_delete,
            notes_list,
            notes_load_all,
            note_get,
            note_create,
            note_save,
            note_delete,
            notes_search,
            attachment_put,
            attachment_get,
            attachment_has,
            attachment_evict,
            emote_search,
            emote_get,
            emote_cache_put,
            emote_cached_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
