//! Piccole regole di JavaScript da cui dipendono i dati già salvati e i limiti di lunghezza.
use serde_json::Value;

/// Gli spazi secondo JavaScript: come Unicode, più il BOM e meno U+0085.
pub fn is_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}
/// `length` di JavaScript: unità UTF-16.
pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}
/// `slice(0, max)` di JavaScript, senza mai spezzare un carattere.
pub fn cut(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// `Number(v)`, se il risultato è finito.
pub fn number(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as u8 as f64,
        Value::Number(n) => n.as_f64()?,
        Value::Object(_) => return None,
        Value::String(_) | Value::Array(_) => {
            let t = text(v);
            let t = trim(&t);
            let radix = |p: &str, r| t.strip_prefix(p).or_else(|| t.strip_prefix(&p.to_uppercase()))
                .map(|d| if d.starts_with(['+', '-']) { f64::NAN } else { u64::from_str_radix(d, r).map_or(f64::NAN, |x| x as f64) });
            if t.is_empty() {
                0.0
            } else if let Some(n) = radix("0x", 16).or_else(|| radix("0o", 8)).or_else(|| radix("0b", 2)) {
                n
            } else if t.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) {
                t.parse().ok()?
            } else {
                return None;
            }
        }
    };
    n.is_finite().then_some(n)
}

/// JavaScript scrive 44, non 44.0.
pub fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 { Value::from(n as i64) } else { Value::from(n) }
}
