use super::support::*;
use super::*;
use crate::app_identity::{macos_data_dir, move_legacy_data, APP_IDENTIFIER};

fn data_folders(home: &Path) -> (PathBuf, PathBuf) {
    let support = home.join("Library").join("Application Support");
    (support.join("com.cpa.gui"), support.join(APP_IDENTIFIER))
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn the_first_launch_moves_arbors_data_and_leaves_a_link_behind() {
    let home = agent_test_home("identity-move");
    let (legacy, current) = data_folders(&home);
    write(&legacy.join("config.toml"), "port = 8317\nzoom-step = 2\n");
    write(&legacy.join("usage-records/usage.db"), "db");
    let webkit = home.join("Library/WebKit");
    let saved = "WebsiteData/Default/a/a/LocalStorage/localstorage.sqlite3";
    write(&webkit.join("com.cpa.gui/WebsiteData/Default/salt"), "salt");
    write(&webkit.join("com.cpa.gui").join(saved), "choices");

    assert_eq!(move_legacy_data(&home), Ok(true));
    assert_eq!(fs::read_to_string(current.join("usage-records/usage.db")).unwrap(), "db");
    assert_eq!(fs::read_link(&legacy).unwrap(), current);
    assert_eq!(
        fs::read_to_string(legacy.join("config.toml")).unwrap(),
        "port = 8317\nzoom-step = 2\n"
    );
    assert_eq!(macos_data_dir(&home), current);
    // WebKit's storage is copied with its salt, which its folder names are derived from, and the old version keeps its
    // own copy.
    let copied = webkit.join(APP_IDENTIFIER);
    assert_eq!(fs::read_to_string(copied.join(saved)).unwrap(), "choices");
    assert_eq!(fs::read_to_string(copied.join("WebsiteData/Default/salt")).unwrap(), "salt");
    assert!(webkit.join("com.cpa.gui").join(saved).is_file());
    assert!(!webkit.join(format!("{APP_IDENTIFIER}.partial")).exists());

    // The next launch finds the new folder and moves nothing.
    assert_eq!(move_legacy_data(&home), Ok(false));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_folder_easycliproxyapi_uses_is_left_alone() {
    let home = agent_test_home("identity-upstream");
    let (legacy, current) = data_folders(&home);
    write(&legacy.join("config.toml"), "port = 8317\nallow-lan = false\n");
    write(&legacy.join("usage-records/usage.db"), "db");
    write(&home.join("Library/WebKit/com.cpa.gui/WebsiteData/Default/salt"), "salt");

    assert_eq!(move_legacy_data(&home), Ok(false));
    assert!(fs::symlink_metadata(&legacy).unwrap().is_dir());
    assert!(!home.join("Library/WebKit").join(APP_IDENTIFIER).exists());
    assert!(!current.exists());
    assert_eq!(macos_data_dir(&home), current);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn arbor_data_that_couldnt_be_moved_is_used_where_it_is() {
    let home = agent_test_home("identity-unmoved");
    let (legacy, _) = data_folders(&home);
    write(&legacy.join("session-archive/archive.db"), "index");

    assert_eq!(macos_data_dir(&home), legacy);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn the_data_folder_is_named_for_the_bundle_id() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(config["identifier"], APP_IDENTIFIER);
}
