// Lingue che Duetto sa riconoscere e tradurre.
// - source: lingua di partenza per DeepL; chi ce l'ha si può anche parlare (AssemblyAI la riconosce).
// - Tutte sono lingue di destinazione per DeepL.
// - latin: scritta in alfabeto latino, l'unico che i sottotitoli nativi CEA-608 sanno mostrare.
// I nomi sono in italiano e passano dal dizionario dell'interfaccia.

const CATALOG = [
  { code: 'it', name: 'Italiano', file: 'italiano', source: 'IT', target: 'IT', latin: true },
  { code: 'en', name: 'Inglese', file: 'inglese', source: 'EN', target: 'EN-GB', latin: true },
  { code: 'es', name: 'Spagnolo', file: 'spagnolo', source: 'ES', target: 'ES', latin: true },
  { code: 'fr', name: 'Francese', file: 'francese', source: 'FR', target: 'FR', latin: true },
  { code: 'de', name: 'Tedesco', file: 'tedesco', source: 'DE', target: 'DE', latin: true },
  { code: 'pt', name: 'Portoghese', file: 'portoghese', source: 'PT', target: 'PT-PT', latin: true },
  { code: 'nl', name: 'Olandese', file: 'olandese', source: 'NL', target: 'NL', latin: true },
  { code: 'ro', name: 'Rumeno', file: 'rumeno', source: 'RO', target: 'RO', latin: true },
  { code: 'sv', name: 'Svedese', file: 'svedese', source: 'SV', target: 'SV', latin: true },
  { code: 'da', name: 'Danese', file: 'danese', source: 'DA', target: 'DA', latin: true },
  { code: 'no', name: 'Norvegese', file: 'norvegese', source: 'NB', target: 'NB', latin: true },
  { code: 'fi', name: 'Finlandese', file: 'finlandese', source: 'FI', target: 'FI', latin: true },
  { code: 'et', name: 'Estone', file: 'estone', source: 'ET', target: 'ET', latin: true },
  { code: 'tr', name: 'Turco', file: 'turco', source: 'TR', target: 'TR', latin: true },
  { code: 'ru', name: 'Russo', file: 'russo', source: 'RU', target: 'RU', latin: false },
  { code: 'ar', name: 'Arabo', file: 'arabo', source: 'AR', target: 'AR', latin: false },
  { code: 'zh', name: 'Cinese', file: 'cinese', source: 'ZH', target: 'ZH-HANS', latin: false },
  { code: 'ja', name: 'Giapponese', file: 'giapponese', source: 'JA', target: 'JA', latin: false },
  { code: 'ko', name: 'Coreano', file: 'coreano', source: 'KO', target: 'KO', latin: false },
  { code: 'pl', name: 'Polacco', file: 'polacco', target: 'PL', latin: true },
  { code: 'cs', name: 'Ceco', file: 'ceco', target: 'CS', latin: true },
  { code: 'sk', name: 'Slovacco', file: 'slovacco', target: 'SK', latin: true },
  { code: 'sl', name: 'Sloveno', file: 'sloveno', target: 'SL', latin: true },
  { code: 'hu', name: 'Ungherese', file: 'ungherese', target: 'HU', latin: true },
  { code: 'lt', name: 'Lituano', file: 'lituano', target: 'LT', latin: true },
  { code: 'lv', name: 'Lettone', file: 'lettone', target: 'LV', latin: true },
  { code: 'id', name: 'Indonesiano', file: 'indonesiano', target: 'ID', latin: true },
  { code: 'el', name: 'Greco', file: 'greco', target: 'EL', latin: false },
  { code: 'bg', name: 'Bulgaro', file: 'bulgaro', target: 'BG', latin: false },
  { code: 'uk', name: 'Ucraino', file: 'ucraino', target: 'UK', latin: false },
];

export const LANGUAGES = CATALOG.map((l) => ({ ...l, spoken: !!l.source }));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
export const language = (code) => BY_CODE.get(code);
export const isSpoken = (code) => !!BY_CODE.get(code)?.spoken;
export const isTarget = (code) => BY_CODE.has(code);
// I sottotitoli nativi CEA-608 mostrano solo l'alfabeto latino.
export const isCaptionTarget = (code) => !!BY_CODE.get(code)?.latin;

// Lingua rilevata da DeepL ("EN", "NB", "ZH"…) o da AssemblyAI ("it", "en-US"…) nel codice di Duetto.
export function codeFromDetected(detected) {
  const value = String(detected || '').toLowerCase();
  if (!value) return '';
  if (BY_CODE.get(value)?.spoken) return value;
  const prefix = value.split(/[-_]/)[0];
  if (prefix === 'nb' || prefix === 'nn') return 'no';
  return BY_CODE.get(prefix)?.spoken ? prefix : '';
}

export const MAX_SPOKEN = 6;
export const MAX_TARGETS = 8;

// Elenca codici validi, senza doppioni, nell'ordine dato.
export function cleanCodes(list, check, max) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((c) => typeof c === 'string' && check(c)))].slice(0, max);
}

// La lingua in cui tradurre una frase detta in "spoken" per chi ha scelto "chosen".
// Se chi parla usa già la lingua scelta, si passa alla prima delle altre lingue di destinazione:
// con italiano e inglese, chi sceglie inglese vede l'inglese tradotto in italiano.
// Restituisce '' se non c'è niente in cui tradurre.
export function effectiveTarget(spoken, chosen, targets) {
  if (chosen && chosen !== spoken) return chosen;
  return targets.find((code) => code !== spoken) || '';
}
