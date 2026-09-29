use super::support::*;
use super::*;

#[test]
fn app_instance_guard_rejects_a_second_copy_and_releases_on_drop() {
    let root = agent_test_home("instance-lock");
    let first = acquire_app_instance_guard_for(&root).unwrap();

    let duplicate = acquire_app_instance_guard_for(&root);
    assert!(duplicate.is_err());
    // A copy run from another folder is another instance, and starts.
    let elsewhere = agent_test_home("instance-lock-elsewhere");
    let other = acquire_app_instance_guard_for(&elsewhere);
    assert!(other.is_ok());
    drop(other);
    fs::remove_dir_all(elsewhere).unwrap();

    drop(first);
    // flock belongs to the open file description, and a child process another test
    // is spawning at that moment can hold a reference to it until the spawn closes
    // it, so allow the release a brief moment to land.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let reacquired = loop {
        match acquire_app_instance_guard_for(&root) {
            Ok(guard) => break Some(guard),
            Err(_) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };
    assert!(reacquired.is_some());
    fs::remove_dir_all(root).unwrap();
}
