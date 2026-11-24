// Scrittura progressiva su disco: ogni frase è aggiunta subito ai file, senza cronologia in memoria.
import fs from 'node:fs';
import path from 'node:path';
import { language } from './languages.js';
import { warn } from './log.js';

const pad = (n, size = 2) => String(n).padStart(size, '0');

function srtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:` +
    `${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
}

const clock = (date) => date.toLocaleTimeString('it-IT', { hour12: false });

export class Transcript {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.enabled = true; // si può spegnere nelle Impostazioni
    this.dir = null;
    this.t0 = 0;
    this.counters = new Map(); // ogni file SRT numera i suoi sottotitoli
    this.lastEnd = 0;
  }

  // La cartella è creata alla prima scrittura e ogni avvio del server ne ha una propria.
  _ensureDir() {
    if (this.dir) return;
    const d = new Date();
    const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    this.dir = path.join(this.rootDir, name);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _append(file, text) {
    fs.appendFileSync(path.join(this.dir, file), text);
  }

  note(text) {
    if (!this.enabled) return;
    try {
      this._ensureDir();
      this._append('trascrizione.txt', `[${clock(new Date())}] *** ${text}\n`);
    } catch (err) {
      warn(`Trascrizione: ${err.message}`);
    }
  }

  _block(file, start, end, text) {
    const n = (this.counters.get(file) || 0) + 1;
    this.counters.set(file, n);
    this._append(file, `${n}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n\n`);
  }

  // entry: { text, lang, translations: { codice: testo }, targets: [codici], mode, startAt, endAt },
  // con orari in millisecondi. targets sono le lingue in onda per questa frase: ognuna ha il suo SRT,
  // anche quando la traduzione non è arrivata, così i file restano allineati.
  addSentence(entry) {
    if (!this.enabled) return;
    try {
      this._ensureDir();
      if (!this.t0) this.t0 = entry.startAt;
      // Gli SRT contano dal primo sottotitolo, con tempi sempre crescenti.
      const start = Math.max(entry.startAt - this.t0, this.lastEnd);
      const end = Math.max(entry.endAt - this.t0, start + 1000);
      this.lastEnd = end;
      this._block('originale.srt', start, end, entry.text);
      // Il file di una lingua contiene tutto in quella lingua: l'originale se è stato detto così,
      // altrimenti la traduzione. Senza traduzione resta l'originale.
      for (const code of new Set([entry.lang, ...entry.targets])) {
        const file = `${language(code)?.file || code}.srt`;
        this._block(file, start, end, code === entry.lang ? entry.text : entry.translations[code] || entry.text);
      }
      const lines = entry.targets.map((code) => `  ${code.toUpperCase()}: ${entry.translations[code] || '(non disponibile)'}\n`);
      this._append('trascrizione.txt',
        `[${clock(new Date(entry.startAt))}] [${entry.lang.toUpperCase()}] [modalità ${entry.mode}]\n` +
        `  Originale: ${entry.text}\n${lines.join('')}`);
    } catch (err) {
      warn(`Trascrizione: ${err.message}`);
    }
  }
}
