//! Impostazioni dell'utente, chiavi API comprese. Il file è lo stesso della versione 1.
use crate::{files::write_atomic, i18n::UI_LANGUAGES, js, log::warn, notice::MAX_NOTICE};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{fs, io, path::{Path, PathBuf}};

const SECRETS: [&str; 3] = ["assemblyaiApiKey", "deeplApiKey", "obsPassword"];
const ENCRYPTED: &str = "enc:v1:";

pub fn assembly_url(region: &str) -> &'static str {
    if region == "eu" { "wss://streaming.eu.assemblyai.com/v3/ws" } else { "wss://streaming.assemblyai.com/v3/ws" }
}

/// Cifra le chiavi con AES-256-GCM: IV, etichetta, testo. Lo stesso formato del guscio Tauri con Node.
/// Le chiavi salvate da Electron usano un altro formato e vanno reinserite.
pub struct Cipher(Aes256Gcm);

impl Cipher {
    pub fn new(key: &[u8; 32]) -> Self { Self(Aes256Gcm::new(key.into())) }

    pub fn encrypt(&self, text: &str) -> Option<String> {
        let mut iv = [0u8; 12];
        getrandom::fill(&mut iv).ok()?;
        let sealed = self.0.encrypt(Nonce::from_slice(&iv), text.as_bytes()).ok()?;
        let (body, tag) = sealed.split_at(sealed.len() - 16);
        Some(STANDARD.encode([&iv[..], tag, body].concat()))
    }
    pub fn decrypt(&self, data: &str) -> Option<String> {
        let raw = STANDARD.decode(data).ok()?;
        if raw.len() < 28 { return None; }
        let plain = self.0.decrypt(Nonce::from_slice(&raw[..12]), [&raw[28..], &raw[12..28]].concat().as_slice()).ok()?;
        String::from_utf8(plain).ok()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    pub assemblyai_api_key: String,
    pub deepl_api_key: String,
    pub assemblyai_region: String,
    pub ui_language: String,
    pub check_updates: bool,
    pub save_files: bool,
    pub overlay_lan: bool,
    pub ai_notice: bool,
    pub ai_notice_text: String,
    /// None: vale quanto indicato all'avvio.
    pub clean_fillers: Option<bool>,
    pub clean_profanity: Option<bool>,
    pub obs_enabled: bool,
    pub obs_host: String,
    pub obs_port: u16,
    pub obs_password: String,
}

impl Default for Values {
    fn default() -> Self {
        Self {
            assemblyai_api_key: String::new(), deepl_api_key: String::new(), assemblyai_region: "auto".into(),
            ui_language: "auto".into(), check_updates: true, save_files: true, overlay_lan: false, ai_notice: false,
            ai_notice_text: String::new(), clean_fillers: None, clean_profanity: None, obs_enabled: false,
            obs_host: "127.0.0.1".into(), obs_port: 4455, obs_password: String::new(),
        }
    }
}

fn valid_host(h: &str) -> bool {
    (1..=253).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

impl Values {
    fn secret(&mut self, key: &str) -> &mut String {
        match key {
            "assemblyaiApiKey" => &mut self.assemblyai_api_key,
            "deeplApiKey" => &mut self.deepl_api_key,
            _ => &mut self.obs_password,
        }
    }

    // Ogni valore non valido lascia quello di prima: vale per il file e per la pagina.
    fn apply(&mut self, change: &Map<String, Value>) {
        let flag = |key: &str, to: &mut bool| if let Some(b) = change.get(key).and_then(Value::as_bool) { *to = b };
        flag("checkUpdates", &mut self.check_updates);
        flag("saveFiles", &mut self.save_files);
        flag("overlayLan", &mut self.overlay_lan);
        flag("aiNotice", &mut self.ai_notice);
        flag("obsEnabled", &mut self.obs_enabled);
        let maybe = |key: &str, to: &mut Option<bool>| if let Some(b) = change.get(key).and_then(Value::as_bool) { *to = Some(b) };
        maybe("cleanFillers", &mut self.clean_fillers);
        maybe("cleanProfanity", &mut self.clean_profanity);
        let text = |key: &str| change.get(key).and_then(Value::as_str);
        if let Some(t) = text("aiNoticeText") { self.ai_notice_text = js::cut(js::trim(t), MAX_NOTICE).into(); }
        if let Some(r) = text("assemblyaiRegion").filter(|r| ["auto", "eu"].contains(r)) { self.assemblyai_region = r.into(); }
        if let Some(l) = text("uiLanguage").filter(|l| UI_LANGUAGES.contains(l)) { self.ui_language = l.into(); }
        if let Some(h) = text("obsHost").map(js::trim).filter(|h| valid_host(h)) { self.obs_host = h.into(); }
        let port = change.get("obsPort").and_then(js::number).filter(|p| p.fract() == 0.0 && *p > 0.0 && *p < 65536.0);
        if let Some(p) = port { self.obs_port = p as u16; }
    }
}

pub struct Settings { file: PathBuf, cipher: Option<Cipher>, pub values: Values }

impl Settings {
    pub fn load(file: impl Into<PathBuf>, cipher: Option<Cipher>) -> Self {
        let mut s = Self { file: file.into(), cipher, values: Values::default() };
        let saved = match fs::read_to_string(&s.file) {
            Ok(text) => serde_json::from_str::<Map<String, Value>>(&text).unwrap_or_else(|e| {
                warn(format!("Impostazioni non leggibili: {e}"));
                Map::new()
            }),
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound { warn(format!("Impostazioni non leggibili: {e}")); }
                Map::new()
            }
        };
        s.values.apply(&saved);
        let mut plain = false;
        for key in SECRETS {
            let Some(stored) = saved.get(key).and_then(Value::as_str) else { continue };
            plain |= !stored.is_empty() && !stored.starts_with(ENCRYPTED);
            *s.values.secret(key) = s.read_key(key, stored);
        }
        // Chiavi in chiaro da una versione precedente: le cifra subito.
        if plain && s.cipher.is_some() { s.save(); }
        s
    }

    fn read_key(&self, key: &str, stored: &str) -> String {
        let Some(data) = stored.strip_prefix(ENCRYPTED) else { return stored.into() };
        let Some(cipher) = &self.cipher else {
            warn(format!("Chiave {key} cifrata ma la cifratura non è disponibile: va reinserita"));
            return String::new();
        };
        cipher.decrypt(data).unwrap_or_else(|| {
            warn(format!("Chiave {key} non decifrabile: va reinserita"));
            String::new()
        })
    }

    pub fn keys_encrypted(&self) -> bool { self.cipher.is_some() }

    /// Una chiave vuota lascia quella già salvata.
    pub fn update(&mut self, change: &Map<String, Value>) -> bool {
        for key in SECRETS {
            if let Some(t) = change.get(key).and_then(Value::as_str).map(js::trim).filter(|t| !t.is_empty()) {
                *self.values.secret(key) = t.into();
            }
        }
        self.values.apply(change);
        self.save()
    }

    pub fn save(&self) -> bool {
        let mut out = self.values.clone();
        if let Some(cipher) = &self.cipher {
            for key in SECRETS {
                let value = out.secret(key);
                if value.is_empty() { continue; }
                // Mai ripiegare sul testo in chiaro quando la cifratura è attiva.
                let Some(data) = cipher.encrypt(value) else {
                    warn("Salvataggio delle impostazioni non riuscito: cifratura");
                    return false;
                };
                *value = format!("{ENCRYPTED}{data}");
            }
        }
        let text = serde_json::to_string_pretty(&out).unwrap_or_default();
        write_atomic(&self.file, &text, true).map_err(|e| warn(format!("Salvataggio delle impostazioni non riuscito: {e}"))).is_ok()
    }
}

/// Le ultime 4 cifre bastano per riconoscere una chiave senza mostrarla.
pub fn mask_key(key: &str) -> String {
    if key.is_empty() { return String::new(); }
    let start = key.char_indices().rev().nth(3).map_or(0, |(i, _)| i);
    format!("••••••••{}", &key[start..])
}

pub fn read_text_file(file: &Path) -> String { fs::read_to_string(file).unwrap_or_default() }
pub fn write_text_file(file: &Path, content: &str) -> io::Result<()> {
    if let Some(dir) = file.parent() { fs::create_dir_all(dir)?; }
    fs::write(file, content)
}
