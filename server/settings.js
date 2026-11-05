// Impostazioni scelte dall'utente, chiavi API comprese. Il file è leggibile solo dal suo proprietario
// e le chiavi complete non vengono mai rimandate al browser.
import fs from 'node:fs';
import path from 'node:path';
import { warn } from './log.js';

const DEFAULTS = { assemblyaiApiKey: '', deeplApiKey: '', cleanFillers: null, cleanProfanity: null };

export class Settings {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) if (saved[key] !== undefined) this.values[key] = saved[key];
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`Impostazioni non leggibili: ${err.message}`);
    }
  }

  update(change) {
    for (const key of ['assemblyaiApiKey', 'deeplApiKey']) {
      // Campo vuoto: la chiave già salvata resta com'è.
      if (typeof change[key] === 'string' && change[key].trim()) this.values[key] = change[key].trim();
    }
    for (const key of ['cleanFillers', 'cleanProfanity']) {
      if (typeof change[key] === 'boolean') this.values[key] = change[key];
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
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
