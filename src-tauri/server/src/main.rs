// Server da riga di comando, con le stesse variabili d'ambiente di server/index.js.
use duetto_core::log;
use duetto_server::{app::App, config::Config, assembly::{AssemblyLink, LinkConfig}, start};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    if let Some(f) = std::env::var_os("LOG_FILE").filter(|f| !f.is_empty()) { log::to_file(f.into()); }
    let cfg = Config::from_env();
    let (engine, events) = AssemblyLink::new(LinkConfig::from(&cfg));
    let app = App::new(cfg, engine, None, None);
    app.listen(events);
    let (_, serve) = start(app.clone()).await?;
    tokio::select! {
        r = serve => r?,
        _ = stop() => {}
    }
    app.engine.shutdown();
    app.flush();
    // Il tempo di ricevere l'ultimo testo finale e di chiudere la sessione, che si paga.
    tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => {}, _ = stop() => {} }
    app.obs.stop();
    app.flush();
    Ok(())
}

async fn stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
