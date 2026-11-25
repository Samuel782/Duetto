// Duetto desktop: finestre, portachiavi e microfono attorno al server in Rust.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod mic;
mod shell;

use duetto_core::{i18n::t, log::{log, warn}, settings::Cipher};
use duetto_server::{app::App, assembly::{AssemblyLink, LinkConfig}, config::Config};
use std::{
    process::Command,
    sync::{atomic::{AtomicBool, Ordering::SeqCst}, Arc, OnceLock},
    time::Duration,
};
use tauri::{
    async_runtime::{block_on, spawn},
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    utils::config::BackgroundThrottlingPolicy,
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN: &str = "com.samuelluggeri.duetto2";

static SERVER: OnceLock<Arc<App>> = OnceLock::new();
static QUIT_ASKED: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

fn testing() -> bool { std::env::var("DUETTO_TEST").is_ok_and(|v| v == "1") }

// Nella lingua scelta nelle Impostazioni.
fn text(key: &str) -> String {
    SERVER.get().map_or_else(|| key.into(), |s| { let lang = s.lock().lang; t(lang, key, &[]) })
}

// Chiave che cifra le chiavi API, custodita nel portachiavi. Se l'accesso è negato non se ne crea
// un'altra: renderebbe illeggibili le chiavi già salvate.
fn cipher() -> Option<Cipher> {
    // Nelle prove non serve, e una firma nuova farebbe comparire la richiesta di macOS.
    if testing() { return None; }
    let entry = keyring::Entry::new(KEYCHAIN, "chiave").ok()?;
    let key = match entry.get_secret() {
        Ok(k) if k.len() == 32 => k,
        Err(keyring::Error::NoEntry) => {
            let mut k = vec![0u8; 32];
            getrandom::fill(&mut k).ok()?;
            entry.set_secret(&k).ok()?;
            k
        }
        other => {
            warn(format!("Portachiavi non disponibile: {:?}", other.err()));
            return None;
        }
    };
    Some(Cipher::new(&key.try_into().ok()?))
}

#[cfg(target_os = "macos")]
fn keep_awake() {
    let _ = Command::new("/usr/bin/caffeinate").args(["-dims", "-w", &std::process::id().to_string()]).spawn();
}
#[cfg(windows)]
fn keep_awake() {
    #[link(name = "kernel32")]
    extern "system" { fn SetThreadExecutionState(flags: u32) -> u32; }
    // Continuo + sistema + schermo, sul filo principale che vive quanto l'app.
    unsafe { SetThreadExecutionState(0x8000_0003); }
}
#[cfg(not(any(target_os = "macos", windows)))]
fn keep_awake() {}

// Dopo un arresto anomalo macOS chiede se riaprire le finestre, e l'app resta ferma finché nessuno risponde.
#[cfg(target_os = "macos")]
fn no_reopen_question() {
    use objc2_foundation::{ns_string, NSUserDefaults};
    NSUserDefaults::standardUserDefaults().setBool_forKey(true, ns_string!("ApplePersistenceIgnoreState"));
}
#[cfg(not(target_os = "macos"))]
fn no_reopen_question() {}

// Sopra la barra dei menu, altrimenti può comparire sui sottotitoli in sala.
#[cfg(target_os = "macos")]
fn raise_room(w: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};
    let _ = w.set_simple_fullscreen(true);
    let _ = w.set_visible_on_all_workspaces(true);
    if let Ok(ptr) = w.ns_window() {
        unsafe { let _: () = msg_send![ptr as *mut AnyObject, setLevel: 26isize]; }
    }
}
#[cfg(not(target_os = "macos"))]
fn raise_room(w: &tauri::WebviewWindow) { let _ = w.set_fullscreen(true); }

// Un evento può essere in diretta: chiudere deve essere una scelta.
fn ask_quit(app: &AppHandle) {
    if QUIT_ASKED.swap(true, SeqCst) { return; }
    if testing() { log("Prova: conferma di chiusura"); }
    let h = app.clone();
    let mut d = app.dialog()
        .message(text("Se sei in diretta, i sottotitoli si fermano.")).title(text("Chiudere Duetto?")).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(text("Chiudi"), text("Annulla")));
    if let Some(w) = app.get_webview_window("main") { d = d.parent(&w); }
    d.show(move |yes| if yes { quit(&h) } else { QUIT_ASKED.store(false, SeqCst) });
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, SeqCst);
    app.exit(0);
}

fn fatal(app: &AppHandle, title: String, message: String) {
    warn(format!("{title}: {message}"));
    let h = app.clone();
    app.dialog().message(message).title(title).kind(MessageDialogKind::Error).show(move |_| quit(&h));
}

// Chiude la sessione, che si paga a connessione aperta, e lascia arrivare l'ultimo testo.
fn stop_server() {
    let Some(s) = SERVER.get() else { return };
    s.engine.shutdown();
    s.flush();
    // Dentro async: il temporizzatore va creato quando il runtime è attivo.
    block_on(async { tokio::time::sleep(Duration::from_millis(1500)).await });
    s.obs.stop();
    s.flush();
    log("Chiuso in ordine");
}

// Avvia il server e restituisce la porta.
fn start_server(app: &AppHandle) -> Result<u16, String> {
    let data = match std::env::var("DUETTO_DATA_DIR") {
        Ok(d) => d.into(),
        Err(_) => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    duetto_core::log::to_file(data.join("app.log"));
    let mut cfg = Config::from_env();
    cfg.keyterms = data.join("keyterms.txt");
    cfg.glossary = data.join("glossario.csv");
    if std::env::var("OUTPUT_DIR").is_err() {
        cfg.output_dir = app.path().document_dir().map_err(|e| e.to_string())?.join("Duetto");
    }
    if std::env::var("DUETTO_LOCALE").is_err() { cfg.locale = sys_locale::get_locale().unwrap_or_default(); }
    cfg.desktop_app = true;
    cfg.port_tries = 10;
    let desktop = shell::Desktop::new(app.clone(), data.join("mic.json"));
    cfg.data_dir = data;

    block_on(async {
        let (engine, events) = AssemblyLink::new(LinkConfig::from(&cfg));
        let server = App::new(cfg, engine, Some(desktop.clone()), cipher());
        let _ = SERVER.set(server.clone());
        server.listen(events);
        let (port, serve) = duetto_server::start(server.clone()).await.map_err(|e| e.to_string())?;
        desktop.start(&server);
        let h = app.clone();
        spawn(async move {
            let end = serve.await;
            if !QUITTING.load(SeqCst) { fatal(&h, "Duetto".into(), format!("Il server interno si è fermato / The internal server stopped: {end:?}")); }
        });
        Ok(port)
    })
}

type Builder<'a> = WebviewWindowBuilder<'a, tauri::Wry, AppHandle>;

fn window<'a>(app: &'a AppHandle, label: &str, url: Url, title: &str) -> Builder<'a> {
    let origin = url.origin();
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .initialization_script("window.DUETTO_NATIVE_MIC = true;")
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |u| u.origin() == origin);
    if testing() {
        b = b.initialization_script(include_str!("../probe.js"))
            .on_document_title_changed(|_, t| if t.starts_with("PROBE") { log(&t) });
    }
    b
}

fn open_child(app: &AppHandle, url: Url) {
    let label = match url.path() {
        "/overlay" => "room",
        "/settings" => "settings",
        _ => return,
    };
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_focus();
        return;
    }
    let mut external = None;
    let origin = url.origin();
    let mut b = window(app, label, url, &text(if label == "room" { "Uscita sala" } else { "Impostazioni" }));
    if label == "settings" {
        b = b.inner_size(720.0, 860.0);
    } else {
        b = b.inner_size(1280.0, 720.0);
        let primary = app.primary_monitor().ok().flatten();
        external = app.available_monitors().unwrap_or_default().into_iter()
            .find(|m| primary.as_ref().is_some_and(|p| p.position() != m.position()));
        // Senza un secondo schermo resta una finestra normale, per non coprire la regia.
        if let Some(m) = &external {
            let pos = m.position().to_logical::<f64>(m.scale_factor());
            b = b.position(pos.x, pos.y).decorations(false);
        }
        // Senza accesso alla tastiera nativa, Esc passa dalla pagina.
        b = b.initialization_script(
            "addEventListener('keydown', (e) => { if (e.key === 'Escape') location.href = 'duetto-close:'; }, true);",
        );
        let handle = app.clone();
        b = b.on_navigation(move |u| {
            if u.scheme() == "duetto-close" {
                if let Some(w) = handle.get_webview_window("room") { let _ = w.close(); }
                return false;
            }
            u.origin() == origin
        });
    }
    match b.build() {
        Ok(w) if external.is_some() => raise_room(&w),
        Ok(_) => {}
        Err(e) => warn(format!("Finestra {label}: {e}")),
    }
}

fn open_main(app: &AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let url: Url = format!("http://localhost:{port}/control").parse()?;
    let origin = url.origin();
    let handle = app.clone();
    // La regia parte sullo schermo principale: l'altro è della sala.
    let mut main = window(app, "main", url, "Duetto").inner_size(1440.0, 900.0);
    if let Some(m) = app.primary_monitor()? {
        let (pos, size) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
        main = main.position(pos.x + ((size.width - 1440.0) / 2.0).max(0.0), pos.y + ((size.height - 900.0) / 2.0).max(0.0));
    }
    main.min_inner_size(760.0, 600.0)
        .on_new_window(move |u, _| {
            if u.origin() != origin {
                if u.scheme() == "https" { let _ = handle.opener().open_url(u.as_str(), None::<&str>); }
            } else {
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || open_child(&h, u));
            }
            NewWindowResponse::Deny
        })
        .build()?;
    // Al primo avvio servono le chiavi: la finestra si apre da sola.
    if SERVER.get().is_some_and(|s| !s.has_keys()) {
        open_child(app, format!("http://localhost:{port}/settings").parse()?);
    }
    Ok(())
}

// Solo prova: riduce la regia a icona, chiede di chiudere, e dopo il limite chiude tutto, microfono compreso.
fn probe(app: &AppHandle) {
    let Some(limit) = std::env::var("DUETTO_PROBE").ok().and_then(|v| v.parse::<u64>().ok()).filter(|_| testing()) else { return };
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        log("Prova: regia ridotta a icona");
        if let Some(w) = h.get_webview_window("main") { let _ = w.minimize(); }
        std::thread::sleep(Duration::from_secs(limit.saturating_sub(24)));
        if let Some(w) = h.get_webview_window("main") { let _ = w.close(); }
        std::thread::sleep(Duration::from_secs(4));
        quit(&h);
    });
}

fn main() {
    no_reopen_question();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Menu proprio: la voce Esci predefinita salterebbe la conferma.
        .menu(|app| {
            let quit = MenuItem::with_id(app, "quit", text("Chiudi"), true, Some("CmdOrCtrl+Q"))?;
            let edit = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?, &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            Menu::with_items(app, &[&Submenu::with_items(app, "Duetto", true, &[&quit])?, &edit])
        })
        .on_menu_event(|app, e| if e.id().as_ref() == "quit" { ask_quit(app) })
        .setup(|app| {
            keep_awake();
            match start_server(app.handle()) {
                Ok(port) => open_main(app.handle(), port)?,
                Err(e) => {
                    let message = text("Nessuna porta disponibile: {error}").replace("{error}", &e);
                    fatal(app.handle(), text("Duetto non può partire"), message);
                }
            }
            probe(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("avvio di Tauri")
        .run(|app, event| match event {
            RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. }
                if label == "main" && !QUITTING.load(SeqCst) =>
            {
                api.prevent_close();
                ask_quit(app);
            }
            // Chiudere le altre finestre non chiude l'app.
            RunEvent::ExitRequested { api, code: None, .. } if !QUITTING.load(SeqCst) => api.prevent_exit(),
            RunEvent::Exit => stop_server(),
            _ => {}
        });
}
