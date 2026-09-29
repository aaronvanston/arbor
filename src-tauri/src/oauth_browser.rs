use super::*;
use ts_rs::TS;

const DEFAULT_BROWSER: &str = "default";
const NO_AUTO_OPEN: &str = "none";

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthBrowserOption {
    id: &'static str,
    label: &'static str,
}

struct BrowserSpec {
    id: &'static str,
    label: &'static str,
    executable: PathBuf,
}

#[tauri::command]
pub(crate) fn list_oauth_browsers() -> Vec<OAuthBrowserOption> {
    let mut options = vec![OAuthBrowserOption {
        id: DEFAULT_BROWSER,
        label: "System Default",
    }];
    options.extend(
        browser_specs()
            .into_iter()
            .map(|browser| OAuthBrowserOption {
                id: browser.id,
                label: browser.label,
            }),
    );
    options
}

#[tauri::command]
pub(crate) fn open_oauth_url(
    app: tauri::AppHandle,
    url: String,
    browser: Option<String>,
) -> Result<(), String> {
    open_oauth_url_inner(&app, &url, browser.as_deref())
}

pub(crate) fn open_oauth_url_inner(
    app: &tauri::AppHandle,
    url: &str,
    browser: Option<&str>,
) -> Result<(), String> {
    let url = validate_http_url(url)?;
    let browser = browser
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER);
    if browser == NO_AUTO_OPEN {
        return Ok(());
    }
    if browser == DEFAULT_BROWSER {
        return open_external_url_inner(app, url);
    }

    let selected = browser_specs()
        .into_iter()
        .find(|candidate| candidate.id == browser)
        .ok_or_else(|| format!("The selected browser is not installed: {browser}"))?;
    crate::system_open::open_with_system(app, url, Some(&selected.executable.to_string_lossy()))
        .map_err(|error| format!("Failed to open {}: {error}", selected.label))
}

fn validate_http_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err("Only http/https links can be opened".to_string())
    }
}

fn browser_specs() -> Vec<BrowserSpec> {
    let roots = [
        PathBuf::from("/Applications"),
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("Applications"),
    ];
    let find = |id, label, bundle: &str| {
        roots
            .iter()
            .map(|root| root.join(bundle))
            .find(|path| path.is_dir())
            .map(|executable| BrowserSpec {
                id,
                label,
                executable,
            })
    };
    [
        find("safari", "Safari", "Safari.app"),
        find("chrome", "Google Chrome", "Google Chrome.app"),
        find("firefox", "Mozilla Firefox", "Firefox.app"),
        find("brave", "Brave", "Brave Browser.app"),
        find("edge", "Microsoft Edge", "Microsoft Edge.app"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_browser_urls_only_allow_http_and_https() {
        assert_eq!(
            validate_http_url(" https://example.com ").unwrap(),
            "https://example.com"
        );
        assert!(validate_http_url("file:///tmp/token").is_err());
        assert!(validate_http_url("javascript:alert(1)").is_err());
    }
}
