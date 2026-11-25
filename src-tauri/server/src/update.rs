//! Versione nuova su GitHub. La richiesta non contiene nulla dell'utente oltre all'indirizzo IP.
use duetto_core::{log::log, updates::{is_newer, version_in}};
use serde_json::{json, Value};
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/Samuel782/Duetto/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/Samuel782/Duetto/releases";

pub async fn check(current: &str, api: Option<&str>) -> Option<Value> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).user_agent("Duetto").build().ok()?;
    let res = client.get(api.unwrap_or(RELEASES_API)).header("Accept", "application/vnd.github+json").send().await.ok()?;
    if !res.status().is_success() { return None; }
    let release: Value = res.json().await.ok()?;
    if release["draft"] == true || release["prerelease"] == true { return None; }
    let version = version_in(release["tag_name"].as_str()?);
    if !is_newer(version, current) { return None; }
    let url = release["html_url"].as_str().filter(|u| u.starts_with("https://github.com/")).unwrap_or(RELEASES_PAGE);
    log(format!("Aggiornamento disponibile: {version}"));
    Some(json!({ "version": version, "url": url }))
}
