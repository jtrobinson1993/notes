//! Multi-account switching (Slack/Discord-style). Each account is its own vault
//! — separate master key, device key, encrypted store, and relay identity —
//! living in its own data dir, so their message logs never mix. The OS keychain
//! is already namespaced by data dir (see vault.rs), so per-account keys are
//! isolated for free.
//!
//! A small registry (`accounts.json`, in the app data dir, alongside the vaults)
//! tracks the accounts + which is active. Switching sets the active account and
//! restarts the app, so the new account gets a fresh vault + relay/live-delivery
//! tasks (those are single-session by design; a process restart is the clean way
//! to swap them, and it's instant).
//!
//! The FIRST account keeps using the app data dir directly (`dir = ""`), so an
//! existing single-account install is preserved as-is — its keychain namespace
//! (derived from the data dir) doesn't move. Added accounts live under
//! `accounts/<id>/`.

use std::fs;
use std::path::PathBuf;

use rand::RngCore;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct AccountEntry {
    pub id: String,
    /// Human label for the picker — the account's public handle once onboarded.
    pub label: String,
    /// Data dir relative to the app data dir. "" = the base dir (legacy/first
    /// account); otherwise "accounts/<id>".
    pub dir: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Registry {
    pub active: String,
    pub accounts: Vec<AccountEntry>,
}

pub struct AccountManager {
    base_dir: PathBuf,
    registry: Registry,
}

fn new_id() -> String {
    let mut b = [0u8; 12];
    rand::rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl AccountManager {
    /// Load the registry, creating a default account (dir "" = the base data dir)
    /// on first run so an existing single-account vault is preserved.
    pub fn load(base_dir: PathBuf) -> Self {
        let path = base_dir.join("accounts.json");
        let registry = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Registry>(&s).ok())
            .filter(|r| !r.accounts.is_empty() && r.accounts.iter().any(|a| a.id == r.active))
            .unwrap_or_else(|| Registry {
                active: "default".into(),
                accounts: vec![AccountEntry {
                    id: "default".into(),
                    label: "Account".into(),
                    dir: String::new(),
                }],
            });
        let mut mgr = Self { base_dir, registry };
        mgr.save();
        mgr
    }

    fn save(&self) {
        let _ = fs::create_dir_all(&self.base_dir);
        if let Ok(json) = serde_json::to_string_pretty(&self.registry) {
            let _ = fs::write(self.base_dir.join("accounts.json"), json);
        }
    }

    fn entry(&self, id: &str) -> Option<&AccountEntry> {
        self.registry.accounts.iter().find(|a| a.id == id)
    }

    /// Absolute data dir for the active account.
    pub fn active_data_dir(&self) -> PathBuf {
        let dir = self
            .entry(&self.registry.active)
            .map(|a| a.dir.clone())
            .unwrap_or_default();
        if dir.is_empty() {
            self.base_dir.clone()
        } else {
            self.base_dir.join(dir)
        }
    }

    pub fn registry(&self) -> Registry {
        self.registry.clone()
    }

    /// Point at an existing account (returns false if unknown).
    pub fn set_active(&mut self, id: &str) -> bool {
        if self.entry(id).is_none() {
            return false;
        }
        self.registry.active = id.to_string();
        self.save();
        true
    }

    /// Create a fresh account (its own dir) and make it active. Returns its id.
    pub fn add(&mut self) -> String {
        let id = new_id();
        self.registry.accounts.push(AccountEntry {
            id: id.clone(),
            label: "New account".into(),
            dir: format!("accounts/{id}"),
        });
        self.registry.active = id.clone();
        self.save();
        id
    }

    /// Update the active account's label (its handle, once known).
    pub fn set_active_label(&mut self, label: &str) {
        let active = self.registry.active.clone();
        if let Some(a) = self.registry.accounts.iter_mut().find(|a| a.id == active) {
            a.label = label.to_string();
        }
        self.save();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("accord-acct-{}", new_id()))
    }

    #[test]
    fn first_run_creates_a_default_account_using_the_base_dir() {
        let dir = tmp();
        let mgr = AccountManager::load(dir.clone());
        let reg = mgr.registry();
        assert_eq!(reg.accounts.len(), 1);
        assert_eq!(reg.active, "default");
        // Default account uses the base dir directly (preserves an existing vault).
        assert_eq!(mgr.active_data_dir(), dir);
        assert!(dir.join("accounts.json").exists());
    }

    #[test]
    fn add_creates_an_isolated_dir_and_switches_active() {
        let dir = tmp();
        let mut mgr = AccountManager::load(dir.clone());
        let id = mgr.add();
        assert_eq!(mgr.registry().active, id);
        assert_eq!(mgr.active_data_dir(), dir.join("accounts").join(&id));
        // Switching back to default restores the base dir.
        assert!(mgr.set_active("default"));
        assert_eq!(mgr.active_data_dir(), dir);
        // Labels persist across a reload.
        mgr.set_active("default");
        mgr.set_active_label("Willow#3589");
        let reloaded = AccountManager::load(dir);
        assert_eq!(
            reloaded.registry().accounts.iter().find(|a| a.id == "default").unwrap().label,
            "Willow#3589"
        );
    }

    #[test]
    fn set_active_rejects_unknown_and_registry_survives_reload() {
        let dir = tmp();
        let mut mgr = AccountManager::load(dir.clone());
        let id = mgr.add();
        assert!(!mgr.set_active("nope"));
        let reloaded = AccountManager::load(dir);
        // The added account + active pointer persist.
        assert_eq!(reloaded.registry().active, id);
        assert_eq!(reloaded.registry().accounts.len(), 2);
    }
}
