//! Scrittura progressiva su disco: ogni frase va subito nei file.
use crate::{languages::language, log::warn};
use chrono::{DateTime, Local, TimeZone};
use std::{collections::HashMap, fs, io, io::Write, path::{Path, PathBuf}};

fn srt_time(ms: i64) -> String {
    let t = ms.max(0);
    format!("{:02}:{:02}:{:02},{:03}", t / 3_600_000, t / 60_000 % 60, t / 1000 % 60, t % 1000)
}
fn clock(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).single().unwrap_or_else(Local::now).format("%H:%M:%S").to_string()
}

/// `targets` sono le lingue in onda: ognuna ha il suo SRT anche senza traduzione, così i file
/// restano allineati. Orari in millisecondi.
pub struct Sentence<'a> {
    pub text: &'a str,
    pub lang: &'a str,
    pub translations: &'a HashMap<String, String>,
    pub targets: &'a [String],
    pub mode: &'a str,
    pub start_at: i64,
    pub end_at: i64,
}

pub struct Transcript {
    root: PathBuf,
    pub enabled: bool,
    dir: Option<PathBuf>,
    t0: i64,
    counters: HashMap<String, u32>,
    last_end: i64,
}

impl Transcript {
    pub fn new(root: PathBuf) -> Self {
        Self { root, enabled: true, dir: None, t0: 0, counters: HashMap::new(), last_end: 0 }
    }
    pub fn dir(&self) -> Option<&Path> { self.dir.as_deref() }

    // La cartella nasce alla prima scrittura; ogni avvio ha la propria.
    fn append(&mut self, file: &str, text: &str) -> io::Result<()> {
        let dir = match &self.dir {
            Some(d) => d.clone(),
            None => {
                let now: DateTime<Local> = Local::now();
                let d = self.root.join(now.format("%Y-%m-%d_%H-%M-%S").to_string());
                fs::create_dir_all(&d)?;
                self.dir = Some(d.clone());
                d
            }
        };
        fs::OpenOptions::new().create(true).append(true).open(dir.join(file))?.write_all(text.as_bytes())
    }

    pub fn note(&mut self, text: &str) {
        if !self.enabled { return; }
        let line = format!("[{}] *** {text}\n", Local::now().format("%H:%M:%S"));
        if let Err(e) = self.append("trascrizione.txt", &line) { warn(format!("Trascrizione: {e}")); }
    }

    pub fn add_sentence(&mut self, s: &Sentence) {
        if !self.enabled { return; }
        if let Err(e) = self.write(s) { warn(format!("Trascrizione: {e}")); }
    }

    fn write(&mut self, s: &Sentence) -> io::Result<()> {
        if self.t0 == 0 { self.t0 = s.start_at; }
        // Gli SRT contano dal primo sottotitolo, con tempi sempre crescenti.
        let start = (s.start_at - self.t0).max(self.last_end);
        let end = (s.end_at - self.t0).max(start + 1000);
        self.last_end = end;
        self.block("originale.srt", start, end, s.text)?;
        let available = |code: &str| s.translations.get(code).map(String::as_str).filter(|x| !x.is_empty());
        let mut codes: Vec<&str> = Vec::new();
        for c in std::iter::once(s.lang).chain(s.targets.iter().map(String::as_str)) {
            if !codes.contains(&c) { codes.push(c); }
        }
        for code in codes {
            let file = format!("{}.srt", language(code).map_or(code, |l| l.file));
            let text = if code == s.lang { s.text } else { available(code).unwrap_or(s.text) };
            self.block(&file, start, end, text)?;
        }
        let mut out = format!("[{}] [{}] [modalità {}]\n  Originale: {}\n", clock(s.start_at), s.lang.to_uppercase(), s.mode, s.text);
        for code in s.targets {
            out += &format!("  {}: {}\n", code.to_uppercase(), available(code).unwrap_or("(non disponibile)"));
        }
        self.append("trascrizione.txt", &out)
    }

    fn block(&mut self, file: &str, start: i64, end: i64, text: &str) -> io::Result<()> {
        let n = self.counters.get(file).copied().unwrap_or(0) + 1;
        self.counters.insert(file.into(), n);
        self.append(file, &format!("{n}\n{} --> {}\n{text}\n\n", srt_time(start), srt_time(end)))
    }
}
