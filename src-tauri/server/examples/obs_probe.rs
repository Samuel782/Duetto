// Esegue una serie di passi (JSON su stdin) sul collegamento a OBS: serve a parity-obs.mjs.
use duetto_core::i18n::Lang;
use duetto_server::obs::{Obs, ObsConfig};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

#[tokio::main]
async fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let o = Obs::new(Lang::It);
    let mut cfg = ObsConfig::default();
    let mut out = Vec::new();
    for s in v.as_array().unwrap() {
        match s["op"].as_str().unwrap() {
            "configure" => {
                if let Some(b) = s["enabled"].as_bool() { cfg.enabled = b }
                if let Some(h) = s["host"].as_str() { cfg.host = h.into() }
                if let Some(p) = s["port"].as_u64() { cfg.port = p as u16 }
                if let Some(p) = s["password"].as_str() { cfg.password = p.into() }
                o.configure(cfg.clone());
            }
            "push" => o.push(s["text"].as_str().unwrap()),
            "stop" => o.stop(),
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(s["wait"].as_u64().unwrap_or(250))).await;
        out.push(o.status());
    }
    println!("@@{}", json!(out));
}
