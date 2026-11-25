// Esegue una serie di passi (JSON su stdin) su DeepL: serve a parity-deepl.mjs.
use duetto_core::i18n::Lang;
use duetto_server::deepl::{DeepL, Request};
use serde_json::{json, Map, Value};
use std::io::Read;

#[tokio::main]
async fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let s = |x: &Value| x.as_str().unwrap_or_default().to_string();
    let c = &v["cfg"];
    let lang = |x: &Value| if x == "en" { Lang::En } else { Lang::It };
    let d = DeepL::new(&s(&c["apiKey"]), &s(&c["endpoint"]), &s(&c["modelType"]), c["useContext"] == true, lang(&c["lang"]));
    d.refresh_usage().await;
    let one = |o: Value| {
        let d = d.clone();
        async move {
            let accept: Vec<String> = o["accept"].as_array().into_iter().flatten().map(|x| x.as_str().unwrap().into()).collect();
            let r = Request { lang: o["lang"].as_str().unwrap(), context: o["context"].as_str().unwrap_or(""), detect: o["detect"] == true, accept: &accept };
            let targets = |l: &str| o["targets"][l].as_array().into_iter().flatten().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>();
            match d.translate(o["text"].as_str().unwrap(), r, targets).await {
                Some(t) => json!({ "lang": t.lang, "translations": t.translations.into_iter().map(|(k, v)| (k, Value::from(v))).collect::<Map<_, _>>() }),
                None => Value::Null,
            }
        }
    };
    let mut out = Vec::new();
    for step in v["steps"].as_array().unwrap() {
        let r = match step["op"].as_str().unwrap() {
            "translate" => one(step.clone()).await,
            "many" => json!(futures_util::future::join_all(step["list"].as_array().unwrap().iter().cloned().map(one)).await),
            "test" => d.test().await,
            "usage" => { d.refresh_usage().await; Value::Null }
            "glossary" => json!(d.sync_glossary(s(&step["file"]).as_ref()).await),
            "key" => { d.set_key(&s(&step["key"])); tokio::time::sleep(std::time::Duration::from_millis(150)).await; Value::Null }
            "lang" => { d.set_lang(lang(&step["lang"])); Value::Null }
            other => panic!("{other}"),
        };
        out.push(json!({ "r": r, "status": d.status() }));
    }
    println!("@@{}", json!(out));
}
