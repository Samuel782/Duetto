//! Il server di Duetto in Rust: pagine, overlay, regia e impostazioni.
pub mod app;
pub mod assembly;
pub mod config;
pub mod deepl;
pub mod engine;
pub mod obs;
pub mod sentences;
mod update;
mod web;

use app::{lan_addresses, App};
use duetto_core::log::{log, warn};
use std::{io, net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;

/// Apre la porta e avvia i compiti periodici. La funzione restituita serve le richieste.
pub async fn start(app: Arc<App>) -> io::Result<(u16, impl std::future::Future<Output = io::Result<()>>)> {
    let listener = bind(&app).await?;
    let port = listener.local_addr()?.port();
    app.lock().port = port;
    log(format!("Controllo:      http://localhost:{port}/control"));
    log(format!("Overlay OBS:    http://localhost:{port}/overlay?out=stream"));
    log(format!("Overlay sala:   http://localhost:{port}/overlay?out=room"));
    if app.overlay_lan(&app.lock()) {
        for ip in lan_addresses() { log(format!("Dalla rete:     http://{ip}:{port}/overlay?out=room")); }
    }
    if !app.has_keys() { warn("Chiavi mancanti: funziona solo la demo"); }

    let a = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        for n in 1u64.. {
            tick.tick().await;
            let mut g = a.lock();
            g.store.flush_if_due();
            if n % 10 == 0 { let s = a.status(&mut g); g.send_control(&s); }
            if n % 150 == 0 { g.ping(); }
        }
    });
    app.deepl.watch_usage();
    let a = app.clone();
    tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(3)).await; a.refresh_update(); });
    let a = app.clone();
    tokio::spawn(async move { a.reload_terms().await; });

    let service = web::router(app).into_make_service_with_connect_info::<SocketAddr>();
    Ok((port, async move { axum::serve(listener, service).await }))
}

// L'app installata prova le porte successive se quella abituale è occupata.
async fn bind(app: &App) -> io::Result<TcpListener> {
    let mut last = None;
    for port in (app.cfg.port..=u16::MAX).take(app.cfg.port_tries as usize) {
        match TcpListener::bind((app.cfg.host.as_str(), port)).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => { warn(format!("Porta {port} occupata")); last = Some(e); }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::ErrorKind::AddrInUse.into()))
}
