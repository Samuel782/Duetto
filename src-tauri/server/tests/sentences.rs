// Dalla frase agli overlay e ai file, con un finto DeepL: ordine, lingua corretta, errori.
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::{get, post}, Json, Router};
use duetto_server::{app::{App, SseClient}, config::Config, engine::Idle, sentences::Final};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::mpsc;

type Bodies = Arc<Mutex<Vec<Value>>>;

// "lenta" risponde dopo 700 ms, "errore" fallisce, "english" viene rilevata come inglese.
async fn translate(State(seen): State<Bodies>, Json(b): Json<Value>) -> axum::response::Response {
    seen.lock().unwrap().push(b.clone());
    let text = b["text"][0].as_str().unwrap().to_string();
    if text.contains("lenta") { tokio::time::sleep(Duration::from_millis(700)).await; }
    if text.contains("errore") { return StatusCode::NOT_FOUND.into_response(); }
    let detected = if text.contains("english") { "EN" } else { "IT" };
    Json(json!({ "translations": [{ "detected_source_language": detected, "text": format!("[{}] {text}", b["target_lang"].as_str().unwrap()) }] })).into_response()
}

struct Ctx { app: Arc<App>, rx: mpsc::Receiver<String>, dir: PathBuf, bodies: Bodies }

async fn setup(name: &str) -> Ctx {
    let dir = std::env::temp_dir().join(format!("duetto-frasi-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let bodies = Bodies::default();
    let fake = Router::new().route("/v2/translate", post(translate))
        .route("/v2/usage", get(|| async { Json(json!({ "character_count": 1, "character_limit": 9 })) })).with_state(bodies.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, fake).await });
    let mut cfg = Config::from_env();
    cfg.data_dir = dir.join("data");
    cfg.output_dir = dir.join("out");
    cfg.deepl_key = "finta".into();
    cfg.deepl_endpoint = url;
    cfg.locale = "it".into();
    cfg.default_mode = "AUTO".into();
    let app = App::new(cfg, Arc::new(Idle::new("m".into())), None, None);
    let (tx, rx) = mpsc::channel(500);
    app.lock().sse[0].push(SseClient { tx, local: true });
    Ctx { app, rx, dir, bodies }
}

fn say(text: &str, detected: &str) -> Final {
    Final { text: text.into(), detected: detected.into(), mode: "AUTO".into(), duration_ms: 1500.0, ..Default::default() }
}

impl Ctx {
    async fn next(&mut self, kinds: &[&str]) -> Value {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(8), self.rx.recv()).await.expect("evento mai arrivato").unwrap();
            let v: Value = serde_json::from_str(m.trim().trim_start_matches("data: ")).unwrap();
            if kinds.contains(&v["t"].as_str().unwrap()) { return v; }
        }
    }
    fn file(&self, name: &str) -> String {
        let d = std::fs::read_dir(self.dir.join("out")).unwrap().next().unwrap().unwrap().path();
        std::fs::read_to_string(d.join(name)).unwrap_or_default()
    }
}
const DONE: [&str; 2] = ["translation", "translationFailed"];

#[tokio::test]
async fn le_traduzioni_escono_in_ordine() {
    let mut c = setup("ordine").await;
    c.app.on_final(say("questa frase è lenta davvero", "it"));
    c.app.on_final(say("questa invece è veloce", "it"));
    c.app.on_final(say("questa va in errore purtroppo", "it"));
    let got: Vec<Value> = [c.next(&DONE).await, c.next(&DONE).await, c.next(&DONE).await].to_vec();
    assert_eq!(got.iter().map(|v| v["id"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(got[0]["text"], "[EN-GB] questa frase è lenta davvero");
    assert_eq!(got[2]["t"], "translationFailed");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(c.file("originale.srt").matches("-->").count(), 3);
    assert_eq!(c.file("inglese.srt").matches("-->").count(), 3, "file allineati anche senza traduzione");
    assert!(c.file("trascrizione.txt").contains("(non disponibile)"));
}

#[tokio::test]
async fn deepl_corregge_la_lingua() {
    let mut c = setup("lingua").await;
    c.app.on_final(say("this is an english sentence", "it"));
    assert_eq!(c.next(&["final"]).await["lang"], "it");
    // Chi ha scelto l'inglese vede l'inglese tradotto nella prima altra lingua.
    let v = c.next(&DONE).await;
    assert_eq!((v["lang"].as_str(), v["text"].as_str()), (Some("it"), Some("[IT] this is an english sentence")));
    assert_eq!(c.app.lock().store.state.last_language.as_deref(), Some("en"));
    // Una frase breve non cambia la lingua corrente e non chiede il rilevamento.
    c.app.on_final(say("ok sì", "it"));
    assert_eq!(c.next(&["final"]).await["lang"], "en");
    c.next(&DONE).await;
    assert_eq!(c.bodies.lock().unwrap().last().unwrap()["source_lang"], "EN");
}

#[tokio::test]
async fn contesto_solo_nella_stessa_lingua() {
    let mut c = setup("contesto").await;
    for text in ["prima frase in italiano", "seconda frase in italiano", "now an english sentence", "ancora una in italiano"] {
        c.app.on_final(say(text, "it"));
        c.next(&DONE).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let bodies = c.bodies.lock().unwrap().clone();
    let context = |t: &str| bodies.iter().find(|b| b["text"][0] == t).unwrap()["context"].clone();
    assert_eq!(context("prima frase in italiano"), Value::Null);
    assert_eq!(context("seconda frase in italiano"), "prima frase in italiano");
    assert_eq!(context("ancora una in italiano"), Value::Null);
}

#[tokio::test]
async fn solo_originale_non_traduce_e_i_riempitivi_spariscono() {
    let mut c = setup("originale").await;
    for i in 0..2 { c.app.lock().output(i).view = "original".into(); }
    c.app.on_final(say("ehm, ehm", "it"));
    assert_eq!(c.next(&["partial"]).await["text"], "");
    c.app.on_final(say("ehm, una frase pulita", "it"));
    assert_eq!(c.next(&["final"]).await["text"], "una frase pulita");
    assert_eq!(c.next(&DONE).await["t"], "translationFailed");
    assert!(c.bodies.lock().unwrap().is_empty());
}

// Un OBS minimo in diretta: accetta, risponde e prende nota dei sottotitoli.
async fn fake_obs(seen: Arc<Mutex<Vec<String>>>) -> u16 {
    use axum::extract::ws::{Message, WebSocketUpgrade};
    let route = get(move |ws: WebSocketUpgrade| async move {
        ws.protocols(["obswebsocket.json"]).on_upgrade(move |mut s| async move {
            let _ = s.send(Message::Text(json!({ "op": 0, "d": {} }).to_string().into())).await;
            while let Some(Ok(Message::Text(m))) = s.recv().await {
                let m: Value = serde_json::from_str(&m).unwrap();
                if m["op"] == 1 { let _ = s.send(Message::Text(json!({ "op": 2, "d": {} }).to_string().into())).await; continue; }
                if let Some(c) = m["d"]["requestData"]["captionText"].as_str() { seen.lock().unwrap().push(c.into()); }
                let answer = json!({ "op": 7, "d": { "requestId": m["d"]["requestId"], "requestStatus": { "result": true }, "responseData": { "outputActive": true } } });
                let _ = s.send(Message::Text(answer.to_string().into())).await;
            }
        })
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/", route)).await });
    port
}

#[tokio::test]
async fn obs_riceve_la_lingua_scelta() {
    let mut c = setup("obs").await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let port = fake_obs(seen.clone()).await;
    let (tx, _rx) = mpsc::channel(50);
    let send = |m: Value| c.app.handle_command(&tx, m.as_object().unwrap().clone());
    send(json!({ "cmd": "languages", "targets": ["en", "it", "de"] }));
    send(json!({ "cmd": "captionsTarget", "lang": "de" }));
    send(json!({ "cmd": "settingsSave", "obsEnabled": true, "obsPort": port }));
    for _ in 0..100 {
        if c.app.obs.live() { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert!(c.app.obs.live(), "{}", c.app.obs.status());
    c.app.on_final(say("questa frase va tradotta", "it"));
    c.next(&DONE).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Il tedesco non è su nessuna uscita: si traduce solo perché va nei sottotitoli nativi.
    assert_eq!(*seen.lock().unwrap(), ["[DE] questa frase va tradotta"]);
    // Con l'originale passa il testo detto. Il pezzo precedente resta il suo tempo.
    let app = c.app.clone();
    app.handle_command(&tx, json!({ "cmd": "captionsTarget", "lang": "original" }).as_object().unwrap().clone());
    c.app.on_final(say("questa resta in italiano", "it"));
    c.next(&DONE).await;
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert_eq!(seen.lock().unwrap().last().unwrap(), "questa resta in italiano");
    c.app.obs.stop();
    assert!(!c.app.obs.live());
}
