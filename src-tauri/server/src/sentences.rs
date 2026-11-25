//! Dalla frase riconosciuta agli overlay e ai file: pulizia, lingua, traduzione, ordine.
use crate::{app::{App, Inner}, assembly::Event, deepl::{Request, Translated}};
use duetto_core::{js, languages::code_from_detected, store::VIEWS, textclean, transcript};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender}, task::JoinHandle};

const CONTEXT_CHARS: usize = 500;

/// Una frase conclusa, come arriva dalla trascrizione.
#[derive(Clone, Debug, Default)]
pub struct Final {
    pub text: String,
    pub continuation: bool,
    pub detected: String,
    /// "AUTO" oppure la lingua fissa con cui è stata riconosciuta.
    pub mode: String,
    pub duration_ms: f64,
}

struct Job { id: u64, text: String, guess: String, short: bool, mode: String, start_at: i64, end_at: i64, translated: JoinHandle<Option<Translated>> }

/// Contesto per DeepL: non viene tradotto né conteggiato.
#[derive(Default)]
pub struct Sentences { previous: Mutex<(String, String)>, queue: Mutex<Option<UnboundedSender<Job>>> }

fn is_short(text: &str) -> bool { text.split(js::is_space).filter(|w| !w.is_empty()).count() <= 2 }

/// Le ultime `max` unità UTF-16, senza spezzare un carattere.
fn last(text: &str, max: usize) -> &str {
    let mut units = 0;
    let mut start = text.len();
    for (i, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > max { break; }
        start = i;
    }
    &text[start..]
}

impl Inner {
    fn resolve_language(&self, s: &Final) -> String {
        let state = &self.store.state;
        let spoken = &state.languages.spoken;
        if s.mode != "AUTO" && spoken.contains(&s.mode) { return s.mode.clone(); }
        let detected = code_from_detected(&s.detected);
        if spoken.contains(&detected) && (!is_short(&s.text) || state.last_language.is_none()) { return detected; }
        state.last_language.clone().filter(|l| spoken.contains(l)).unwrap_or_else(|| spoken[0].clone())
    }
}

impl App {
    fn clean(&self, text: &str) -> String {
        let (fillers, profanity) = {
            let g = self.lock();
            let v = &g.settings.values;
            (v.clean_fillers.unwrap_or(self.cfg.clean_fillers), v.clean_profanity.unwrap_or(self.cfg.clean_profanity))
        };
        textclean::clean(text, fillers, profanity)
    }

    /// Lingua dei sottotitoli nativi per una frase: vuota se non vanno mandati.
    fn captions_language(&self, g: &Inner, lang: &str) -> String {
        if !self.obs.live() { return String::new(); }
        let target = &g.store.state.captions_target;
        if target == "original" { lang.into() } else { target.clone() }
    }

    /// Le lingue in onda per una frase detta in `lang`: solo queste vengono tradotte.
    pub fn targets_on_air(&self, lang: &str) -> Vec<String> {
        let mut g = self.lock();
        let mut wanted: Vec<String> = Vec::new();
        for i in 0..2 {
            let code = g.output_target(i, lang);
            if g.output(i).view != VIEWS[2] && !code.is_empty() && !wanted.contains(&code) { wanted.push(code); }
        }
        let captions = self.captions_language(&g, lang);
        if !captions.is_empty() && captions != lang && !wanted.contains(&captions) { wanted.push(captions); }
        wanted
    }

    /// Riceve gli eventi della trascrizione, nell'ordine in cui sono avvenuti.
    pub fn listen(self: &Arc<Self>, mut events: UnboundedReceiver<Event>) {
        let app = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(e) = events.recv().await {
                let Some(app) = app.upgrade() else { return };
                match e { Event::Partial(text, cont) => app.on_partial(&text, cont), Event::Final(f) => app.on_final(f) }
            }
        });
    }

    pub fn on_partial(&self, text: &str, continuation: bool) {
        let text = self.clean(text);
        self.lock().broadcast(&json!({ "t": "partial", "text": text, "cont": continuation }), None);
    }

    pub fn on_final(self: &Arc<Self>, sentence: Final) {
        let text = self.clean(&sentence.text);
        let short = is_short(&sentence.text);
        let end_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let (id, guess, accept) = {
            let mut g = self.lock();
            if text.is_empty() {
                g.broadcast(&json!({ "t": "partial", "text": "" }), None);
                return;
            }
            let guess = g.resolve_language(&sentence);
            let id = g.next_sentence();
            g.broadcast(&json!({ "t": "final", "id": id, "text": text, "lang": guess, "cont": sentence.continuation }), None);
            (id, guess, g.store.state.languages.spoken.clone())
        };
        // In AUTO la lingua la conferma DeepL: quella di AssemblyAI è un'ipotesi che sbaglia soprattutto
        // ai cambi di lingua. Una frase di una o due parole non basta a rilevarla.
        let detect = sentence.mode == "AUTO" && !short && accept.len() > 1;
        let context = {
            let p = self.sentences.previous.lock().unwrap_or_else(|e| e.into_inner());
            if p.1 == guess { p.0.clone() } else { String::new() }
        };
        let (app, t, l) = (self.clone(), text.clone(), guess.clone());
        let translated = tokio::spawn(async move {
            let request = Request { lang: &l, context: &context, detect, accept: &accept };
            app.deepl.translate(&t, request, |lang| app.targets_on_air(lang)).await
        });
        let job = Job { id, text, guess, short, mode: sentence.mode, start_at: end_at - sentence.duration_ms.round() as i64, end_at, translated };
        let mut queue = self.sentences.queue.lock().unwrap_or_else(|e| e.into_inner());
        let tx = queue.get_or_insert_with(|| self.start_writer());
        if let Err(lost) = tx.send(job) {
            // Lo scrittore si è fermato per un errore: se ne avvia un altro, la frase non si perde.
            let fresh = self.start_writer();
            let _ = fresh.send(lost.0);
            *queue = Some(fresh);
        }
    }

    // Le traduzioni arrivano in parallelo ma escono nell'ordine in cui le frasi sono state dette.
    fn start_writer(self: &Arc<Self>) -> UnboundedSender<Job> {
        let (tx, mut rx) = unbounded_channel::<Job>();
        let app = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(mut job) = rx.recv().await {
                let result = (&mut job.translated).await.ok().flatten();
                let Some(app) = app.upgrade() else { return };
                app.deliver(job, result);
            }
        });
        tx
    }

    fn deliver(&self, job: Job, result: Option<Translated>) {
        let (lang, found) = result.map_or((job.guess, Vec::new()), |r| (r.lang, r.translations));
        let translations: HashMap<String, String> = found.into_iter()
            .map(|(code, value)| (code, self.clean(&value))).filter(|(_, v)| !v.is_empty()).collect();
        let captions = {
            let mut g = self.lock();
            g.send_translations(job.id, |code| translations.get(code).cloned(), &lang);
            let state = &mut g.store.state;
            if (!job.short || state.last_language.is_none() || job.mode != "AUTO") && state.last_language.as_deref() != Some(&lang) {
                state.last_language = Some(lang.clone());
                g.store.save();
            }
            self.captions_language(&g, &lang)
        };
        if !captions.is_empty() {
            let text = if captions == lang { &job.text } else { translations.get(&captions).map_or("", String::as_str) };
            if !text.is_empty() { self.obs.push(text); }
        }
        {
            let mut p = self.sentences.previous.lock().unwrap_or_else(|e| e.into_inner());
            let before = if p.1 == lang { p.0.as_str() } else { "" };
            let joined = format!("{before} {}", job.text);
            *p = (last(js::trim(&joined), CONTEXT_CHARS).into(), lang.clone());
        }
        let targets = self.targets_on_air(&lang);
        self.lock().transcript.add_sentence(&transcript::Sentence {
            text: &job.text, lang: &lang, translations: &translations, targets: &targets, mode: &job.mode, start_at: job.start_at, end_at: job.end_at,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coda_del_contesto() {
        assert_eq!(last("abcdef", 3), "def");
        assert_eq!(last("abc", 10), "abc");
        assert_eq!(last("a👍b", 2), "b");
        assert_eq!(last("", 5), "");
    }
    #[test]
    fn frasi_corte() {
        assert!(is_short(" sì, certo ") && is_short(""));
        assert!(!is_short("uno due tre"));
    }
}
