//! I testi sono in italiano nel codice e fanno da chiave; `public/i18n/en.json` li traduce.
use std::{collections::HashMap, sync::LazyLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang { It, En }

pub const UI_LANGUAGES: [&str; 3] = ["auto", "it", "en"];

static DICT: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../public/i18n/en.json")).expect("en.json")
});

/// "auto" segue il sistema: italiano se il computer è in italiano, altrimenti inglese.
pub fn resolve(choice: &str, system_locale: &str) -> Lang {
    match choice {
        "it" => Lang::It,
        "en" => Lang::En,
        _ => {
            let mut c = system_locale.chars();
            let starts = c.next().is_some_and(|x| x.eq_ignore_ascii_case(&'i')) && c.next().is_some_and(|x| x.eq_ignore_ascii_case(&'t'));
            if starts && !c.next().is_some_and(|x| x.is_ascii_alphanumeric() || x == '_') { Lang::It } else { Lang::En }
        }
    }
}

/// Traduce e poi inserisce i valori tra graffe. Un segnaposto senza valore resta com'è.
pub fn t(lang: Lang, text: &str, vars: &[(&str, &str)]) -> String {
    let template = match lang {
        Lang::En => DICT.get(text).map_or(text, String::as_str),
        Lang::It => text,
    };
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let value = rest.find('}').and_then(|j| vars.iter().find(|(k, _)| *k == &rest[1..j]).map(|(_, v)| (j, v)));
        match value {
            Some((j, v)) => { out.push_str(v); rest = &rest[j + 1..]; }
            None => { out.push('{'); rest = &rest[1..]; }
        }
    }
    out + rest
}
