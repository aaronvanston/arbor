use super::support::*;
use super::*;
use crate::digest_export::{page_file_name, saved_page};

#[test]
fn the_page_is_offered_under_a_plain_html_name() {
    assert_eq!(page_file_name(" arbor-week-2026-09-21.html ").unwrap(), "arbor-week-2026-09-21.html");
    assert_eq!(page_file_name("Week.HTML").unwrap(), "Week.HTML");
    for name in [
        "",
        "arbor-week.txt",
        "../arbor-week.html",
        "reports/arbor-week.html",
        "C:\\arbor-week.html",
        ".html",
        "arbor\nweek.html",
    ] {
        assert!(page_file_name(name).is_err(), "{name:?} should be refused");
    }
    assert!(page_file_name(&format!("{}.html", "a".repeat(200))).is_err());
}

#[test]
fn only_a_saved_page_is_opened() {
    let home = agent_test_home("digest-export");
    let page = home.join("arbor-week-2026-09-21.html");
    fs::write(&page, "<!doctype html>").unwrap();
    let program = home.join("run.command");
    fs::write(&program, "echo hi").unwrap();

    assert_eq!(saved_page(&path_to_string(&page)).unwrap(), page);
    // Anything but an .html file that's there is refused, programs and folders included.
    assert!(saved_page(&path_to_string(&program)).is_err());
    assert!(saved_page(&path_to_string(&home.join("missing.html"))).is_err());
    assert!(saved_page(&path_to_string(&home)).is_err());
    assert!(saved_page("arbor-week-2026-09-21.html").is_err());

    fs::remove_dir_all(home).unwrap();
}
