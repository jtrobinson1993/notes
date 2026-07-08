mod blobs;
mod identity;
mod keys;
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
