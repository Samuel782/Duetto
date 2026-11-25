//! Confine con la trascrizione. Quella vera è `AssemblyLink`; `Idle` serve
//! alle prove che non la usano.
use duetto_core::i18n::Lang;
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};

pub type Pending<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineConfig {
    pub lang: Option<Lang>,
    pub assembly_key: String,
    pub assembly_url: String,
}

pub trait Engine: Send + Sync + 'static {
    /// Chiavi e indirizzi: valgono dalla prossima connessione.
    fn configure(&self, config: EngineConfig);
    fn set_languages(&self, mode: &str, spoken: &[String]);
    fn active(&self) -> bool;
    fn push_audio(&self, pcm: &[u8]);
    /// Chiude la sessione: la fatturazione è sulla connessione aperta.
    fn stop(&self);
    fn shutdown(&self);
    fn simulate_drop(&self, seconds: f64);
    /// Senza `configured` ed `estimatedCost`, che aggiunge il server.
    fn assembly_status(&self) -> Value;
    fn set_keyterms(&self, terms: Vec<String>);
    fn test_assembly(&self) -> Pending<Value>;
}

pub struct Idle { model: String }

impl Idle {
    pub fn new(model: String) -> Self { Self { model } }
}

impl Engine for Idle {
    fn configure(&self, _: EngineConfig) {}
    fn set_languages(&self, _: &str, _: &[String]) {}
    fn active(&self) -> bool { false }
    fn push_audio(&self, _: &[u8]) {}
    fn stop(&self) {}
    fn shutdown(&self) {}
    fn simulate_drop(&self, _: f64) {}
    fn assembly_status(&self) -> Value {
        json!({ "state": "idle", "fatal": false, "lastError": "", "sessionId": "", "model": self.model,
            "billedSeconds": 0, "bufferedMs": 0, "retryInSeconds": 0, "handoff": false })
    }
    fn set_keyterms(&self, _: Vec<String>) {}
    fn test_assembly(&self) -> Pending<Value> {
        Box::pin(async { json!({ "ok": false, "message": "AssemblyAI spento" }) })
    }
}
