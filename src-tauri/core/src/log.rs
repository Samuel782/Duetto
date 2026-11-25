//! Log essenziali con orario, anche su un file di dimensione limitata.
use std::{fs, io::Write, path::PathBuf, sync::OnceLock};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
static FILE: OnceLock<PathBuf> = OnceLock::new();

/// Da chiamare una volta all'avvio. Senza, si scrive solo a terminale.
pub fn to_file(path: PathBuf) {
    let _ = FILE.set(path);
}

fn write(line: &str) {
    let Some(file) = FILE.get() else { return };
    // Il log non deve mai fermare l'app.
    if fs::metadata(file).is_ok_and(|m| m.len() > MAX_BYTES) {
        let mut old = file.as_os_str().to_owned();
        old.push(".1");
        let _ = fs::rename(file, old);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(file) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let _ = writeln!(f, "{now} {line}");
    }
}

pub fn log(line: impl AsRef<str>) {
    println!("[{}] {}", chrono::Local::now().format("%H:%M:%S"), line.as_ref());
    write(line.as_ref());
}
pub fn warn(line: impl AsRef<str>) {
    eprintln!("[{}] ATTENZIONE: {}", chrono::Local::now().format("%H:%M:%S"), line.as_ref());
    write(&format!("ATTENZIONE: {}", line.as_ref()));
}
