//! Stato del server e comandi della regia. Tutto dietro un solo blocco, tenuto per tempi brevissimi
//! e mai attraverso un'attesa.
use crate::{config::Config, deepl::DeepL, engine::{Engine, EngineConfig}, obs::{Obs, ObsConfig}, sentences::Sentences};
use duetto_core::{
    i18n::{self, t, Lang}, js, languages::*, log::{log, warn}, notice::notice_text,
    settings::{assembly_url, mask_key, read_text_file, write_text_file, Cipher, Settings},
    store::*, transcript::Transcript,
};
use serde_json::{json, Map, Value};
use std::{
    net::{IpAddr, Ipv4Addr}, path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering::Relaxed}, Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::mpsc::{error::TrySendError, Sender};

/// Ciò che solo il guscio desktop può fare.
pub trait Shell: Send + Sync + 'static {
    fn open_folder(&self, folder: PathBuf);
    fn mic_command(&self, message: &Map<String, Value>);
    fn mic_state(&self) -> Value;
}

pub struct SseClient { pub tx: Sender<String>, pub local: bool }
pub struct ControlClient { pub id: u64, pub tx: Sender<String> }

pub struct Inner {
    pub settings: Settings,
    pub store: Store,
    pub transcript: Transcript,
    pub lang: Lang,
    pub sse: [Vec<SseClient>; 2],
    pub control: Vec<ControlClient>,
    pub update: Value,
    pub port: u16,
    pub last_links: Vec<String>,
    sentence_seq: u64,
    audio_owner: Option<(u64, Instant)>,
    demo: Option<u64>,
}

pub struct App {
    pub cfg: Config,
    pub engine: Arc<dyn Engine>,
    pub deepl: Arc<DeepL>,
    pub obs: Arc<Obs>,
    pub sentences: Sentences,
    pub shell: Option<Arc<dyn Shell>>,
    inner: Mutex<Inner>,
    ids: AtomicU64,
}

const DEMO: [(&str, &str, &str); 4] = [
    ("it", "Buongiorno a tutti e benvenuti alla prima sessione della giornata.", "Good morning everyone and welcome to the first session of the day."),
    ("en", "Grazie mille per avermi invitato qui oggi.", "Thank you very much for having me here today."),
    ("it", "Vorrei iniziare con una domanda semplice sul futuro del nostro settore.", "I would like to start with a simple question about the future of our industry."),
    ("en", "I numeri mostrano una chiara tendenza negli ultimi cinque anni, e non sta rallentando.", "The numbers show a clear trend over the last five years, and it is not slowing down."),
];

pub fn out_index(out: &Value) -> Option<usize> { OUTPUTS.iter().position(|o| out == o) }

impl Inner {
    pub fn output(&mut self, i: usize) -> &mut Output {
        let o = &mut self.store.state.outputs;
        if i == 0 { &mut o.stream } else { &mut o.room }
    }
    fn output_ref(&self, i: usize) -> &Output {
        let o = &self.store.state.outputs;
        if i == 0 { &o.stream } else { &o.room }
    }

    /// Un overlay bloccato non deve far crescere la memoria: si scollega e si ricollega da solo.
    pub fn broadcast(&mut self, payload: &Value, out: Option<usize>) {
        let text = format!("data: {payload}\n\n");
        for (i, clients) in self.sse.iter_mut().enumerate() {
            if out.is_none_or(|o| o == i) { clients.retain(|c| c.tx.try_send(text.clone()).is_ok()); }
        }
    }
    pub fn ping(&mut self) {
        for clients in &mut self.sse { clients.retain(|c| c.tx.try_send(": ping\n\n".into()).is_ok()); }
    }
    pub fn send_control(&mut self, payload: &Value) {
        let text = payload.to_string();
        // Una regia lenta salta il messaggio, una chiusa si toglie.
        self.control.retain(|c| !matches!(c.tx.try_send(text.clone()), Err(TrySendError::Closed(_))));
    }

    pub fn profile(&self, i: usize) -> Value {
        let o = self.output_ref(i);
        let v = &self.settings.values;
        json!({ "t": "profile", "view": o.view, "hidden": o.hidden, "target": o.target, "style": o.style,
            "notice": notice_text(v.ai_notice, &v.ai_notice_text, &o.target) })
    }
    fn push_profile(&mut self, i: usize) {
        let p = self.profile(i);
        self.broadcast(&p, Some(i));
    }
    pub fn public_state(&self) -> Value {
        let s = &self.store.state;
        json!({ "t": "state", "languageMode": s.language_mode, "languages": s.languages, "captionsTarget": s.captions_target,
            "outputs": s.outputs, "presets": s.presets })
    }
    /// La lingua in cui un'uscita mostra la traduzione di una frase detta in `lang`.
    pub fn output_target(&self, i: usize, lang: &str) -> String {
        effective_target(lang, &self.output_ref(i).target, &self.store.state.languages.targets).into()
    }
    pub fn next_sentence(&mut self) -> u64 { self.sentence_seq += 1; self.sentence_seq }

    /// Senza traduzione, chi vede solo quella legge l'originale.
    pub fn send_translations(&mut self, id: u64, find: impl Fn(&str) -> Option<String>, lang: &str) {
        for i in 0..2 {
            let code = self.output_target(i, lang);
            let message = match find(&code).filter(|x| !x.is_empty()) {
                Some(text) => json!({ "t": "translation", "id": id, "text": text, "lang": code }),
                None => json!({ "t": "translationFailed", "id": id }),
            };
            self.broadcast(&message, Some(i));
        }
    }
    pub fn close_remote_overlays(&mut self) {
        for clients in &mut self.sse { clients.retain(|c| c.local); }
    }
    fn stop_demo(&mut self) {
        if self.demo.take().is_some() {
            log("Demo fermata");
            self.broadcast(&json!({ "t": "clear" }), None);
        }
    }
}

impl App {
    pub fn new(cfg: Config, engine: Arc<dyn Engine>, shell: Option<Arc<dyn Shell>>, cipher: Option<Cipher>) -> Arc<Self> {
        let settings = Settings::load(cfg.data_dir.join("settings.json"), cipher);
        let store = Store::load(cfg.data_dir.join("state.json"), &cfg.default_mode);
        let mut transcript = Transcript::new(cfg.output_dir.clone());
        transcript.enabled = settings.values.save_files;
        let lang = i18n::resolve(&settings.values.ui_language, &cfg.locale);
        let key = Some(settings.values.deepl_api_key.as_str()).filter(|k| !k.is_empty()).unwrap_or(&cfg.deepl_key);
        let deepl = DeepL::new(key, &cfg.deepl_endpoint, &cfg.deepl_model, cfg.deepl_context, lang);
        let app = Arc::new(Self {
            deepl, obs: Obs::new(lang), sentences: Sentences::default(),
            inner: Mutex::new(Inner {
                settings, store, transcript, lang, sse: Default::default(), control: Vec::new(), update: Value::Null, port: cfg.port,
                last_links: Vec::new(), sentence_seq: 0, audio_owner: None, demo: None,
            }),
            cfg, engine, shell, ids: AtomicU64::new(1),
        });
        {
            let g = app.lock();
            app.engine.configure(app.engine_config(&g));
            app.configure_obs(&g);
            app.engine.set_languages(&g.store.state.language_mode, &g.store.state.languages.spoken);
        }
        app
    }

    /// Un errore in un comando non deve fermare tutti gli altri durante l'evento.
    pub fn lock(&self) -> MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn new_id(&self) -> u64 { self.ids.fetch_add(1, Relaxed) }

    // Una chiave salvata nelle Impostazioni ha la precedenza su quella nell'ambiente.
    fn assembly_key<'a>(&'a self, g: &'a Inner) -> &'a str {
        Some(g.settings.values.assemblyai_api_key.as_str()).filter(|k| !k.is_empty()).unwrap_or(&self.cfg.assembly_key)
    }
    fn deepl_key<'a>(&'a self, g: &'a Inner) -> &'a str {
        Some(g.settings.values.deepl_api_key.as_str()).filter(|k| !k.is_empty()).unwrap_or(&self.cfg.deepl_key)
    }
    pub fn has_keys(&self) -> bool { let g = self.lock(); !self.assembly_key(&g).is_empty() && !self.deepl_key(&g).is_empty() }
    pub fn assembly_url(&self, g: &Inner) -> String {
        if self.cfg.assembly_url.is_empty() { assembly_url(&g.settings.values.assemblyai_region).into() } else { self.cfg.assembly_url.clone() }
    }
    fn engine_config(&self, g: &Inner) -> EngineConfig {
        EngineConfig {
            lang: Some(g.lang), assembly_key: self.assembly_key(g).into(), assembly_url: self.assembly_url(g),
        }
    }
    fn configure_obs(&self, g: &Inner) {
        let v = &g.settings.values;
        self.obs.set_lang(g.lang);
        self.obs.configure(ObsConfig { enabled: v.obs_enabled, host: v.obs_host.clone(), port: v.obs_port, password: v.obs_password.clone() });
    }
    pub fn overlay_lan(&self, g: &Inner) -> bool { self.cfg.overlay_allow_lan || g.settings.values.overlay_lan }

    pub fn links(&self, g: &Inner) -> Value {
        let base = format!("http://localhost:{}", g.port);
        let network: Vec<String> = if self.overlay_lan(g) {
            lan_addresses().iter().map(|ip| format!("http://{ip}:{}/overlay?out=room", g.port)).collect()
        } else { Vec::new() };
        json!({ "stream": format!("{base}/overlay?out=stream"), "room": format!("{base}/overlay?out=room"), "network": network })
    }

    pub fn schema(&self, g: &Inner) -> Value {
        let languages: Vec<Value> = LANGUAGES.iter()
            .map(|l| json!({ "code": l.code, "name": t(g.lang, l.name, &[]), "spoken": l.spoken(), "latin": l.latin })).collect();
        json!({ "t": "schema", "styleSchema": style_schema(), "defaults": default_styles(), "languages": languages,
            "limits": { "spoken": MAX_SPOKEN, "targets": MAX_TARGETS }, "links": self.links(g),
            "desktopApp": self.shell.is_some(), "outputDir": self.cfg.output_dir })
    }

    pub fn status(&self, g: &mut Inner) -> Value {
        for clients in &mut g.sse { clients.retain(|c| !c.tx.is_closed()); }
        let mut aai = self.engine.assembly_status();
        let cost = aai["billedSeconds"].as_f64().unwrap_or(0.0) / 3600.0 * self.cfg.price_per_hour;
        aai["estimatedCost"] = js::json_number((cost * 100.0).round() / 100.0);
        aai["configured"] = json!(!self.assembly_key(g).is_empty());
        aai["euOnly"] = json!(self.assembly_url(g).contains(".eu."));
        let dir = g.transcript.dir().map_or(String::new(), |d| d.strip_prefix(&self.cfg.root).unwrap_or(d).display().to_string());
        json!({ "t": "status", "aai": aai, "deepl": self.deepl.status(), "lastLanguage": g.store.state.last_language,
            "demo": g.demo.is_some(), "update": g.update, "obs": self.obs.status(),
            "overlays": { "stream": g.sse[0].len(), "room": g.sse[1].len() }, "outputDir": dir })
    }

    /// Le chiavi complete entrano ma non escono mai.
    fn settings_message(&self, g: &Inner) -> Value {
        let v = &g.settings.values;
        json!({ "t": "settings", "assemblyaiKey": mask_key(self.assembly_key(g)), "deeplKey": mask_key(self.deepl_key(g)),
            "cleanFillers": v.clean_fillers.unwrap_or(self.cfg.clean_fillers), "cleanProfanity": v.clean_profanity.unwrap_or(self.cfg.clean_profanity),
            "assemblyaiRegion": v.assemblyai_region, "uiLanguage": v.ui_language, "checkUpdates": v.check_updates, "saveFiles": v.save_files,
            "overlayLan": self.overlay_lan(g), "aiNotice": v.ai_notice, "aiNoticeText": v.ai_notice_text,
            "obsEnabled": v.obs_enabled, "obsHost": v.obs_host, "obsPort": v.obs_port, "obsPassword": mask_key(&v.obs_password),
            "keysEncrypted": g.settings.keys_encrypted(), "keyterms": read_text_file(&self.cfg.keyterms), "glossary": read_text_file(&self.cfg.glossary) })
    }

    fn keyterms(&self) -> Vec<String> {
        let text = read_text_file(&self.cfg.keyterms);
        let mut terms: Vec<String> = Vec::new();
        for l in text.split('\n').map(js::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            if !terms.iter().any(|x| x == l) { terms.push(l.into()); }
        }
        let all = terms.len();
        terms.retain(|x| js::len(x) <= 50);
        if terms.len() < all { warn(format!("keyterms.txt: {} termini oltre 50 caratteri ignorati", all - terms.len())); }
        if terms.len() > 100 { warn(format!("keyterms.txt: tenuti i primi 100 termini su {}", terms.len())); }
        terms.truncate(100);
        terms
    }

    pub async fn reload_terms(&self) -> String {
        let terms = self.keyterms();
        let n = terms.len().to_string();
        self.engine.set_keyterms(terms);
        let glossary = self.deepl.sync_glossary(&self.cfg.glossary).await;
        let lang = self.lock().lang;
        let message = t(lang, "{n} termini chiave ricaricati. Glossario: {glossary}", &[("n", &n), ("glossary", &glossary)]);
        log(&message);
        message
    }

    /// Le modifiche valgono subito e in ordine; le verifiche, che aspettano la rete, proseguono a parte.
    fn save_settings(self: &Arc<Self>, tx: &Sender<String>, m: &Map<String, Value>) {
        let saved = {
            let mut g = self.lock();
            let (before, checked) = (g.lang, g.settings.values.check_updates);
            let saved = g.settings.update(m);
            g.lang = i18n::resolve(&g.settings.values.ui_language, &self.cfg.locale);
            if g.settings.values.check_updates != checked { self.clone().refresh_update(); }
            // Le pagine aperte si ricaricano nella nuova lingua.
            if g.lang != before {
                let code = if g.lang == Lang::En { "en" } else { "it" };
                g.send_control(&json!({ "t": "language", "lang": code }));
            }
            self.engine.configure(self.engine_config(&g));
            self.configure_obs(&g);
            self.deepl.set_lang(g.lang);
            self.deepl.set_key(self.deepl_key(&g));
            g.transcript.enabled = g.settings.values.save_files;
            for i in 0..2 { g.push_profile(i); }
            if !self.overlay_lan(&g) { g.close_remote_overlays(); }
            let links = json!({ "t": "links", "links": self.links(&g) });
            g.send_control(&links);
            saved
        };
        for (key, file) in [("keyterms", &self.cfg.keyterms), ("glossary", &self.cfg.glossary)] {
            if let Some(text) = m.get(key).and_then(Value::as_str) {
                if let Err(e) = write_text_file(file, text) { warn(format!("Salvataggio di termini e glossario non riuscito: {e}")); }
            }
        }
        let (app, tx) = (self.clone(), tx.clone());
        tokio::spawn(async move {
            let (assemblyai, deepl) = tokio::join!(app.engine.test_assembly(), app.deepl.test());
            let terms = app.reload_terms().await;
            let result = json!({ "t": "settingsResult", "saved": saved, "assemblyai": assemblyai, "deepl": deepl, "terms": terms });
            let view = app.settings_message(&app.lock());
            let _ = tx.send(result.to_string()).await;
            let _ = tx.send(view.to_string()).await;
        });
    }

    /// L'audio passa dallo stesso collegamento: un comando non deve mai farlo aspettare.
    pub fn handle_command(self: &Arc<Self>, tx: &Sender<String>, m: Map<String, Value>) {
        match m.get("cmd").and_then(Value::as_str).unwrap_or_default() {
            "reloadTerms" => {
                let (app, tx) = (self.clone(), tx.clone());
                tokio::spawn(async move {
                    let message = app.reload_terms().await;
                    let _ = tx.send(json!({ "t": "notice", "message": message }).to_string()).await;
                });
            }
            "settingsGet" => {
                let view = self.settings_message(&self.lock());
                let _ = tx.try_send(view.to_string());
            }
            "settingsSave" => self.save_settings(tx, &m),
            "openOutputFolder" => {
                let _ = std::fs::create_dir_all(&self.cfg.output_dir);
                if let Some(s) = &self.shell { s.open_folder(self.cfg.output_dir.clone()); }
            }
            cmd => {
                if let Some(s) = self.shell.as_ref().filter(|_| ["micStart", "micDevice", "pause"].contains(&cmd)) { s.mic_command(&m); }
                let mut g = self.lock();
                if !self.run(&mut g, cmd, &m) { return; }
                g.store.save();
                let state = g.public_state();
                g.send_control(&state);
            }
        }
    }

    // Restituisce false se il comando non esiste.
    fn run(self: &Arc<Self>, g: &mut Inner, cmd: &str, m: &Map<String, Value>) -> bool {
        let null = Value::Null;
        let get = |k: &str| m.get(k).unwrap_or(&null);
        let text = |k: &str| get(k).as_str().unwrap_or_default();
        let out = out_index(get("out"));
        let each: &[usize] = match (cmd, out) { ("viewAll", _) => &[0, 1], (_, Some(0)) => &[0], (_, Some(1)) => &[1], _ => &[] };
        match cmd {
            "language" => self.set_language_mode(g, text("mode")),
            "languages" => self.set_languages(g, get("spoken"), get("targets")),
            "target" => {
                let lang = text("lang");
                if g.store.state.languages.targets.iter().any(|x| x == lang) {
                    for &i in each { g.output(i).target = lang.into(); g.push_profile(i); }
                }
            }
            "captionsTarget" => {
                let lang = text("lang");
                if pick_captions_target(lang, &g.store.state.languages.targets) == lang { g.store.state.captions_target = lang.into(); }
            }
            "view" | "viewAll" => {
                let view = text("view");
                if VIEWS.contains(&view) { for &i in each { g.output(i).view = view.into(); g.push_profile(i); } }
            }
            "hidden" => for &i in each { let o = g.output(i); o.hidden = !o.hidden; g.push_profile(i); },
            "clear" => for &i in each { g.broadcast(&json!({ "t": "clear" }), Some(i)); },
            "style" => for &i in each { g.output(i).style.extend(sanitize_style(get("patch"))); g.push_profile(i); },
            "styleReset" => for &i in each {
                g.output(i).style = default_styles()[OUTPUTS[i]].as_object().cloned().unwrap_or_default();
                g.push_profile(i);
            },
            "presetSave" => {
                let raw = match get("name") { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => String::new() };
                let name = js::cut(js::trim(&raw), 60);
                if !name.is_empty() {
                    for &i in each { let style = g.output(i).style.clone(); g.store.state.presets.insert(name.into(), style.into()); }
                }
            }
            "presetLoad" => if let Some(p) = g.store.state.presets.get(text("name")).and_then(Value::as_object).cloned() {
                for &i in each { g.output(i).style.extend(p.clone()); g.push_profile(i); }
            },
            "presetDelete" => { g.store.state.presets.shift_remove(text("name")); }
            "presetImport" => g.store.state.presets.extend(sanitize_presets(get("presets"))),
            "pause" => {
                self.engine.stop();
                g.audio_owner = None;
                log("Pausa: sessione chiusa, nessun credito consumato");
            }
            "demo" => if truthy(get("on")) { self.start_demo(g) } else { g.stop_demo() },
            "simulateDrop" => {
                let s = js::number(get("seconds")).filter(|n| *n != 0.0).unwrap_or(10.0);
                self.engine.simulate_drop(s.clamp(1.0, 120.0));
            }
            _ => return false,
        }
        true
    }

    fn set_language_mode(&self, g: &mut Inner, value: &str) {
        let mode = normalize_mode(value, &g.store.state.languages.spoken);
        if mode.is_empty() || mode == g.store.state.language_mode { return; }
        self.engine.set_languages(&mode, &g.store.state.languages.spoken);
        let note = format!("Modalità lingua: {mode}");
        g.store.state.language_mode = mode;
        g.transcript.note(&note);
        log(note);
    }

    // Modalità, uscite e sottotitoli restano su lingue ancora scelte.
    fn set_languages(&self, g: &mut Inner, spoken: &Value, targets: &Value) {
        let now = &g.store.state.languages;
        let keep = |v: &Value, old: &Vec<String>| if v.is_null() { json!(old) } else { v.clone() };
        let next = sanitize_languages(&json!({ "spoken": keep(spoken, &now.spoken), "targets": keep(targets, &now.targets) }));
        g.store.state.languages = next.clone();
        let s = &mut g.store.state;
        if s.language_mode != "AUTO" && !next.spoken.contains(&s.language_mode) { s.language_mode = "AUTO".into(); }
        if s.last_language.as_ref().is_some_and(|l| !next.spoken.contains(l)) { s.last_language = None; }
        for i in 0..2 {
            let target = pick_target(&g.output(i).target, &next.targets);
            if target != g.output(i).target { g.output(i).target = target; g.push_profile(i); }
        }
        g.store.state.captions_target = pick_captions_target(&g.store.state.captions_target, &next.targets);
        self.engine.set_languages(&g.store.state.language_mode, &next.spoken);
        let note = format!("Lingue: parlate {}; traduzioni {}", next.spoken.join(", "), next.targets.join(", "));
        g.transcript.note(&note);
        log(note);
    }

    /// PCM 16 bit: AssemblyAI accetta blocchi tra 50 e 1000 ms. Una sola sorgente alla volta.
    pub fn handle_audio(&self, source: u64, data: &[u8]) {
        if data.len() % 2 != 0 || !(1600..=32000).contains(&data.len()) { return; }
        let mut g = self.lock();
        if g.audio_owner.is_some_and(|(id, at)| id != source && at.elapsed() < Duration::from_secs(1)) { return; }
        g.audio_owner = Some((source, Instant::now()));
        g.stop_demo();
        drop(g);
        self.engine.push_audio(data);
    }
    pub fn forget_audio(&self, source: u64) {
        let mut g = self.lock();
        if g.audio_owner.is_some_and(|(id, _)| id == source) { g.audio_owner = None; }
    }

    // Testo finto: nessun credito consumato, nessun file scritto.
    fn start_demo(self: &Arc<Self>, g: &mut Inner) {
        if g.demo.is_some() || self.engine.active() { return; }
        log("Demo attiva");
        let run = self.new_id();
        g.demo = Some(run);
        let app = self.clone();
        tokio::spawn(async move {
            let wait = |ms| tokio::time::sleep(Duration::from_millis(ms));
            for (lang, it, en) in DEMO.iter().cycle() {
                let text = if *lang == "it" { it } else { en };
                let words: Vec<&str> = text.split(' ').collect();
                let mut id = 0;
                for n in 1..=words.len() {
                    {
                        let mut g = app.lock();
                        if g.demo != Some(run) { return; }
                        if n < words.len() {
                            g.broadcast(&json!({ "t": "partial", "text": words[..n].join(" ") }), None);
                        } else {
                            id = g.next_sentence();
                            g.broadcast(&json!({ "t": "final", "id": id, "text": text, "lang": lang }), None);
                        }
                    }
                    if n < words.len() { wait(220).await; }
                }
                wait(350).await;
                {
                    let mut g = app.lock();
                    if g.demo != Some(run) { return; }
                    g.send_translations(id, |c| match c { "it" => Some(it.to_string()), "en" => Some(en.to_string()), _ => None }, lang);
                }
                wait(1800).await;
            }
        });
    }

    /// Avviso di versione nuova: solo nell'app desktop e se non disattivato. Mai errori.
    pub fn refresh_update(self: Arc<Self>) {
        tokio::spawn(async move {
            let wanted = !self.cfg.update_api.is_empty() || (self.cfg.desktop_app && !self.cfg.test);
            let found = if wanted && self.lock().settings.values.check_updates {
                crate::update::check(&self.cfg.version, Some(self.cfg.update_api.as_str()).filter(|a| !a.is_empty())).await
            } else { None };
            let mut g = self.lock();
            // Il permesso può essere cambiato durante la richiesta.
            g.update = found.filter(|_| g.settings.values.check_updates).unwrap_or(Value::Null);
        });
    }

    pub fn flush(&self) { self.lock().store.flush(); }
}

fn truthy(v: &Value) -> bool {
    match v { Value::Null => false, Value::Bool(b) => *b, Value::Number(n) => n.as_f64() != Some(0.0), Value::String(s) => !s.is_empty(), _ => true }
}

pub fn lan_addresses() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs().unwrap_or_default().iter()
        .filter_map(|i| match i.ip() { IpAddr::V4(ip) if !ip.is_loopback() => Some(ip), _ => None }).collect()
}
