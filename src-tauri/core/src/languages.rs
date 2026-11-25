//! Lingue che Duetto sa riconoscere e tradurre. Chi ha `source` si può anche parlare; `latin` è
//! l'unico alfabeto che i sottotitoli nativi CEA-608 sanno mostrare.
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct Language {
    pub code: &'static str,
    pub name: &'static str,
    pub file: &'static str,
    pub source: &'static str,
    pub target: &'static str,
    pub latin: bool,
}
impl Language {
    pub fn spoken(&self) -> bool { !self.source.is_empty() }
}

const fn l(code: &'static str, name: &'static str, file: &'static str, source: &'static str, target: &'static str, latin: bool) -> Language {
    Language { code, name, file, source, target, latin }
}

pub static LANGUAGES: &[Language] = &[
    l("it", "Italiano", "italiano", "IT", "IT", true),
    l("en", "Inglese", "inglese", "EN", "EN-GB", true),
    l("es", "Spagnolo", "spagnolo", "ES", "ES", true),
    l("fr", "Francese", "francese", "FR", "FR", true),
    l("de", "Tedesco", "tedesco", "DE", "DE", true),
    l("pt", "Portoghese", "portoghese", "PT", "PT-PT", true),
    l("nl", "Olandese", "olandese", "NL", "NL", true),
    l("ro", "Rumeno", "rumeno", "RO", "RO", true),
    l("sv", "Svedese", "svedese", "SV", "SV", true),
    l("da", "Danese", "danese", "DA", "DA", true),
    l("no", "Norvegese", "norvegese", "NB", "NB", true),
    l("fi", "Finlandese", "finlandese", "FI", "FI", true),
    l("et", "Estone", "estone", "ET", "ET", true),
    l("tr", "Turco", "turco", "TR", "TR", true),
    l("ru", "Russo", "russo", "RU", "RU", false),
    l("ar", "Arabo", "arabo", "AR", "AR", false),
    l("zh", "Cinese", "cinese", "ZH", "ZH-HANS", false),
    l("ja", "Giapponese", "giapponese", "JA", "JA", false),
    l("ko", "Coreano", "coreano", "KO", "KO", false),
    l("pl", "Polacco", "polacco", "", "PL", true),
    l("cs", "Ceco", "ceco", "", "CS", true),
    l("sk", "Slovacco", "slovacco", "", "SK", true),
    l("sl", "Sloveno", "sloveno", "", "SL", true),
    l("hu", "Ungherese", "ungherese", "", "HU", true),
    l("lt", "Lituano", "lituano", "", "LT", true),
    l("lv", "Lettone", "lettone", "", "LV", true),
    l("id", "Indonesiano", "indonesiano", "", "ID", true),
    l("el", "Greco", "greco", "", "EL", false),
    l("bg", "Bulgaro", "bulgaro", "", "BG", false),
    l("uk", "Ucraino", "ucraino", "", "UK", false),
];

pub const MAX_SPOKEN: usize = 6;
pub const MAX_TARGETS: usize = 8;

pub fn language(code: &str) -> Option<&'static Language> { LANGUAGES.iter().find(|x| x.code == code) }
pub fn is_spoken(code: &str) -> bool { language(code).is_some_and(Language::spoken) }
pub fn is_target(code: &str) -> bool { language(code).is_some() }
pub fn is_caption_target(code: &str) -> bool { language(code).is_some_and(|x| x.latin) }

/// Lingua rilevata da DeepL ("EN", "NB") o da AssemblyAI ("en-US") nel codice di Duetto, o "".
pub fn code_from_detected(detected: &str) -> String {
    let value = detected.to_lowercase();
    if is_spoken(&value) { return value; }
    let prefix = value.split(['-', '_']).next().unwrap_or("");
    if prefix == "nb" || prefix == "nn" { return "no".into(); }
    if is_spoken(prefix) { prefix.into() } else { String::new() }
}

/// Codici validi, senza doppioni, nell'ordine dato.
pub fn clean_codes(list: Option<&Value>, check: fn(&str) -> bool, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in list.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if check(c) && !out.iter().any(|x| x == c) { out.push(c.into()); }
    }
    out.truncate(max);
    out
}

/// In quale lingua tradurre per chi ha scelto `chosen`. Se è già la lingua parlata si passa alla
/// prima delle altre; "" se non c'è niente in cui tradurre.
pub fn effective_target<'a>(spoken: &str, chosen: &'a str, targets: &'a [String]) -> &'a str {
    if !chosen.is_empty() && chosen != spoken { return chosen; }
    targets.iter().find(|c| *c != spoken).map_or("", String::as_str)
}
