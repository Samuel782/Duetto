//! Sottotitoli nativi della diretta: il testo va a OBS con obs-websocket 5, e OBS lo inserisce nello
//! streaming come sottotitoli CEA-608.
use duetto_core::{captions::{caption_chunks, obs_auth, CHUNK_CHARS}, i18n::{t, Lang}, js, log::{log, warn}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::ErrorKind,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{sync::{mpsc, oneshot}, task::AbortHandle, time::{interval, sleep, timeout}};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Error, Message},
};

const RETRY: Duration = Duration::from_millis(5000);
const STATUS_EVERY: Duration = Duration::from_millis(5000);
const CONNECT: Duration = Duration::from_millis(4000);
const ANSWER: Duration = Duration::from_millis(4000);
const MIN_SHOW_MS: u64 = 1500;
const MS_PER_CHAR: u64 = 45;
const MAX_QUEUE: usize = 8; // chi parla molto veloce non deve far accumulare ritardo
const WRONG_PASSWORD: u16 = 4009;
const MAX_MESSAGE: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ObsConfig { pub enabled: bool, pub host: String, pub port: u16, pub password: String }

impl Default for ObsConfig {
    fn default() -> Self { Self { enabled: false, host: "127.0.0.1".into(), port: 4455, password: String::new() } }
}

#[derive(Clone, Copy, PartialEq)]
enum Link { Off, Connecting, Connected }

struct State {
    cfg: ObsConfig,
    lang: Lang,
    link: Link,
    streaming: bool,
    last_error: String,
    queue: VecDeque<String>,
    sending: bool,
    sent: u64,
    next_id: u64,
    /// Cambia a ogni nuova configurazione: un compito rimasto indietro non tocca più nulla.
    run: u64,
    task: Option<AbortHandle>,
    out: Option<mpsc::UnboundedSender<String>>,
    pending: HashMap<String, oneshot::Sender<Value>>,
}

pub struct Obs(Mutex<State>);

impl Obs {
    pub fn new(lang: Lang) -> Arc<Self> {
        Arc::new(Self(Mutex::new(State {
            cfg: ObsConfig::default(), lang, link: Link::Off, streaming: false, last_error: String::new(), queue: VecDeque::new(),
            sending: false, sent: 0, next_id: 0, run: 0, task: None, out: None, pending: HashMap::new(),
        })))
    }

    fn lock(&self) -> MutexGuard<'_, State> { self.0.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn set_lang(&self, lang: Lang) { self.lock().lang = lang; }

    pub fn configure(self: &Arc<Self>, cfg: ObsConfig) {
        let mut s = self.lock();
        if s.cfg == cfg { return; }
        s.cfg = cfg;
        s.close();
        s.last_error.clear();
        if s.cfg.enabled {
            s.link = Link::Connecting;
            let (me, run) = (self.clone(), s.run);
            s.task = Some(tokio::spawn(async move { me.keep_connected(run).await }).abort_handle());
        }
    }

    pub fn stop(&self) {
        let mut s = self.lock();
        s.cfg.enabled = false;
        s.close();
    }

    pub fn live(&self) -> bool { let s = self.lock(); s.link == Link::Connected && s.streaming }

    pub fn status(&self) -> Value {
        let s = self.lock();
        let state = match s.link { Link::Off => "off", Link::Connecting => "connecting", Link::Connected => "connected" };
        json!({ "enabled": s.cfg.enabled, "state": state, "streaming": s.streaming, "live": s.link == Link::Connected && s.streaming,
            "lastError": s.last_error, "sent": s.sent })
    }

    /// Aggiunge una frase ai sottotitoli, solo se OBS è in diretta.
    pub fn push(self: &Arc<Self>, text: &str) {
        let mut s = self.lock();
        if s.link != Link::Connected || !s.streaming || text.is_empty() { return; }
        s.queue.extend(caption_chunks(text, CHUNK_CHARS));
        let extra = s.queue.len().saturating_sub(MAX_QUEUE);
        s.queue.drain(..extra);
        if s.sending { return; }
        s.sending = true;
        let me = self.clone();
        tokio::spawn(async move { me.show().await });
    }

    // Ogni pezzo resta il tempo di leggerlo prima del successivo.
    async fn show(self: Arc<Self>) {
        loop {
            let chunk = {
                let mut s = self.lock();
                let Some(c) = s.queue.pop_front() else { s.sending = false; return };
                c
            };
            let wait = MIN_SHOW_MS.max(js::len(&chunk) as u64 * MS_PER_CHAR);
            let me = self.clone();
            tokio::spawn(async move {
                if me.request("SendStreamCaption", json!({ "captionText": chunk })).await.is_some() { me.lock().sent += 1; }
            });
            sleep(Duration::from_millis(wait)).await;
        }
    }

    /// I dati della risposta se riuscita, altrimenti None.
    async fn request(&self, kind: &str, data: Value) -> Option<Value> {
        let (id, rx) = {
            let mut s = self.lock();
            if s.link != Link::Connected { return None; }
            s.next_id += 1;
            let id = s.next_id.to_string();
            let (tx, rx) = oneshot::channel();
            let message = json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } });
            s.out.as_ref()?.send(message.to_string()).ok()?;
            s.pending.insert(id.clone(), tx);
            (id, rx)
        };
        let answer = timeout(ANSWER, rx).await;
        let mut s = self.lock();
        s.pending.remove(&id);
        let d = answer.ok()?.ok()?; // scaduta, o collegamento chiuso
        let outcome = &d["requestStatus"];
        if outcome["result"] != true {
            if kind == "SendStreamCaption" {
                let error = outcome["comment"].as_str().filter(|c| !c.is_empty()).map_or_else(|| outcome["code"].to_string(), String::from);
                s.last_error = t(s.lang, "OBS ha rifiutato il sottotitolo: {error}", &[("error", &error)]);
            }
            return None;
        }
        Some(d["responseData"].clone())
    }

    async fn keep_connected(self: Arc<Self>, run: u64) {
        loop {
            let code = self.session(run).await;
            {
                let mut s = self.lock();
                if s.run != run { return; }
                if s.link == Link::Connected { warn(format!("OBS: collegamento perso ({code})")); }
                s.disconnect();
                // Password sbagliata: riprovare non serve finché non cambia.
                if code == WRONG_PASSWORD {
                    s.last_error = t(s.lang, "Password di OBS rifiutata", &[]);
                    s.link = Link::Off;
                    return;
                }
                s.link = Link::Connecting;
            }
            sleep(RETRY).await;
        }
    }

    // Un collegamento, dall'apertura alla chiusura. Restituisce il codice di chiusura.
    async fn session(self: &Arc<Self>, run: u64) -> u16 {
        let cfg = self.lock().cfg.clone();
        let failed = |e: Option<Error>| {
            let mut s = self.lock();
            if s.run != run { return; }
            s.last_error = match e {
                Some(Error::Io(io)) if io.kind() == ErrorKind::ConnectionRefused => t(s.lang, "OBS non risponde: è aperto, con il server WebSocket attivo?", &[]),
                Some(e) => e.to_string(),
                None => "Opening handshake has timed out".into(),
            };
        };
        let mut request = match format!("ws://{}:{}", cfg.host, cfg.port).into_client_request() {
            Ok(r) => r,
            Err(e) => { failed(Some(e)); return 1006; }
        };
        request.headers_mut().insert("Sec-WebSocket-Protocol", tokio_tungstenite::tungstenite::http::HeaderValue::from_static("obswebsocket.json"));
        let limits = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let mut ws = match timeout(CONNECT, connect_async_with_config(request, Some(limits), true)).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => { failed(Some(e)); return 1006; }
            Err(_) => { failed(None); return 1006; }
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut s = self.lock();
            if s.run != run { return 1006; }
            s.out = Some(tx);
        }
        let mut poll = interval(STATUS_EVERY);
        loop {
            let connected = self.lock().link == Link::Connected;
            tokio::select! {
                Some(text) = rx.recv() => if let Err(e) = ws.send(Message::text(text)).await { failed(Some(e)); return 1006; },
                // La risposta arriva da questo stesso ciclo: la domanda va fatta senza aspettarla qui.
                _ = poll.tick(), if connected => self.ask_streaming(run),
                message = ws.next() => match message {
                    None => return 1006,
                    Some(Err(e)) => {
                        if !matches!(e, Error::ConnectionClosed | Error::AlreadyClosed | Error::Protocol(_)) { failed(Some(e)); }
                        return 1006;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let _ = timeout(Duration::from_secs(1), ws.close(None)).await;
                        let Some(f) = frame else { return 1005 };
                        let mut s = self.lock();
                        if s.run == run && s.last_error.is_empty() { s.last_error = f.reason.to_string(); }
                        return f.code.into();
                    }
                    Some(Ok(m)) => {
                        let Ok(v) = serde_json::from_slice::<Value>(&m.into_data()) else { continue };
                        if self.on_message(run, &cfg.password, &v) { poll.reset_immediately(); }
                    }
                },
            }
        }
    }

    // Restituisce true quando OBS ha accettato il collegamento.
    fn on_message(&self, run: u64, password: &str, m: &Value) -> bool {
        let mut s = self.lock();
        if s.run != run { return false; }
        match m["op"].as_u64() {
            Some(0) => { // OBS chiede chi siamo e, se serve, la password
                let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
                let auth = &m["d"]["authentication"];
                if auth.is_object() {
                    let text = |k: &str| auth[k].as_str().unwrap_or_default();
                    identify["authentication"] = obs_auth(password, text("salt"), text("challenge")).into();
                }
                if let Some(out) = &s.out { let _ = out.send(json!({ "op": 1, "d": identify }).to_string()); }
                false
            }
            Some(2) => {
                s.link = Link::Connected;
                s.last_error.clear();
                log("OBS: collegato per i sottotitoli");
                true
            }
            Some(7) => {
                let done = m["d"]["requestId"].as_str().and_then(|id| s.pending.remove(id));
                if let Some(tx) = done { let _ = tx.send(m["d"].clone()); }
                false
            }
            _ => false,
        }
    }

    fn ask_streaming(self: &Arc<Self>, run: u64) {
        let me = self.clone();
        tokio::spawn(async move {
            let live = me.request("GetStreamStatus", json!({})).await.is_some_and(|d| d["outputActive"] == true);
            let mut s = me.lock();
            if s.run == run && s.link == Link::Connected { s.streaming = live; }
        });
    }
}

impl State {
    fn disconnect(&mut self) {
        self.out = None;
        self.streaming = false;
        self.pending.clear(); // chi aspetta una risposta riceve subito None
    }
    fn close(&mut self) {
        self.run += 1;
        if let Some(task) = self.task.take() { task.abort(); }
        self.queue.clear();
        self.link = Link::Off;
        self.disconnect();
    }
}
