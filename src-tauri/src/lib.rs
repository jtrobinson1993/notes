mod blobs;
mod envelope;
mod identity;
mod keys;
mod message;
mod relay_client;
mod relay_live;
mod store;
mod vault;

use std::sync::Mutex;
use tauri::Manager;
use vault::{Vault, VaultStatus};

type VaultState<'a> = tauri::State<'a, Mutex<Vault>>;

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

// ---- relay auth (D4/D4b client half) ----

#[tauri::command]
fn device_public_key(vault: VaultState) -> Result<String, String> {
    let vault = vault.lock().unwrap();
    let key = vault.device_signing_key().map_err(|e| e.to_string())?;
    Ok(relay_client::device_public_key_b64(&key))
}

#[tauri::command]
async fn relay_connect(
    url: String,
    app: tauri::AppHandle,
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    // Take the key before any await: the vault mutex must not cross it.
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.connect(&url, &signing).await?;
    // Start the live-delivery link once: it holds a WS and emits `relay:mail`
    // nudges so the webview drains its mailbox without polling (best-effort;
    // REST fetch stays authoritative).
    if relay.try_begin_live() {
        if let Some((base, fp)) = relay.session_info() {
            tauri::async_runtime::spawn(relay_live::run_forever(base, fp, signing, app));
        }
    }
    Ok(())
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
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
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
            message::Disposition::Discard => ack_ids.push(row.queue_id),
            message::Disposition::Buffer => buffered += 1,
        }
    }

    // Persist first; only ack once durably stored (hold-until-ack). Friends
    // (D4b): record the verified sender's addressing so we can reach them, and
    // read my own handle (persisted at invite creation) for reciprocation.
    let friend_count = friends.len();
    let (ingested, my_handle) = {
        let vault = vault.lock().unwrap();
        let store = vault.store().map_err(|e| e.to_string())?;
        let my_handle = store.get_setting("identity.handle").map_err(|e| e.to_string())?;
        // Persist the relay row so friend + conversation rows can FK to it.
        store
            .upsert_relay(&relay_fp, &base_url, &relay_fp, &my_identity_pub)
            .map_err(|e| e.to_string())?;
        if !friends.is_empty() {
            for f in &friends {
                store
                    .record_friend(&store::FriendRecord {
                        contact_id: f.contact_id.clone(),
                        display_name: None,
                        relay_id: relay_fp.clone(),
                        handle: f.handle.clone(),
                        identity_pub: f.identity_pub.clone(),
                        sealing_pub: f.sealing_pub.clone(),
                        delivery_token: f.delivery_token.clone(),
                    })
                    .map_err(|e| e.to_string())?;
            }
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
        (ingested, my_handle)
    };

    // Reciprocate: on a friend-accept (not a confirm), seal a friend-confirm
    // with my addressing back to the new friend's sealing key and send it via
    // their now-known delivery token, so they record me too → mutual (D4b).
    // Best-effort; a dropped confirm is retried by the invitee re-drawing later.
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
            let payload = message::friend_payload(&handle, &my_delivery_token, &my_sealing_b64);
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
    Ok(message::DrainReport { ingested, acked, buffered, friends: friend_count })
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
#[tauri::command]
async fn relay_invite_redeem(
    token: String,
    envelope: Vec<u8>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<i64, String> {
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
        store
            .upsert_group(&group_id, group_key.as_ref(), Some(&name))
            .map_err(|e| e.to_string())?;
        store
            .ensure_conversation(&group_id, "group", &relay_fp)
            .map_err(|e| e.to_string())?;
    }
    Ok(group_id)
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
        message::ChatMessagePayload::new_text(msg_id.clone(), group_id, None, content, sent_at);
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
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
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
            .friend_addressing(&contact_id, &relay_fp)
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
        content,
        sent_at,
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

/// Register the wrapped-MK escrow with the connected relay (D15).
#[tauri::command]
async fn relay_escrow_upload(
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let (signing, bundle) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let bundle = vault.escrow_bundle().map_err(|e| e.to_string())?;
        (signing, bundle)
    };
    relay.escrow_upload(&signing, bundle).await
}

/// Cold-start restore on a fresh device (D15/D3a): fetch public KDF params by
/// handle, derive the escrow fetch auth key from the password, fetch the
/// escrow, then rebuild the vault. No session/device key needed — this runs
/// before any local vault exists.
#[tauri::command]
async fn vault_restore_from_escrow(
    url: String,
    handle: String,
    password: String,
    vault: VaultState<'_>,
) -> Result<(), String> {
    let (salt, m, t, p) = relay_client::RelayClient::escrow_kdf(&url, &handle).await?;
    let auth_key_b64 = Vault::derive_escrow_auth_key_b64(&password, &salt, m, t, p)
        .map_err(|e| e.to_string())?;
    let payload =
        relay_client::RelayClient::escrow_fetch(&url, &handle, "password", &auth_key_b64).await?;
    let mut vault = vault.lock().unwrap();
    vault
        .restore_from_escrow(&payload, &password)
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

// ---- first-run legacy import (spec/migration.md) ----
// The webview decrypts with the existing v1 crypto and streams plaintext
// batches down; each command is transactional and idempotent.

#[tauri::command]
fn import_notes(batch: Vec<store::ImportNote>, vault: VaultState) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_notes(batch).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_note_versions(
    batch: Vec<store::ImportNoteVersion>,
    vault: VaultState,
) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_note_versions(batch).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_conversations(
    batch: Vec<store::ImportConversation>,
    vault: VaultState,
) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_conversations(batch).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_contacts(batch: Vec<store::ImportContact>, vault: VaultState) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_contacts(batch).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_messages(batch: Vec<store::ImportMessage>, vault: VaultState) -> Result<usize, String> {
    let vault = vault.lock().unwrap();
    let store = vault.store().map_err(|e| e.to_string())?;
    store.import_messages(batch).map_err(|e| e.to_string())
}

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
            let data_dir = app.path().app_data_dir()?;
            app.manage(Mutex::new(Vault::new(data_dir)));
            app.manage(relay_client::RelayClient::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock_keychain,
            vault_unlock,
            vault_unlock_recovery,
            vault_restore_from_escrow,
            vault_lock,
            settings_get,
            settings_set,
            device_public_key,
            relay_connect,
            relay_status,
            relay_escrow_upload,
            relay_invite_mint,
            relay_invite_redeem,
            relay_my_directory_keys,
            friends_list,
            friend_addressing,
            friend_remove,
            dm_conversation_id_for,
            dm_mark_read,
            dm_unread,
            group_create,
            group_list,
            relay_send_group_message,
            relay_directory_publish,
            relay_register_verifier,
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
            import_notes,
            import_note_versions,
            import_conversations,
            import_contacts,
            import_messages
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
