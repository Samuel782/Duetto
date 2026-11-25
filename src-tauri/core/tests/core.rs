use duetto_core::{settings::*, store::Store, textclean::clean, transcript::Transcript};
use serde_json::json;
use std::path::PathBuf;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("duetto-core-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn cipher(n: u8) -> Option<Cipher> { Some(Cipher::new(&[n; 32])) }

#[test]
fn chiavi_cifrate_migrazione_e_chiave_diversa() {
    let f = dir("chiavi").join("settings.json");
    std::fs::write(&f, r#"{"deeplApiKey":"chiave-finta"}"#).unwrap();
    assert_eq!(Settings::load(&f, cipher(1)).values.deepl_api_key, "chiave-finta");
    assert!(!std::fs::read_to_string(&f).unwrap().contains("chiave-finta"));
    assert_eq!(Settings::load(&f, cipher(1)).values.deepl_api_key, "chiave-finta");
    assert_eq!(Settings::load(&f, cipher(2)).values.deepl_api_key, "");
    assert_eq!(Settings::load(&f, None).values.deepl_api_key, "");
}

#[cfg(unix)]
#[test]
fn file_delle_chiavi_solo_del_proprietario() {
    use std::os::unix::fs::PermissionsExt;
    let f = dir("permessi").join("settings.json");
    assert!(Settings::load(&f, None).update(json!({"deeplApiKey": "x"}).as_object().unwrap()));
    assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn salvataggio_differito() {
    let f = dir("stato").join("state.json");
    let mut s = Store::load(&f, "");
    s.state.language_mode = "it".into();
    s.save();
    s.flush_if_due();
    assert!(!std::fs::read_to_string(&f).unwrap().contains("\"languageMode\": \"it\""));
    std::thread::sleep(std::time::Duration::from_millis(550));
    s.flush_if_due();
    assert!(std::fs::read_to_string(&f).unwrap().contains("\"languageMode\": \"it\""));
}

#[test]
fn trascrizione_spenta_non_scrive() {
    let d = dir("spenta");
    let mut t = Transcript::new(d.clone());
    t.enabled = false;
    t.note("x");
    assert_eq!(std::fs::read_dir(d).unwrap().count(), 0);
}

#[test]
fn pulizia() {
    assert_eq!(clean("cioè Cioè, ehm, va bene", true, true), "va bene");
    assert_eq!(clean("bene cioè Cioè va", true, true), "bene cioè va");
    assert_eq!(clean(&"ehm ".repeat(5000), true, true), "");
}
