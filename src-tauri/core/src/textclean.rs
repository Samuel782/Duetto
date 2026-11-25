//! Toglie gli intercalari e attenua le parolacce, in italiano e in inglese.
use crate::js;
use fancy_regex::{Captures, Regex};
use std::sync::LazyLock;

// Spazi come in JavaScript: con il BOM e senza U+0085.
const S: &str = r"[\s\x{feff}--\x{85}]";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("<S>", S)).expect(pattern)
}
macro_rules! regex {
    ($name:ident, $p:expr) => { static $name: LazyLock<Regex> = LazyLock::new(|| re($p)); };
}
regex!(HESITATIONS, r"(?i)(?<![\p{L}\p{N}])(?:e+h?m+|u+h?m+|m{2,}|hm+|e+h{2,}|u+h+|e+r+m+|um+)(?![\p{L}\p{N}])[,.…]*<S>*");
// Scritte per esteso: un rimando a un gruppo distinguerebbe maiuscole e minuscole ("cioè Cioè").
regex!(REPEATED, concat!(r"(?i)(?<![\p{L}\p{N}])(?:(cioè)(?:(?:<S>|,)+cioè)+|(you know)(?:(?:<S>|,)+you know)+|",
    r"(i mean)(?:(?:<S>|,)+i mean)+)(?![\p{L}\p{N}])"));
regex!(COMMA_FILLERS, r"(?i),<S>*(?:you know|i mean|like)<S>*(?=[,.!?…])");
regex!(START_FILLERS, r"(?i)(^|[.!?…]<S>+)(?:you know|i mean|like|cioè),<S>+");
regex!(PROFANITY, concat!(r"(?i)(?<![\p{L}\p{N}])(?:cazz[oiaeu]\p{L}*|minchi\p{L}*|stronz\p{L}*|merd\p{L}*|vaffancul\p{L}*|",
    r"fancul\p{L}*|coglion\p{L}*|incazz\p{L}*|bastard[oaie]|puttan\p{L}*|troi[ae]|fott\p{L}*|porc[oa] (?:dio|madonna|puttana)|",
    r"fuck\p{L}*|motherfuck\p{L}*|shit\p{L}*|bullshit|bitch\p{L}*|asshole\p{L}*|bastards?|dickhead\p{L}*|cunt\p{L}*|wank\p{L}*)(?![\p{L}\p{N}])"));
regex!(SPACE_BEFORE, r"<S>+([,.!?;:…])");
regex!(DOUBLE, r"([,;:])(?:<S>*[,;:])+");
regex!(COMMA_STOP, r",<S>*([.!?…])");
regex!(LEADING, r"^(?:<S>|[,.;:…])+");
regex!(SPACES, r"<S>{2,}");
regex!(ANY_WORD, r"[\p{L}\p{N}]");
regex!(UPPER, r"^\p{Lu}");
regex!(LOWER, r"^\p{Ll}");

// Un testo che manda in crisi l'espressione resta com'è: mai perdere un sottotitolo.
fn sub(re: &Regex, text: String, to: impl Fn(&Captures) -> String) -> String {
    match re.try_replacen(&text, 0, |c: &Captures| to(c)) {
        Ok(out) => out.into_owned(),
        Err(_) => text,
    }
}
fn first(c: &Captures) -> String { (1..c.len()).find_map(|i| c.get(i)).map_or("", |m| m.as_str()).into() }
fn none(_: &Captures) -> String { String::new() }
fn is(re: &Regex, text: &str) -> bool { re.is_match(text).unwrap_or(false) }

fn mask(word: &str) -> String {
    let n = word.chars().count();
    if n <= 2 { return word.into(); }
    word.chars().enumerate().map(|(i, c)| if i == 0 || i == n - 1 || c == ' ' { c } else { '*' }).collect()
}

fn tidy(text: String, original: &str) -> String {
    let out = sub(&SPACE_BEFORE, text, first);
    let out = sub(&DOUBLE, out, first);
    let out = sub(&COMMA_STOP, out, first);
    let out = sub(&LEADING, out, none);
    let out = sub(&SPACES, out, |_| " ".into());
    let out = js::trim(&out);
    if !is(&ANY_WORD, out) { return String::new(); }
    // Se è sparito l'inizio della frase, la maiuscola passa alla parola successiva.
    if is(&UPPER, original) && is(&LOWER, out) {
        let mut c = out.chars();
        return c.next().into_iter().flat_map(char::to_uppercase).chain(c).collect();
    }
    out.into()
}

pub fn clean(input: &str, fillers: bool, profanity: bool) -> String {
    let original = js::trim(input);
    let mut text = original.to_string();
    if fillers {
        text = sub(&HESITATIONS, text, none);
        text = sub(&REPEATED, text, first);
        text = sub(&START_FILLERS, text, first);
        text = sub(&COMMA_FILLERS, text, none);
    }
    if profanity { text = sub(&PROFANITY, text, |c| mask(c.get(0).map_or("", |m| m.as_str()))); }
    tidy(text, original)
}
