//! Le stesse variabili d'ambiente di `server/index.js`.
use std::{env, path::PathBuf};

pub struct Config {
    pub root: PathBuf,
    pub port: u16,
    pub port_tries: u16,
    pub host: String,
    pub control_allow_lan: bool,
    pub overlay_allow_lan: bool,
    pub price_per_hour: f64,
    pub data_dir: PathBuf,
    pub output_dir: PathBuf,
    pub keyterms: PathBuf,
    pub glossary: PathBuf,
    pub version: String,
    pub default_mode: String,
    pub locale: String,
    pub assembly_key: String,
    pub assembly_url: String,
    pub assembly_model: String,
    pub min_turn_silence: String,
    pub max_turn_silence: String,
    pub rollover_before: f64,
    pub session_max: f64,
    pub deepl_key: String,
    pub deepl_endpoint: String,
    pub deepl_model: String,
    pub deepl_context: bool,
    pub clean_fillers: bool,
    pub clean_profanity: bool,
    pub update_api: String,
    pub desktop_app: bool,
    pub test: bool,
}

fn var(name: &str) -> String { env::var(name).unwrap_or_default() }
fn or(name: &str, default: &str) -> String { Some(var(name)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.into()) }
fn flag(name: &str, default: bool) -> bool { let v = var(name); if v.is_empty() { default } else { v == "true" } }
fn num<T: std::str::FromStr + Default + PartialEq>(name: &str, default: T) -> T {
    var(name).trim().parse().ok().filter(|n| *n != T::default()).unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        let root = env::current_dir().unwrap_or_default();
        let file = |name: &str, default: &str| { let v = var(name); if v.is_empty() { root.join(default) } else { PathBuf::from(v) } };
        Self {
            port: num("PORT", 8787),
            port_tries: if flag("PORT_FALLBACK", false) { 10 } else { 1 },
            host: or("HOST", "0.0.0.0"),
            control_allow_lan: flag("CONTROL_ALLOW_LAN", false),
            overlay_allow_lan: flag("OVERLAY_ALLOW_LAN", false),
            price_per_hour: num("ASSEMBLYAI_PRICE_PER_HOUR", 0.45),
            data_dir: file("DATA_DIR", "data"),
            output_dir: file("OUTPUT_DIR", "output"),
            keyterms: file("KEYTERMS_FILE", "keyterms.txt"),
            glossary: file("GLOSSARY_FILE", "glossario.csv"),
            version: or("DUETTO_VERSION", include_version()),
            default_mode: var("DEFAULT_LANGUAGE_MODE"),
            locale: or("DUETTO_LOCALE", &var("LANG")),
            assembly_key: var("ASSEMBLYAI_API_KEY"),
            assembly_url: var("ASSEMBLYAI_WS_URL"),
            assembly_model: or("ASSEMBLYAI_SPEECH_MODEL", "universal-3-6-pro"),
            min_turn_silence: var("MIN_TURN_SILENCE"),
            max_turn_silence: or("MAX_TURN_SILENCE", "700"), // chiude prima l'ultimo blocco quando chi parla si ferma
            rollover_before: num("SESSION_ROLLOVER_BEFORE_SECONDS", 120.0),
            session_max: num("SESSION_MAX_SECONDS", 0.0),
            deepl_key: var("DEEPL_API_KEY"),
            deepl_endpoint: var("DEEPL_ENDPOINT"),
            // Vuota ma presente: nessun modello richiesto.
            deepl_model: env::var("DEEPL_MODEL_TYPE").unwrap_or_else(|_| "latency_optimized".into()),
            deepl_context: flag("DEEPL_USE_CONTEXT", true),
            clean_fillers: flag("CLEAN_FILLERS", true),
            clean_profanity: flag("CLEAN_PROFANITY", true),
            update_api: var("DUETTO_UPDATE_API"),
            desktop_app: var("DESKTOP_APP") == "true",
            test: var("DUETTO_TEST") == "1",
            root,
        }
    }
}

// La versione sta in un solo posto: package.json.
fn include_version() -> &'static str {
    let text = include_str!("../../../package.json");
    text.split("\"version\": \"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("0.0.0")
}
