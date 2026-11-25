//! Sottotitoli nativi per OBS: pezzi di testo e risposta alla richiesta di password.
use crate::js;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

pub const CHUNK_CHARS: usize = 64;

pub fn caption_chunks(text: &str, size: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut line = String::new();
    for word in text.split(js::is_space).filter(|w| !w.is_empty()) {
        let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if js::len(&candidate) <= size { line = candidate; continue; }
        if !line.is_empty() { chunks.push(std::mem::take(&mut line)); }
        line = js::cut(word, size).into();
    }
    if !line.is_empty() { chunks.push(line); }
    chunks
}

pub fn obs_auth(password: &str, salt: &str, challenge: &str) -> String {
    let hash = |t: String| STANDARD.encode(Sha256::digest(t));
    hash(hash(format!("{password}{salt}")) + challenge)
}
