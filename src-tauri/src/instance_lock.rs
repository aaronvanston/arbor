use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const APP_INSTANCE_LOCK_PREFIX: &str = "EasyCLIProxyAPI-instance";

pub(crate) struct AppInstanceGuard {
    _file: fs::File,
}

pub(crate) fn acquire_app_instance_guard() -> Result<AppInstanceGuard, String> {
    let executable_dir = super::executable_dir()?;
    acquire_app_instance_guard_for(&executable_dir)
}

fn app_instance_key(executable_dir: &Path) -> String {
    let resolved = fs::canonicalize(executable_dir)
        .unwrap_or_else(|_| executable_dir.to_path_buf())
        .to_string_lossy()
        .to_string();
    let digest = Sha256::digest(resolved.as_bytes());
    format!("{digest:x}")
}

pub(crate) fn acquire_app_instance_guard_for(
    executable_dir: &Path,
) -> Result<AppInstanceGuard, String> {
    use std::{fs::OpenOptions, os::fd::AsRawFd};

    let lock_path = std::env::temp_dir().join(format!(
        "{APP_INSTANCE_LOCK_PREFIX}-{}.lock",
        app_instance_key(executable_dir)
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open application instance lock for the current directory: {error}"))?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        let raw_error = error.raw_os_error();
        if raw_error == Some(libc::EWOULDBLOCK) || raw_error == Some(libc::EAGAIN) {
            return Err("An application instance is already running in the current Arbor directory".to_string());
        }
        return Err(format!("Failed to lock the current Arbor directory: {error}"));
    }

    Ok(AppInstanceGuard { _file: file })
}
