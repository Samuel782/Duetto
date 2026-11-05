// Log essenziali con orario. Nell'app installata finiscono anche su un file di dimensione limitata.
import fs from 'node:fs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const logFile = process.env.LOG_FILE || '';

function toFile(line) {
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch { /* il log non deve mai fermare l'app */ }
}

const stamp = () => new Date().toLocaleTimeString('it-IT', { hour12: false });
const text = (args) => args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ');

export function log(...args) {
  console.log(`[${stamp()}]`, ...args);
  toFile(text(args));
}

export function warn(...args) {
  console.warn(`[${stamp()}] ATTENZIONE:`, ...args);
  toFile(`ATTENZIONE: ${text(args)}`);
}
