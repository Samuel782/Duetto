// Stato persistente su JSON: modalità, stili e preset. Definisce anche lo schema degli stili,
// da cui la pagina di controllo genera il pannello e con cui il server valida ogni valore.
import fs from 'node:fs';
import path from 'node:path';
import { warn } from './log.js';

export const OUTPUTS = ['stream', 'room'];
export const VIEWS = ['both', 'translation', 'original'];
export const LANGUAGE_MODES = ['AUTO', 'IT', 'EN'];

const num = (key, label, min, max, step = 1) => ({ key, label, type: 'number', min, max, step });
const color = (key, label) => ({ key, label, type: 'color' });
const select = (key, label, options) => ({ key, label, type: 'select', options });

export const STYLE_SCHEMA = [
  { group: 'Carattere', fields: [
    { key: 'font', label: 'Font', type: 'font' },
    select('fontSource', 'Origine', [['system', 'Di sistema'], ['google', 'Google Font']]),
    num('weight', 'Peso', 100, 900, 100),
    num('size', 'Dimensione', 12, 200),
  ] },
  { group: 'Colori e contorno', fields: [
    color('colorOriginal', 'Originale'),
    color('colorTranslation', 'Traduzione'),
    color('outlineColor', 'Contorno'),
    num('outlineWidth', 'Spessore contorno', 0, 12, 0.5),
    color('shadowColor', 'Ombra'),
    num('shadowBlur', 'Sfocatura ombra', 0, 40),
    num('shadowOffset', 'Distanza ombra', 0, 30),
  ] },
  { group: 'Sfondo', fields: [
    select('bgMode', 'Tipo', [['none', 'Nessuno'], ['box', 'Riquadro'], ['full', 'Pieno']]),
    color('bgColor', 'Colore'),
    num('bgOpacity', 'Opacità', 0, 1, 0.05),
  ] },
  { group: 'Posizione', fields: [
    select('align', 'Allineamento', [['left', 'Sinistra'], ['center', 'Centro'], ['right', 'Destra']]),
    select('position', 'Posizione', [['top', 'Alto'], ['center', 'Centro'], ['bottom', 'Basso']]),
    num('marginX', 'Margine laterale', 0, 600),
    num('marginY', 'Margine verticale', 0, 500),
  ] },
  { group: 'Impaginazione', fields: [
    num('lines', 'Righe per lingua', 1, 8),
    num('charsPerLine', 'Caratteri per riga', 10, 120),
    num('lineHeight', 'Interlinea', 0.8, 2.5, 0.05),
    num('gap', 'Spazio tra le lingue', 0, 200),
    select('order', 'Ordine', [['original', 'Originale sopra'], ['translation', 'Traduzione sopra']]),
  ] },
  { group: 'Dissolvenza', fields: [
    num('fadeDuration', 'Durata (s)', 0, 10, 0.1),
    num('fadeAfter', 'Sparisce dopo (s)', 1, 120),
  ] },
];

const FIELDS = STYLE_SCHEMA.flatMap((g) => g.fields);

export const DEFAULT_STYLES = {
  stream: {
    font: 'Arial', fontSource: 'system', weight: 700, size: 44,
    colorOriginal: '#ffffff', colorTranslation: '#ffffff',
    outlineColor: '#000000', outlineWidth: 3,
    shadowColor: '#000000', shadowBlur: 6, shadowOffset: 2,
    bgMode: 'none', bgColor: '#000000', bgOpacity: 0.6,
    align: 'center', position: 'bottom', marginX: 80, marginY: 60,
    lines: 2, charsPerLine: 42, lineHeight: 1.2, gap: 14, order: 'original',
    fadeDuration: 0.6, fadeAfter: 6,
  },
  room: {
    font: 'Arial', fontSource: 'system', weight: 700, size: 72,
    colorOriginal: '#ffffff', colorTranslation: '#ffd84d',
    outlineColor: '#000000', outlineWidth: 0,
    shadowColor: '#000000', shadowBlur: 0, shadowOffset: 0,
    bgMode: 'full', bgColor: '#000000', bgOpacity: 1,
    align: 'center', position: 'center', marginX: 80, marginY: 60,
    lines: 3, charsPerLine: 40, lineHeight: 1.25, gap: 40, order: 'original',
    fadeDuration: 0.6, fadeAfter: 6,
  },
};

// Accetta solo campi noti con valori validi: i dati possono arrivare da un JSON importato.
export function sanitizeStyle(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const f of FIELDS) {
    const v = patch[f.key];
    if (v === undefined) continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = Math.min(f.max, Math.max(f.min, n));
    } else if (f.type === 'color') {
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[f.key] = v;
    } else if (f.type === 'select') {
      if (f.options.some((o) => o[0] === v)) out[f.key] = v;
    } else if (f.type === 'font') {
      if (typeof v === 'string' && /^[\p{L}\p{N} ,'-]{1,80}$/u.test(v)) out[f.key] = v;
    }
  }
  return out;
}

export function sanitizePresets(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [name, style] of Object.entries(input).slice(0, 200)) {
    const clean = name.trim().slice(0, 60);
    if (clean) out[clean] = sanitizeStyle(style);
  }
  return out;
}

export class Store {
  constructor(file, envLanguageMode) {
    this.file = file;
    this.timer = null;
    const data = this._read();
    const envMode = LANGUAGE_MODES.includes(envLanguageMode) ? envLanguageMode : 'AUTO';
    // Dopo un riavvio vale l'ultima modalità, salvo che il valore in .env sia stato cambiato.
    const keepSaved = data.envLanguageMode === envMode && LANGUAGE_MODES.includes(data.languageMode);
    this.state = {
      envLanguageMode: envMode,
      languageMode: keepSaved ? data.languageMode : envMode,
      lastLanguage: ['it', 'en'].includes(data.lastLanguage) ? data.lastLanguage : null,
      presets: sanitizePresets(data.presets),
      outputs: {},
    };
    for (const out of OUTPUTS) {
      const saved = data.outputs?.[out] || {};
      this.state.outputs[out] = {
        view: VIEWS.includes(saved.view) ? saved.view : 'both',
        hidden: saved.hidden === true,
        style: { ...DEFAULT_STYLES[out], ...sanitizeStyle(saved.style) },
      };
    }
    this.flush();
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`Stato non leggibile, uso i valori predefiniti: ${err.message}`);
      return {};
    }
  }

  // Salvataggio differito: i cursori dello stile producono molte modifiche ravvicinate.
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
  }

  // La scrittura passa da un file temporaneo: un arresto a metà non corrompe lo stato.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      warn(`Salvataggio dello stato non riuscito: ${err.message}`);
    }
  }
}
