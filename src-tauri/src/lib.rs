mod blobs;
mod identity;
mod keys;
mod relay_client;
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
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    // Take the key before any await: the vault mutex must not cross it.
    let signing = {
        let vault = vault.lock().unwrap();
        vault.device_signing_key().map_err(|e| e.to_string())?
    };
    relay.connect(&url, &signing).await
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

/// Register the wrapped-MK escrow with the connected relay (D15).
#[tauri::command]
async fn relay_escrow_upload(
    vault: VaultState<'_>,
    relay: tauri::State<'_, relay_client::RelayClient>,
) -> Result<(), String> {
    let (signing, payload, pw_hash, rc_hash) = {
        let vault = vault.lock().unwrap();
        let signing = vault.device_signing_key().map_err(|e| e.to_string())?;
        let (payload, pw, rc) = vault.escrow_bundle().map_err(|e| e.to_string())?;
        (signing, payload, pw, rc)
    };
    relay.escrow_upload(&signing, payload, pw_hash, rc_hash).await
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
            vault_lock,
            settings_get,
            settings_set,
            device_public_key,
            relay_connect,
            relay_status,
            relay_escrow_upload,
            relay_directory_publish,
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
