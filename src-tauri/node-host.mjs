// Ospita il server di Duetto per il guscio Tauri: stampa la porta e si ferma quando stdin si chiude.
// Con DUETTO_MOCK=1 usa servizi finti locali: nessun dato esce dal computer.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const data = process.env.DATA_DIR;
process.env.DESKTOP_APP = 'true';
process.env.PORT_FALLBACK = 'true';
process.env.KEYTERMS_FILE = path.join(data, 'keyterms.txt');
process.env.GLOSSARY_FILE = path.join(data, 'glossario.csv');
process.env.LOG_FILE = path.join(data, 'app.log');

let mock = null;
if (process.env.DUETTO_MOCK === '1') {
  const { startMock } = await import('../test/mock-services.js');
  mock = await startMock({});
  Object.assign(process.env, {
    DUETTO_TEST: '1',
    HOST: '127.0.0.1',
    ASSEMBLYAI_API_KEY: 'mock-key',
    ASSEMBLYAI_WS_URL: `ws://127.0.0.1:${mock.port}/v3/ws`,
    DEEPL_API_KEY: 'mock:fx',
    DEEPL_ENDPOINT: `http://127.0.0.1:${mock.port}`,
  });
}

// La chiave di cifratura arriva dal guscio, che la tiene nel portachiavi.
const lines = readline.createInterface({ input: process.stdin });
// Un solo ascoltatore fin dall'inizio: le righe arrivate durante il caricamento restano in coda.
let onLine = null;
const queue = [];
lines.on('line', (line) => (onLine ? onLine(line) : queue.push(line)));
const keyHex = await new Promise((resolve) => {
  onLine = (line) => { onLine = null; resolve(line); };
  if (queue.length) onLine(queue.shift());
});
if (/^[0-9a-f]{64}$/.test(keyHex)) {
  const key = Buffer.from(keyHex, 'hex');
  const { setSecretStore } = await import('../server/settings.js');
  setSecretStore({
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    decrypt(data) {
      const raw = Buffer.from(data, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  });
}

const server = await import('../server/index.js');
const { t } = await import('../server/i18n.js');
const OPENERS = { darwin: 'open', win32: 'explorer.exe' };
server.hooks.openFolder = (folder) => execFile(OPENERS[process.platform] || 'xdg-open', [folder], () => {});

// Microfono: cattura il guscio, qui si decide quando inviare. La pagina mostra soltanto.
const MIC_FILE = path.join(data, 'mic.json');
const mic = { devices: [], device: '', deviceName: '', opened: '', error: '', started: false, sending: false };
try {
  const saved = JSON.parse(fs.readFileSync(MIC_FILE, 'utf8'));
  mic.device = String(saved.device || '');
  mic.deviceName = String(saved.deviceName || '');
} catch { /* primo avvio */ }
const publish = () => server.hooks.sendControl({ t: 'mic', ...mic });
const openMic = () => console.log(`DUETTO_MIC ${JSON.stringify(mic.device)}`);
server.hooks.micState = () => ({ t: 'mic', ...mic });
server.hooks.micCommand = (m) => {
  if (m.cmd === 'micStart') mic.started = mic.sending = true;
  else if (m.cmd === 'pause') mic.sending = false;
  else if (m.cmd === 'micDevice' && typeof m.device === 'string' && m.device.length < 300) {
    mic.device = m.device;
    mic.deviceName = mic.devices.find((d) => d.id === mic.device)?.name || '';
    mic.opened = '';
    fs.writeFile(MIC_FILE, JSON.stringify({ device: mic.device, deviceName: mic.deviceName }), () => {});
    openMic();
  }
  publish();
};
const probe = { n: 0, t0: 0, last: 0, gap: 0, peak: 0 };
onLine = (line) => {
  if (line.startsWith('PCM ')) {
    const [, peak, body] = line.split(' ');
    const now = performance.now();
    if (mock) {
      if (!probe.t0) probe.t0 = now; else probe.n += 1;
      probe.gap = Math.max(probe.gap, probe.last ? now - probe.last : 0);
      probe.last = now;
      probe.peak = Math.max(probe.peak, Number(peak));
    }
    if (mic.sending) server.nativeAudio(Buffer.from(body, 'base64'));
    server.hooks.sendControl({ t: 'level', peak: Number(peak) });
  } else if (line.startsWith('MIC ')) {
    const m = JSON.parse(line.slice(4));
    if (m.devices) mic.devices = m.devices;
    if (m.opened !== undefined) { mic.opened = m.opened; mic.error = ''; }
    if (m.error) { mic.opened = ''; mic.error = m.error; }
    if (mock) console.log('MIC', line.slice(4));
    publish();
  }
};
queue.splice(0).forEach(onLine);
openMic();

const stop = () => server.shutdown().finally(() => process.exit(0));
lines.on('close', stop);
process.on('SIGTERM', stop);
try {
  const ready = await server.serverReady;
  let sent = '';
  const texts = () => {
    const line = ['Chiudi', 'Annulla', 'Chiudere Duetto?', 'Se sei in diretta, i sottotitoli si fermano.', 'Uscita sala', 'Impostazioni'].map((x) => t(x)).join('\t');
    if (line !== sent) console.log(`DUETTO_TEXTS ${line}`);
    sent = line;
  };
  texts();
  setInterval(texts, 1000); // la lingua può cambiare nelle Impostazioni
  console.log(`DUETTO_READY ${ready.port} ${ready.hasKeys ? 1 : 0}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
if (mock) setInterval(() => console.log('MOCK', JSON.stringify({ persi: Math.round(probe.last - probe.t0 - probe.n * 100), blocchi: probe.n, pausaMax: Math.round(probe.gap), fermoDa: Math.round(performance.now() - probe.last), picco: probe.peak, sessioni: mock.stats.sessions, erroriAudio: mock.stats.audioErrors, chiuse: mock.stats.closedSessions.length })), 5000);
