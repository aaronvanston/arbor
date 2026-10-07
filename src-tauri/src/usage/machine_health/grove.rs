//! Grove, the machine-health sampler Arbor carries: `grove`, which runs on this Mac and reads every machine, and
//! `grove-probe`, a small resident sampler Arbor installs on a machine when the user asks.
//!
//! The release is pinned in `grove-version.txt` and fetched by the release build into `bundled-grove/` (the app's
//! `Resources/grove/`): the macOS builds of `grove` and every system's `grove-probe`, each checked against the
//! release's SHA256SUMS, which goes in beside them.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const VERSION_FILE: &str = "grove-version.txt";
/// In the app's Resources, and in a checkout for a dev build.
const RESOURCES_FOLDER: &str = "grove";
const SOURCE_FOLDER: &str = "bundled-grove";
const SUMS_FILE: &str = "SHA256SUMS";

/// The Grove release in this build: its version and the folder with its archives and their checksums.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bundle {
    pub(crate) version: String,
    pub(crate) dir: PathBuf,
}

/// Which of the release's two programs an archive holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Program {
    /// The command line, run on this Mac.
    Grove,
    /// The resident sampler, run on a machine.
    Probe,
}

impl Program {
    fn name(self) -> &'static str {
        match self {
            Self::Grove => "grove",
            Self::Probe => "grove-probe",
        }
    }
}

fn bundle_in(version_file: &Path, dir: &Path) -> Option<Bundle> {
    let version = std::fs::read_to_string(version_file).ok()?.trim().trim_start_matches('v').to_string();
    (!version.is_empty() && dir.is_dir()).then(|| Bundle { version, dir: dir.to_path_buf() })
}

/// The release this build carries: the app's own Resources, or a checkout's `bundled-grove/` for a dev build.
#[allow(dead_code)] // Machine health starts reading it in the change after the one that bundles it.
pub(crate) fn bundle() -> Option<Bundle> {
    let executable_dir = crate::core_runtime::executable_dir().ok()?;
    if let Some(resources) = crate::core_runtime::macos_app_resources_dir(&executable_dir) {
        if let Some(bundle) = bundle_in(&resources.join(VERSION_FILE), &resources.join(RESOURCES_FOLDER)) {
            return Some(bundle);
        }
    }
    let root = crate::core_runtime::source_project_root(&executable_dir)?;
    bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER))
}

pub(crate) fn asset_name(program: Program, version: &str, target: &str) -> String {
    format!("{}-{version}-{target}.tar.gz", program.name())
}

/// One archive, read only when it matches the checksum the release lists for it.
pub(crate) fn archive(bundle: &Bundle, program: Program, target: &str) -> Result<Vec<u8>, String> {
    let name = asset_name(program, &bundle.version, target);
    let sums = std::fs::read_to_string(bundle.dir.join(SUMS_FILE)).map_err(|_| "This build of Arbor has no checksums for Grove".to_string())?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let (hash, file) = line.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name).then(|| hash.trim().to_ascii_lowercase())
        })
        .ok_or_else(|| format!("This build of Arbor has no {} for {target}", program.name()))?;
    let bytes = std::fs::read(bundle.dir.join(&name)).map_err(|_| format!("This build of Arbor has no {} for {target}", program.name()))?;
    let actual: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != expected {
        return Err(format!("The {} Arbor carries doesn't match its checksum", program.name()));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arbor-grove-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_archive_is_read_only_when_it_matches_its_checksum() {
        let dir = temp_dir("sums");
        std::fs::write(dir.join("grove-probe-0.1.1-linux-x64.tar.gz"), b"probe").unwrap();
        std::fs::write(dir.join("grove-0.1.1-darwin-arm64.tar.gz"), b"tampered").unwrap();
        let sum = |bytes: &[u8]| Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        std::fs::write(
            dir.join(SUMS_FILE),
            format!("{}  grove-probe-0.1.1-linux-x64.tar.gz\n{}  grove-0.1.1-darwin-arm64.tar.gz\n", sum(b"probe"), sum(b"grove")),
        )
        .unwrap();
        let bundle = Bundle { version: "0.1.1".into(), dir: dir.clone() };
        assert_eq!(archive(&bundle, Program::Probe, "linux-x64").unwrap(), b"probe");
        assert!(archive(&bundle, Program::Grove, "darwin-arm64").unwrap_err().contains("doesn't match"));
        assert!(archive(&bundle, Program::Probe, "linux-arm64").unwrap_err().contains("no grove-probe for linux-arm64"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The checkout's pinned release, as `scripts/build-release.sh` fetches it into `bundled-grove/`: both macOS
    /// builds of `grove` and every system's `grove-probe` are there, match their checksums and hold the one program
    /// each names. Ignored because it needs that fetch first.
    #[test]
    #[ignore]
    fn the_pinned_release_is_bundled_for_every_system() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bundle = bundle_in(&root.join(VERSION_FILE), &root.join(SOURCE_FOLDER)).expect("grove-version.txt names a release");
        let wanted = [
            (Program::Grove, "darwin-arm64"),
            (Program::Grove, "darwin-x64"),
            (Program::Probe, "darwin-arm64"),
            (Program::Probe, "darwin-x64"),
            (Program::Probe, "linux-x64"),
            (Program::Probe, "linux-arm64"),
        ];
        for (program, target) in wanted {
            let bytes = archive(&bundle, program, target).unwrap();
            let mut tar = std::process::Command::new("tar").args(["-tzf", "-"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            std::io::Write::write_all(&mut tar.stdin.take().unwrap(), &bytes).unwrap();
            let listing = String::from_utf8(tar.wait_with_output().unwrap().stdout).unwrap();
            assert_eq!(listing.trim(), program.name(), "{target}");
        }
    }
}
