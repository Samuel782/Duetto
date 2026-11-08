// Server locale: pagine, audio dal browser, trascrizione, traduzione e invio agli overlay.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AssemblyLink, testAssemblyKey } from './assemblyai.js';
import { DeepL } from './deepl.js';
import { log, warn } from './log.js';
import { Settings, maskKey, readTextFile, writeTextFile } from './settings.js';
import {
  DEFAULT_STYLES, LANGUAGE_MODES, OUTPUTS, STYLE_SCHEMA, Store, VIEWS, sanitizePresets, sanitizeStyle,
} from './store.js';
import { createCleaner } from './textclean.js';
import { Transcript } from './transcript.js';

// Gli errori non devono mai far cadere il processo durante l'evento.
process.on('uncaughtException', (err) => warn('Errore non gestito:', err));
process.on('unhandledRejection', (err) => warn('Promessa rifiutata:', err));

// L'app installata registra qui le azioni che solo il sistema operativo può compiere.
export const hooks = { openFolder: null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const flag = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true');
const PORT = Number(env.PORT) || 8787;
const HOST = env.HOST || '0.0.0.0';
const CONTROL_ALLOW_LAN = flag(env.CONTROL_ALLOW_LAN, false);
const FALLBACK_LANGUAGE = env.FALLBACK_LANGUAGE === 'en' ? 'en' : 'it';
const PRICE_PER_HOUR = Number(env.ASSEMBLYAI_PRICE_PER_HOUR) || 0.45;
const DATA_DIR = env.DATA_DIR || path.join(ROOT, 'data');
const OUTPUT_DIR = env.OUTPUT_DIR || path.join(ROOT, 'output');
const KEYTERMS_FILE = env.KEYTERMS_FILE || path.join(ROOT, 'keyterms.txt');
const GLOSSARY_FILE = env.GLOSSARY_FILE || path.join(ROOT, 'glossario.csv');

const store = new Store(path.join(DATA_DIR, 'state.json'), env.DEFAULT_LANGUAGE_MODE);
const state = store.state;
const settings = new Settings(path.join(DATA_DIR, 'settings.json'));
const transcript = new Transcript(OUTPUT_DIR);

// Una chiave salvata nelle Impostazioni ha la precedenza su quella nel file .env.
const assemblyKey = () => settings.values.assemblyaiApiKey || env.ASSEMBLYAI_API_KEY || '';
const deeplKey = () => settings.values.deeplApiKey || env.DEEPL_API_KEY || '';
const cleanFillers = () => settings.values.cleanFillers ?? flag(env.CLEAN_FILLERS, true);
const cleanProfanity = () => settings.values.cleanProfanity ?? flag(env.CLEAN_PROFANITY, true);

let clean = createCleaner({ fillers: cleanFillers(), profanity: cleanProfanity() });

const deepl = new DeepL({
  apiKey: deeplKey(),
  endpoint: env.DEEPL_ENDPOINT || '', // vuoto: scelto in base alla chiave
  modelType: env.DEEPL_MODEL_TYPE ?? 'latency_optimized',
  useContext: flag(env.DEEPL_USE_CONTEXT, true),
});

const link = new AssemblyLink({
  apiKey: assemblyKey(),
  url: env.ASSEMBLYAI_WS_URL || 'wss://streaming.assemblyai.com/v3/ws',
  model: env.ASSEMBLYAI_SPEECH_MODEL || 'universal-3-6-pro',
  minTurnSilence: env.MIN_TURN_SILENCE || '',
  maxTurnSilence: env.MAX_TURN_SILENCE || '700', // chiude prima l'ultimo blocco quando chi parla si ferma
  rolloverBeforeMs: (Number(env.SESSION_ROLLOVER_BEFORE_SECONDS) || 120) * 1000,
  sessionMaxMs: (Number(env.SESSION_MAX_SECONDS) || 0) * 1000,
});
link.mode = state.languageMode;

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
  const message = `${terms.length} termini chiave ricaricati. Glossario: ${glossary}`;
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

const profileMessage = (out) => ({ t: 'profile', ...state.outputs[out] });

setInterval(() => {
  for (const name of OUTPUTS) for (const res of sseClients[name]) res.write(': ping\n\n');
}, 15000);

// --- Elaborazione delle frasi ---

let sentenceSeq = 0;
let previous = { text: '', lang: null }; // contesto per DeepL: non viene tradotto né conteggiato
let writeTail = Promise.resolve(); // mantiene l'ordine delle frasi nei file

const isShortText = (text) => text.trim().split(/\s+/).length <= 2;
const validDetected = (sentence) => {
  const detected = sentence.detected.toLowerCase().slice(0, 2);
  return detected === 'it' || detected === 'en' ? detected : '';
};

function resolveLanguage(sentence) {
  if (sentence.mode === 'IT') return 'it';
  if (sentence.mode === 'EN') return 'en';
  const detected = validDetected(sentence);
  if (detected && (!isShortText(sentence.text) || !state.lastLanguage)) return detected;
  return state.lastLanguage || FALLBACK_LANGUAGE;
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
  const detect = sentence.mode === 'AUTO' && !isShort;

  const id = ++sentenceSeq;
  const endAt = Date.now();
  broadcast({ t: 'final', id, text, lang: guess, cont: !!sentence.continuation });

  const context = previous.lang === guess ? previous.text : '';
  const translated = deepl.translate(text, guess, context, detect).catch(() => null);

  // Le traduzioni arrivano in parallelo ma escono nell'ordine in cui le frasi sono state dette.
  writeTail = writeTail.then(() => translated).then((result) => {
    const lang = result?.lang || guess;
    const translation = result?.text ? clean(result.text) : '';
    broadcast(translation ? { t: 'translation', id, text: translation } : { t: 'translationFailed', id });
    if (!isShort || !state.lastLanguage || sentence.mode !== 'AUTO') setLastLanguage(lang);
    const sameLanguage = previous.lang === lang;
    previous = { text: `${sameLanguage ? previous.text : ''} ${text}`.trim().slice(-500), lang };
    transcript.addSentence({
      text, translation, lang, mode: sentence.mode,
      startAt: endAt - sentence.durationMs, endAt,
    });
  }).catch((err) => warn('Trascrizione:', err.message));
});

// --- Modalità demo: testo finto, nessun credito consumato, nessun file scritto ---

const DEMO_LINES = [
  ['it', 'Buongiorno a tutti e benvenuti alla prima sessione della giornata.', 'Good morning everyone and welcome to the first session of the day.'],
  ['en', 'Thank you very much for having me here today.', 'Grazie mille per avermi invitato qui oggi.'],
  ['it', 'Vorrei iniziare con una domanda semplice sul futuro del nostro settore.', 'I would like to start with a simple question about the future of our industry.'],
  ['en', 'The numbers show a clear trend over the last five years, and it is not slowing down.', 'I numeri mostrano una chiara tendenza negli ultimi cinque anni, e non sta rallentando.'],
];
let demoTimer = null;

function startDemo() {
  if (demoTimer || link.active) return;
  log('Demo attiva');
  let line = 0;
  let word = 0;
  const step = () => {
    const [lang, text, translation] = DEMO_LINES[line];
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
      broadcast({ t: 'translation', id, text: translation });
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

const publicState = () => ({ t: 'state', languageMode: state.languageMode, outputs: state.outputs, presets: state.presets });

function statusMessage() {
  const aai = link.status();
  return {
    t: 'status',
    aai: { ...aai, estimatedCost: Number((aai.billedSeconds / 3600 * PRICE_PER_HOUR).toFixed(2)), configured: !!assemblyKey() },
    deepl: deepl.status(),
    lastLanguage: state.lastLanguage,
    demo: !!demoTimer,
    overlays: { stream: sseClients.stream.size, room: sseClients.room.size },
    outputDir: transcript.dir ? path.relative(ROOT, transcript.dir) : '',
  };
}

setInterval(() => sendControl(statusMessage()), 1000);

function setLanguageMode(mode) {
  if (!LANGUAGE_MODES.includes(mode) || mode === state.languageMode) return;
  state.languageMode = mode;
  link.setMode(mode);
  transcript.note(`Modalità lingua: ${mode}`);
  log(`Modalità lingua: ${mode}`);
}

function setProfile(out, change) {
  if (!OUTPUTS.includes(out)) return;
  Object.assign(state.outputs[out], change);
  broadcast(profileMessage(out), out);
}

const commands = {
  language: (m) => setLanguageMode(m.mode),
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
    keyterms: readTextFile(KEYTERMS_FILE),
    glossary: readTextFile(GLOSSARY_FILE),
  };
}

async function saveSettings(ws, m) {
  const saved = settings.update(m);
  link.setApiKey(assemblyKey());
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

// --- HTTP ---

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const controlAllowed = (req) => CONTROL_ALLOW_LAN || isLocal(req);

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
  '/audio-worklet.js': ['audio-worklet.js', 'text/javascript'],
};
const OVERLAY_FILES = {
  '/overlay': ['overlay.html', 'text/html'],
  '/overlay.js': ['overlay.js', 'text/javascript'],
};

function serveFile(res, [name, type]) {
  fs.readFile(path.join(ROOT, 'public', name), (err, content) => {
    if (err) {
      res.writeHead(500).end('Errore di lettura');
      return;
    }
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
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
  if (pathname === '/events') { serveEvents(req, res, url); return; }
  if (Object.hasOwn(OVERLAY_FILES, pathname)) { serveFile(res, OVERLAY_FILES[pathname]); return; }
  if (Object.hasOwn(CONTROL_FILES, pathname)) {
    if (!controlAllowed(req)) { res.writeHead(403).end('Pagina di controllo disponibile solo sul Mac'); return; }
    serveFile(res, CONTROL_FILES[pathname]);
    return;
  }
  res.writeHead(404).end('Non trovato');
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
    links: overlayLinks(), desktopApp: !!hooks.openFolder, outputDir: OUTPUT_DIR,
  }));
  ws.send(JSON.stringify(publicState()));
  ws.send(JSON.stringify(statusMessage()));
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
    network: lanAddresses().map((ip) => `http://${ip}:${activePort}/overlay?out=room`),
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
