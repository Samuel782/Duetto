// Server locale: pagine, audio dal browser, trascrizione, traduzione e invio agli overlay.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AssemblyLink, testAssemblyKey } from './assemblyai.js';
import { DeepL } from './deepl.js';
import {
  englishDictionary, language, locale, resolveLanguage as resolveUiLanguage, setLanguage, t,
} from './i18n.js';
import { log, warn } from './log.js';
import {
  ASSEMBLY_URLS, Settings, keysEncrypted, maskKey, readTextFile, writeTextFile,
} from './settings.js';
import {
  DEFAULT_STYLES, OUTPUTS, STYLE_SCHEMA, Store, VIEWS, normalizeMode, pickCaptionsTarget, pickTarget,
  sanitizeLanguages, sanitizePresets, sanitizeStyle,
} from './store.js';
import {
  LANGUAGES, MAX_SPOKEN, MAX_TARGETS, codeFromDetected, effectiveTarget,
} from './languages.js';
import { noticeText } from './notice.js';
import { ObsCaptions } from './obs.js';
import { createCleaner } from './textclean.js';
import { Transcript } from './transcript.js';
import { checkForUpdate } from './updates.js';

// Gli errori non devono mai far cadere il processo durante l'evento.
process.on('uncaughtException', (err) => warn('Errore non gestito:', err));
process.on('unhandledRejection', (err) => warn('Promessa rifiutata:', err));

// L'app installata registra qui le azioni che solo il sistema operativo può compiere.
// micCommand e micState: microfono catturato dal guscio invece che dalla pagina.
export const hooks = { openFolder: null, micCommand: null, micState: null, sendControl: null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const flag = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true');
const PORT = Number(env.PORT) || 8787;
const HOST = env.HOST || '0.0.0.0';
const CONTROL_ALLOW_LAN = flag(env.CONTROL_ALLOW_LAN, false);
const OVERLAY_ALLOW_LAN = flag(env.OVERLAY_ALLOW_LAN, false);
const PRICE_PER_HOUR = Number(env.ASSEMBLYAI_PRICE_PER_HOUR) || 0.45;
const DATA_DIR = env.DATA_DIR || path.join(ROOT, 'data');
const OUTPUT_DIR = env.OUTPUT_DIR || path.join(ROOT, 'output');
const KEYTERMS_FILE = env.KEYTERMS_FILE || path.join(ROOT, 'keyterms.txt');
const GLOSSARY_FILE = env.GLOSSARY_FILE || path.join(ROOT, 'glossario.csv');

const store = new Store(path.join(DATA_DIR, 'state.json'), env.DEFAULT_LANGUAGE_MODE);
const state = store.state;
const settings = new Settings(path.join(DATA_DIR, 'settings.json'));
const transcript = new Transcript(OUTPUT_DIR);
transcript.enabled = settings.values.saveFiles;
const VERSION = env.DUETTO_VERSION || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Nuova versione su GitHub: solo nell'app desktop, se l'utente non l'ha disattivato.
// DUETTO_UPDATE_API sostituisce l'indirizzo di GitHub nei test.
let update = null;
async function refreshUpdate() {
  const wanted = env.DUETTO_UPDATE_API || (env.DESKTOP_APP === 'true' && env.DUETTO_TEST !== '1');
  update = wanted && settings.values.checkUpdates
    ? await checkForUpdate(VERSION, env.DUETTO_UPDATE_API || undefined)
    : null;
}
setTimeout(refreshUpdate, 3000);

// Una chiave salvata nelle Impostazioni ha la precedenza su quella nel file .env.
const assemblyKey = () => settings.values.assemblyaiApiKey || env.ASSEMBLYAI_API_KEY || '';
const deeplKey = () => settings.values.deeplApiKey || env.DEEPL_API_KEY || '';
const cleanFillers = () => settings.values.cleanFillers ?? flag(env.CLEAN_FILLERS, true);
const cleanProfanity = () => settings.values.cleanProfanity ?? flag(env.CLEAN_PROFANITY, true);
// Lingua dell'interfaccia: scelta nelle Impostazioni, oppure quella del sistema.
const applyLanguage = () => setLanguage(resolveUiLanguage(settings.values.uiLanguage, env.DUETTO_LOCALE || env.LANG || ''));
applyLanguage();
// Server AssemblyAI scelto nelle Impostazioni. L'indirizzo nel file .env, usato anche dai test, ha la precedenza.
const assemblyUrl = () => env.ASSEMBLYAI_WS_URL || ASSEMBLY_URLS[settings.values.assemblyaiRegion] || ASSEMBLY_URLS.auto;

let clean = createCleaner({ fillers: cleanFillers(), profanity: cleanProfanity() });

const deepl = new DeepL({
  apiKey: deeplKey(),
  endpoint: env.DEEPL_ENDPOINT || '', // vuoto: scelto in base alla chiave
  modelType: env.DEEPL_MODEL_TYPE ?? 'latency_optimized',
  useContext: flag(env.DEEPL_USE_CONTEXT, true),
});

const link = new AssemblyLink({
  apiKey: assemblyKey(),
  url: assemblyUrl(),
  model: env.ASSEMBLYAI_SPEECH_MODEL || 'universal-3-6-pro',
  minTurnSilence: env.MIN_TURN_SILENCE || '',
  maxTurnSilence: env.MAX_TURN_SILENCE || '700', // chiude prima l'ultimo blocco quando chi parla si ferma
  rolloverBeforeMs: (Number(env.SESSION_ROLLOVER_BEFORE_SECONDS) || 120) * 1000,
  sessionMaxMs: (Number(env.SESSION_MAX_SECONDS) || 0) * 1000,
});
link.setLanguages({ mode: state.languageMode, spoken: state.languages.spoken });

// Sottotitoli nativi della diretta, attraverso OBS.
const obs = new ObsCaptions();
const configureObs = () => obs.configure({
  enabled: !!settings.values.obsEnabled, host: settings.values.obsHost,
  port: settings.values.obsPort, password: settings.values.obsPassword,
});
configureObs();

// --- Termini chiave ---

function loadKeyterms() {
  let lines = [];
  try {
    lines = fs.readFileSync(KEYTERMS_FILE, 'utf8').split(/\r?\n/);
  } catch { /* file facoltativo */ }
  const terms = [...new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))];
  const valid = terms.filter((t) => t.length <= 50);
  if (valid.length < terms.length) warn(`keyterms.txt: ${terms.length - valid.length} termini oltre 50 caratteri ignorati`);
  if (valid.length > 100) warn(`keyterms.txt: tenuti i primi 100 termini su ${valid.length}`);
  return valid.slice(0, 100);
}

async function reloadTerms() {
  const terms = loadKeyterms();
  link.setKeyterms(terms);
  const glossary = await deepl.syncGlossary(GLOSSARY_FILE);
  const message = t('{n} termini chiave ricaricati. Glossario: {glossary}', { n: terms.length, glossary });
  log(message);
  return message;
}

// --- Overlay (Server-Sent Events) ---

const sseClients = { stream: new Set(), room: new Set() };

function sendSse(res, payload) {
  // Un client bloccato non deve far crescere la memoria del server.
  if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload, out = null) {
  for (const name of out ? [out] : OUTPUTS) for (const res of sseClients[name]) sendSse(res, payload);
}

const profileMessage = (out) => ({
  t: 'profile',
  ...state.outputs[out],
  notice: noticeText(settings.values.aiNotice, settings.values.aiNoticeText, state.outputs[out].target),
});

setInterval(() => {
  for (const name of OUTPUTS) for (const res of sseClients[name]) res.write(': ping\n\n');
}, 15000);

// --- Lingue ---

// La lingua in cui un'uscita mostra la traduzione di una frase detta in "lang".
const outputTarget = (out, lang) => effectiveTarget(lang, state.outputs[out].target, state.languages.targets);

// Le lingue in onda per una frase detta in "lang": una per ogni uscita che mostra la traduzione,
// più quella dei sottotitoli nativi se OBS li sta trasmettendo. Solo queste vengono tradotte.
function targetsOnAir(lang) {
  const wanted = new Set();
  for (const out of OUTPUTS) {
    if (state.outputs[out].view === 'original') continue;
    const code = outputTarget(out, lang);
    if (code) wanted.add(code);
  }
  const captions = captionsLanguage(lang);
  if (captions && captions !== lang) wanted.add(captions);
  return [...wanted];
}

// Lingua dei sottotitoli nativi per una frase: '' se non vanno mandati.
function captionsLanguage(lang) {
  if (!obs.status().live) return '';
  // Una sola lingua: se chi parla la usa già, passa l'originale.
  return state.captionsTarget === 'original' ? lang : state.captionsTarget;
}

// --- Elaborazione delle frasi ---

let sentenceSeq = 0;
let previous = { text: '', lang: null }; // contesto per DeepL: non viene tradotto né conteggiato
let writeTail = Promise.resolve(); // mantiene l'ordine delle frasi nei file

const isShortText = (text) => text.trim().split(/\s+/).length <= 2;

function resolveLanguage(sentence) {
  const { spoken } = state.languages;
  if (sentence.mode !== 'AUTO' && spoken.includes(sentence.mode)) return sentence.mode;
  const detected = codeFromDetected(sentence.detected);
  const valid = spoken.includes(detected) ? detected : '';
  if (valid && (!isShortText(sentence.text) || !state.lastLanguage)) return valid;
  return spoken.includes(state.lastLanguage) ? state.lastLanguage : spoken[0];
}

function setLastLanguage(lang) {
  if (state.lastLanguage !== lang) {
    state.lastLanguage = lang;
    store.save();
  }
}

link.on('partial', (text, continuation) => {
  broadcast({ t: 'partial', text: clean(text), cont: continuation });
});

// Ogni uscita riceve la traduzione nella sua lingua. Se non c'è, chi vede solo la traduzione
// legge l'originale.
function sendTranslations(id, lang, translations) {
  for (const out of OUTPUTS) {
    const code = outputTarget(out, lang);
    const text = code && translations[code];
    broadcast(text ? { t: 'translation', id, text, lang: code } : { t: 'translationFailed', id }, out);
  }
}

link.on('final', (sentence) => {
  const text = clean(sentence.text);
  if (!text) {
    broadcast({ t: 'partial', text: '' });
    return;
  }
  const guess = resolveLanguage(sentence);
  const isShort = isShortText(sentence.text);
  // In AUTO la lingua la conferma DeepL, frase per frase: quella di AssemblyAI è solo un'ipotesi, che
  // sbaglia soprattutto ai cambi di lingua. Una seconda richiesta serve solo se l'ipotesi è errata.
  // Una frase di una o due parole non basta a rilevarla e non cambia la lingua corrente.
  const detect = sentence.mode === 'AUTO' && !isShort && state.languages.spoken.length > 1;

  const id = ++sentenceSeq;
  const endAt = Date.now();
  broadcast({ t: 'final', id, text, lang: guess, cont: !!sentence.continuation });

  const context = previous.lang === guess ? previous.text : '';
  const translated = deepl.translate(text, {
    lang: guess, targetsFor: targetsOnAir, context, detect, accept: state.languages.spoken,
  }).catch(() => null);

  // Le traduzioni arrivano in parallelo ma escono nell'ordine in cui le frasi sono state dette.
  writeTail = writeTail.then(() => translated).then((result) => {
    const lang = result?.lang || guess;
    const translations = {};
    for (const [code, value] of Object.entries(result?.translations || {})) {
      const cleaned = clean(value);
      if (cleaned) translations[code] = cleaned;
    }
    sendTranslations(id, lang, translations);
    const captions = captionsLanguage(lang);
    if (captions) obs.push(captions === lang ? text : translations[captions] || '');
    if (!isShort || !state.lastLanguage || sentence.mode !== 'AUTO') setLastLanguage(lang);
    const sameLanguage = previous.lang === lang;
    previous = { text: `${sameLanguage ? previous.text : ''} ${text}`.trim().slice(-500), lang };
    transcript.addSentence({
      text, lang, translations, targets: targetsOnAir(lang), mode: sentence.mode,
      startAt: endAt - sentence.durationMs, endAt,
    });
  }).catch((err) => warn('Trascrizione:', err.message));
});

// --- Modalità demo: testo finto, nessun credito consumato, nessun file scritto ---
// Le frasi hanno il testo in italiano e in inglese: un'uscita impostata su un'altra lingua mostra l'originale.

const DEMO_LINES = [
  ['it', {
    it: 'Buongiorno a tutti e benvenuti alla prima sessione della giornata.',
    en: 'Good morning everyone and welcome to the first session of the day.',
  }],
  ['en', {
    en: 'Thank you very much for having me here today.',
    it: 'Grazie mille per avermi invitato qui oggi.',
  }],
  ['it', {
    it: 'Vorrei iniziare con una domanda semplice sul futuro del nostro settore.',
    en: 'I would like to start with a simple question about the future of our industry.',
  }],
  ['en', {
    en: 'The numbers show a clear trend over the last five years, and it is not slowing down.',
    it: 'I numeri mostrano una chiara tendenza negli ultimi cinque anni, e non sta rallentando.',
  }],
];
let demoTimer = null;

function startDemo() {
  if (demoTimer || link.active) return;
  log('Demo attiva');
  let line = 0;
  let word = 0;
  const step = () => {
    const [lang, texts] = DEMO_LINES[line];
    const text = texts[lang];
    const words = text.split(' ');
    word += 1;
    if (word < words.length) {
      broadcast({ t: 'partial', text: words.slice(0, word).join(' ') });
      demoTimer = setTimeout(step, 220);
      return;
    }
    const id = ++sentenceSeq;
    broadcast({ t: 'final', id, text, lang });
    demoTimer = setTimeout(() => {
      sendTranslations(id, lang, texts);
      line = (line + 1) % DEMO_LINES.length;
      word = 0;
      demoTimer = setTimeout(step, 1800);
    }, 350);
  };
  step();
}

function stopDemo() {
  if (!demoTimer) return;
  clearTimeout(demoTimer);
  demoTimer = null;
  log('Demo fermata');
  broadcast({ t: 'clear' });
}

// --- Pagina di controllo ---

const controlClients = new Set();
let audioOwner = null;
let audioOwnerAt = 0;

function sendControl(payload) {
  const data = JSON.stringify(payload);
  for (const ws of controlClients) {
    if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 1024) ws.send(data, () => {});
  }
}

const publicState = () => ({
  t: 'state', languageMode: state.languageMode, languages: state.languages, captionsTarget: state.captionsTarget,
  outputs: state.outputs, presets: state.presets,
});

function statusMessage() {
  const aai = link.status();
  return {
    t: 'status',
    aai: { ...aai, estimatedCost: Number((aai.billedSeconds / 3600 * PRICE_PER_HOUR).toFixed(2)), configured: !!assemblyKey(), euOnly: link.cfg.url.includes('.eu.') },
    deepl: deepl.status(),
    lastLanguage: state.lastLanguage,
    demo: !!demoTimer,
    update,
    obs: obs.status(),
    overlays: { stream: sseClients.stream.size, room: sseClients.room.size },
    outputDir: transcript.dir ? path.relative(ROOT, transcript.dir) : '',
  };
}

setInterval(() => sendControl(statusMessage()), 1000);

function setLanguageMode(value) {
  const mode = normalizeMode(value, state.languages.spoken);
  if (!mode || mode === state.languageMode) return;
  state.languageMode = mode;
  link.setLanguages({ mode });
  transcript.note(`Modalità lingua: ${mode}`);
  log(`Modalità lingua: ${mode}`);
}

// Nuove lingue dell'evento: modalità, uscite e sottotitoli restano su lingue ancora scelte.
function setLanguages(input) {
  const next = sanitizeLanguages({ ...state.languages, ...input });
  state.languages = next;
  if (state.languageMode !== 'AUTO' && !next.spoken.includes(state.languageMode)) state.languageMode = 'AUTO';
  if (!next.spoken.includes(state.lastLanguage)) state.lastLanguage = null;
  for (const out of OUTPUTS) {
    const target = pickTarget(state.outputs[out].target, next.targets);
    if (target !== state.outputs[out].target) setProfile(out, { target });
  }
  state.captionsTarget = pickCaptionsTarget(state.captionsTarget, next.targets);
  link.setLanguages({ mode: state.languageMode, spoken: next.spoken });
  const note = `Lingue: parlate ${next.spoken.join(', ')}; traduzioni ${next.targets.join(', ')}`;
  transcript.note(note);
  log(note);
}

function setProfile(out, change) {
  if (!OUTPUTS.includes(out)) return;
  Object.assign(state.outputs[out], change);
  broadcast(profileMessage(out), out);
}

const commands = {
  language: (m) => setLanguageMode(m.mode),
  // Le chip mandano una sola lista: l'altra resta com'è.
  languages: (m) => setLanguages({ spoken: m.spoken ?? state.languages.spoken, targets: m.targets ?? state.languages.targets }),
  target: (m) => { if (state.languages.targets.includes(m.lang)) setProfile(m.out, { target: m.lang }); },
  captionsTarget: (m) => {
    if (pickCaptionsTarget(m.lang, state.languages.targets) === m.lang) state.captionsTarget = m.lang;
  },
  view: (m) => { if (VIEWS.includes(m.view)) setProfile(m.out, { view: m.view }); },
  viewAll: (m) => { if (VIEWS.includes(m.view)) OUTPUTS.forEach((out) => setProfile(out, { view: m.view })); },
  hidden: (m) => { if (OUTPUTS.includes(m.out)) setProfile(m.out, { hidden: !state.outputs[m.out].hidden }); },
  clear: (m) => { if (OUTPUTS.includes(m.out)) broadcast({ t: 'clear' }, m.out); },
  style: (m) => {
    if (OUTPUTS.includes(m.out)) setProfile(m.out, { style: { ...state.outputs[m.out].style, ...sanitizeStyle(m.patch) } });
  },
  styleReset: (m) => { if (OUTPUTS.includes(m.out)) setProfile(m.out, { style: { ...DEFAULT_STYLES[m.out] } }); },
  presetSave: (m) => {
    const name = String(m.name || '').trim().slice(0, 60);
    if (name && OUTPUTS.includes(m.out)) state.presets[name] = { ...state.outputs[m.out].style };
  },
  presetLoad: (m) => {
    const preset = state.presets[m.name];
    if (preset && OUTPUTS.includes(m.out)) setProfile(m.out, { style: { ...state.outputs[m.out].style, ...preset } });
  },
  presetDelete: (m) => { delete state.presets[m.name]; },
  presetImport: (m) => { Object.assign(state.presets, sanitizePresets(m.presets)); },
  pause: () => { link.stop(); audioOwner = null; log('Pausa: sessione chiusa, nessun credito consumato'); },
  demo: (m) => { if (m.on) startDemo(); else stopDemo(); },
  simulateDrop: (m) => link.simulateDrop(Math.min(120, Math.max(1, Number(m.seconds) || 10))),
};

// Comandi delle Impostazioni. Le chiavi complete entrano ma non escono mai.
function settingsMessage() {
  return {
    t: 'settings',
    assemblyaiKey: maskKey(assemblyKey()),
    deeplKey: maskKey(deeplKey()),
    cleanFillers: cleanFillers(),
    cleanProfanity: cleanProfanity(),
    assemblyaiRegion: settings.values.assemblyaiRegion,
    uiLanguage: settings.values.uiLanguage,
    checkUpdates: settings.values.checkUpdates,
    saveFiles: settings.values.saveFiles,
    overlayLan: overlayLan(),
    aiNotice: settings.values.aiNotice,
    aiNoticeText: settings.values.aiNoticeText,
    obsEnabled: settings.values.obsEnabled,
    obsHost: settings.values.obsHost,
    obsPort: settings.values.obsPort,
    obsPassword: maskKey(settings.values.obsPassword),
    keysEncrypted: keysEncrypted(),
    keyterms: readTextFile(KEYTERMS_FILE),
    glossary: readTextFile(GLOSSARY_FILE),
  };
}

async function saveSettings(ws, m) {
  const before = language();
  const checkedUpdates = settings.values.checkUpdates;
  const saved = settings.update(m);
  applyLanguage();
  // GitHub si interroga all'avvio, e di nuovo solo se il controllo cambia.
  if (settings.values.checkUpdates !== checkedUpdates) refreshUpdate();
  // Le pagine aperte si ricaricano nella nuova lingua: la regia solo se non sta inviando audio.
  if (language() !== before) sendControl({ t: 'language', lang: language() });
  link.setApiKey(assemblyKey());
  link.cfg.url = assemblyUrl(); // vale dalla prossima connessione
  transcript.enabled = settings.values.saveFiles;
  OUTPUTS.forEach((out) => broadcast(profileMessage(out), out));
  if (!overlayLan()) closeRemoteOverlays();
  sendControl({ t: 'links', links: overlayLinks() });
  configureObs();
  if (deeplKey() !== deepl.cfg.apiKey) deepl.setApiKey(deeplKey());
  clean = createCleaner({ fillers: cleanFillers(), profanity: cleanProfanity() });
  try {
    if (typeof m.keyterms === 'string') writeTextFile(KEYTERMS_FILE, m.keyterms);
    if (typeof m.glossary === 'string') writeTextFile(GLOSSARY_FILE, m.glossary);
  } catch (err) {
    warn(`Salvataggio di termini e glossario non riuscito: ${err.message}`);
  }
  const [assemblyai, deeplResult] = await Promise.all([
    testAssemblyKey({ url: link.cfg.url, model: link.cfg.model, apiKey: assemblyKey() }),
    deepl.test(),
  ]);
  const terms = await reloadTerms();
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ t: 'settingsResult', saved, assemblyai, deepl: deeplResult, terms }));
    ws.send(JSON.stringify(settingsMessage()));
  }
}

async function handleCommand(ws, m) {
  if (m.cmd === 'reloadTerms') {
    const message = await reloadTerms();
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'notice', message }));
    return;
  }
  if (m.cmd === 'settingsGet') {
    if (ws.readyState === 1) ws.send(JSON.stringify(settingsMessage()));
    return;
  }
  if (m.cmd === 'settingsSave') {
    await saveSettings(ws, m);
    return;
  }
  if (m.cmd === 'openOutputFolder') {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    hooks.openFolder?.(OUTPUT_DIR);
    return;
  }
  if (hooks.micCommand && ['micStart', 'micDevice', 'pause'].includes(m.cmd)) hooks.micCommand(m);
  const command = Object.hasOwn(commands, m.cmd) ? commands[m.cmd] : null;
  if (!command) return;
  command(m);
  store.save();
  sendControl(publicState());
}

function handleAudio(ws, data) {
  // PCM 16 bit: AssemblyAI accetta blocchi tra 50 e 1000 ms.
  if (data.length % 2 !== 0 || data.length < 1600 || data.length > 32000) return;
  const now = Date.now();
  if (audioOwner !== ws && now - audioOwnerAt < 1000) return; // una sola sorgente alla volta
  audioOwner = ws;
  audioOwnerAt = now;
  if (demoTimer) stopDemo();
  link.pushAudio(data);
}

// Audio catturato dal guscio.
hooks.sendControl = sendControl;
const NATIVE_SOURCE = {};
export function nativeAudio(data) { handleAudio(NATIVE_SOURCE, data); }

// --- HTTP ---

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const controlAllowed = (req) => CONTROL_ALLOW_LAN || isLocal(req);
// I sottotitoli escono da questo computer solo se l'operatore lo permette.
const overlayLan = () => OVERLAY_ALLOW_LAN || settings.values.overlayLan;
const overlayAllowed = (req) => overlayLan() || isLocal(req);

function closeRemoteOverlays() {
  for (const out of OUTPUTS) for (const res of sseClients[out]) if (!isLocal(res.req)) res.destroy();
}

// Un collegamento da un altro sito non deve poter comandare il server.
function sameOrigin(req) {
  const { origin, host } = req.headers;
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

const CONTROL_FILES = {
  '/settings': ['settings.html', 'text/html'],
  '/settings.js': ['settings.js', 'text/javascript'],
  '/control': ['control.html', 'text/html'],
  '/control.js': ['control.js', 'text/javascript'],
  '/control.css': ['control.css', 'text/css'],
  '/motion.js': ['motion.js', 'text/javascript'],
  '/i18n.js': ['i18n.js', 'text/javascript'],
  '/audio-worklet.js': ['audio-worklet.js', 'text/javascript'],
};
const OVERLAY_FILES = {
  '/overlay': ['overlay.html', 'text/html'],
  '/overlay.js': ['overlay.js', 'text/javascript'],
};

function serveFile(res, [name, type]) {
  fs.readFile(path.join(ROOT, 'public', name), (err, content) => {
    if (err) {
      res.writeHead(500).end(t('Errore di lettura'));
      return;
    }
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    // Le traduzioni arrivano con lo script stesso: la pagina appare subito nella lingua giusta.
    if (name === 'i18n.js') {
      const head = `window.DUETTO_LANG = ${JSON.stringify(language())};\n` +
        `window.DUETTO_LOCALE = ${JSON.stringify(locale())};\nwindow.DUETTO_DICT = ${language() === 'en' ? JSON.stringify(englishDictionary()) : '{}'};\n`;
      res.end(head + content);
      return;
    }
    res.end(content);
  });
}

function serveEvents(req, res, url) {
  const out = url.searchParams.get('out') === 'room' ? 'room' : 'stream';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  sendSse(res, profileMessage(out));
  sseClients[out].add(res);
  req.on('close', () => sseClients[out].delete(res));
  res.on('error', () => sseClients[out].delete(res));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (pathname === '/') {
    res.writeHead(302, { Location: controlAllowed(req) ? '/control' : '/overlay?out=room' }).end();
    return;
  }
  if ((pathname === '/events' || Object.hasOwn(OVERLAY_FILES, pathname)) && !overlayAllowed(req)) {
    res.writeHead(403).end(t('Sottotitoli disponibili solo sul computer dell\'app'));
    return;
  }
  if (pathname === '/events') { serveEvents(req, res, url); return; }
  if (Object.hasOwn(OVERLAY_FILES, pathname)) { serveFile(res, OVERLAY_FILES[pathname]); return; }
  if (Object.hasOwn(CONTROL_FILES, pathname)) {
    if (!controlAllowed(req)) { res.writeHead(403).end(t('Pagina di controllo disponibile solo sul computer dell\'app')); return; }
    serveFile(res, CONTROL_FILES[pathname]);
    return;
  }
  res.writeHead(404).end(t('Non trovato'));
});
server.on('clientError', (_err, socket) => socket.destroy());

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws' || !controlAllowed(req) || !sameOrigin(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  controlClients.add(ws);
  ws.send(JSON.stringify({
    t: 'schema', styleSchema: STYLE_SCHEMA, defaults: DEFAULT_STYLES,
    languages: LANGUAGES.map(({ code, name, spoken, latin }) => ({ code, name: t(name), spoken, latin })),
    limits: { spoken: MAX_SPOKEN, targets: MAX_TARGETS },
    links: overlayLinks(), desktopApp: !!hooks.openFolder, outputDir: OUTPUT_DIR,
  }));
  ws.send(JSON.stringify(publicState()));
  ws.send(JSON.stringify(statusMessage()));
  if (hooks.micState) ws.send(JSON.stringify(hooks.micState()));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { handleAudio(ws, data); return; }
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    handleCommand(ws, message).catch((err) => warn('Comando non riuscito:', err.message));
  });
  ws.on('close', () => {
    controlClients.delete(ws);
    if (audioOwner === ws) audioOwner = null;
  });
  ws.on('error', () => {});
});

// --- Avvio e arresto ---

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

let activePort = PORT;

function overlayLinks() {
  const base = `http://localhost:${activePort}`;
  return {
    stream: `${base}/overlay?out=stream`,
    room: `${base}/overlay?out=room`,
    network: (overlayLan() ? lanAddresses() : []).map((ip) => `http://${ip}:${activePort}/overlay?out=room`),
  };
}

// L'app installata prova le porte successive se quella abituale è occupata.
const MAX_PORT_TRIES = flag(env.PORT_FALLBACK, false) ? 10 : 1;
let portTries = 0;
let resolveReady;
let rejectReady;
export const serverReady = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

server.on('listening', () => {
  activePort = server.address().port;
  const links = overlayLinks();
  log(`Controllo:      http://localhost:${activePort}/control`);
  log(`Overlay OBS:    ${links.stream}`);
  log(`Overlay sala:   ${links.room}`);
  for (const url of links.network) log(`Dalla rete:     ${url}`);
  if (!assemblyKey()) warn('Chiave AssemblyAI mancante: funziona solo la demo');
  if (!deeplKey()) warn('Chiave DeepL mancante: nessuna traduzione');
  resolveReady({ port: activePort, hasKeys: !!assemblyKey() && !!deeplKey() });
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    portTries += 1;
    if (portTries < MAX_PORT_TRIES) {
      server.listen(PORT + portTries, HOST);
      return;
    }
    warn(`Porta ${PORT + portTries - 1} occupata`);
    rejectReady(err);
    if (!flag(env.DESKTOP_APP, false)) process.exit(1); // da riga di comando è inutile proseguire
    return;
  }
  warn(`Server: ${err.message}`);
});
server.listen(PORT, HOST);

reloadTerms().catch((err) => warn('Termini chiave:', err.message));

// Termina le sessioni, salva lo stato e lascia il tempo di ricevere l'ultimo testo finale.
let stopping = null;
export function shutdown() {
  if (stopping) return stopping;
  log('Arresto: chiudo la sessione AssemblyAI');
  link.shutdown(); // Terminate ferma la fatturazione
  deepl.shutdown();
  obs.stop();
  store.flush();
  stopping = new Promise((resolve) => setTimeout(resolve, 1500));
  return stopping;
}

// Da riga di comando il processo si chiude con Ctrl+C. L'app installata gestisce da sé la chiusura.
if (!flag(env.DESKTOP_APP, false)) {
  const onSignal = () => { if (stopping) process.exit(0); shutdown().then(() => process.exit(0)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
