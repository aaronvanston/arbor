//! How an automation's agent reaches Arbor's own proxy. Every run goes through it with the one Automations client key,
//! whatever the machine's own sign-ins are, so its use shows in Usage like any other agent's and a machine's expired
//! login never stops it. The key is read from the core's own list by its fingerprint each time it's needed; it reaches
//! a machine only in a script's input and a file only its owner can read, never a command line, a log or the webview.
//!
//! Which address reaches the proxy depends on the machine: this Mac answers on loopback, another machine might come in
//! over the LAN or a tunnel that fronts the proxy on a port of its own. So the machine tries them itself and keeps the
//! first that answers `/v1/models` with the key: the address set in Settings, then the proxy addresses the machine's own
//! agents are set up with, then the one Arbor listens on.

use super::super::harnesses::Launcher;
use super::super::shell::Machine;
use super::super::telemetry::remote_address;
use super::store;
use super::*;
use crate::core_config::{current_core_config_settings, current_core_tls_settings, is_loopback_host};
use tauri::Manager;

/// The Automations key's fingerprint, as Usage keeps a key's.
pub(super) const KEY_SETTING: &str = "proxy_key";
/// The address the user set for machines to reach the proxy at, tried before any other.
pub(super) const ADDRESS_SETTING: &str = "proxy_address";
/// The key's name in the core's list.
pub(super) const KEY_NAME: &str = "Automations";
/// The exit a run on the background runner gives when no address answered with the key.
pub(super) const UNREACHABLE_EXIT: i32 = 125;

pub(super) const NO_KEY: &str = "Automations reach your proxy with their own key. Add it in Settings › Machines first";
pub(super) const UNREACHABLE: &str = "The machine couldn't reach your proxy with the Automations key. Check the address in Settings › Machines";

/// What a run needs to reach the proxy: the key, and the addresses Arbor knows of to try before and after the ones
/// the machine's own agents use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProxySetup {
    pub(super) key: String,
    pub(super) first: Vec<String>,
    pub(super) last: Vec<String>,
}

impl ProxySetup {
    /// The file a run reads it from: `key=`, then a `first=` or `last=` line for each address.
    pub(super) fn file(&self) -> String {
        let mut text = format!("key={}\n", self.key);
        for (word, addresses) in [("first", &self.first), ("last", &self.last)] {
            for address in addresses {
                text.push_str(&format!("{word}={address}\n"));
            }
        }
        text
    }

    /// What a placement depends on, without the key itself: a new key or address means placing it again.
    pub(super) fn summary(&self) -> String {
        format!("{}\n{}\n{}", crate::usage::hash_text(&self.key), self.first.join(" "), self.last.join(" "))
    }
}

/// Whether an agent is started through the proxy. Others keep their own setup, since Arbor can't point them at it.
pub(super) fn routes(input: &AutomationInput) -> bool {
    matches!(input.agent.spec().launcher, Some(Launcher::Claude | Launcher::Codex))
}

/// A new client key: long, random, and only characters a shell or curl's config never treats specially.
pub(super) fn new_key() -> Result<String, String> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|error| format!("Couldn't make a key: {error}"))?;
    Ok(format!("sk-arbor-{}", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

/// The key the core has with this fingerprint, if it still has it: the key can be deleted or paused in Settings.
fn key_with(app: &tauri::AppHandle, fingerprint: &str) -> Option<String> {
    let settings = current_core_config_settings(app.state::<crate::GuiConfigState>().inner()).ok()?;
    settings.api_keys.into_iter().find(|key| crate::usage::hash_text(key.trim()) == fingerprint)
}

/// Whether the Automations key is in the core's list now.
pub(super) fn has_key(app: &tauri::AppHandle, fingerprint: Option<&str>) -> bool {
    fingerprint.is_some_and(|fingerprint| key_with(app, fingerprint).is_some())
}

/// The proxy as Arbor listens: loopback for this Mac, and for another machine the address it listens on, or this
/// Mac's LAN address when it listens on all of them. None when it listens on loopback alone.
fn own_addresses(app: &tauri::AppHandle, local: bool) -> Vec<String> {
    let Ok(config) = app.state::<crate::GuiConfigState>().snapshot() else { return Vec::new() };
    let scheme = if current_core_tls_settings().is_ok_and(|tls| tls.enabled) { "https" } else { "http" };
    let host = if local {
        Some("127.0.0.1".to_string())
    } else if is_loopback_host(&config.host) {
        None
    } else {
        remote_address(&config.host)
    };
    host.map(|host| format!("{scheme}://{host}:{}", config.port)).into_iter().collect()
}

/// Everything a run on `machine` needs to reach the proxy, or why it can't.
pub(super) async fn setup(app: &tauri::AppHandle, machine: &Machine) -> Result<ProxySetup, String> {
    let (fingerprint, address) = run_usage_task(|| {
        let connection = open_usage_database()?;
        Ok((store::setting(&connection, KEY_SETTING)?, store::setting(&connection, ADDRESS_SETTING)?))
    })
    .await?;
    let key = fingerprint.and_then(|fingerprint| key_with(app, &fingerprint)).ok_or(NO_KEY)?;
    Ok(ProxySetup {
        key,
        first: address.map(|address| address.trim().to_string()).filter(|address| !address.is_empty()).into_iter().collect(),
        last: own_addresses(app, machine.is_local()),
    })
}

/// What's wrong with an address typed in Settings, if anything. Empty clears it.
pub(super) fn check_address(address: &str) -> Result<(), String> {
    let address = address.trim();
    if address.is_empty() {
        return Ok(());
    }
    let rest = address.strip_prefix("http://").or_else(|| address.strip_prefix("https://")).ok_or("Start the address with http:// or https://")?;
    if rest.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | '`' | '$')) {
        return Err("That isn't an address a machine can reach".into());
    }
    Ok(())
}

/// Shell functions for finding the proxy on a machine. `arbor_proxy_order FILE` prints each address to try, once, in
/// order: the file's `first=` lines, the proxy addresses the machine's own agents use (when the script defines
/// `agent_homes`), then its `last=` lines. `arbor_proxy_find FILE` prints the first that answers with the file's
/// `key=`, which curl reads from its input, so the key is never on a command line.
pub(super) const FUNCTIONS: &str = r#"arbor_proxy_seen() {
  command -v agent_homes >/dev/null 2>&1 || return 0
  agent_homes | while IFS="$(printf '\t')" read -r ap_agent ap_dir; do
    case $ap_agent in
      codex) [ -f "$ap_dir/config.toml" ] && sed -n 's/^[[:space:]]*base_url[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ap_dir/config.toml" ;;
      claude) [ -f "$ap_dir/settings.json" ] && grep -o '"ANTHROPIC_BASE_URL"[[:space:]]*:[[:space:]]*"[^"]*"' "$ap_dir/settings.json" | sed 's/.*"\([^"]*\)"$/\1/' ;;
    esac
  done
}
arbor_proxy_order() {
  { sed -n 's/^first=//p' "$1"; arbor_proxy_seen; sed -n 's/^last=//p' "$1"; } | while IFS= read -r ap_url; do
    ap_url=${ap_url%/}; ap_url=${ap_url%/v1}; ap_url=${ap_url%/}
    case $ap_url in http://*|https://*) printf '%s\n' "$ap_url" ;; esac
  done | awk '!seen[$0]++'
}
arbor_proxy_find() {
  ap_key=$(sed -n 's/^key=//p' "$1" | head -n 1)
  [ -n "$ap_key" ] || return 0
  arbor_proxy_order "$1" | while IFS= read -r ap_url; do
    ap_code=$(printf 'header = "Authorization: Bearer %s"\n' "$ap_key" | curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 -K - "$ap_url/v1/models" 2>/dev/null)
    if [ "$ap_code" = 200 ]; then printf '%s\n' "$ap_url"; break; fi
  done
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn setup() -> ProxySetup {
        ProxySetup { key: "sk-arbor-0123abcd".into(), first: vec!["https://proxy.example.net:8443/".into()], last: vec!["http://10.0.0.5:8317".into()] }
    }

    #[test]
    fn the_summary_follows_the_key_and_addresses_without_holding_the_key() {
        let summary = setup().summary();
        assert!(!summary.contains("sk-arbor-0123abcd"));
        let mut other = setup();
        other.key = "sk-arbor-ffff".into();
        assert_ne!(other.summary(), summary);
        let mut moved = setup();
        moved.last.clear();
        assert_ne!(moved.summary(), summary);
        assert_eq!(setup().file(), "key=sk-arbor-0123abcd\nfirst=https://proxy.example.net:8443/\nlast=http://10.0.0.5:8317\n");
    }

    #[test]
    fn new_keys_are_long_random_and_plain() {
        let (a, b) = (new_key().unwrap(), new_key().unwrap());
        assert_ne!(a, b);
        assert!(a.starts_with("sk-arbor-") && a.len() == 57 && a.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
        assert!(crate::core_config::validate_core_api_key(&a).is_ok());
    }

    #[test]
    fn typed_addresses_must_be_reachable_urls() {
        assert!(check_address("").is_ok());
        assert!(check_address("https://proxy.example.net:8443").is_ok());
        assert!(check_address("proxy.example.net").is_err());
        assert!(check_address("http://").is_err());
        assert!(check_address("http://host$(rm)").is_err());
    }

    /// The machine's side, under sh and dash with a fake curl that answers 200 only at one address and only with
    /// the key: addresses come in order, once each, the agents' own in the middle, and the key never reaches curl's
    /// command line.
    #[test]
    fn a_machine_tries_each_address_in_order_and_keeps_the_first_that_answers() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("arbor-proxy-{}-{}", std::process::id(), super::super::runner::new_uuid()));
        let bin = home.join("bin");
        for dir in [&bin, &home.join(".codex"), &home.join(".claude")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(home.join(".codex/config.toml"), "model_provider = \"hub\"\n[model_providers.hub]\nbase_url = \"https://tunnel.example.net:8443/v1\"\n").unwrap();
        std::fs::write(home.join(".claude/settings.json"), "{ \"env\": { \"ANTHROPIC_BASE_URL\": \"http://10.0.0.5:8317\" } }").unwrap();
        let curl = bin.join("curl");
        std::fs::write(
            &curl,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$HOME/curl-args\"\nconfig=$(cat)\n\
             case \"$*\" in *'https://tunnel.example.net:8443/v1/models'*) ;; *) printf 401; exit 0 ;; esac\n\
             case $config in *'Bearer sk-arbor-0123abcd'*) printf 200 ;; *) printf 401 ;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(home.join("proxy"), setup().file()).unwrap();
        let homes = "agent_homes() { printf 'codex\\t%s\\n' \"$HOME/.codex\"; printf 'claude\\t%s\\n' \"$HOME/.claude\"; }\n";
        for shell in ["sh", "dash"] {
            let _ = std::fs::remove_file(home.join("curl-args"));
            let script = format!("{FUNCTIONS}{homes}arbor_proxy_order \"$HOME/proxy\"; echo found=$(arbor_proxy_find \"$HOME/proxy\")\n");
            let path = format!("{}:/usr/bin:/bin", bin.display());
            let Ok(mut child) = std::process::Command::new(shell).env("HOME", &home).env("PATH", path).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn() else { continue };
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let stdout = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
            assert_eq!(
                stdout,
                "https://proxy.example.net:8443\nhttps://tunnel.example.net:8443\nhttp://10.0.0.5:8317\nfound=https://tunnel.example.net:8443\n",
                "{shell}"
            );
            let args = std::fs::read_to_string(home.join("curl-args")).unwrap();
            assert_eq!(args.lines().count(), 2, "{shell}: stops at the first that answers");
            assert!(!args.contains("sk-arbor"), "{shell}: the key stays off the command line");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
