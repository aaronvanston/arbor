//! Opening links and files in the apps the system picks, without leaving `open` behind.

use std::process::Child;

/// Opens a link or a file in `with`, or in the app the system picks for it. Arbor runs `open` itself and waits for
/// it: tauri-plugin-opener starts it through a fork that exits at once and is never waited for, so every link Arbor
/// opened left a zombie process behind until Arbor quit.
pub(crate) fn open_with_system(app: &tauri::AppHandle, target: &str, with: Option<&str>) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let _ = app;
    let mut command = Command::new("/usr/bin/open");
    if let Some(with) = with {
        command.arg("-a").arg(with);
    }
    // `--` so a target starting with a dash is never taken for an option.
    command.arg("--").arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    reap_when_done(command.spawn().map_err(|error| error.to_string())?);
    Ok(())
}

/// Waits for a process left to run on its own, so it doesn't stay a zombie once it's done.
pub(crate) fn reap_when_done(mut child: Child) {
    let _ = std::thread::Builder::new().name("arbor-reap".into()).spawn(move || {
        let _ = child.wait();
    });
}
