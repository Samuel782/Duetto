// I risultati della versione JavaScript (fino alla 1.2.3), conservati come riferimento: una modifica
// che li cambia deve essere voluta. Ogni riga di golden.json è [funzione, argomenti, risultato].
use duetto_core::{segmenter::Word, *};
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp() -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("duetto-golden-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(format!("{}.json", N.fetch_add(1, Relaxed)))
}

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
            let f = temp();
            std::fs::write(&f, s(1)).unwrap();
            store::Store::load(&f, s(2));
            // Le chiavi numeriche in JavaScript vengono prima: conta il contenuto.
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap()
        }
        "settings" => {
            let f = temp();
            std::fs::write(&f, s(1)).unwrap();
            settings::Settings::load(&f, None).update(a[2].as_object().unwrap());
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap()
        }
        "decrypt" => json!(settings::Cipher::new(&[7; 32]).decrypt(s(0))),
        "fixture" => {
            let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/parlato-continuo.json")).unwrap();
            let messages: Vec<Value> = serde_json::from_str(&text).unwrap();
            let words = |m: &Value| m["words"].as_array().unwrap().iter()
                .map(|w| Word { text: w[0].as_str().unwrap().into(), start: w[1].as_f64().unwrap(), end: w[2].as_f64().unwrap() }).collect::<Vec<_>>();
            let mut seg = segmenter::TurnSegmenter::new();
            let mut out: Vec<Value> = messages.iter().filter(|m| m["end_of_turn"] != true).map(|m| {
                let (blocks, partial) = seg.update(&words(m));
                json!({ "blocks": blocks, "partial": partial })
            }).collect();
            let last = messages.iter().find(|m| m["end_of_turn"] == true).unwrap();
            out.push(json!(seg.finish(&words(last), last["transcript"].as_str().unwrap())));
            json!(out)
        }
        other => panic!("{other}"),
    }
}

// JavaScript non distingue 1 da 1.0.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[test]
fn come_la_versione_javascript() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("golden.json")).unwrap();
    assert!(cases.len() > 3500);
    let mut bad = 0;
    for c in &cases {
        let name = c[0].as_str().unwrap();
        let got = run(name, &c[1]);
        let want = match (name, c[2].as_str()) { ("store" | "settings", Some(t)) => serde_json::from_str(t).unwrap(), _ => c[2].clone() };
        if !same(&got, &want) {
            bad += 1;
            if bad <= 5 { eprintln!("{name} {}\n  atteso {want}\n  avuto  {got}", c[1]); }
        }
    }
    let _ = std::fs::remove_dir_all(temp().parent().unwrap());
    assert_eq!(bad, 0, "{bad} casi su {}", cases.len());
}
