//! Pagine, eventi per gli overlay e collegamento della regia.
use crate::app::{App, ControlClient, SseClient};
use axum::{
    body::{Body, Bytes},
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, ConnectInfo, FromRequestParts, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use duetto_core::i18n::{t, Lang};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{convert::Infallible, net::{IpAddr, SocketAddr}, sync::Arc};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

const HTML: &str = "text/html; charset=utf-8";
const SCRIPT: &str = "text/javascript; charset=utf-8";
const QUEUE: usize = 1024;
const MAX_MESSAGE: usize = 1024 * 1024;

macro_rules! page { ($f:literal) => { include_bytes!(concat!("../../../public/", $f)) as &'static [u8] }; }

fn control_file(path: &str) -> Option<(&'static [u8], &'static str)> {
    Some(match path {
        "/settings" => (page!("settings.html"), HTML),
        "/settings.js" => (page!("settings.js"), SCRIPT),
        "/control" => (page!("control.html"), HTML),
        "/control.js" => (page!("control.js"), SCRIPT),
        "/control.css" => (page!("control.css"), "text/css; charset=utf-8"),
        "/motion.js" => (page!("motion.js"), SCRIPT),
        "/i18n.js" => (page!("i18n.js"), SCRIPT),
        "/audio-worklet.js" => (page!("audio-worklet.js"), SCRIPT),
        _ => return None,
    })
}
fn overlay_file(path: &str) -> Option<(&'static [u8], &'static str)> {
    Some(match path {
        "/overlay" => (page!("overlay.html"), HTML),
        "/overlay.js" => (page!("overlay.js"), SCRIPT),
        _ => return None,
    })
}

fn is_local(addr: &SocketAddr) -> bool { addr.ip().to_canonical().is_loopback() }

fn host_of(headers: &HeaderMap) -> &str { headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default() }

/// Un sito estraneo può far puntare il proprio nome a 127.0.0.1 e presentarsi come locale: la regia
/// risponde solo a "localhost" o a un indirizzo numerico, che un sito non può fingere.
fn trusted_host(host: &str) -> bool {
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host.rsplit_once(':').map_or(host, |(n, _)| n),
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

/// Un collegamento da un altro sito non deve poter comandare il server.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else { return true };
    let host = host_of(headers);
    let rest = origin.to_str().ok().and_then(|o| o.split_once("://"));
    // Il browser toglie la porta predefinita sia dall'origine sia da Host.
    rest.is_some_and(|(_, o)| !host.is_empty() && o.eq_ignore_ascii_case(host))
}

fn control_allowed(app: &App, addr: &SocketAddr, headers: &HeaderMap) -> bool {
    app.cfg.control_allow_lan || (is_local(addr) && trusted_host(host_of(headers)))
}
fn plain(code: StatusCode, text: String) -> Response { (code, text).into_response() }

fn file(app: &App, path: &str, (body, kind): (&'static [u8], &'static str)) -> Response {
    let headers = [(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "no-store")];
    if path != "/i18n.js" { return (headers, body).into_response(); }
    // Le traduzioni arrivano con lo script: la pagina appare subito nella lingua giusta.
    let (lang, locale, dict) = match app.lock().lang {
        Lang::En => ("en", "en-GB", include_str!("../../../public/i18n/en.json").trim()),
        Lang::It => ("it", "it-IT", "{}"),
    };
    let head = format!("window.DUETTO_LANG = \"{lang}\";\nwindow.DUETTO_LOCALE = \"{locale}\";\nwindow.DUETTO_DICT = {dict};\n");
    (headers, [head.as_bytes(), body].concat()).into_response()
}

fn events(app: &App, addr: &SocketAddr, query: &str) -> Response {
    let room = query.split('&').find_map(|p| p.strip_prefix("out=")) == Some("room");
    let i = room as usize;
    let (tx, rx) = mpsc::channel(QUEUE);
    let mut g = app.lock();
    let _ = tx.try_send(format!("retry: 1000\n\ndata: {}\n\n", g.profile(i)));
    g.sse[i].push(SseClient { tx, local: is_local(addr) });
    drop(g);
    let stream = ReceiverStream::new(rx).map(|s| Ok::<_, Infallible>(Bytes::from(s)));
    ([(header::CONTENT_TYPE, "text/event-stream"), (header::CACHE_CONTROL, "no-store")], Body::from_stream(stream)).into_response()
}

async fn handle(State(app): State<Arc<App>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let lang = app.lock().lang;
    if path == "/ws" && req.headers().contains_key(header::UPGRADE) { return upgrade(app, addr, req).await; }
    if req.method() != Method::GET { return StatusCode::METHOD_NOT_ALLOWED.into_response(); }
    if path == "/" {
        let to = if control_allowed(&app, &addr, req.headers()) { "/control" } else { "/overlay?out=room" };
        return (StatusCode::FOUND, [(header::LOCATION, to)]).into_response();
    }
    let overlay = overlay_file(&path);
    if overlay.is_some() || path == "/events" {
        let allowed = (is_local(&addr) && trusted_host(host_of(req.headers()))) || app.overlay_lan(&app.lock());
        if !allowed { return plain(StatusCode::FORBIDDEN, t(lang, "Sottotitoli disponibili solo sul computer dell'app", &[])); }
        return match overlay { Some(f) => file(&app, &path, f), None => events(&app, &addr, req.uri().query().unwrap_or_default()) };
    }
    if let Some(f) = control_file(&path) {
        if !control_allowed(&app, &addr, req.headers()) {
            return plain(StatusCode::FORBIDDEN, t(lang, "Pagina di controllo disponibile solo sul computer dell'app", &[]));
        }
        return file(&app, &path, f);
    }
    plain(StatusCode::NOT_FOUND, t(lang, "Non trovato", &[]))
}

async fn upgrade(app: Arc<App>, addr: SocketAddr, req: Request) -> Response {
    if !control_allowed(&app, &addr, req.headers()) || !same_origin(req.headers()) { return StatusCode::FORBIDDEN.into_response(); }
    let (mut parts, _) = req.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &app).await {
        Ok(ws) => ws.max_message_size(MAX_MESSAGE).max_frame_size(MAX_MESSAGE).on_upgrade(move |socket| control(app, socket)),
        Err(e) => e.into_response(),
    }
}

async fn control(app: Arc<App>, socket: WebSocket) {
    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(QUEUE);
    let id = app.new_id();
    {
        let mut g = app.lock();
        let first = [app.schema(&g), g.public_state(), app.status(&mut g)];
        for m in first.into_iter().chain(app.shell.as_ref().map(|s| s.mic_state())) { let _ = tx.try_send(m.to_string()); }
        g.control.push(ControlClient { id, tx: tx.clone() });
    }
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() { break; }
        }
    });
    while let Some(Ok(message)) = source.next().await {
        match message {
            Message::Binary(data) => app.handle_audio(id, &data),
            Message::Text(text) => {
                let Ok(Value::Object(m)) = serde_json::from_str(&text) else { continue };
                app.handle_command(&tx, m);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    app.lock().control.retain(|c| c.id != id);
    app.forget_audio(id);
    writer.abort();
}

pub fn router(app: Arc<App>) -> Router { Router::new().fallback(handle).with_state(app) }

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, host.parse().unwrap());
        if let Some(o) = origin { h.insert(header::ORIGIN, o.parse().unwrap()); }
        h
    }
    #[test]
    fn nomi_che_puntano_a_questo_computer() {
        for ok in ["localhost:8787", "LOCALHOST", "127.0.0.1:8787", "[::1]:8787", "192.168.1.5:8787"] { assert!(trusted_host(ok), "{ok}"); }
        for no in ["evil.example:8787", "localhost.evil.example", "", "127.0.0.1.evil.example:1"] { assert!(!trusted_host(no), "{no}"); }
    }
    #[test]
    fn origine() {
        assert!(same_origin(&headers("localhost:8787", None)));
        assert!(same_origin(&headers("localhost:8787", Some("http://localhost:8787"))));
        assert!(!same_origin(&headers("localhost:8787", Some("http://evil.example"))));
        assert!(!same_origin(&headers("localhost:8787", Some("http://localhost:9999"))));
        assert!(!same_origin(&headers("localhost:8787", Some("null"))));
    }
}
