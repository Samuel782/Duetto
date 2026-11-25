use crate::js;
use fancy_regex::Regex;
use std::{collections::HashSet, sync::LazyLock};

static CELL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[\s\x{feff}--\x{85}]*("(?:[^"]|"")*"|[^,]*)[\s\x{feff}--\x{85}]*(?:,|$)"#).unwrap()
});

fn cell(raw: &str) -> String {
    let t = js::trim(raw);
    let t = t.strip_prefix('"').unwrap_or(t);
    t.strip_suffix('"').unwrap_or(t).replace("\"\"", "\"")
}

/// Coppie italiano, inglese. La prima riga di un termine ripetuto vince.
pub fn parse_csv(content: &str) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut pairs = Vec::new();
    for raw in content.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() || line.starts_with('#') { continue; }
        let cells: Vec<String> = CELL.captures_iter(line).take(2).flatten()
            .map(|c| cell(c.get(1).map_or("", |m| m.as_str()))).collect();
        let [it, en] = cells.as_slice() else { continue };
        let key = it.to_lowercase();
        if it.is_empty() || en.is_empty() || key == "italiano" || !seen.insert(key) { continue; }
        pairs.push((it.replace('\t', " "), en.replace('\t', " ")));
    }
    pairs
}
