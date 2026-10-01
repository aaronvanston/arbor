//! The window's saved settings (machine names and looks, account order and caps, alert choices, the Sync repo…),
//! kept by the app in saved-store.json instead of the window's own storage, so the command line can read and change
//! them and the window hears when it does. Each value is the text the window wrote, under the window's key; the app
//! doesn't read inside them. Settings that only matter to the window's layout stay in the window.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Emitter;
use ts_rs::TS;

const STORE_FILE: &str = "saved-store.json";
pub(crate) const SAVED_STORE_CHANGED_EVENT: &str = "saved-store-changed";
/// Every key the window saves starts with this.
const KEY_PREFIX: &str = "arbor.";
const MAX_KEY_LENGTH: usize = 200;
/// More than any setting needs; the alert history, the largest, stays well under it.
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct StoreFile {
    version: u32,
    /// Whether the window has moved what it kept itself into this file.
    migrated: bool,
    values: BTreeMap<String, String>,
}

/// Everything saved, for the window to read before it draws.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedStoreSnapshot {
    pub(crate) values: BTreeMap<String, String>,
    pub(crate) migrated: bool,
}

/// One saved setting changed; `value` is none when it was removed.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedStoreChange {
    pub(crate) name: String,
    pub(crate) value: Option<String>,
}

#[derive(Default)]
pub(crate) struct SavedStoreState {
    file: Mutex<Option<StoreFile>>,
}

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::core_base_dir()?.join(STORE_FILE))
}

fn read_file(path: &Path) -> Result<StoreFile, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("Couldn't read {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile { version: 1, ..StoreFile::default() }),
        Err(error) => Err(format!("Couldn't read {}: {error}", path.display())),
    }
}

/// Writes beside the file and renames it into place, so a crash mid-write leaves the old file whole.
fn write_file(path: &Path, file: &StoreFile) -> Result<(), String> {
    let text = serde_json::to_string(file).map_err(|error| error.to_string())?;
    let partial = path.with_extension("json.partial");
    fs::write(&partial, text).map_err(|error| format!("Couldn't save the settings: {error}"))?;
    fs::rename(&partial, path).map_err(|error| format!("Couldn't save the settings: {error}"))
}

fn check_entry(name: &str, value: Option<&str>) -> Result<(), String> {
    if !name.starts_with(KEY_PREFIX) || name.len() > MAX_KEY_LENGTH || name.chars().any(char::is_control) {
        return Err(format!("{name} isn't a setting Arbor saves; their names start with {KEY_PREFIX}"));
    }
    if value.is_some_and(|value| value.len() > MAX_VALUE_BYTES) {
        return Err(format!("The value for {name} is too large to save"));
    }
    Ok(())
}

impl SavedStoreState {
    /// Runs `change` on the file as it is on disk, the first time, or as last saved, and saves it when it changed.
    fn with_file<T>(&self, path: &Path, change: impl FnOnce(&mut StoreFile) -> T) -> Result<T, String> {
        let mut held = self.file.lock().map_err(|_| "The saved settings are unusable".to_string())?;
        if held.is_none() {
            *held = Some(read_file(path)?);
        }
        let Some(file) = held.as_mut() else {
            return Err("The saved settings are unusable".into());
        };
        let before = file.clone();
        let result = change(file);
        if *file != before {
            file.version = 1;
            if let Err(error) = write_file(path, file) {
                *file = before;
                return Err(error);
            }
        }
        Ok(result)
    }

    fn snapshot_at(&self, path: &Path) -> Result<SavedStoreSnapshot, String> {
        self.with_file(path, |file| SavedStoreSnapshot { values: file.values.clone(), migrated: file.migrated })
    }

    /// Saves or removes one value; true when that changed anything.
    fn set_at(&self, path: &Path, name: &str, value: Option<String>) -> Result<bool, String> {
        check_entry(name, value.as_deref())?;
        self.with_file(path, |file| match value {
            Some(value) => file.values.insert(name.to_string(), value.clone()).as_ref() != Some(&value),
            None => file.values.remove(name).is_some(),
        })
    }

    /// Takes in what the window kept itself, once. A value already here is newer, so it stays.
    fn migrate_at(&self, path: &Path, values: BTreeMap<String, String>) -> Result<SavedStoreSnapshot, String> {
        for (name, value) in &values {
            check_entry(name, Some(value))?;
        }
        self.with_file(path, |file| {
            if !file.migrated {
                for (name, value) in values {
                    file.values.entry(name).or_insert(value);
                }
                file.migrated = true;
            }
            SavedStoreSnapshot { values: file.values.clone(), migrated: file.migrated }
        })
    }
}

#[tauri::command]
pub(crate) fn saved_store_snapshot(state: tauri::State<'_, SavedStoreState>) -> Result<SavedStoreSnapshot, String> {
    state.snapshot_at(&store_path()?)
}

/// Saves one setting, or removes it when there's no value, and tells the window, which updates whatever shows it.
#[tauri::command]
pub(crate) fn saved_store_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, SavedStoreState>,
    name: String,
    value: Option<String>,
) -> Result<(), String> {
    if state.set_at(&store_path()?, &name, value.clone())? {
        let _ = app.emit(SAVED_STORE_CHANGED_EVENT, SavedStoreChange { name, value });
    }
    Ok(())
}

/// Moves the settings an earlier version kept in the window into the app, the first time this version runs.
#[tauri::command]
pub(crate) fn saved_store_migrate(
    state: tauri::State<'_, SavedStoreState>,
    values: BTreeMap<String, String>,
) -> Result<SavedStoreSnapshot, String> {
    state.migrate_at(&store_path()?, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-saved-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(STORE_FILE)
    }

    #[test]
    fn a_value_is_saved_read_back_and_removed() {
        let path = temp_path("set");
        let state = SavedStoreState::default();
        assert!(state.set_at(&path, "arbor.machine-names.v1", Some("{\"a\":\"b\"}".into())).unwrap());
        assert!(!state.set_at(&path, "arbor.machine-names.v1", Some("{\"a\":\"b\"}".into())).unwrap(), "the same value again changes nothing");
        let fresh = SavedStoreState::default();
        assert_eq!(fresh.snapshot_at(&path).unwrap().values["arbor.machine-names.v1"], "{\"a\":\"b\"}");
        assert!(fresh.set_at(&path, "arbor.machine-names.v1", None).unwrap());
        assert!(SavedStoreState::default().snapshot_at(&path).unwrap().values.is_empty());
    }

    #[test]
    fn only_arbors_own_names_are_kept() {
        let path = temp_path("names");
        let state = SavedStoreState::default();
        assert!(state.set_at(&path, "theme", Some("dark".into())).is_err());
        assert!(state.set_at(&path, "arbor.\nx", Some("1".into())).is_err());
        assert!(!path.exists(), "a refused value writes nothing");
    }

    #[test]
    fn the_windows_values_move_in_once_and_newer_ones_win() {
        let path = temp_path("migrate");
        let state = SavedStoreState::default();
        state.set_at(&path, "arbor.accounts.order.v1", Some("new".into())).unwrap();
        let moved = BTreeMap::from([
            ("arbor.accounts.order.v1".to_string(), "old".to_string()),
            ("arbor.plan-costs.v1".to_string(), "{}".to_string()),
        ]);
        let snapshot = state.migrate_at(&path, moved).unwrap();
        assert!(snapshot.migrated);
        assert_eq!(snapshot.values["arbor.accounts.order.v1"], "new");
        assert_eq!(snapshot.values["arbor.plan-costs.v1"], "{}");
        let again = BTreeMap::from([("arbor.machine-looks.v1".to_string(), "{}".to_string())]);
        assert!(!state.migrate_at(&path, again).unwrap().values.contains_key("arbor.machine-looks.v1"));
    }

    #[test]
    fn an_unreadable_file_is_left_for_someone_to_look_at() {
        let path = temp_path("broken");
        fs::write(&path, "not json").unwrap();
        assert!(SavedStoreState::default().snapshot_at(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");
    }
}
