// Esegue una funzione per riga JSON da stdin: serve a parity.mjs per il confronto con JavaScript.
use duetto_core::{segmenter::Word, transcript::Sentence, *};
use serde_json::{json, Value};
use std::{collections::HashMap, io::BufRead};

fn list(v: &Value) -> Vec<String> { v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect() }

fn run(name: &str, a: &Value) -> Value {
    let s = |i: usize| a[i].as_str().unwrap_or_default();
    match name {
        "clean" => json!(textclean::clean(s(0), a[1] == true, a[2] == true)),
        "glossary" => json!(glossary::parse_csv(s(0))),
        "chunks" => json!(captions::caption_chunks(s(0), a[1].as_u64().unwrap() as usize)),
        "obsAuth" => json!(captions::obs_auth(s(0), s(1), s(2))),
        "isNewer" => json!(updates::is_newer(s(0), s(1))),
        "notice" => json!(notice::notice_text(a[0] == true, s(1), s(2))),
        "t" => json!(i18n::t(if s(0) == "en" { i18n::Lang::En } else { i18n::Lang::It }, s(1), &[("n", "5"), ("error", "x{n}")])),
        "resolve" => json!(if i18n::resolve(s(0), s(1)) == i18n::Lang::It { "it" } else { "en" }),
        "detected" => json!(languages::code_from_detected(s(0))),
        "effective" => json!(languages::effective_target(s(0), s(1), &list(&a[2]))),
        "languages" => json!(languages::LANGUAGES.iter().map(|l| json!([l.code, l.name, l.file, l.source, l.target, l.latin, l.spoken()])).collect::<Vec<_>>()),
        "sanitizeLanguages" => json!(store::sanitize_languages(&a[0])),
        "captionsTarget" => json!(store::pick_captions_target(s(0), &list(&a[1]))),
        "mode" => json!(store::normalize_mode(s(0), &list(&a[1]))),
        "style" => json!(store::sanitize_style(&a[0])),
        "presets" => json!(store::sanitize_presets(&a[0])),
        "schema" => json!([store::style_schema(), store::default_styles()]),
        "mask" => json!(settings::mask_key(s(0))),
        "segment" => {
            let mut seg = segmenter::TurnSegmenter::new();
            let mut out = Vec::new();
            let words = |v: &Value| serde_json::from_value::<Vec<Word>>(v.clone()).unwrap();
            for step in a[0].as_array().unwrap() {
                let (blocks, partial) = seg.update(&words(step));
                out.push(json!({ "blocks": blocks, "partial": partial }));
            }
            out.push(json!(seg.finish(&words(&a[1]), s(2))));
            json!(out)
        }
        "store" => {
            std::fs::write(s(0), s(1)).unwrap();
            store::Store::load(s(0), s(2));
            json!(std::fs::read_to_string(s(0)).unwrap())
        }
        "settings" => {
            std::fs::write(s(0), s(1)).unwrap();
            let mut x = settings::Settings::load(s(0), None);
            x.update(a[2].as_object().unwrap());
            json!(std::fs::read_to_string(s(0)).unwrap())
        }
        "decrypt" => json!(settings::Cipher::new(&[7; 32]).decrypt(s(0))),
        "encrypt" => json!(settings::Cipher::new(&[7; 32]).encrypt(s(0))),
        "transcript" => {
            let mut t = transcript::Transcript::new(s(0).into());
            for e in a[1].as_array().unwrap() {
                let tr: HashMap<String, String> = serde_json::from_value(e["translations"].clone()).unwrap();
                t.add_sentence(&Sentence {
                    text: e["text"].as_str().unwrap(), lang: e["lang"].as_str().unwrap(), translations: &tr, targets: &list(&e["targets"]),
                    mode: "AUTO", start_at: e["startAt"].as_i64().unwrap(), end_at: e["endAt"].as_i64().unwrap(),
                });
            }
            json!(t.dir().map(|d| d.to_str()))
        }
        other => panic!("{other}"),
    }
}

fn main() {
    for line in std::io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        println!("{}", run(v[0].as_str().unwrap(), &v[1]));
    }
}
