//! Confronto di versioni. La richiesta a GitHub arriverà con la parte di rete.

/// I numeri della versione, anche in un tag con un prefisso: "v1.2.1", "Duetto_1.2.1".
pub fn version_in(text: &str) -> &str {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() { i += 1; continue; }
        let digits = |mut j: usize| { while j < b.len() && b[j].is_ascii_digit() { j += 1 } j };
        let first = digits(i);
        let mut end = first;
        while end + 1 < b.len() && b[end] == b'.' && b[end + 1].is_ascii_digit() { end = digits(end + 1); }
        if end > first { return &text[i..end]; }
        i = first;
    }
    ""
}

/// Confronta 1.10.0 e 1.9.2 numero per numero.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| {
        let mut p = version_in(v).split('.').take(3).map(|n| n.parse::<f64>().unwrap_or(0.0)).collect::<Vec<_>>();
        p.resize(3, 0.0);
        p
    };
    let (a, b) = (parts(candidate), parts(current));
    (0..3).find(|&i| a[i] != b[i]).is_some_and(|i| a[i] > b[i])
}
