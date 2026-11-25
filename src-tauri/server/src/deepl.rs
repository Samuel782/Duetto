//! Traduzione con DeepL: timeout di 3 s, un solo nuovo tentativo, poi si prosegue senza traduzione.
use duetto_core::{glossary::parse_csv, i18n::{t, Lang}, languages::{code_from_detected, language}, log::{log, warn}};
use futures_util::future::join_all;
use reqwest::{header::{HeaderMap, HeaderValue, AUTHORIZATION}, Client, Response};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::{Arc, Mutex, MutexGuard}, time::{Duration, Instant}};

const TIMEOUT: Duration = Duration::from_millis(3000);
const MAX_IN_FLIGHT: usize = 6; // se DeepL è bloccato non si accumula nulla
const USAGE_EVERY: Duration = Duration::from_secs(60);
const GLOSSARY_NAME: &str = "duetto";

// Le chiavi dei piani gratuiti finiscono con ":fx" e usano un indirizzo diverso.
fn endpoint_for(key: &str) -> &'static str {
    if key.ends_with(":fx") { "https://api-free.deepl.com" } else { "https://api.deepl.com" }
}

/// Numero con i separatori della lingua: 1.234.567 oppure 1,234,567.
fn grouped(n: f64, lang: Lang) -> String {
    let digits = format!("{:.0}", n.max(0.0));
    let separator = if lang == Lang::En { ',' } else { '.' };
    let mut out = String::new();
    // In italiano si separa solo da cinque cifre in su: 1000, ma 10.000.
    if lang == Lang::It && digits.len() < 5 { return digits; }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 { out.push(separator); }
        out.push(c);
    }
    out
}

struct State {
    lang: Lang,
    key: String,
    base: String,
    model_type: Option<String>,
    glossary_id: Option<String>,
    glossary_note: String,
    in_flight: usize,
    quota_exhausted: bool,
    last_error: String,
    avg_ms: f64,
    used: Option<f64>,
    limit: Option<f64>,
}

pub struct DeepL { http: Client, endpoint: String, use_context: bool, state: Mutex<State> }

/// Le traduzioni di una frase e la lingua in cui è stata davvero detta.
#[derive(Debug, PartialEq)]
pub struct Translated { pub lang: String, pub translations: Vec<(String, String)> }

pub struct Request<'a> {
    pub lang: &'a str,
    pub context: &'a str,
    /// La lingua è un'ipotesi: la conferma DeepL alla prima richiesta.
    pub detect: bool,
    /// Lingue rilevabili: una frase in una terza lingua resta in quella ipotizzata.
    pub accept: &'a [String],
}

struct Answer { text: String, detected: String }
struct Failure { error: String, retry: bool }

// Alla fine della traduzione, anche interrotta, il posto in coda si libera.
struct Slot<'a>(&'a DeepL);
impl Drop for Slot<'_> { fn drop(&mut self) { self.0.lock().in_flight -= 1; } }

impl DeepL {
    /// `endpoint` vuoto: scelto in base alla chiave.
    pub fn new(key: &str, endpoint: &str, model_type: &str, use_context: bool, lang: Lang) -> Arc<Self> {
        let endpoint = endpoint.trim_end_matches('/').to_string();
        Arc::new(Self {
            // L'autorizzazione non deve finire a un altro indirizzo: i rinvii non si seguono.
            http: Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap_or_default(),
            use_context,
            state: Mutex::new(State {
                lang, key: key.into(), base: if endpoint.is_empty() { endpoint_for(key).into() } else { endpoint.clone() },
                model_type: Some(model_type.to_string()).filter(|m| !m.is_empty()), glossary_id: None,
                glossary_note: t(lang, "nessun glossario", &[]), in_flight: 0, quota_exhausted: false, last_error: String::new(),
                avg_ms: 0.0, used: None, limit: None,
            }),
            endpoint,
        })
    }

    /// Aggiorna ogni minuto i caratteri mostrati in regia.
    pub fn watch_usage(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(d) = me.upgrade() else { return };
                d.refresh_usage().await;
                drop(d);
                tokio::time::sleep(USAGE_EVERY).await;
            }
        });
    }

    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|e| e.into_inner()) }
    fn t(&self, text: &str, vars: &[(&str, &str)]) -> String { let l = self.lock().lang; t(l, text, vars) }

    pub fn set_lang(&self, lang: Lang) { self.lock().lang = lang; }

    pub fn set_key(self: &Arc<Self>, key: &str) {
        {
            let mut s = self.lock();
            if s.key == key { return; }
            s.key = key.into();
            if self.endpoint.is_empty() { s.base = endpoint_for(key).into(); }
            s.quota_exhausted = false;
            s.last_error.clear();
            (s.used, s.limit) = (None, None);
        }
        let me = self.clone();
        tokio::spawn(async move { me.refresh_usage().await });
    }

    fn headers(&self) -> Option<HeaderMap> {
        let mut value = HeaderValue::from_str(&format!("DeepL-Auth-Key {}", self.lock().key)).ok()?;
        value.set_sensitive(true);
        Some(HeaderMap::from_iter([(AUTHORIZATION, value)]))
    }

    async fn send(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Response, String> {
        let url = format!("{}{path}", self.lock().base);
        let method = method.parse().map_err(|_| "metodo".to_string())?;
        let mut req = self.http.request(method, url).timeout(timeout).headers(self.headers().ok_or("chiave non valida")?);
        if let Some(b) = body { req = req.json(b); }
        req.send().await.map_err(describe)
    }

    /// Controlla la chiave e aggiorna i caratteri.
    pub async fn test(&self) -> Value {
        let no = |message: String| json!({ "ok": false, "message": message });
        if self.lock().key.is_empty() { return no(self.t("Chiave mancante", &[])); }
        let silent = |e: String| no(self.t("Nessuna risposta: {error}", &[("error", &e)]));
        let res = match self.send("GET", "/v2/usage", None, Duration::from_secs(6)).await { Ok(r) => r, Err(e) => return silent(e) };
        if res.status() == 403 { return no(self.t("Chiave rifiutata da DeepL", &[])); }
        if !res.status().is_success() { return no(self.t("Errore HTTP {status}", &[("status", res.status().as_str())])); }
        let data: Value = match res.json().await { Ok(d) => d, Err(e) => return silent(describe(e)) };
        let mut s = self.lock();
        (s.used, s.limit) = (data["character_count"].as_f64(), data["character_limit"].as_f64());
        let n = grouped(s.limit.unwrap_or(0.0) - s.used.unwrap_or(0.0), s.lang);
        json!({ "ok": true, "message": t(s.lang, "Chiave valida, {n} caratteri disponibili", &[("n", &n)]) })
    }

    pub async fn refresh_usage(&self) {
        if self.lock().key.is_empty() { return; }
        // Un errore di rete si ritenta al prossimo giro.
        let Ok(res) = self.send("GET", "/v2/usage", None, Duration::from_secs(5)).await else { return };
        if res.status() == 403 {
            let error = self.t("Chiave DeepL rifiutata: controlla chiave ed endpoint", &[]);
            self.lock().last_error = error;
        }
        if !res.status().is_success() { return; }
        let Ok(data) = res.json::<Value>().await else { return };
        let mut s = self.lock();
        (s.used, s.limit) = (data["character_count"].as_f64(), data["character_limit"].as_f64());
        // La quota può tornare con il nuovo periodo o un cambio di piano.
        if s.limit.is_some_and(|l| l > 0.0 && s.used.unwrap_or(0.0) < l) { s.quota_exhausted = false; }
    }

    /// Traduce nelle lingue che `targets` indica per la lingua di partenza. None se nessuna traduzione riesce.
    pub async fn translate(&self, text: &str, r: Request<'_>, targets: impl Fn(&str) -> Vec<String>) -> Option<Translated> {
        {
            let s = self.lock();
            if s.key.is_empty() || s.quota_exhausted { return None; }
        }
        if !r.detect && targets(r.lang).is_empty() { return Some(Translated { lang: r.lang.into(), translations: Vec::new() }); }
        {
            let mut s = self.lock();
            if s.in_flight >= MAX_IN_FLIGHT {
                s.last_error = t(s.lang, "Troppe traduzioni in coda", &[]);
                return None;
            }
            s.in_flight += 1;
        }
        let _slot = Slot(self);
        let started = Instant::now();
        let mut source = r.lang.to_string();
        let mut done: Vec<(String, String)> = Vec::new();
        if let Some(first) = targets(&source).into_iter().next().filter(|_| r.detect) {
            let Some(answer) = self.with_retry(text, &source, &first, r.context, true).await else { return self.give_up() };
            let found = code_from_detected(&answer.detected);
            if !found.is_empty() && found != source && r.accept.contains(&found) { source = found.clone(); }
            // Vale se la lingua rilevata è quella usata per sceglierne la destinazione.
            if found == source && targets(&source).contains(&first) { done.push((first, answer.text)); }
        }
        let rest: Vec<String> = targets(&source).into_iter().filter(|c| !done.iter().any(|(d, _)| d == c)).collect();
        let context = if source == r.lang { r.context } else { "" };
        let answers = join_all(rest.iter().map(|code| self.with_retry(text, &source, code, context, false))).await;
        for (code, answer) in rest.iter().zip(answers) {
            if let Some(a) = answer { done.push((code.clone(), a.text)); }
        }
        if !rest.is_empty() && done.is_empty() { return self.give_up(); }
        let ms = started.elapsed().as_millis() as f64;
        let mut s = self.lock();
        s.avg_ms = if s.avg_ms > 0.0 { (s.avg_ms * 0.9 + ms * 0.1).round() } else { ms };
        s.last_error.clear();
        Some(Translated { lang: source, translations: done })
    }

    fn give_up(&self) -> Option<Translated> {
        let error = self.lock().last_error.clone();
        warn(format!("DeepL: {error}"));
        None
    }

    async fn with_retry(&self, text: &str, source: &str, target: &str, context: &str, detect: bool) -> Option<Answer> {
        for _ in 0..2 {
            match self.request(text, source, target, context, detect).await {
                Ok(a) => return Some(a),
                Err(f) => {
                    self.lock().last_error = f.error;
                    if !f.retry { break; }
                }
            }
        }
        None
    }

    async fn request(&self, text: &str, source: &str, target: &str, context: &str, detect: bool) -> Result<Answer, Failure> {
        let mut body = Map::new();
        body.insert("text".into(), json!([text]));
        body.insert("target_lang".into(), language(target).map_or(target, |l| l.target).into());
        if !detect { body.insert("source_lang".into(), language(source).map_or(source, |l| l.source).into()); }
        if !context.is_empty() && self.use_context { body.insert("context".into(), context.into()); }
        {
            let s = self.lock();
            if let Some(m) = &s.model_type { body.insert("model_type".into(), m.as_str().into()); }
            // Il glossario ha solo italiano e inglese: con le altre coppie DeepL rifiuterebbe.
            if let Some(id) = s.glossary_id.as_ref().filter(|_| !detect && [("it", "en"), ("en", "it")].contains(&(source, target))) {
                body.insert("glossary_id".into(), id.as_str().into());
            }
        }
        // Il tempo massimo vale per tutta la risposta, corpo compreso.
        let network = |e: String| Failure {
            error: if e == TIMED_OUT { self.t("Timeout oltre 3 s", &[]) } else { self.t("Rete: {error}", &[("error", &e)]) }, retry: true,
        };
        let res = self.send("POST", "/v2/translate", Some(&Value::Object(body)), TIMEOUT).await.map_err(network)?;
        let status = res.status();
        if status.is_success() {
            let data: Value = res.json().await.map_err(|e| network(describe(e)))?;
            let first = &data["translations"][0];
            let get = |k: &str| first[k].as_str().unwrap_or_default().to_string();
            return Ok(Answer { text: get("text"), detected: get("detected_source_language") });
        }
        let mut s = self.lock();
        if status == 456 {
            s.quota_exhausted = true;
            return Err(Failure { error: t(s.lang, "Quota DeepL esaurita", &[]), retry: false });
        }
        if status == 400 && (s.model_type.is_some() || s.glossary_id.is_some()) {
            // Un'opzione non è accettata dal piano: si riprova senza, per non fermare le traduzioni.
            warn("DeepL: richiesta rifiutata, disattivo model_type e glossario");
            s.model_type = None;
            if s.glossary_id.take().is_some() { s.glossary_note = t(s.lang, "glossario rifiutato da DeepL, ignorato", &[]); }
            return Err(Failure { error: t(s.lang, "Richiesta rifiutata (400)", &[]), retry: true });
        }
        Err(Failure { error: t(s.lang, "Errore HTTP {status}", &[("status", status.as_str())]), retry: status == 429 || status.is_server_error() })
    }

    /// Crea il glossario nelle due direzioni, sostituendo quello dell'avvio precedente.
    pub async fn sync_glossary(&self, file: &Path) -> String {
        self.lock().glossary_id = None;
        let note = if self.lock().key.is_empty() {
            self.t("chiave DeepL mancante", &[])
        } else {
            match self.create_glossary(file).await {
                Ok(note) => note,
                Err(note) => { warn(format!("DeepL: {note}")); note }
            }
        };
        self.lock().glossary_note = note.clone();
        note
    }

    async fn create_glossary(&self, file: &Path) -> Result<String, String> {
        let five = Duration::from_secs(5);
        let failed = |e: String| self.t("glossario non caricato: {error}", &[("error", &e)]);
        let pairs = std::fs::read_to_string(file).map(|c| parse_csv(&c)).unwrap_or_default();
        let list = self.send("GET", "/v3/glossaries", None, five).await.map_err(failed)?;
        if !list.status().is_success() {
            return Err(self.t("glossari non disponibili con questo piano (HTTP {status}): file ignorato", &[("status", list.status().as_str())]));
        }
        let data: Value = list.json().await.map_err(|e| failed(describe(e)))?;
        for old in data["glossaries"].as_array().into_iter().flatten().filter(|g| g["name"] == GLOSSARY_NAME) {
            let Some(id) = old["glossary_id"].as_str() else { continue };
            self.send("DELETE", &format!("/v3/glossaries/{id}"), None, five).await.map_err(failed)?;
        }
        if pairs.is_empty() { return Ok(self.t("nessun termine nel glossario", &[])); }
        let tsv = |swap: bool| pairs.iter().map(|(it, en)| if swap { format!("{en}\t{it}") } else { format!("{it}\t{en}") }).collect::<Vec<_>>().join("\n");
        let direction = |from: &str, to: &str, swap| json!({ "source_lang": from, "target_lang": to, "entries": tsv(swap), "entries_format": "tsv" });
        let body = json!({ "name": GLOSSARY_NAME, "dictionaries": [direction("it", "en", false), direction("en", "it", true)] });
        let res = self.send("POST", "/v3/glossaries", Some(&body), Duration::from_secs(8)).await.map_err(failed)?;
        if !res.status().is_success() {
            return Err(self.t("creazione del glossario rifiutata (HTTP {status}): file ignorato", &[("status", res.status().as_str())]));
        }
        let made: Value = res.json().await.map_err(|e| failed(describe(e)))?;
        self.lock().glossary_id = made["glossary_id"].as_str().map(String::from);
        let n = pairs.len().to_string();
        log(format!("DeepL: glossario con {n} termini"));
        Ok(self.t("{n} termini attivi", &[("n", &n)]))
    }

    pub fn status(&self) -> Value {
        let s = self.lock();
        let number = |n: Option<f64>| n.map_or(Value::Null, duetto_core::js::json_number);
        let remaining = s.limit.zip(s.used).map(|(l, u)| (l - u).max(0.0));
        let low = remaining.zip(s.limit).is_some_and(|(r, l)| l > 0.0 && r / l < 0.1);
        json!({ "configured": !s.key.is_empty(), "avgMs": duetto_core::js::json_number(s.avg_ms), "used": number(s.used), "limit": number(s.limit),
            "remaining": number(remaining), "low": low, "quotaExhausted": s.quota_exhausted, "lastError": s.last_error, "glossary": s.glossary_note })
    }
}

const TIMED_OUT: &str = "timeout";

// Senza l'indirizzo: il messaggio si vede in regia.
fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() { return TIMED_OUT.into(); }
    e.without_url().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeri() {
        assert_eq!(grouped(0.0, Lang::It), "0");
        assert_eq!(grouped(-5.0, Lang::It), "0");
        assert_eq!(grouped(1234567.0, Lang::It), "1.234.567");
        assert_eq!((grouped(1000.0, Lang::It), grouped(1000.0, Lang::En)), ("1000".into(), "1,000".into()));
        assert_eq!(grouped(499000.0, Lang::En), "499,000");
    }
}
