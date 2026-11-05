// Divide in blocchi di senso un turno lungo, mentre si parla: così la traduzione non aspetta la
// fine del turno, che con chi parla senza pause può arrivare dopo decine di secondi.
//
// AssemblyAI non indica quali parole dei parziali siano stabili, e le più recenti cambiano spesso.
// Serve quindi un margine, più breve dove il punto di taglio è più sicuro.
//
// I valori vengono da prove con DeepL su parlato reale. Blocchi più lunghi ritardano le prime parole
// fino al loro invio; con un limite di 50 caratteri invece il significato si rompe: "lavora al
// secondo / livello" è diventato "operates every second".
const DEFAULTS = { sentenceMarginMs: 100, clauseMarginMs: 200, limitMarginMs: 600, minChars: 25, maxChars: 60 };
const ORPHAN_LOOKAHEAD_WORDS = 3; // non lasciare da sola la fine imminente di una frase
const ORPHAN_SLACK_CHARS = 25;
const ALIGN_WINDOW_WORDS = 6; // le revisioni possono unire o dividere qualche parola
const TAIL_WORDS = 4;

// Un blocco non deve finire con una di queste: la traduzione perderebbe il senso.
const WEAK_ENDINGS = new Set([
  'a', 'ad', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'che', 'chi', 'con', 'cui', 'da', 'dal', 'dalla', 'dei', 'del',
  'della', 'delle', 'dello', 'di', 'e', 'ed', 'gli', 'i', 'il', 'in', 'la', 'le', 'lo', 'ma', 'nel', 'nella', 'o', 'per',
  'più', 'se', 'si', 'su', 'sul', 'sulla', 'tra', 'fra', 'un', 'una', 'uno', 'non', 'come', 'mentre', 'perché', 'quindi',
  'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'if', 'is', 'it', 'of', 'on', 'or',
  'so', 'that', 'the', 'their', 'this', 'to', 'we', 'when', 'which', 'while', 'who', 'will', 'with', 'you', 'not',
]);

const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const joinWords = (words) => words.map((w) => w.text).join(' ');

export class TurnSegmenter {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.consumed = 0; // parole del turno già consegnate
    this.tail = []; // le ultime consegnate, per ritrovare il punto se le revisioni lo spostano
    this.blocks = 0;
  }

  // Parole non ancora consegnate. Ogni messaggio ripete tutto il turno: conta la posizione nella
  // sequenza, confermata dalle ultime parole consegnate. I tempi non servono: con parlato veloce
  // si spostano di oltre un secondo tra un messaggio e l'altro e duplicherebbero il testo.
  _remaining(words) {
    if (!this.consumed) return words;
    const texts = words.map((w) => normalize(w.text));
    const from = Math.max(0, this.consumed - ALIGN_WINDOW_WORDS);
    const to = Math.min(words.length, this.consumed + ALIGN_WINDOW_WORDS);
    let best = Math.min(this.consumed, words.length);
    let bestScore = 0;
    let bestDistance = Infinity;
    for (let p = from; p <= to; p++) {
      let score = 0;
      this.tail.forEach((word, i) => {
        if (texts[p - this.tail.length + i] === word) score += 1;
      });
      const distance = Math.abs(p - this.consumed);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = p;
        bestScore = score;
        bestDistance = distance;
      }
    }
    // Una revisione può raddoppiare la parola al confine ("vogliamo / vogliamo ottenere").
    if (normalize(words[best]?.text ?? '') === this.tail[this.tail.length - 1]) best += 1;
    this.consumed = best;
    return words.slice(best);
  }

  _commit(words, count) {
    const block = words.slice(0, count);
    const last = block[block.length - 1];
    this.consumed += count;
    this.tail = [...this.tail, ...block.map((w) => normalize(w.text))].slice(-TAIL_WORDS);
    this.blocks += 1;
    return { text: joinWords(block), durationMs: Math.max(0, last.end - block[0].start) };
  }

  // Sceglie dove tagliare; 0 se è meglio aspettare. Il punto sull'ultima parola non vale: i parziali
  // ne aggiungono spesso uno provvisorio in coda, anche a metà frase.
  _chooseCut(words) {
    const { sentenceMarginMs, clauseMarginMs, limitMarginMs, minChars, maxChars } = this.options;
    const latest = words[words.length - 1].end;
    let chars = 0;
    let clause = 0;
    let sentence = 0;
    let underLimit = 0;
    let stable = 0;
    for (let i = 0; i < words.length - 1; i++) {
      const w = words[i];
      chars += w.text.length + 1;
      const age = latest - w.end;
      if (chars <= maxChars + ORPHAN_SLACK_CHARS && age >= sentenceMarginMs && /[.!?…]$/.test(w.text)) sentence = i + 1;
      if (chars >= minChars && chars <= maxChars && age >= clauseMarginMs && /[,;:]$/.test(w.text)) clause = i + 1;
      if (age >= limitMarginMs) {
        stable = i + 1;
        if (chars <= maxChars) underLimit = i + 1;
      }
    }
    if (sentence) return sentence;
    if (clause) return clause;
    if (stable <= underLimit) return 0;
    // Nessuna punteggiatura utile: si taglia al limite, evitando di chiudere su una parola debole.
    let cut = Math.max(underLimit, 1);
    // Se la frase sta per finire, conviene aspettare il suo punto piuttosto che lasciare una parola sola.
    const ahead = words.slice(cut, cut + ORPHAN_LOOKAHEAD_WORDS);
    const aheadChars = joinWords(words.slice(0, cut + ORPHAN_LOOKAHEAD_WORDS)).length;
    if (aheadChars <= maxChars + ORPHAN_SLACK_CHARS && ahead.some((w) => /[.!?…]$/.test(w.text))) return 0;
    for (let back = 0; back < 4 && cut > 1 && WEAK_ENDINGS.has(normalize(words[cut - 1].text)); back++) cut -= 1;
    return cut;
  }

  // Parziale: restituisce i blocchi pronti e il testo ancora provvisorio.
  update(words) {
    const blocks = [];
    let remaining = this._remaining(words);
    while (remaining.length) {
      const cut = this._chooseCut(remaining);
      if (!cut) break;
      blocks.push(this._commit(remaining, cut));
      remaining = remaining.slice(cut);
    }
    return { blocks, partial: joinWords(remaining) };
  }

  // Fine del turno: il resto. Se non è stato tagliato nulla vale il testo già formattato.
  finish(words, transcript) {
    if (!this.blocks) return { text: transcript, durationMs: words.length ? Math.max(0, words[words.length - 1].end - words[0].start) : 0 };
    const remaining = this._remaining(words);
    if (!remaining.length) return null;
    return { text: joinWords(remaining), durationMs: Math.max(0, remaining[remaining.length - 1].end - remaining[0].start) };
  }
}
