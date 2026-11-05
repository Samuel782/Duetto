// Pulizia del testo: toglie gli intercalari e attenua le parolacce, in italiano e in inglese.
const L = '\\p{L}\\p{N}';
const word = (body) => new RegExp(`(?<![${L}])(?:${body})(?![${L}])`, 'giu');

// Interiezioni da togliere ovunque, con l'eventuale punteggiatura che le segue.
const HESITATIONS = new RegExp(
  `(?<![${L}])(?:e+h?m+|u+h?m+|m{2,}|hm+|e+h{2,}|u+h+|e+r+m+|um+)(?![${L}])[,.…]*\\s*`, 'giu',
);
const REPEATED = /(?<![\p{L}\p{N}])(cioè|you know|i mean)(?:[\s,]+\1)+(?![\p{L}\p{N}])/giu;
// "you know" e "like" solo quando sono chiaramente riempitivi, cioè isolati dalle virgole.
const COMMA_FILLERS = /,\s*(?:you know|i mean|like)\s*(?=[,.!?…])/giu;
const START_FILLERS = /(^|[.!?…]\s+)(?:you know|i mean|like|cioè),\s+/giu;

const PROFANITY = word([
  'cazz[oiaeu]\\p{L}*', 'minchi\\p{L}*', 'stronz\\p{L}*', 'merd\\p{L}*', 'vaffancul\\p{L}*',
  'fancul\\p{L}*', 'coglion\\p{L}*', 'incazz\\p{L}*', 'bastard[oaie]', 'puttan\\p{L}*', 'troi[ae]',
  'fott\\p{L}*', 'porc[oa] (?:dio|madonna|puttana)',
  'fuck\\p{L}*', 'motherfuck\\p{L}*', 'shit\\p{L}*', 'bullshit', 'bitch\\p{L}*', 'asshole\\p{L}*',
  'bastards?', 'dickhead\\p{L}*', 'cunt\\p{L}*', 'wank\\p{L}*',
].join('|'));

function mask(match) {
  const chars = [...match];
  if (chars.length <= 2) return match;
  return chars[0] + chars.slice(1, -1).map((c) => (c === ' ' ? ' ' : '*')).join('') + chars[chars.length - 1];
}

function tidy(text, original) {
  let out = text
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/^[\s,.;:…]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(out)) return '';
  // Se è sparito l'inizio della frase, la maiuscola passa alla parola successiva.
  if (/^\p{Lu}/u.test(original) && /^\p{Ll}/u.test(out)) {
    out = out[0].toLocaleUpperCase() + out.slice(1);
  }
  return out;
}

export function createCleaner({ fillers = true, profanity = true } = {}) {
  return function clean(input) {
    let text = (input || '').trim();
    if (!text) return '';
    const original = text;
    if (fillers) {
      text = text
        .replace(HESITATIONS, '')
        .replace(REPEATED, '$1')
        .replace(START_FILLERS, '$1')
        .replace(COMMA_FILLERS, '');
    }
    if (profanity) text = text.replace(PROFANITY, mask);
    return tidy(text, original);
  };
}
