//! Stato persistente: modalità, lingue, stili e preset. Stesso file di `server/store.js`.
use crate::{files::write_atomic, js, languages::*, log::warn};
use fancy_regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::{fs, io, path::PathBuf, sync::LazyLock, time::{Duration, Instant}};

pub const OUTPUTS: [&str; 2] = ["stream", "room"];
pub const VIEWS: [&str; 3] = ["both", "translation", "original"];
pub type Style = Map<String, Value>;

/// Schema del pannello e stili predefiniti, estratti da `server/store.js`.
static STYLES: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("styles.json")).expect("styles.json"));
static FONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N} ,'-]{1,80}\z").unwrap());

pub fn style_schema() -> &'static Value { &STYLES["schema"] }
pub fn default_styles() -> &'static Value { &STYLES["defaults"] }
fn default_style(out: &str) -> Style { STYLES["defaults"][out].as_object().cloned().unwrap_or_default() }

pub fn normalize_mode(mode: &str, spoken: &[String]) -> String {
    let value = js::trim(mode);
    if value.to_uppercase() == "AUTO" { return "AUTO".into(); }
    let code = value.to_lowercase();
    if spoken.contains(&code) { code } else { String::new() }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Languages { pub spoken: Vec<String>, pub targets: Vec<String> }

/// In quali lingue si può parlare e in quali si traduce. Mai vuote.
pub fn sanitize_languages(input: &Value) -> Languages {
    let or = |list: Vec<String>, default: [&str; 2]| if list.is_empty() { default.map(String::from).to_vec() } else { list };
    Languages {
        spoken: or(clean_codes(input.get("spoken"), is_spoken, MAX_SPOKEN), ["it", "en"]),
        targets: or(clean_codes(input.get("targets"), is_target, MAX_TARGETS), ["en", "it"]),
    }
}

pub fn pick_target(code: &str, targets: &[String]) -> String {
    targets.iter().find(|t| *t == code).or(targets.first()).cloned().unwrap_or_default()
}

/// Sottotitoli nativi: l'originale, oppure una lingua di destinazione in alfabeto latino.
pub fn pick_captions_target(code: &str, targets: &[String]) -> String {
    if code == "original" || (targets.iter().any(|t| t == code) && is_caption_target(code)) { return code.into(); }
    targets.iter().find(|t| is_caption_target(t)).cloned().unwrap_or_else(|| "original".into())
}

/// Solo campi noti con valori validi: i dati possono arrivare da un JSON importato.
pub fn sanitize_style(patch: &Value) -> Style {
    let mut out = Style::new();
    let Some(patch) = patch.as_object() else { return out };
    let fields = STYLES["schema"].as_array().into_iter().flatten().flat_map(|g| g["fields"].as_array().into_iter().flatten());
    for f in fields {
        let key = f["key"].as_str().unwrap_or_default();
        let Some(v) = patch.get(key) else { continue };
        let clean = match f["type"].as_str().unwrap_or_default() {
            "number" => js::number(v).map(|n| js::json_number(n.max(f["min"].as_f64().unwrap_or(n)).min(f["max"].as_f64().unwrap_or(n)))),
            "color" => v.as_str().filter(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())).map(Value::from),
            "select" => f["options"].as_array().into_iter().flatten().any(|o| &o[0] == v).then(|| v.clone()),
            "font" => v.as_str().filter(|s| FONT.is_match(s).unwrap_or(false)).map(Value::from),
            _ => None,
        };
        if let Some(c) = clean { out.insert(key.into(), c); }
    }
    out
}

// Fino alla 1.0.1 il carattere era unico: uno stile salvato allora vale anche per la traduzione.
fn sanitize_saved_style(saved: &Value) -> Style {
    let mut style = sanitize_style(saved);
    for (from, to) in [("font", "fontTranslation"), ("fontSource", "fontSourceTranslation"), ("weight", "weightTranslation"), ("size", "sizeTranslation")] {
        if let (Some(v), None) = (style.get(from).cloned(), style.get(to)) { style.insert(to.into(), v); }
    }
    style
}

pub fn sanitize_presets(input: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, style) in input.as_object().into_iter().flatten().take(200) {
        let clean = js::cut(js::trim(name), 60);
        if !clean.is_empty() { out.insert(clean.into(), Value::Object(sanitize_saved_style(style))); }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Output { pub view: String, pub hidden: bool, pub target: String, pub style: Style }

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Outputs { pub stream: Output, pub room: Output }

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub env_language_mode: String,
    pub language_mode: String,
    pub languages: Languages,
    pub last_language: Option<String>,
    pub captions_target: String,
    pub presets: Map<String, Value>,
    pub outputs: Outputs,
}

impl State {
    pub fn from_saved(data: &Value, env_language_mode: &str) -> Self {
        let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
        let languages = sanitize_languages(&data["languages"]);
        let mode = |m: &str| Some(normalize_mode(m, &languages.spoken)).filter(|m| !m.is_empty());
        let env_mode = mode(env_language_mode).unwrap_or_else(|| "AUTO".into());
        // Dopo un riavvio vale l'ultima modalità, salvo che il valore in .env sia cambiato.
        let same_env = text(&data["envLanguageMode"]).to_uppercase() == env_mode.to_uppercase();
        let saved_mode = mode(&text(&data["languageMode"])).filter(|_| same_env);
        let output = |out: &str| {
            let saved = &data["outputs"][out];
            let mut style = default_style(out);
            style.extend(sanitize_saved_style(&saved["style"]));
            Output {
                view: saved["view"].as_str().filter(|v| VIEWS.contains(v)).unwrap_or("both").into(),
                hidden: saved["hidden"] == true,
                target: pick_target(&text(&saved["target"]), &languages.targets),
                style,
            }
        };
        Self {
            language_mode: saved_mode.unwrap_or_else(|| env_mode.clone()),
            env_language_mode: env_mode,
            last_language: data["lastLanguage"].as_str().map(String::from).filter(|l| languages.spoken.contains(l)),
            captions_target: pick_captions_target(&text(&data["captionsTarget"]), &languages.targets),
            presets: sanitize_presets(&data["presets"]),
            outputs: Outputs { stream: output("stream"), room: output("room") },
            languages,
        }
    }
}

const SAVE_DELAY: Duration = Duration::from_millis(500);

pub struct Store { file: PathBuf, pub state: State, due: Option<Instant> }

impl Store {
    pub fn load(file: impl Into<PathBuf>, env_language_mode: &str) -> Self {
        let file = file.into();
        let read = fs::read_to_string(&file).map_err(|e| (e.kind() == io::ErrorKind::NotFound, e.to_string()))
            .and_then(|t| serde_json::from_str(&t).map_err(|e| (false, e.to_string())));
        let data = read.unwrap_or_else(|(missing, e)| {
            if !missing { warn(format!("Stato non leggibile, uso i valori predefiniti: {e}")); }
            Value::Null
        });
        let mut s = Self { state: State::from_saved(&data, env_language_mode), file, due: None };
        s.flush();
        s
    }

    /// Salvataggio differito: i cursori dello stile producono molte modifiche ravvicinate.
    /// Chi usa Store chiama `flush_if_due` a intervalli regolari.
    pub fn save(&mut self) {
        self.due.get_or_insert_with(|| Instant::now() + SAVE_DELAY);
    }
    pub fn flush_if_due(&mut self) {
        if self.due.is_some_and(|d| Instant::now() >= d) { self.flush(); }
    }
    pub fn flush(&mut self) {
        self.due = None;
        let text = serde_json::to_string_pretty(&self.state).unwrap_or_default();
        if let Err(e) = write_atomic(&self.file, &text, false) { warn(format!("Salvataggio dello stato non riuscito: {e}")); }
    }
}
