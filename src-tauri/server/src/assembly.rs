//! Collegamento ad AssemblyAI Streaming v3: sessione attiva, riconnessione e cambio di sessione prima
//! del limite di 3 ore, senza perdere né duplicare il parlato.
//!
//! Tutto lo stato è dietro un solo blocco; ogni sessione ha un compito che legge e uno che scrive.
use crate::{engine::{Engine, EngineConfig, Pending}, sentences::Final};
use axum::body::Bytes;
use duetto_core::{i18n::{t, Lang}, js, log::{log, warn}, segmenter::{Block, TurnSegmenter, Word}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{atomic::{AtomicUsize, Ordering::Relaxed}, Arc, Mutex, MutexGuard, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpStream, runtime::Handle, sync::{mpsc, oneshot}, time::{interval, sleep, timeout}};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, error::ProtocolError, http::HeaderValue, protocol::WebSocketConfig, Error, Message},
    MaybeTlsStream, WebSocketStream,
};

const BYTES_PER_MS: usize = 32; // PCM 16 bit, mono, 16 kHz
const AUDIO_BUFFER_BYTES: usize = 3000 * BYTES_PER_MS; // massimo 3 secondi
const MAX_SOCKET_BACKLOG: usize = 5000 * BYTES_PER_MS; // oltre, la connessione è bloccata
const DEAD_AFTER: Duration = Duration::from_millis(7000); // nessun messaggio né pong
const STALE_REPLAY: Duration = Duration::from_millis(3000); // da questa età l'audio recente non è stato elaborato
const AUDIO_IDLE: Duration = Duration::from_millis(15000); // la sessione è fatturata a connessione aperta
const HANDOFF_MIN: Duration = Duration::from_millis(1500); // audio minimo dato alla nuova sessione
const HANDOFF_FORCE: Duration = Duration::from_millis(15000); // poi chiude il turno con ForceEndpoint
const HANDOFF_MAX: Duration = Duration::from_millis(20000); // e infine passa comunque
const ROLLOVER_RETRY: Duration = Duration::from_millis(15000);
const HANDSHAKE: Duration = Duration::from_millis(5000);
const DRAIN: Duration = Duration::from_millis(3000); // attesa dell'ultimo testo finale
const DEFAULT_SESSION: Duration = Duration::from_secs(3 * 3600);
const MAX_URL: usize = 6000;

pub struct LinkConfig {
    pub api_key: String,
    pub url: String,
    pub model: String,
    pub min_turn_silence: String,
    pub max_turn_silence: String,
    pub rollover_before: Duration,
    /// Zero: vale la scadenza indicata da AssemblyAI.
    pub session_max: Duration,
}

impl From<&crate::config::Config> for LinkConfig {
    // Chiave e indirizzo li imposta App, dalle Impostazioni o dall'ambiente.
    fn from(c: &crate::config::Config) -> Self {
        Self {
            api_key: String::new(), url: String::new(), model: c.assembly_model.clone(),
            min_turn_silence: c.min_turn_silence.clone(), max_turn_silence: c.max_turn_silence.clone(),
            rollover_before: Duration::from_secs_f64(c.rollover_before.clamp(1.0, 1e6)),
            session_max: Duration::from_secs_f64(c.session_max.clamp(0.0, 1e6)),
        }
    }
}

pub enum Event { Partial(String, bool), Final(Final) }

struct Turn { order: i64, mode: String, text: String, last_end: f64, segmenter: TurnSegmenter, emitted: usize }

struct Session {
    out: mpsc::UnboundedSender<Message>,
    queued: Arc<AtomicUsize>,
    kill: Option<oneshot::Sender<()>>,
    open: bool,
    draining: bool,
    id: String,
    ready: bool,
    emit: bool,
    audio_ms: f64,
    turn: Option<Turn>,
    speech_mode: Option<String>,
    last_final_end: f64,
    last_final_order: i64,
    cut_ms: f64,
    offset_ms: f64,
    feed_start: Option<Instant>,
    forced: bool,
    opened_at: Option<Instant>,
    last_msg: Instant,
    rollover_at: Option<Instant>,
    fatal: bool,
    /// I termini già mandati nell'indirizzo.
    keyterms: Vec<String>,
    error: String,
}

impl Session {
    fn send(&self, message: &Value) {
        if self.open { let _ = self.out.send(Message::text(message.to_string())); }
    }
    fn send_audio(&mut self, frame: &Bytes) {
        if !self.open { return; }
        self.audio_ms += frame.len() as f64 / BYTES_PER_MS as f64;
        self.queued.fetch_add(frame.len(), Relaxed);
        let _ = self.out.send(Message::Binary(frame.clone()));
    }
    fn kill(&mut self) {
        if let Some(k) = self.kill.take() { let _ = k.send(()); }
    }
    fn feeding(&self) -> bool { self.feed_start.is_some() }
}

struct State {
    cfg: LinkConfig,
    lang: Lang,
    mode: String,
    spoken: Vec<String>,
    keyterms: Vec<String>,
    active: bool,
    shut_down: bool,
    sessions: HashMap<u64, Session>,
    ids: u64,
    primary: Option<u64>,
    next: Option<u64>, // in preparazione per il cambio
    recent: VecDeque<Bytes>, // ultimi 3 s, per recuperare l'audio inviato a una connessione morta
    recent_bytes: usize,
    backlog: VecDeque<Bytes>, // in attesa di una sessione pronta
    backlog_bytes: usize,
    catch_up: bool, // recupera il buffer a velocità 2x
    attempts: u32,
    retry_at: Option<Instant>,
    reconnect: Option<u64>, // il tentativo programmato: un numero vecchio non vale più
    blocked_until: Instant,
    last_audio: Instant,
    last_error: String,
    closed_billed: Duration,
    fatal: bool,
    events: mpsc::UnboundedSender<Event>,
}

pub struct AssemblyLink { state: Mutex<State>, rt: Handle, me: Weak<AssemblyLink> }

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(url: &str, key: &str) -> Result<Ws, Error> {
    let mut request = url.into_client_request()?;
    let mut value = HeaderValue::from_str(key)?;
    value.set_sensitive(true);
    request.headers_mut().insert("Authorization", value);
    let limits = WebSocketConfig::default().max_message_size(Some(8 << 20)).max_frame_size(Some(8 << 20));
    connect_async_with_config(request, Some(limits), true).await.map(|(ws, _)| ws)
}

fn describe(e: &Error) -> String {
    match e {
        Error::Http(r) => format!("Unexpected server response: {}", r.status().as_u16()),
        e => e.to_string(),
    }
}
// Una caduta senza chiusura è il codice 1006, non un errore con un testo suo.
fn is_plain_drop(e: &Error) -> bool {
    matches!(e, Error::ConnectionClosed | Error::AlreadyClosed | Error::Protocol(ProtocolError::ResetWithoutClosingHandshake))
}
fn too_many(text: &str) -> bool { text.to_lowercase().contains("too many") }

fn query(pairs: &[(&str, &str)]) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs { q.append_pair(k, v); }
    q.finish().replace('+', "%20")
}

fn words_of(m: &Value) -> Vec<Word> {
    m["words"].as_array().into_iter().flatten().map(|w| Word {
        text: w["text"].as_str().unwrap_or_default().into(), start: w["start"].as_f64().unwrap_or(0.0), end: w["end"].as_f64().unwrap_or(0.0),
    }).collect()
}

impl AssemblyLink {
    /// Va creato dentro il runtime. Gli eventi escono nell'ordine in cui sono avvenuti.
    pub fn new(cfg: LinkConfig) -> (Arc<Self>, mpsc::UnboundedReceiver<Event>) {
        // Serve un solo motore TLS, scelto esplicitamente; se c'è già va bene quello.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (events, rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        let link = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            rt: Handle::current(),
            state: Mutex::new(State {
                cfg, lang: Lang::It, mode: "AUTO".into(), spoken: vec!["it".into(), "en".into()], keyterms: Vec::new(), active: false,
                shut_down: false, sessions: HashMap::new(), ids: 0, primary: None, next: None, recent: VecDeque::new(), recent_bytes: 0,
                backlog: VecDeque::new(), backlog_bytes: 0, catch_up: true, attempts: 0, retry_at: None, reconnect: None,
                blocked_until: now, last_audio: now, last_error: String::new(), closed_billed: Duration::ZERO, fatal: false, events,
            }),
        });
        let me = Arc::downgrade(&link);
        tokio::spawn(async move {
            let mut every = interval(Duration::from_secs(1));
            // Dopo una sospensione del computer un controllo solo basta.
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                let Some(l) = me.upgrade() else { return };
                let mut s = l.lock();
                if s.shut_down && s.sessions.is_empty() { return; }
                l.tick(&mut s);
            }
        });
        (link, rx)
    }

    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|e| e.into_inner()) }

    /// Verifica una chiave aprendo e chiudendo subito una sessione: il costo è di pochi secondi.
    async fn test(url: String, model: String, key: String, lang: Lang) -> Value {
        let no = |message: String| json!({ "ok": false, "message": message });
        if key.is_empty() { return no(t(lang, "Chiave mancante", &[])); }
        let full = format!("{url}?{}", query(&[("speech_model", &model), ("encoding", "pcm_s16le"), ("sample_rate", "16000")]));
        let attempt = async {
            let mut error = String::new();
            let mut ws = match connect(&full, &key).await { Ok(ws) => ws, Err(e) => return no(describe(&e)) };
            while let Some(Ok(m)) = ws.next().await {
                let Message::Text(text) = m else { continue };
                let v: Value = serde_json::from_str(&text).unwrap_or_default();
                if v["type"] == "Begin" {
                    let _ = ws.send(Message::text(json!({ "type": "Terminate" }).to_string())).await;
                    // La sessione si paga finché è aperta: si accompagna fino alla chiusura.
                    tokio::spawn(timeout(DRAIN, async move { while let Some(Ok(_)) = ws.next().await {} }));
                    return json!({ "ok": true, "message": t(lang, "Chiave valida", &[]) });
                }
                if v["type"] == "Error" { error = v["error"].as_str().unwrap_or_default().into(); }
            }
            no(if error.is_empty() { t(lang, "Connessione rifiutata", &[]) } else { error })
        };
        timeout(Duration::from_secs(8), attempt).await.unwrap_or_else(|_| no(t(lang, "Nessuna risposta: controlla la connessione", &[])))
    }

    // --- Apertura e chiusura ---

    fn open(&self, s: &mut State, as_next: bool) {
        if Instant::now() < s.blocked_until {
            if !as_next { self.schedule_reconnect(s); }
            return;
        }
        let (url, deferred) = s.build_url();
        s.ids += 1;
        let id = s.ids;
        let (out, rx) = mpsc::unbounded_channel();
        let (kill, killed) = oneshot::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        s.sessions.insert(id, Session {
            out, queued: queued.clone(), kill: Some(kill), open: false, draining: false, id: String::new(), ready: false, emit: !as_next,
            audio_ms: 0.0, turn: None, speech_mode: None, last_final_end: 0.0, last_final_order: -1, cut_ms: 0.0, offset_ms: 0.0,
            feed_start: None, forced: false, opened_at: None, last_msg: Instant::now(), rollover_at: None, fatal: false,
            keyterms: if deferred { Vec::new() } else { s.keyterms.clone() }, error: String::new(),
        });
        if as_next { s.next = Some(id) } else { s.primary = Some(id) }
        let key = s.cfg.api_key.clone();
        let Some(me) = self.me.upgrade() else { return };
        self.rt.spawn(async move { me.run(id, url, key, rx, queued, killed).await });
    }

    async fn run(self: Arc<Self>, id: u64, url: String, key: String, mut rx: mpsc::UnboundedReceiver<Message>, queued: Arc<AtomicUsize>, mut killed: oneshot::Receiver<()>) {
        let opened = tokio::select! {
            _ = &mut killed => { self.closed(id, 1006, ""); return }
            r = timeout(HANDSHAKE, connect(&url, &key)) => r,
        };
        let ws = match opened {
            Ok(Ok(ws)) => ws,
            failed => {
                let (text, fatal) = match failed {
                    Ok(Err(e)) => (describe(&e), matches!(&e, Error::Http(r) if [401, 403].contains(&r.status().as_u16()))),
                    _ => ("Opening handshake has timed out".into(), false),
                };
                if let Some(x) = self.lock().sessions.get_mut(&id) { x.error = text; x.fatal |= fatal; }
                self.closed(id, 1006, "");
                return;
            }
        };
        if let Some(x) = self.lock().sessions.get_mut(&id) {
            x.open = true;
            x.opened_at = Some(Instant::now());
            x.last_msg = Instant::now();
        }
        let (mut sink, mut stream) = ws.split();
        // Scrittura a parte: una rete bloccata non deve impedire di leggere né di chiudere.
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let size = if let Message::Binary(b) = &m { b.len() } else { 0 };
                if sink.send(m).await.is_err() { return; }
                queued.fetch_sub(size, Relaxed);
            }
        });
        let (mut code, mut reason) = (1006, String::new());
        loop {
            let m = tokio::select! { _ = &mut killed => break, m = stream.next() => m };
            match m {
                Some(Ok(Message::Text(text))) => {
                    let mut s = self.lock();
                    if let Some(x) = s.sessions.get_mut(&id) { x.last_msg = Instant::now(); }
                    if let Ok(v) = serde_json::from_str::<Value>(&text) { self.on_message(&mut s, id, &v); }
                }
                Some(Ok(Message::Close(frame))) => {
                    code = 1005;
                    if let Some(f) = frame { code = f.code.into(); reason = f.reason.to_string(); }
                    break;
                }
                Some(Ok(Message::Pong(_))) => if let Some(x) = self.lock().sessions.get_mut(&id) { x.last_msg = Instant::now(); },
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    if !is_plain_drop(&e) {
                        if let Some(x) = self.lock().sessions.get_mut(&id).filter(|x| x.error.is_empty()) { x.error = describe(&e); }
                    }
                    break;
                }
                None => break,
            }
        }
        self.closed(id, code, &reason);
        // Lascia partire la risposta alla chiusura, poi la connessione cade.
        if code != 1006 { let _ = timeout(Duration::from_millis(500), stream.next()).await; }
        writer.abort();
    }

    fn closed(&self, id: u64, code: u16, reason: &str) {
        let mut guard = self.lock();
        let s = &mut *guard;
        let Some(mut x) = s.sessions.remove(&id) else { return };
        if let Some(at) = x.opened_at.take() { s.closed_billed += at.elapsed(); }
        // 1000 è una chiusura normale: il suo motivo ("Session Ended") non è un errore.
        let error = if !x.error.is_empty() { x.error.clone() }
            else if code != 1000 && !reason.to_lowercase().contains("see error") { reason.to_string() } else { String::new() };
        if !error.is_empty() { s.last_error = error.clone(); }
        else if code != 1000 && s.active { s.last_error = t(s.lang, "Connessione chiusa (codice {code})", &[("code", &code.to_string())]); }
        if code == 1008 && !too_many(&error) { x.fatal = true; }

        if s.next == Some(id) {
            s.next = None;
            s.fatal |= x.fatal;
            let retry = Instant::now() + ROLLOVER_RETRY;
            if let Some(p) = s.primary_mut() { p.rollover_at = Some(retry); }
            return;
        }
        if s.primary != Some(id) { s.flush_partial(&mut x); return; } // sessione in chiusura

        let stale = x.last_msg.elapsed();
        log(format!("AssemblyAI: connessione chiusa (codice {code}){}", if error.is_empty() { String::new() } else { format!(": {error}") }));
        if s.next.and_then(|n| s.sessions.get(&n)).is_some_and(|n| n.ready) {
            self.promote(s, Some(x));
            return;
        }
        s.flush_partial(&mut x);
        s.primary = None;
        if !s.active { return; }
        s.fatal |= x.fatal;
        // Connessione morta da secondi: quell'audio non è stato elaborato e si può recuperare.
        // Dopo una chiusura immediata, invece, si ripartirebbe da parlato già trascritto.
        if stale >= STALE_REPLAY && x.ready {
            s.backlog = s.recent.clone();
            s.backlog_bytes = s.recent_bytes;
        }
        self.schedule_reconnect(s);
    }

    fn schedule_reconnect(&self, s: &mut State) {
        if !s.active || s.reconnect.is_some() { return; }
        let delay = Duration::from_millis(if s.fatal { 60000 } else { (1000u64 << s.attempts.min(4)).min(15000) });
        s.attempts += 1;
        s.retry_at = Some(Instant::now() + delay);
        s.ids += 1;
        let ticket = s.ids;
        s.reconnect = Some(ticket);
        let me = self.me.clone();
        self.rt.spawn(async move {
            sleep(delay).await;
            let Some(l) = me.upgrade() else { return };
            let mut s = l.lock();
            if s.reconnect != Some(ticket) { return; }
            s.reconnect = None;
            if s.active && s.primary.is_none() { l.open(&mut s, false); }
        });
        log(format!("AssemblyAI: nuovo tentativo tra {} s", delay.as_secs()));
    }

    // Attende l'ultimo testo finale, ma non all'infinito: la sessione si paga finché è aperta.
    fn drain(&self, s: &mut State, id: u64, keep_emitting: bool) {
        let Some(x) = s.sessions.get_mut(&id) else { return };
        x.emit = keep_emitting;
        x.draining = true;
        if !x.open { x.kill(); return; }
        x.send(&json!({ "type": "Terminate" }));
        let me = self.me.clone();
        self.rt.spawn(async move {
            sleep(DRAIN).await;
            let Some(l) = me.upgrade() else { return };
            let mut s = l.lock();
            if let Some(x) = s.sessions.get_mut(&id) { x.kill(); }
        });
    }

    fn stop_locked(&self, s: &mut State) {
        if !s.active { return; }
        s.active = false;
        s.reconnect = None;
        s.recent.clear();
        s.recent_bytes = 0;
        s.clear_backlog();
        s.attempts = 0;
        s.retry_at = None;
        if let Some(p) = s.primary.take() { self.drain(s, p, true); }
        if let Some(n) = s.next.take() { self.drain(s, n, false); }
    }

    // --- Messaggi ---

    fn on_message(&self, s: &mut State, id: u64, m: &Value) {
        match m["type"].as_str().unwrap_or_default() {
            "Begin" => s.on_begin(id, m),
            "SpeechStarted" => {
                let mode = s.mode.clone();
                if let Some(x) = s.sessions.get_mut(&id) { x.speech_mode = Some(mode); }
            }
            "Turn" => if s.on_turn(id, m) { self.try_handoff(s); },
            "Error" => {
                let text = m["error"].as_str().unwrap_or_default();
                let code = m["error_code"].as_i64();
                let full = js::trim(&format!("{} {text}", code.map_or(String::new(), |c| c.to_string()))).to_string();
                if let Some(x) = s.sessions.get_mut(&id) {
                    x.error = full.clone();
                    // Riprovare subito è inutile con errori di chiave o saldo; è utile con il limite di sessioni.
                    if code == Some(1008) && !too_many(text) { x.fatal = true; }
                }
                // Se AssemblyAI rifiuta il recupero a 2x, scarta il buffer e prosegue in tempo reale.
                if code == Some(3007) && text.to_lowercase().contains("rate") {
                    s.catch_up = false;
                    s.clear_backlog();
                }
                warn(format!("AssemblyAI: {full}"));
            }
            _ => {} // Heartbeat, Termination, SpeakerRevision
        }
    }

    // --- Cambio di sessione senza perdita ---

    fn try_handoff(&self, s: &mut State) {
        let Some(start) = s.next.and_then(|n| s.sessions.get(&n)).and_then(|n| n.feed_start) else { return };
        let Some(p) = s.primary_mut() else { return };
        let elapsed = start.elapsed();
        if elapsed < HANDOFF_MIN { return; }
        if p.turn.is_none() || elapsed >= HANDOFF_MAX { self.promote(s, None); return; }
        if elapsed >= HANDOFF_FORCE && !p.forced {
            p.forced = true;
            p.send(&json!({ "type": "ForceEndpoint" }));
        }
    }

    // `closed`: la sessione precedente, se si è appena chiusa da sola.
    fn promote(&self, s: &mut State, closed: Option<Session>) {
        let Some(next) = s.next.take() else { return };
        let was_closed = closed.is_some();
        let old_id = s.primary.take();
        if let Some(mut a) = closed.or_else(|| old_id.and_then(|o| s.sessions.remove(&o))) {
            s.flush_partial(&mut a);
            let mut fed = false;
            if let Some(b) = s.sessions.get_mut(&next).filter(|b| b.feeding()) {
                // Il taglio sono le ultime parole già trascritte, nell'orologio della nuova sessione.
                b.cut_ms = (a.last_final_end - b.offset_ms).max(0.0);
                fed = true;
            }
            if fed { s.clear_backlog(); } // la nuova sessione ha già ricevuto questo audio
            if let Some(o) = old_id.filter(|_| !was_closed) {
                s.sessions.insert(o, a);
                self.drain(s, o, false);
            }
        }
        s.primary = Some(next);
        if let Some(b) = s.sessions.get_mut(&next) {
            b.emit = true;
            log(format!("AssemblyAI: passaggio alla sessione {}", b.id));
        }
    }

    fn tick(&self, s: &mut State) {
        let now = Instant::now();
        for x in s.sessions.values_mut() {
            if x.open { let _ = x.out.send(Message::Ping(Bytes::new())); }
            if now.duration_since(x.last_msg) > DEAD_AFTER || x.queued.load(Relaxed) > MAX_SOCKET_BACKLOG {
                if x.kill.is_some() { warn("AssemblyAI: connessione senza risposta, la chiudo"); }
                x.kill();
            }
        }
        if !s.active { return; }
        if now.duration_since(s.last_audio) > AUDIO_IDLE {
            log("Nessun audio da 15 s: chiudo la sessione per non consumare crediti");
            self.stop_locked(s);
            return;
        }
        let no_next = s.next.is_none();
        if let Some(p) = s.primary_mut().filter(|p| no_next && p.ready && p.rollover_at.is_some_and(|r| now >= r)) {
            log("AssemblyAI: apertura della nuova sessione prima del limite di durata");
            p.rollover_at = Some(now + ROLLOVER_RETRY); // ritenta se questa non si apre
            self.open(s, true);
        }
        self.try_handoff(s);
    }
}

impl State {
    fn primary_mut(&mut self) -> Option<&mut Session> { self.primary.and_then(|p| self.sessions.get_mut(&p)) }
    fn clear_backlog(&mut self) {
        self.backlog.clear();
        self.backlog_bytes = 0;
    }
    // In AUTO si riconosce tra le lingue dell'evento; con una lingua fissa, solo quella.
    fn language_codes(&self) -> Vec<String> { if self.mode == "AUTO" { self.spoken.clone() } else { vec![self.mode.clone()] } }

    fn build_url(&self) -> (String, bool) {
        let codes = json!(self.language_codes()).to_string();
        let mut pairs = vec![("speech_model", self.cfg.model.as_str()), ("encoding", "pcm_s16le"), ("sample_rate", "16000"),
            ("language_detection", "true"), ("language_codes", &codes), ("session_heartbeat", "true")];
        if !self.cfg.min_turn_silence.is_empty() { pairs.push(("min_turn_silence", &self.cfg.min_turn_silence)); }
        if !self.cfg.max_turn_silence.is_empty() { pairs.push(("max_turn_silence", &self.cfg.max_turn_silence)); }
        let base = format!("{}?{}", self.cfg.url, query(&pairs));
        if self.keyterms.is_empty() { return (base, false); }
        let full = format!("{base}&{}", query(&[("keyterms_prompt", &json!(self.keyterms).to_string())]));
        // Con liste molto lunghe evita un URL eccessivo: i termini partono subito dopo Begin.
        if full.len() < MAX_URL { (full, false) } else { (base, true) }
    }

    fn update_config(&self, key: &str, value: Value) {
        let message = json!({ "type": "UpdateConfiguration", key: value });
        for id in [self.primary, self.next].into_iter().flatten() {
            if let Some(x) = self.sessions.get(&id).filter(|x| x.ready) { x.send(&message); }
        }
    }

    fn on_begin(&mut self, id: u64, m: &Value) {
        let now = Instant::now();
        self.attempts = 0;
        self.retry_at = None;
        self.fatal = false;
        self.last_error.clear();
        let left = m["expires_at"].as_f64().filter(|e| *e > 0.0).map_or(DEFAULT_SESSION, |e| {
            let unix = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
            Duration::from_secs_f64((e - unix).clamp(0.0, 1e6))
        });
        let mut until = left.saturating_sub(self.cfg.rollover_before);
        if !self.cfg.session_max.is_zero() { until = until.min(self.cfg.session_max); }
        // I parametri errati vengono ignorati senza errore: va controllato il modello effettivo.
        if let Some(model) = m["configuration"]["model"].as_str().filter(|x| !x.is_empty() && *x != self.cfg.model) {
            self.last_error = t(self.lang, "Modello richiesto {wanted}, attivo {model}", &[("wanted", &self.cfg.model), ("model", model)]);
            warn(&self.last_error);
        }
        let codes = self.language_codes();
        let is_primary = self.primary == Some(id);
        let Some(x) = self.sessions.get_mut(&id) else { return };
        x.id = m["id"].as_str().unwrap_or_default().into();
        x.ready = true;
        x.rollover_at = Some(now + until);
        // Troppo lunghi per l'indirizzo, oppure cambiati mentre la sessione si apriva.
        if x.keyterms != self.keyterms { x.send(&json!({ "type": "UpdateConfiguration", "keyterms_prompt": self.keyterms })); }
        // La modalità può essere cambiata mentre la sessione si stava aprendo.
        x.send(&json!({ "type": "UpdateConfiguration", "language_codes": codes }));
        log(format!("AssemblyAI: sessione {} {}", if is_primary { "attiva" } else { "pronta per il cambio" }, x.id));
    }

    // Restituisce true se il turno si è concluso.
    fn on_turn(&mut self, id: u64, m: &Value) -> bool {
        let mode = self.mode.clone();
        let is_pro = self.cfg.model.contains("pro");
        let Some(x) = self.sessions.get_mut(&id) else { return false };
        let order = m["turn_order"].as_i64().unwrap_or(x.last_final_order + 1);
        if !x.emit || order <= x.last_final_order { return false; }
        let mut text = m["transcript"].as_str().unwrap_or_default().to_string();
        let mut words = words_of(m);
        // Dopo un cambio di sessione, le parole già trascritte dalla precedente si scartano.
        if x.cut_ms > 0.0 && !words.is_empty() {
            let all = words.len();
            words.retain(|w| w.end > x.cut_ms);
            if words.is_empty() { return false; }
            if words.len() < all { text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "); }
        }
        if x.turn.as_ref().is_none_or(|c| c.order != order) {
            // La frase in corso si completa con la modalità attiva quando è iniziata. Conta l'arrivo di
            // SpeechStarted: i timestamp della prima parola possono anticipare il parlato di circa 1 s.
            let mode = x.speech_mode.take().unwrap_or_else(|| mode.clone());
            x.turn = Some(Turn { order, mode, text: String::new(), last_end: 0.0, segmenter: TurnSegmenter::new(), emitted: 0 });
        }
        let Some(mut turn) = x.turn.take() else { return false };
        if let Some(w) = words.last() { turn.last_end = w.end; }

        // U3 Pro: il turno è completo con end_of_turn e turn_is_formatted entrambi veri.
        let done = m["end_of_turn"] == true && (m["turn_is_formatted"] != false || !is_pro);
        if !done {
            let (blocks, partial) = if words.is_empty() { (Vec::new(), text) } else { turn.segmenter.update(&words) };
            for block in blocks { emit_block(&self.events, &mode, &mut turn, block, ""); }
            turn.text = partial.clone();
            let _ = self.events.send(Event::Partial(partial, turn.emitted > 0));
            x.turn = Some(turn);
            return false;
        }
        x.last_final_order = order;
        if turn.last_end > 0.0 { x.last_final_end = turn.last_end; }
        match turn.segmenter.finish(&words, &text).filter(|b| !b.text.is_empty()) {
            // La lingua di AssemblyAI vale per tutto il turno: è affidabile solo se è un blocco unico.
            Some(rest) => {
                let detected = if turn.emitted > 0 { "" } else { m["language_code"].as_str().unwrap_or_default() };
                emit_block(&self.events, &mode, &mut turn, rest, detected);
            }
            None => { let _ = self.events.send(Event::Partial(String::new(), false)); }
        }
        true
    }

    // Un turno rimasto aperto a sessione chiusa diventa finale, per non perdere il testo.
    fn flush_partial(&self, x: &mut Session) {
        let Some(mut turn) = x.turn.take() else { return };
        if turn.text.is_empty() || !x.emit { return; }
        if turn.last_end > 0.0 { x.last_final_end = turn.last_end; }
        let text = std::mem::take(&mut turn.text);
        emit_block(&self.events, &self.mode, &mut turn, Block { text, duration_ms: 0.0 }, "");
    }
}

// Un cambio di modalità vale dal blocco successivo, anche a turno aperto.
fn emit_block(events: &mpsc::UnboundedSender<Event>, mode: &str, turn: &mut Turn, block: Block, detected: &str) {
    let used = std::mem::replace(&mut turn.mode, mode.into());
    let _ = events.send(Event::Final(Final {
        text: block.text, detected: detected.into(), mode: used, duration_ms: block.duration_ms, continuation: turn.emitted > 0,
    }));
    turn.emitted += 1;
}

impl Engine for AssemblyLink {
    // Una chiave nuova vale subito: non serve aspettare il prossimo tentativo.
    fn configure(&self, c: EngineConfig) {
        let mut s = self.lock();
        if let Some(l) = c.lang { s.lang = l; }
        s.cfg.url = c.assembly_url;
        if c.assembly_key == s.cfg.api_key { return; }
        s.cfg.api_key = c.assembly_key;
        s.fatal = false;
        s.last_error.clear();
        s.attempts = 0;
        s.retry_at = None;
        if s.active && s.primary.is_none() {
            s.reconnect = None;
            self.open(&mut s, false);
        }
    }

    fn set_languages(&self, mode: &str, spoken: &[String]) {
        let mut s = self.lock();
        s.mode = mode.into();
        s.spoken = spoken.to_vec();
        s.update_config("language_codes", json!(s.language_codes()));
    }

    fn set_keyterms(&self, terms: Vec<String>) {
        let mut s = self.lock();
        s.update_config("keyterms_prompt", json!(terms));
        s.keyterms = terms;
    }

    fn active(&self) -> bool { self.lock().active }

    fn push_audio(&self, pcm: &[u8]) {
        let mut guard = self.lock();
        let s = &mut *guard;
        if s.shut_down { return; }
        let now = Instant::now();
        let frame = Bytes::copy_from_slice(pcm);
        s.last_audio = now;
        s.recent.push_back(frame.clone());
        s.recent_bytes += frame.len();
        while s.recent_bytes > AUDIO_BUFFER_BYTES { s.recent_bytes -= s.recent.pop_front().map_or(0, |f| f.len()); }

        if !s.active {
            s.active = true;
            s.fatal = false;
            s.attempts = 0;
            self.open(s, false);
        }
        let primary = s.primary.and_then(|p| s.sessions.get(&p)).filter(|p| p.ready).map(|p| p.audio_ms);
        // La nuova sessione riceve audio solo a buffer vuoto: così il suo orologio è allineato.
        if let (Some(audio_ms), true) = (primary, s.backlog.is_empty()) {
            if let Some(n) = s.next.and_then(|n| s.sessions.get_mut(&n)).filter(|n| n.ready && !n.feeding()) {
                n.offset_ms = audio_ms;
                n.feed_start = Some(now);
            }
        }
        s.backlog_bytes += frame.len();
        s.backlog.push_back(frame.clone());
        while s.backlog_bytes > AUDIO_BUFFER_BYTES { s.backlog_bytes -= s.backlog.pop_front().map_or(0, |f| f.len()); }

        if primary.is_some() {
            for _ in 0..if s.catch_up { 2 } else { 1 } {
                let Some(out) = s.backlog.pop_front() else { break };
                s.backlog_bytes -= out.len();
                if let Some(p) = s.primary_mut() { p.send_audio(&out); }
            }
        }
        if let Some(n) = s.next.and_then(|n| s.sessions.get_mut(&n)).filter(|n| n.feeding()) { n.send_audio(&frame); }
    }

    fn stop(&self) { self.stop_locked(&mut self.lock()); }

    fn shutdown(&self) {
        let mut s = self.lock();
        s.shut_down = true; // l'audio ancora in arrivo non deve riaprire una sessione
        self.stop_locked(&mut s);
    }

    fn simulate_drop(&self, seconds: f64) {
        let mut s = self.lock();
        s.blocked_until = Instant::now() + Duration::from_secs_f64(seconds);
        log(format!("Test: caduta simulata di {seconds} s"));
        for x in s.sessions.values_mut() { x.kill(); }
    }

    fn assembly_status(&self) -> Value {
        let s = self.lock();
        let billed = s.closed_billed + s.sessions.values().filter_map(|x| x.opened_at).map(|a| a.elapsed()).sum::<Duration>();
        let primary = s.primary.and_then(|p| s.sessions.get(&p));
        let state = match (s.active, primary.is_some_and(|p| p.ready), s.attempts > 0) {
            (false, _, _) => "idle", (_, true, _) => "connected", (_, _, true) => "reconnecting", _ => "connecting",
        };
        let retry = s.retry_at.and_then(|r| r.checked_duration_since(Instant::now())).map_or(0, |d| d.as_secs_f64().ceil() as u64);
        json!({ "state": state, "fatal": s.fatal, "lastError": s.last_error, "sessionId": primary.map_or("", |p| p.id.as_str()),
            "model": s.cfg.model, "billedSeconds": billed.as_secs_f64().round() as u64,
            "bufferedMs": (s.backlog_bytes as f64 / BYTES_PER_MS as f64).round() as u64, "retryInSeconds": retry, "handoff": s.next.is_some() })
    }

    fn test_assembly(&self) -> Pending<Value> {
        let s = self.lock();
        Box::pin(Self::test(s.cfg.url.clone(), s.cfg.model.clone(), s.cfg.api_key.clone(), s.lang))
    }
}
