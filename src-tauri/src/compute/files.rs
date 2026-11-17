//! Compute's two files beside config.toml: the providers' keys, and the links agents record between a sandbox and
//! the machine and session that started it. Both are written to a temporary file only you can read and moved over
//! the old one under a lock, the way the phone alert secrets are, so neither is ever half written or lost to a
//! second save at once.

use super::ComputeProviderId;
use crate::core_config::replace_file_atomically;
use crate::core_runtime::{core_base_dir, path_to_string};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Not in the Keychain: every update re-signs the app, so macOS would ask again after each one and the background
/// round would stop until someone answered.
const SECRETS_FILE: &str = "compute-secrets.json";
const CLAIMS_FILE: &str = "compute-claims.json";
static SECRETS_LOCK: Mutex<()> = Mutex::new(());
static CLAIMS_LOCK: Mutex<()> = Mutex::new(());

/// A provider's API key. It never prints, so a `{:?}` anywhere can't leak it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ComputeKey(String);

impl ComputeKey {
    pub(crate) fn new(key: &str) -> ComputeKey {
        ComputeKey(key.trim().to_string())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ComputeKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ComputeKey([hidden])")
    }
}

/// Each connected provider's key.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ComputeSecrets {
    #[serde(default)]
    pub(crate) keys: BTreeMap<ComputeProviderId, ComputeKey>,
}

pub(crate) fn secrets_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(SECRETS_FILE))
}

pub(crate) fn claims_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(CLAIMS_FILE))
}

/// The saved keys, or none before the first is saved.
pub(crate) fn read_secrets(path: &Path) -> Result<ComputeSecrets, String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ComputeSecrets::default()),
        Err(error) => return Err(format!("Couldn’t read the saved Compute keys in {}: {error}", path_to_string(path))),
    };
    // serde's reason can quote the file, so it's left out.
    serde_json::from_slice(&content).map_err(|_| {
        format!("The saved Compute keys in {} can’t be read. Delete the file and connect again.", path_to_string(path))
    })
}

/// Saves `key` for `provider`, or forgets it when `key` is None.
pub(crate) fn save_key(path: &Path, provider: ComputeProviderId, key: Option<&ComputeKey>) -> Result<(), String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut secrets = read_secrets(path)?;
    match key {
        Some(key) => {
            secrets.keys.insert(provider, key.clone());
        }
        None => {
            if secrets.keys.remove(&provider).is_none() {
                return Ok(());
            }
        }
    }
    let content = serde_json::to_vec_pretty(&secrets).map_err(|_| "Failed to serialize the Compute keys".to_string())?;
    write_private(path, SECRETS_FILE, &content).map_err(|error| format!("Couldn't save the Compute keys to {}: {error}", path_to_string(path)))
}

/// A link an agent recorded: this machine, and maybe this session, started this sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputeClaim {
    pub(crate) provider: ComputeProviderId,
    pub(crate) sandbox_id: String,
    pub(crate) machine: String,
    #[serde(default)]
    pub(crate) session: Option<String>,
    pub(crate) linked_at_ms: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct ClaimsFile {
    #[serde(default)]
    claims: Vec<ComputeClaim>,
}

pub(crate) fn read_claims(path: &Path) -> Result<Vec<ComputeClaim>, String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Couldn’t read the sandbox links in {}: {error}", path_to_string(path))),
    };
    serde_json::from_slice::<ClaimsFile>(&content).map(|file| file.claims).map_err(|_| {
        format!("The sandbox links in {} can’t be read. Delete the file and link the sandboxes again.", path_to_string(path))
    })
}

/// Changes the links under the lock and saves them when `change` says it changed something. Returns them as saved.
pub(crate) fn update_claims(
    path: &Path,
    change: impl FnOnce(&mut Vec<ComputeClaim>) -> bool,
) -> Result<Vec<ComputeClaim>, String> {
    let _guard = CLAIMS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut claims = read_claims(path)?;
    if change(&mut claims) {
        let content = serde_json::to_vec_pretty(&ClaimsFile { claims: claims.clone() })
            .map_err(|error| format!("Failed to serialize the sandbox links: {error}"))?;
        write_private(path, CLAIMS_FILE, &content)
            .map_err(|error| format!("Couldn't save the sandbox links to {}: {error}", path_to_string(path)))?;
    }
    Ok(claims)
}

/// Written to a temporary file only you can read, then moved over the old one, so the file is never half written or
/// open to other users.
fn write_private(path: &Path, name: &str, content: &[u8]) -> io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".{name}.tmp.{}.{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let written = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        // Exactly 0600, whatever the umask.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arbor-compute-{name}-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn the_key_file_is_only_yours_and_forgetting_a_key_removes_it() {
        let dir = temp_dir("secrets");
        let path = dir.join(SECRETS_FILE);
        assert!(read_secrets(&path).unwrap().keys.is_empty());
        save_key(&path, ComputeProviderId::Boat, Some(&ComputeKey::new("  boat_fake_test_key_0001 "))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let saved = read_secrets(&path).unwrap();
        assert_eq!(saved.keys[&ComputeProviderId::Boat].expose(), "boat_fake_test_key_0001");
        // The key never prints.
        assert!(!format!("{saved:?}").contains("boat_fake_test_key_0001"));
        save_key(&path, ComputeProviderId::Boat, None).unwrap();
        assert!(read_secrets(&path).unwrap().keys.is_empty());
        // No temporary files are left beside it.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_key_file_says_so_without_quoting_it() {
        let dir = temp_dir("broken");
        let path = dir.join(SECRETS_FILE);
        fs::write(&path, "{\"keys\":{\"boat\":\"boat_fake_secret_value_x\"").unwrap();
        let error = read_secrets(&path).unwrap_err();
        assert!(!error.contains("boat_fake_secret_value_x"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn claims_save_and_come_back() {
        let dir = temp_dir("claims");
        let path = dir.join(CLAIMS_FILE);
        let claim = ComputeClaim {
            provider: ComputeProviderId::Boat,
            sandbox_id: "bx_23456789".into(),
            machine: "cam-mbp".into(),
            session: Some("s-1".into()),
            linked_at_ms: 5,
        };
        let saved = update_claims(&path, |claims| {
            claims.push(claim.clone());
            true
        })
        .unwrap();
        assert_eq!(saved, [claim.clone()]);
        assert_eq!(read_claims(&path).unwrap(), [claim]);
        // A change that changes nothing doesn't write.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        update_claims(&path, |_| false).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        fs::remove_dir_all(dir).unwrap();
    }
}
