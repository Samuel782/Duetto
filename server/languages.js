// Lingue che Duetto sa riconoscere e tradurre.
// - spoken: AssemblyAI la riconosce e DeepL la accetta come lingua di partenza.
// - Tutte sono lingue di destinazione per DeepL.
// - latin: scritta in alfabeto latino, l'unico che i sottotitoli nativi CEA-608 sanno mostrare.
// I nomi sono in italiano e passano dal dizionario dell'interfaccia.

export const LANGUAGES = [
  { code: 'it', name: 'Italiano', file: 'italiano', source: 'IT', target: 'IT', spoken: true, latin: true },
  { code: 'en', name: 'Inglese', file: 'inglese', source: 'EN', target: 'EN-GB', spoken: true, latin: true },
  { code: 'es', name: 'Spagnolo', file: 'spagnolo', source: 'ES', target: 'ES', spoken: true, latin: true },
  { code: 'fr', name: 'Francese', file: 'francese', source: 'FR', target: 'FR', spoken: true, latin: true },
  { code: 'de', name: 'Tedesco', file: 'tedesco', source: 'DE', target: 'DE', spoken: true, latin: true },
  { code: 'pt', name: 'Portoghese', file: 'portoghese', source: 'PT', target: 'PT-PT', spoken: true, latin: true },
  { code: 'nl', name: 'Olandese', file: 'olandese', source: 'NL', target: 'NL', spoken: true, latin: true },
  { code: 'ro', name: 'Rumeno', file: 'rumeno', source: 'RO', target: 'RO', spoken: true, latin: true },
  { code: 'sv', name: 'Svedese', file: 'svedese', source: 'SV', target: 'SV', spoken: true, latin: true },
  { code: 'da', name: 'Danese', file: 'danese', source: 'DA', target: 'DA', spoken: true, latin: true },
  { code: 'no', name: 'Norvegese', file: 'norvegese', source: 'NB', target: 'NB', spoken: true, latin: true },
  { code: 'fi', name: 'Finlandese', file: 'finlandese', source: 'FI', target: 'FI', spoken: true, latin: true },
  { code: 'et', name: 'Estone', file: 'estone', source: 'ET', target: 'ET', spoken: true, latin: true },
  { code: 'tr', name: 'Turco', file: 'turco', source: 'TR', target: 'TR', spoken: true, latin: true },
  { code: 'ru', name: 'Russo', file: 'russo', source: 'RU', target: 'RU', spoken: true, latin: false },
  { code: 'ar', name: 'Arabo', file: 'arabo', source: 'AR', target: 'AR', spoken: true, latin: false },
  { code: 'zh', name: 'Cinese', file: 'cinese', source: 'ZH', target: 'ZH-HANS', spoken: true, latin: false },
  { code: 'ja', name: 'Giapponese', file: 'giapponese', source: 'JA', target: 'JA', spoken: true, latin: false },
  { code: 'ko', name: 'Coreano', file: 'coreano', source: 'KO', target: 'KO', spoken: true, latin: false },
  { code: 'pl', name: 'Polacco', file: 'polacco', target: 'PL', spoken: false, latin: true },
  { code: 'cs', name: 'Ceco', file: 'ceco', target: 'CS', spoken: false, latin: true },
  { code: 'sk', name: 'Slovacco', file: 'slovacco', target: 'SK', spoken: false, latin: true },
  { code: 'sl', name: 'Sloveno', file: 'sloveno', target: 'SL', spoken: false, latin: true },
  { code: 'hu', name: 'Ungherese', file: 'ungherese', target: 'HU', spoken: false, latin: true },
  { code: 'lt', name: 'Lituano', file: 'lituano', target: 'LT', spoken: false, latin: true },
  { code: 'lv', name: 'Lettone', file: 'lettone', target: 'LV', spoken: false, latin: true },
  { code: 'id', name: 'Indonesiano', file: 'indonesiano', target: 'ID', spoken: false, latin: true },
  { code: 'el', name: 'Greco', file: 'greco', target: 'EL', spoken: false, latin: false },
  { code: 'bg', name: 'Bulgaro', file: 'bulgaro', target: 'BG', spoken: false, latin: false },
  { code: 'uk', name: 'Ucraino', file: 'ucraino', target: 'UK', spoken: false, latin: false },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
export const language = (code) => BY_CODE.get(code);
export const isSpoken = (code) => !!BY_CODE.get(code)?.spoken;
export const isTarget = (code) => BY_CODE.has(code);

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
