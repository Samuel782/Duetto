// Prototipo: finestra Tauri attorno al server Node esistente.
mod mic;

use base64::Engine;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering::SeqCst}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri::{
    utils::config::BackgroundThrottlingPolicy,
    webview::NewWindowResponse,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder,
};

struct Server(Mutex<Option<Child>>);
// Verso il server: una riga per messaggio. Chiuderlo fa fermare il server in ordine.
struct ToServer(Arc<Mutex<Option<ChildStdin>>>);

static QUIT_ASKED: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

// Testi delle finestre native, nella lingua scelta: li manda il server, che ha il dizionario.
static TEXTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const DEFAULT_TEXTS: [&str; 6] = ["Chiudi", "Annulla", "Chiudere Duetto?", "Se sei in diretta, i sottotitoli si fermano.", "Uscita sala", "Impostazioni"];
fn text(i: usize) -> String {
    TEXTS.lock().unwrap().get(i).cloned().unwrap_or_else(|| DEFAULT_TEXTS[i].into())
}

// Chiave che cifra le chiavi API, custodita nel portachiavi del sistema. Se il portachiavi nega
// l'accesso non se ne crea un'altra: renderebbe illeggibili le chiavi già salvate.
fn master_key() -> Option<String> {
    // Nelle prove con servizi finti non serve, e una firma nuova farebbe comparire la richiesta di macOS.
    if std::env::var("DUETTO_MOCK").is_ok_and(|v| v == "1") { return None; }
    let entry = keyring::Entry::new("com.samuelluggeri.duetto.prototipo", "chiave").ok()?;
    let key = match entry.get_secret() {
        Ok(k) if k.len() == 32 => k,
        Err(keyring::Error::NoEntry) => {
            let mut k = vec![0u8; 32];
            getrandom::fill(&mut k).ok()?;
            entry.set_secret(&k).ok()?;
            log("portachiavi: chiave creata");
            k
        }
        other => {
            log(&format!("portachiavi non disponibile: {:?}", other.err()));
            return None;
        }
    };
    log("portachiavi: chiave letta");
    Some(key.iter().map(|b| format!("{b:02x}")).collect())
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
fn raise_room(w: &tauri::WebviewWindow) {
    let _ = w.set_fullscreen(true);
}

// Un evento può essere in diretta: chiudere deve essere una scelta.
fn ask_quit(app: &tauri::AppHandle) {
    if QUIT_ASKED.swap(true, SeqCst) { return; }
    log("conferma di chiusura mostrata");
    let h = app.clone();
    let mut d = app.dialog()
        .message(text(3)).title(text(2)).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(text(0), text(1)));
    if let Some(w) = app.get_webview_window("main") { d = d.parent(&w); }
    d.show(move |yes| {
        if yes { quit(&h) } else { QUIT_ASKED.store(false, SeqCst) }
    });
}

fn quit(app: &tauri::AppHandle) {
    QUITTING.store(true, SeqCst);
    app.exit(0);
}

// Dentro il pacchetto server e Node stanno in Resources/app; in sviluppo si usa la cartella del progetto.
fn locate() -> (PathBuf, PathBuf) {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(PathBuf::from).unwrap_or_default();
    for root in [dir.join("../Resources/app"), dir.join("app")] {
        if root.join("server/index.js").exists() {
            let name = if cfg!(windows) { "node.exe" } else { "duetto-node" };
            return (root, dir.join(name));
        }
    }
    (concat!(env!("CARGO_MANIFEST_DIR"), "/..").into(), std::env::var("DUETTO_NODE").unwrap_or_else(|_| "node".into()).into())
}

fn log(line: &str) {
    println!("{line}");
    if let Ok(path) = std::env::var("DUETTO_PROBE_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn probing() -> bool {
    std::env::var("DUETTO_PROBE").is_ok()
}

fn start_mic(wanted: mic::Wanted, stdin: Arc<Mutex<Option<ChildStdin>>>) {
    let (tx, rx) = mpsc::sync_channel::<String>(100); // 10 s: se il server si blocca, l'audio vecchio si scarta
    std::thread::spawn(move || {
        for line in rx {
            if let Some(w) = stdin.lock().unwrap().as_mut() { let _ = writeln!(w, "{line}"); }
        }
    });
    std::thread::spawn(move || {
        mic::run(wanted, |event| {
            let line = match event {
                mic::Event::Frame { peak, pcm } => format!("PCM {peak:.5} {}", base64::engine::general_purpose::STANDARD.encode(pcm)),
                mic::Event::Devices(d) => format!("MIC {}", serde_json::json!({ "devices": d.iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect::<Vec<_>>() })),
                mic::Event::Opened(n) => format!("MIC {}", serde_json::json!({ "opened": n })),
                mic::Event::Failed(e) => format!("MIC {}", serde_json::json!({ "error": e })),
            };
            let _ = tx.try_send(line);
        });
    });
}

fn start_server(app: &tauri::AppHandle, data: &std::path::Path, docs: &std::path::Path) -> Result<(Child, u16, bool), String> {
    let (root, node) = locate();
    let mut child = Command::new(node)
        .arg("src-tauri/node-host.mjs")
        .current_dir(root)
        .env("DUETTO_LOCALE", sys_locale::get_locale().unwrap_or_default())
        .env("DATA_DIR", data)
        .env("OUTPUT_DIR", docs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Prima riga di stdin: la chiave. Mai nell'ambiente o negli argomenti, dove altri processi la leggono.
    let key = master_key().unwrap_or_default();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{key}").map_err(|e| e.to_string())?;
    let stdin = Arc::new(Mutex::new(Some(stdin)));
    app.manage(ToServer(stdin.clone()));
    let wanted = mic::Wanted::default();
    start_mic(wanted.clone(), stdin);
    let out = child.stdout.take().unwrap();
    let app = app.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(port) = line.strip_prefix("DUETTO_READY ") {
                let mut p = port.split_whitespace();
                let n = p.next().and_then(|v| v.parse::<u16>().ok()).unwrap_or(0);
                let _ = tx.send((n, p.next() == Some("1")));
            } else if let Some(name) = line.strip_prefix("DUETTO_MIC ") {
                if let Ok(name) = serde_json::from_str::<String>(name) { wanted.set(name) }
            } else if let Some(t) = line.strip_prefix("DUETTO_TEXTS ") {
                let list: Vec<String> = t.split('\t').map(String::from).collect();
                if list.len() == DEFAULT_TEXTS.len() { *TEXTS.lock().unwrap() = list; }
                continue;
            }
            log(&line);
        }
        if !QUITTING.load(SeqCst) && app.try_state::<Server>().is_some_and(|s| s.0.lock().unwrap().is_some()) {
            log("server terminato in modo imprevisto");
            let h = app.clone();
            app.dialog().message("Il server interno si è fermato. / The internal server stopped.")
                .title("Duetto").kind(MessageDialogKind::Error).show(move |_| quit(&h));
        }
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok((port, keys)) if port > 0 => Ok((child, port, keys)),
        _ => {
            let _ = child.kill();
            Err("il server non parte".into())
        }
    }
}

// Chiudere stdin fa fermare il server in ordine: così la sessione AssemblyAI smette di costare.
fn stop_server(app: &tauri::AppHandle) {
    let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() else { return };
    let end = Instant::now() + Duration::from_secs(4);
    while Instant::now() < end {
        // Se il filo audio sta scrivendo si riprova, senza restare bloccati.
        if let Ok(mut stdin) = app.state::<ToServer>().0.try_lock() { stdin.take(); }
        if matches!(child.try_wait(), Ok(Some(_))) {
            log("server chiuso in ordine");
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    log("server chiuso a forza");
}

type Builder<'a> = WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>;

fn window<'a>(app: &'a tauri::AppHandle, label: &str, url: Url, title: &str) -> Builder<'a> {
    let origin = url.origin();
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .initialization_script("window.DUETTO_NATIVE_MIC = true;")
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |u| u.origin() == origin);
    if probing() {
        b = b
            .initialization_script(format!("window.__PROBE_MODE = {:?};", std::env::var("DUETTO_PROBE_MODE").unwrap_or_default()))
            .initialization_script(include_str!("../probe.js"))
            .on_document_title_changed(|_, t| if t.starts_with("PROBE") { log(&t) });
    }
    b
}

fn open_child(app: &tauri::AppHandle, url: Url) {
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
    let mut b = window(app, label, url, &text(if label == "room" { 4 } else { 5 }));
    if label == "settings" {
        b = b.inner_size(720.0, 860.0);
    } else {
        b = b.inner_size(1280.0, 720.0);
        let primary = app.primary_monitor().ok().flatten();
        external = app.available_monitors().unwrap_or_default().into_iter()
            .find(|m| primary.as_ref().is_some_and(|p| p.position() != m.position()));
        if let Some(m) = &external {
            let pos = m.position().to_logical::<f64>(m.scale_factor());
            b = b.position(pos.x, pos.y).decorations(false);
            log("sala: secondo schermo");
        }
        // Senza accesso alla tastiera nativa, Esc passa dalla pagina.
        b = b.initialization_script(
            "addEventListener('keydown', (e) => { if (e.key === 'Escape') location.href = 'duetto-close:'; }, true);",
        );
        let handle = app.clone();
        let origin = app.get_webview_window("main").and_then(|w| w.url().ok()).map(|u| u.origin());
        b = b.on_navigation(move |u| {
            if u.scheme() == "duetto-close" {
                if let Some(w) = handle.get_webview_window("room") { let _ = w.close(); }
                return false;
            }
            Some(u.origin()) == origin
        });
    }
    match b.build() {
        // Su Mac lo schermo intero "semplice" copre tutto lo schermo senza creare uno Space.
        Ok(w) if external.is_some() => {
            raise_room(&w);
        }
        Ok(_) => {}
        Err(e) => log(&format!("finestra {label}: {e}")),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            log("seconda istanza: porto avanti la finestra");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Menu proprio: la voce Esci predefinita salterebbe la conferma.
        .menu(|app| {
            let quit = MenuItem::with_id(app, "quit", text(0), true, Some("CmdOrCtrl+Q"))?;
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
            let data = match std::env::var("DUETTO_DATA_DIR") {
                Ok(d) => d.into(),
                Err(_) => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data)?;
            let docs = match std::env::var("OUTPUT_DIR") {
                Ok(d) => d.into(),
                Err(_) => app.path().document_dir()?.join("Duetto"),
            };
            let (child, port, has_keys) = start_server(app.handle(), &data, &docs)?;
            app.manage(Server(Mutex::new(Some(child))));
            let url: Url = format!("http://localhost:{port}/control").parse()?;
            let origin = url.origin();
            let handle = app.handle().clone();
            // La regia parte sullo schermo principale: l'altro è della sala.
            let mut main = window(app.handle(), "main", url, "Duetto").inner_size(1440.0, 900.0);
            if let Some(m) = app.primary_monitor()? {
                let (pos, size) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
                main = main.position(pos.x + ((size.width - 1440.0) / 2.0).max(0.0), pos.y + ((size.height - 900.0) / 2.0).max(0.0));
            }
            main
                .min_inner_size(760.0, 600.0)
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
            if !has_keys {
                open_child(app.handle(), format!("http://localhost:{port}/settings").parse()?);
            }

            // Prove: chiude tutto dopo il limite, microfono compreso.
            if let Some(limit) = std::env::var("DUETTO_PROBE").ok().and_then(|v| v.parse::<u64>().ok()) {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(20));
                    log("--- regia ridotta a icona");
                    if let Some(w) = h.get_webview_window("main") { let _ = w.minimize(); }
                    std::thread::sleep(Duration::from_secs(limit.saturating_sub(20)));
                    quit(&h);
                });
            }
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
            RunEvent::Exit => stop_server(app),
            _ => {}
        });
}
