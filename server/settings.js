// Impostazioni scelte dall'utente, chiavi API comprese. Il file è leggibile solo dal suo proprietario
// e le chiavi complete non vengono mai rimandate al browser.
// Nell'app desktop le chiavi sono cifrate con il portachiavi del sistema (Portachiavi su Mac,
// DPAPI su Windows): copiare il file su un altro computer non basta per usarle.
import fs from 'node:fs';
import path from 'node:path';
import { UI_LANGUAGES } from './i18n.js';
import { warn } from './log.js';

const KEYS = ['assemblyaiApiKey', 'deeplApiKey'];
const DEFAULTS = {
  assemblyaiApiKey: '', deeplApiKey: '', assemblyaiRegion: 'auto', uiLanguage: 'auto', checkUpdates: true, cleanFillers: null, cleanProfanity: null,
};
export const REGIONS = ['auto', 'eu'];
const ENCRYPTED = 'enc:v1:';

// Cifratura fornita dall'app desktop prima di caricare il server. Senza, le chiavi restano in chiaro
// come nella versione da riga di comando.
let secrets = null;
export function setSecretStore(store) { secrets = store; }
export const keysEncrypted = () => !!secrets;

export class Settings {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`Impostazioni non leggibili: ${err.message}`);
    }
    let plain = false;
    for (const key of Object.keys(DEFAULTS)) {
      if (saved[key] === undefined) continue;
      if (KEYS.includes(key)) {
        this.values[key] = this.readKey(key, saved[key]);
        if (saved[key] && !saved[key].startsWith(ENCRYPTED)) plain = true;
      } else {
        this.values[key] = saved[key];
      }
    }
    if (!REGIONS.includes(this.values.assemblyaiRegion)) this.values.assemblyaiRegion = 'auto';
    if (!UI_LANGUAGES.includes(this.values.uiLanguage)) this.values.uiLanguage = 'auto';
    // Chiavi salvate in chiaro da una versione precedente: le cifra subito.
    if (plain && secrets) this.save();
  }

  readKey(key, stored) {
    if (typeof stored !== 'string' || !stored.startsWith(ENCRYPTED)) return typeof stored === 'string' ? stored : '';
    if (!secrets) {
      warn(`Chiave ${key} cifrata ma la cifratura non è disponibile: va reinserita`);
      return '';
    }
    try {
      return secrets.decrypt(stored.slice(ENCRYPTED.length));
    } catch (err) {
      warn(`Chiave ${key} non decifrabile (${err.message}): va reinserita`);
      return '';
    }
  }

  writeKey(value) {
    if (!value || !secrets) return value;
    return ENCRYPTED + secrets.encrypt(value);
  }

  update(change) {
    for (const key of KEYS) {
      // Campo vuoto: la chiave già salvata resta com'è.
      if (typeof change[key] === 'string' && change[key].trim()) this.values[key] = change[key].trim();
    }
    for (const key of ['cleanFillers', 'cleanProfanity', 'checkUpdates']) {
      if (typeof change[key] === 'boolean') this.values[key] = change[key];
    }
    if (REGIONS.includes(change.assemblyaiRegion)) this.values.assemblyaiRegion = change.assemblyaiRegion;
    if (UI_LANGUAGES.includes(change.uiLanguage)) this.values.uiLanguage = change.uiLanguage;
    return this.save();
  }

  save() {
    try {
      const out = { ...this.values };
      for (const key of KEYS) out[key] = this.writeKey(out[key]);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      warn(`Salvataggio delle impostazioni non riuscito: ${err.message}`);
      return false;
    }
  }
}

// Le ultime 4 cifre bastano per riconoscere una chiave senza mostrarla.
export const maskKey = (key) => (key ? `••••••••${key.slice(-4)}` : '');

export function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function writeTextFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
