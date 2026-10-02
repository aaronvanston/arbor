//! The socket the running app answers the command line on. It's a file in the app's data folder that only this user
//! can open (folder 0700, socket 0600), and each connection is checked to come from the same user; there's no
//! network port. Each line in is a request, each line out its answer, and `watch` turns a connection into the app's
//! event stream until the other end goes away. `pools.connect` picks a pool member for an SSH connection and holds
//! the pick for as long as the connection stays open, which is as long as the `arbor` carrying it keeps the socket.

use super::{audit, dispatch, protocol};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::Listener;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

static SOCKET: OnceLock<PathBuf> = OnceLock::new();

/// Starts answering the command line. A failure only means `arbor` can't reach this run of the app.
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(app).await {
            eprintln!("The command line socket stopped: {error}");
        }
    });
}

/// Takes the socket file away as the app quits, so `arbor` knows at once that nothing is answering.
pub(crate) fn stop() {
    if let Some(path) = SOCKET.get() {
        let _ = fs::remove_file(path);
    }
}

/// Makes the socket's folder private and clears a socket a crashed run left behind. A socket something still answers
/// on belongs to another running Arbor, which keeps it.
fn prepare(path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Couldn't make {} private: {error}", dir.display()))?;
    }
    if path.symlink_metadata().is_ok() {
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(format!("Another Arbor is already answering on {}", path.display()));
        }
        fs::remove_file(path).map_err(|error| format!("Couldn't clear the old socket: {error}"))?;
    }
    Ok(())
}

fn bind(path: &Path) -> Result<UnixListener, String> {
    prepare(path)?;
    // The folder is already this user's alone, so nobody else can reach the socket before its own mode is set. The
    // umask isn't narrowed for it: that's the whole process's, and other threads make files and folders meanwhile.
    let listener = UnixListener::bind(path).map_err(|error| format!("Couldn't open {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Couldn't make {} private: {error}", path.display()))?;
    Ok(listener)
}

async fn serve(app: tauri::AppHandle) -> Result<(), String> {
    let path = super::socket_path()?;
    let listener = bind(&path)?;
    let _ = SOCKET.set(path);
    loop {
        let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        if !same_user(&stream) {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = connection(app, stream).await;
        });
    }
}

/// Whether whoever connected is this user. The folder's mode already stops anyone else; this is the second lock.
fn same_user(stream: &UnixStream) -> bool {
    let me = unsafe { libc::geteuid() };
    stream.peer_cred().is_ok_and(|cred| cred.uid() == me)
}

/// Reads one line, refusing one longer than [`protocol::MAX_LINE`]. None at the end of the stream.
pub(crate) async fn read_line<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    let read = (&mut *reader).take(protocol::MAX_LINE as u64 + 1).read_until(b'\n', &mut line).await?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() > protocol::MAX_LINE {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line too long"));
    }
    Ok(Some(String::from_utf8_lossy(&line).trim_end().to_string()))
}

pub(crate) async fn write_line<W: AsyncWrite + Unpin>(writer: &mut W, value: &impl serde::Serialize) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    writer.flush().await
}

async fn connection(app: tauri::AppHandle, stream: UnixStream) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut client = String::from("cli");
    while let Some(line) = read_line(&mut reader).await? {
        if line.is_empty() {
            continue;
        }
        let request: protocol::Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let failure = protocol::unsupported(format!("That request isn't JSON Arbor can read: {error}"));
                write_line(&mut write, &protocol::Response::error("", failure)).await?;
                continue;
            }
        };
        if request.method == protocol::HELLO {
            if let Some(name) = request.args.get("client").and_then(|name| name.as_str()) {
                client = name.chars().take(16).collect();
            }
        }
        if request.method == protocol::WATCH {
            return watch(&app, &request, reader, write).await;
        }
        if request.method == protocol::POOL_CONNECT {
            return pool_connect(&app, &client, &request, reader, write).await;
        }
        let response = dispatch::handle(&app, &client, request).await;
        write_line(&mut write, &response).await?;
    }
    Ok(())
}

/// Answers where an SSH connection to a pool goes, then keeps its place on the member until the other end closes,
/// which is when `arbor` stops carrying the connection.
async fn pool_connect<R: AsyncRead + Unpin>(
    app: &tauri::AppHandle,
    client: &str,
    request: &protocol::Request,
    reader: BufReader<R>,
    mut write: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    let started = std::time::Instant::now();
    let text = |name: &str| request.args.get(name).and_then(|value| value.as_str()).unwrap_or_default().to_string();
    let opened = if !super::settings::read().enabled {
        Err(protocol::unavailable("Command line control is off in Arbor's Settings › App."))
    } else {
        crate::usage::machine_health::pool_ssh::open_connection(app, &text("pool"), &text("name"))
            .await
            .map_err(crate::command_error::CommandError::failed)
    };
    let (response, hold) = match opened {
        Ok((target, hold)) => (protocol::Response::ok(&request.id, serde_json::to_value(target).unwrap_or_default()), Some(hold)),
        Err(error) => (protocol::Response::error(&request.id, error), None),
    };
    audit::record(&audit::Entry::new(client, &request.method, Some(dispatch::Access::Read), &response, started.elapsed()));
    write_line(&mut write, &response).await?;
    if hold.is_some() {
        held_until_closed(reader).await;
    }
    drop(hold);
    Ok(())
}

/// Waits for the other end to close, ignoring anything it sends.
async fn held_until_closed<R: AsyncRead + Unpin>(mut reader: BufReader<R>) {
    let mut ignored = Vec::new();
    while matches!((&mut reader).read_buf(&mut ignored).await, Ok(count) if count > 0) {
        ignored.clear();
    }
}

/// Passes on the app's events until the other end closes. `args.events` picks some; none means all of them.
async fn watch<R: AsyncRead + Unpin>(
    app: &tauri::AppHandle,
    request: &protocol::Request,
    mut reader: BufReader<R>,
    mut write: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    if !super::settings::read().enabled {
        let failure = protocol::unavailable("Command line control is off in Arbor's Settings › App.");
        return write_line(&mut write, &protocol::Response::error(&request.id, failure)).await;
    }
    let wanted: Vec<String> = request
        .args
        .get("events")
        .and_then(|events| serde_json::from_value(events.clone()).ok())
        .filter(|events: &Vec<String>| !events.is_empty())
        .unwrap_or_else(|| protocol::WATCHED_EVENTS.iter().map(|event| event.to_string()).collect());
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let listeners: Vec<_> = wanted
        .iter()
        .filter(|event| protocol::WATCHED_EVENTS.contains(&event.as_str()))
        .map(|event| {
            let sender = sender.clone();
            let name = event.clone();
            app.listen_any(event.clone(), move |emitted| {
                let _ = sender.send(protocol::event_line(&name, emitted.payload()));
            })
        })
        .collect();
    let started = protocol::Response::ok(&request.id, serde_json::json!({ "watching": wanted }));
    let mut result = write_line(&mut write, &started).await;
    let mut ignored = Vec::new();
    while result.is_ok() {
        tokio::select! {
            event = events.recv() => match event {
                Some(event) => result = write_line(&mut write, &event).await,
                None => break,
            },
            // Anything more the other end sends is ignored; its end of the stream ends the watch.
            read = (&mut reader).read_buf(&mut ignored) => {
                ignored.clear();
                if !matches!(read, Ok(count) if count > 0) {
                    break;
                }
            }
        }
    }
    for id in listeners {
        app.unlisten(id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_socket_is_private_and_a_stale_one_is_replaced() {
        let dir = super::super::test_dir("sock");
        let path = dir.join("private").join("a.sock");
        let listener = bind(&path).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert!(bind(&path).is_err(), "a socket something answers on is left to it");
        drop(listener);
        assert!(bind(&path).is_ok(), "one nothing answers on is cleared");
    }

    #[tokio::test]
    async fn a_held_connection_lasts_until_the_other_end_closes() {
        let (client, server) = UnixStream::pair().unwrap();
        let held = tokio::spawn(held_until_closed(BufReader::new(server)));
        let (_, mut write) = client.into_split();
        write.write_all(b"anything\n").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!held.is_finished(), "still open");
        drop(write);
        tokio::time::timeout(std::time::Duration::from_secs(2), held).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lines_are_read_whole_and_an_endless_one_is_refused() {
        let (client, server) = UnixStream::pair().unwrap();
        assert!(same_user(&server));
        let (_, mut write) = client.into_split();
        write_line(&mut write, &serde_json::json!({ "method": "hello" })).await.unwrap();
        let mut reader = BufReader::new(server);
        assert_eq!(read_line(&mut reader).await.unwrap().unwrap(), r#"{"method":"hello"}"#);
        tokio::spawn(async move {
            let chunk = vec![b'x'; 1024 * 1024];
            for _ in 0..9 {
                if write.write_all(&chunk).await.is_err() {
                    break;
                }
            }
        });
        assert!(read_line(&mut reader).await.is_err());
    }
}
