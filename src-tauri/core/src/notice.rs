//! Avviso al pubblico: sottotitoli generati con AI. Nella lingua dell'uscita, altrimenti in inglese.
pub const MAX_NOTICE: usize = 160;

pub fn notice_text<'a>(enabled: bool, custom: &'a str, lang: &str) -> &'a str {
    if !enabled { return ""; }
    if !custom.is_empty() { return custom; }
    match lang {
        "it" => "Sottotitoli e traduzioni generati con AI: possono contenere errori",
        "es" => "Subtítulos y traducciones generados con IA: pueden contener errores",
        "fr" => "Sous-titres et traductions générés par IA : ils peuvent contenir des erreurs",
        "de" => "KI-generierte Untertitel und Übersetzungen: können Fehler enthalten",
        "pt" => "Legendas e traduções geradas com IA: podem conter erros",
        "nl" => "Door AI gegenereerde ondertitels en vertalingen: kunnen fouten bevatten",
        _ => "AI-generated subtitles and translations: may contain errors",
    }
}
