//! Divide in blocchi di senso un turno lungo, mentre si parla: così la traduzione non aspetta la fine
//! del turno, che con chi parla senza pause può arrivare dopo decine di secondi.
//!
//! AssemblyAI non indica quali parole dei parziali siano stabili, e le più recenti cambiano spesso:
//! serve un margine, più breve dove il punto di taglio è più sicuro. I valori vengono da prove con
//! DeepL su parlato reale. Blocchi più lunghi ritardano le prime parole; con un limite di 50 caratteri
//! il significato si rompe: "lavora al secondo / livello" è diventato "operates every second".
use crate::js;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::LazyLock};

const SENTENCE_MARGIN: f64 = 100.0;
const CLAUSE_MARGIN: f64 = 200.0;
const LIMIT_MARGIN: f64 = 600.0;
const MIN_CHARS: usize = 25;
const MAX_CHARS: usize = 60;
const ORPHAN_LOOKAHEAD_WORDS: usize = 3;
const ORPHAN_SLACK_CHARS: usize = 25;
const ALIGN_WINDOW_WORDS: usize = 6;
const TAIL_WORDS: usize = 4;

static WEAK_ENDINGS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "a ad al allo alla ai agli alle che chi con cui da dal dalla dei del della delle dello di e ed gli i il in la le lo ma \
     nel nella o per più se si su sul sulla tra fra un una uno non come mentre perché quindi \
     an and are as at be but by for from has have if is it of on or so that the their this to we when which while who will with you not"
        .split_whitespace().collect()
});

#[derive(Clone, Debug, Deserialize)]
pub struct Word { pub text: String, pub start: f64, pub end: f64 }

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block { pub text: String, pub duration_ms: f64 }

// Solo lettere e cifre, come \p{L}\p{N}: `is_alphanumeric` di Rust comprende anche altri segni.
fn normalize(text: &str) -> String {
    static OTHER: LazyLock<fancy_regex::Regex> = LazyLock::new(|| fancy_regex::Regex::new(r"[^\p{L}\p{N}]").unwrap());
    OTHER.replace_all(&text.to_lowercase(), "").into_owned()
}
fn join(words: &[Word]) -> String { words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ") }
fn stop(w: &Word) -> bool { w.text.ends_with(['.', '!', '?', '…']) }
fn span(words: &[Word]) -> f64 {
    match (words.first(), words.last()) { (Some(a), Some(b)) => (b.end - a.start).max(0.0), _ => 0.0 }
}

#[derive(Default)]
pub struct TurnSegmenter { consumed: usize, tail: Vec<String>, blocks: usize }

impl TurnSegmenter {
    pub fn new() -> Self { Self::default() }

    /// Parole non ancora consegnate: conta la posizione, confermata dalle ultime consegnate.
    fn remaining<'a>(&mut self, words: &'a [Word]) -> &'a [Word] {
        if self.consumed == 0 { return words; }
        let texts: Vec<String> = words.iter().map(|w| normalize(&w.text)).collect();
        let from = self.consumed.saturating_sub(ALIGN_WINDOW_WORDS);
        let to = words.len().min(self.consumed + ALIGN_WINDOW_WORDS);
        let mut best = self.consumed.min(words.len());
        let (mut best_score, mut best_distance) = (0, usize::MAX);
        for p in from..=to {
            let score = self.tail.iter().enumerate()
                .filter(|(i, word)| (p + i).checked_sub(self.tail.len()).and_then(|k| texts.get(k)) == Some(*word)).count();
            let distance = p.abs_diff(self.consumed);
            if score > best_score || (score == best_score && distance < best_distance) {
                (best, best_score, best_distance) = (p, score, distance);
            }
        }
        // Una revisione può raddoppiare la parola al confine ("vogliamo / vogliamo ottenere").
        let next = texts.get(best).map_or("", String::as_str);
        if self.tail.last().is_some_and(|t| t == next) { best += 1; }
        self.consumed = best;
        &words[best.min(words.len())..]
    }

    fn commit(&mut self, words: &[Word], count: usize) -> Block {
        let block = &words[..count];
        self.consumed += count;
        self.tail.extend(block.iter().map(|w| normalize(&w.text)));
        self.tail.drain(..self.tail.len().saturating_sub(TAIL_WORDS));
        self.blocks += 1;
        Block { text: join(block), duration_ms: span(block) }
    }

    /// Dove tagliare; 0 se è meglio aspettare. L'ultima parola non vale: il suo punto è spesso provvisorio.
    fn choose_cut(words: &[Word]) -> usize {
        let latest = words[words.len() - 1].end;
        let (mut chars, mut clause, mut sentence, mut under, mut stable) = (0, 0, 0, 0, 0);
        for (i, w) in words[..words.len() - 1].iter().enumerate() {
            chars += js::len(&w.text) + 1;
            let age = latest - w.end;
            if chars <= MAX_CHARS + ORPHAN_SLACK_CHARS && age >= SENTENCE_MARGIN && stop(w) { sentence = i + 1; }
            if (MIN_CHARS..=MAX_CHARS).contains(&chars) && age >= CLAUSE_MARGIN && w.text.ends_with([',', ';', ':']) { clause = i + 1; }
            if age >= LIMIT_MARGIN {
                stable = i + 1;
                if chars <= MAX_CHARS { under = i + 1; }
            }
        }
        if sentence > 0 { return sentence; }
        if clause > 0 { return clause; }
        if stable <= under { return 0; }
        let mut cut = under.max(1);
        let upto = words.len().min(cut + ORPHAN_LOOKAHEAD_WORDS);
        let ahead = &words[cut..upto];
        if js::len(&join(&words[..upto])) <= MAX_CHARS + ORPHAN_SLACK_CHARS && ahead.iter().any(stop) { return 0; }
        for _ in 0..4 {
            if cut <= 1 || !WEAK_ENDINGS.contains(normalize(&words[cut - 1].text).as_str()) { break; }
            cut -= 1;
        }
        cut
    }

    /// Parziale: i blocchi pronti e il testo ancora provvisorio.
    pub fn update(&mut self, words: &[Word]) -> (Vec<Block>, String) {
        let mut blocks = Vec::new();
        let mut rest = self.remaining(words);
        while !rest.is_empty() {
            let cut = Self::choose_cut(rest);
            if cut == 0 { break; }
            blocks.push(self.commit(rest, cut));
            rest = &rest[cut..];
        }
        (blocks, join(rest))
    }

    /// Fine del turno: il resto. Se non è stato tagliato nulla vale il testo già formattato.
    pub fn finish(&mut self, words: &[Word], transcript: &str) -> Option<Block> {
        if self.blocks == 0 { return Some(Block { text: transcript.into(), duration_ms: span(words) }); }
        let rest = self.remaining(words);
        (!rest.is_empty()).then(|| Block { text: join(rest), duration_ms: span(rest) })
    }
}
