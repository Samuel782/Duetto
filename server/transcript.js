// Scrittura progressiva su disco: ogni frase è aggiunta subito ai file, senza cronologia in memoria.
import fs from 'node:fs';
import path from 'node:path';
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
    this.dir = null;
    this.t0 = 0;
    this.counter = 0;
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
    try {
      this._ensureDir();
      this._append('trascrizione.txt', `[${clock(new Date())}] *** ${text}\n`);
    } catch (err) {
      warn(`Trascrizione: ${err.message}`);
    }
  }

  // entry: { text, translation, lang, mode, startAt, endAt } con orari in millisecondi.
  addSentence(entry) {
    try {
      this._ensureDir();
      if (!this.t0) this.t0 = entry.startAt;
      // Gli SRT contano dal primo sottotitolo, con tempi sempre crescenti.
      const start = Math.max(entry.startAt - this.t0, this.lastEnd);
      const end = Math.max(entry.endAt - this.t0, start + 1000);
      this.lastEnd = end;
      this.counter += 1;
      const block = (text) => `${this.counter}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n\n`;
      const other = entry.translation || entry.text; // senza traduzione resta l'originale
      const italian = entry.lang === 'it' ? entry.text : other;
      const english = entry.lang === 'en' ? entry.text : other;
      this._append('originale.srt', block(entry.text));
      this._append('italiano.srt', block(italian));
      this._append('inglese.srt', block(english));
      this._append('trascrizione.txt',
        `[${clock(new Date(entry.startAt))}] [${entry.lang.toUpperCase()}] [modalità ${entry.mode}]\n` +
        `  Originale:  ${entry.text}\n` +
        `  Traduzione: ${entry.translation || '(non disponibile)'}\n`);
    } catch (err) {
      warn(`Trascrizione: ${err.message}`);
    }
  }
}
