// Ciò che il server chiede al guscio: cartella dei file e microfono. Lo stato del microfono vive qui,
// non nella pagina: vale anche se la pagina si ricarica o è nascosta.
use crate::mic;
use duetto_core::{files::write_atomic, log::{log, warn}};
use duetto_server::app::{App, Shell};
use serde_json::{json, Map, Value};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;

// Il microfono del guscio come sorgente audio: le pagine partono da 1.
const NATIVE: u64 = 0;

#[derive(Default)]
struct State { devices: Vec<(String, String)>, device: String, device_name: String, opened: String, error: String, started: bool, sending: bool }

pub struct Desktop { tauri: tauri::AppHandle, file: PathBuf, state: Mutex<State>, wanted: mic::Wanted, app: OnceLock<Weak<App>> }

impl Desktop {
    pub fn new(tauri: tauri::AppHandle, file: PathBuf) -> Arc<Self> {
        let saved: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let text = |k: &str| saved[k].as_str().unwrap_or_default().to_string();
        let state = State { device: text("device"), device_name: text("deviceName"), ..Default::default() };
        Arc::new(Self { tauri, file, state: Mutex::new(state), wanted: Default::default(), app: OnceLock::new() })
    }

    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|e| e.into_inner()) }
    fn app(&self) -> Option<Arc<App>> { self.app.get().and_then(Weak::upgrade) }

    /// Da chiamare una volta, quando il server è pronto.
    pub fn start(self: &Arc<Self>, app: &Arc<App>) {
        let _ = self.app.set(Arc::downgrade(app));
        let device = self.lock().device.clone();
        self.wanted.set(device);
        let me = self.clone();
        std::thread::spawn(move || loop {
            let (m, wanted) = (me.clone(), me.wanted.clone());
            // Un errore nella cattura non deve togliere il microfono per il resto dell'evento.
            if catch_unwind(AssertUnwindSafe(|| mic::run(wanted, |e| m.on_event(e)))).is_err() {
                warn("Microfono: errore interno, riparto");
            }
            std::thread::sleep(Duration::from_secs(1));
        });
    }

    fn on_event(&self, event: mic::Event) {
        match event {
            mic::Event::Frame { peak, pcm } => {
                let sending = self.lock().sending;
                let Some(app) = self.app() else { return };
                if sending { app.handle_audio(NATIVE, &pcm); }
                app.lock().send_control(&json!({ "t": "level", "peak": peak }));
                return;
            }
            mic::Event::Devices(d) => self.lock().devices = d,
            mic::Event::Opened(name) => {
                log(format!("Microfono: {name}"));
                let mut s = self.lock();
                s.opened = name;
                s.error.clear();
            }
            mic::Event::Failed(error) => {
                let mut s = self.lock();
                if s.error != error { warn(format!("Microfono: {error}")); }
                s.opened.clear();
                s.error = error;
            }
        }
        self.publish();
    }

    // Prima si legge lo stato, poi si usa il server: mai i due blocchi insieme.
    fn publish(&self) {
        let state = self.mic_state();
        if let Some(app) = self.app() { app.lock().send_control(&state); }
    }
}

impl Shell for Desktop {
    fn open_folder(&self, folder: PathBuf) {
        let _ = self.tauri.opener().open_path(folder.to_string_lossy(), None::<&str>);
    }

    fn mic_command(&self, m: &Map<String, Value>) {
        match m.get("cmd").and_then(Value::as_str).unwrap_or_default() {
            "micStart" => { let mut s = self.lock(); (s.started, s.sending) = (true, true); }
            "pause" => self.lock().sending = false,
            "micDevice" => {
                let Some(id) = m.get("device").and_then(Value::as_str).filter(|d| d.len() < 300) else { return };
                let mut s = self.lock();
                s.device = id.into();
                s.device_name = s.devices.iter().find(|d| d.0 == id).map(|d| d.1.clone()).unwrap_or_default();
                s.opened.clear();
                let saved = json!({ "device": s.device, "deviceName": s.device_name }).to_string();
                drop(s);
                if let Err(e) = write_atomic(&self.file, &saved, false) { warn(format!("Scelta dell'ingresso non salvata: {e}")); }
                self.wanted.set(id.into());
            }
            _ => return,
        }
        self.publish();
    }

    fn mic_state(&self) -> Value {
        let s = self.lock();
        let devices: Vec<Value> = s.devices.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect();
        json!({ "t": "mic", "devices": devices, "device": s.device, "deviceName": s.device_name, "opened": s.opened, "error": s.error,
            "started": s.started, "sending": s.sending })
    }
}
