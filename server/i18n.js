// Lingua dell'interfaccia. I testi sono scritti in italiano nel codice e fanno da chiave:
// public/i18n/en.json li traduce in inglese. Se una traduzione manca si vede l'italiano, mai un errore.
// Lo stesso dizionario serve al server (messaggi, errori, finestre di dialogo) e alle pagine.
import fs from 'node:fs';
import { warn } from './log.js';

export const UI_LANGUAGES = ['auto', 'it', 'en'];

let dict = {};
try {
  dict = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'));
} catch (err) {
  warn(`Traduzioni inglesi non caricate: ${err.message}`);
}
export const englishDictionary = () => dict;

let current = 'it';

// "auto" segue la lingua del sistema: italiano se il computer è in italiano, altrimenti inglese.
export function resolveLanguage(choice, systemLocale = '') {
  if (choice === 'it' || choice === 'en') return choice;
  return /^it\b/i.test(systemLocale) ? 'it' : 'en';
}

export function setLanguage(lang) { current = lang === 'en' ? 'en' : 'it'; }
export const language = () => current;
export const locale = () => (current === 'en' ? 'en-GB' : 'it-IT');

// t('Ne restano {n}', { n: 5 }): traduce e poi inserisce i valori.
export function t(text, vars = {}) {
  const template = current === 'en' ? (dict[text] ?? text) : text;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
