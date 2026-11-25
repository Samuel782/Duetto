// Stesse richieste e stessi comandi al server Node e a quello Rust: le risposte devono coincidere.
// Uso: cargo build --release && node parity.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../node_modules/ws/wrapper.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-web-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopAll = [];
process.on('exit', () => { stopAll.forEach((f) => f()); fs.rmSync(tmp, { recursive: true, force: true }); });

// Le verifiche delle chiavi e DeepL non ci sono ancora in Rust: chiavi vuote da entrambe le parti.
async function start(name, command, args, port) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keyterms.txt'), '# nota\nUno\n\nUno\r\nDue\n' + 'x'.repeat(60));
  const child = spawn(command, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DUETTO_LOCALE: 'it', DATA_DIR: path.join(dir, 'data'), OUTPUT_DIR: path.join(tmp, 'output'),
      KEYTERMS_FILE: path.join(dir, 'keyterms.txt'), GLOSSARY_FILE: path.join(dir, 'glossario.csv') },
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  stopAll.push(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !logs.includes('Overlay sala'); i++) await sleep(50);
  return { name, port, dir, child, logs: () => logs };
}

const get = (s, p, { method = 'GET', headers = {} } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, path: p, method, headers }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', cache: res.headers['cache-control'], location: res.headers.location, body }));
  });
  req.on('error', (e) => resolve({ error: e.code }));
  req.end();
});
const open = (s, headers) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers });
  ws.on('open', () => { ws.terminate(); resolve(true); });
  ws.on('error', () => resolve(false));
});

const COMMANDS = [
  { cmd: 'settingsGet' }, { cmd: 'language', mode: 'IT' }, { cmd: 'language', mode: 'zz' }, { cmd: 'language' }, { cmd: 'target', out: 'stream', lang: 'it' }, { cmd: 'target', out: 'stream', lang: 'fr' }, { cmd: 'target', out: 'x', lang: 'it' },
  { cmd: 'languages', spoken: ['it', 'es', 'xx', 'es'] }, { cmd: 'languages', targets: ['ja', 'de', 'en'] }, { cmd: 'languages', targets: [] }, { cmd: 'languages', targets: 5, spoken: ['en'] },
  { cmd: 'languages', spoken: ['it', 'en'], targets: ['en', 'it', 'ja'] }, { cmd: 'captionsTarget', lang: 'ja' }, { cmd: 'captionsTarget', lang: 'it' }, { cmd: 'captionsTarget', lang: 'original' },
  { cmd: 'view', out: 'room', view: 'original' }, { cmd: 'view', out: 'room', view: 'zz' }, { cmd: 'viewAll', view: 'translation' }, { cmd: 'hidden', out: 'stream' }, { cmd: 'hidden', out: 'nessuna' }, { cmd: 'hidden', out: 'stream' }, { cmd: 'clear', out: 'stream' },
  { cmd: 'style', out: 'room', patch: { size: 9999, colorOriginal: 'red', lineHeight: 1.15, font: 'Verdana', align: 'left' } }, { cmd: 'style', out: 'room' }, { cmd: 'style', out: 'stream', patch: [1] },
  { cmd: 'presetSave', name: '  Mio  ', out: 'room' }, { cmd: 'presetSave', name: 7, out: 'room' }, { cmd: 'presetSave', name: '', out: 'room' }, { cmd: 'presetLoad', name: 'Mio', out: 'stream' }, { cmd: 'presetLoad', name: 'manca', out: 'stream' },
  { cmd: 'presetImport', presets: { A: { size: 20 }, B: 3 } }, { cmd: 'presetImport' }, { cmd: 'presetDelete', name: 'A' }, { cmd: 'presetDelete' }, { cmd: 'styleReset', out: 'room' }, { cmd: 'reloadTerms' },
  { cmd: 'nonEsiste' }, { cmd: 'constructor' }, { cmd: '__proto__' }, { nulla: 1 }, [], 'testo', 5, null, { cmd: 5 }, { cmd: 'simulateDrop', seconds: 'x' }, { cmd: 'pause' },
  { cmd: 'settingsSave', aiNotice: true, saveFiles: false, uiLanguage: 'en', keyterms: 'Solo uno\n', glossary: 'a,b\n', obsPort: '4460', checkUpdates: false }, { cmd: 'settingsSave', aiNoticeText: ' mio ', uiLanguage: 'it', overlayLan: true }, { cmd: 'settingsSave', aiNotice: false, overlayLan: false, assemblyaiRegion: 'eu' },
];

async function session(s) {
  const events = { stream: [], room: [] };
  for (const out of ['stream', 'room']) {
    http.get({ host: '127.0.0.1', port: s.port, path: `/events?out=${out}`, agent: false }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; const p = b.split('\n\n'); b = p.pop(); events[out].push(...p); }); });
  }
  await sleep(200);
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  const all = [];
  const statuses = [];
  ws.on('message', (d) => { const m = JSON.parse(d); (m.t === 'status' ? statuses : all).push(m); });
  await new Promise((r) => ws.on('open', r));
  await sleep(300);
  for (const c of COMMANDS) { ws.send(JSON.stringify(c)); await sleep(c?.cmd === 'settingsSave' || c?.cmd === 'reloadTerms' ? 400 : 60); }
  ws.send('{rotto');
  ws.send(JSON.stringify({ cmd: 'demo', on: true }));
  await sleep(6500);
  ws.send(Buffer.alloc(3200));
  await sleep(300);
  await sleep(1200);
  const state = fs.readFileSync(path.join(s.dir, 'data', 'state.json'), 'utf8');
  const settings = fs.readFileSync(path.join(s.dir, 'data', 'settings.json'), 'utf8');
  const big = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  const closed = await new Promise((r) => { big.on('open', () => big.send('x'.repeat(1200000))); big.on('close', () => r(true)); big.on('error', () => {}); setTimeout(() => r(false), 3000); });
  ws.terminate();
  return { all, status: statuses.at(-1), first: statuses[0], events, state, settings, closed };
}

const servers = [await start('node', process.execPath, ['server/index.js'], 18961), await start('rust', new URL('target/release/duetto-server', import.meta.url).pathname, [], 18962)];
let bad = 0;
let count = 0;
const same = (label, values) => {
  count += 1;
  const [a, b] = values.map((v) => JSON.stringify(v)?.replaceAll('18962', '18961'));
  if (a !== b) {
    bad += 1;
    let i = 0;
    while (a?.[i] === b?.[i] && i < (a?.length ?? 0)) i += 1;
    console.log('DIVERSO', label, '\n  node', a?.slice(Math.max(0, i - 60), i + 160), '\n  rust', b?.slice(Math.max(0, i - 60), i + 160));
  }
};
const both = (f) => Promise.all(servers.map(f));

const PATHS = ['/', '/control', '/control.js', '/control.css', '/settings', '/settings.js', '/motion.js', '/i18n.js', '/audio-worklet.js', '/overlay', '/overlay?out=room', '/overlay.js', '/niente', '/control/', '/Control', '/.env', '/../.env', '/server/index.js', '/ws'];
for (const p of PATHS) {
  const values = await both((s) => get(s, p));
  for (const v of values) { v.type = v.status === 200 ? v.type : ''; if (p === '/i18n.js') v.body = v.body.replace(/^window\.DUETTO_DICT = (.*);$/m, (_, j) => JSON.stringify(JSON.parse(j))); }
  same(`GET ${p}`, values);
}
for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) same(`${method} /control`, (await both((s) => get(s, '/control', { method }))).map((v) => v.status));
for (const [h, expected] of [[{}, true], [{ Origin: 'http://localhost:PORT', Host: 'localhost:PORT' }, true], [{ Origin: 'http://evil.example' }, false], [{ Origin: 'null' }, false], [{ Origin: 'http://127.0.0.1:1' }, false]]) {
  const r = await both((s) => open(s, Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.replace('PORT', s.port)]))));
  same(`ws ${JSON.stringify(h)}`, r);
  if (r[1] !== expected) { bad += 1; console.log('ATTESO', expected, h); }
}
// Più severo di Node: un nome estraneo che punta a questo computer non entra.
for (const p of ['/control', '/settings', '/overlay', '/events']) {
  count += 1;
  const v = await get(servers[1], p, { headers: { Host: 'evil.example:18962' } });
  if (v.status !== 403) { bad += 1; console.log('Host estraneo ammesso', p, v.status); }
}
count += 1;
if (await open(servers[1], { Host: 'evil.example:18962', Origin: 'http://evil.example:18962' })) { bad += 1; console.log('rebinding ammesso'); }

const results = await both(session);
same('numero messaggi', results.map((r) => r.all.map((m) => m.t)));
for (let i = 0; i < Math.max(...results.map((r) => r.all.length)); i++) same(`messaggio ${i} ${results[0].all[i]?.t}`, results.map((r) => { const m = { ...r.all[i] }; if (m.t === 'settingsResult') { delete m.assemblyai; delete m.deepl; delete m.terms; } if (m.t === 'notice') m.message = m.message.split('.')[0]; return m; }));
for (const out of ['stream', 'room']) {
  // La demo è a tempo: si confronta la sequenza, non quanti parziali stanno nella finestra.
  const lists = results.map((r) => r.events[out].map((e) => e.replace(/"id":\d+/, '"id":0')));
  const n = Math.min(...lists.map((l) => l.length)) - 2;
  same(`eventi ${out}`, lists.map((l) => l.slice(0, n)));
  same(`ultimo evento ${out}`, lists.map((l) => l.at(-1)));
  console.log('eventi', out, n);
}
for (const k of ['first', 'status']) same(`stato ${k}`, results.map((r) => { const m = structuredClone(r[k]); delete m.deepl.glossary; m.outputDir = path.basename(m.outputDir); return m; }).map((m) => { m.aai = { ...m.aai, state: 0, lastError: 0, fatal: 0, bufferedMs: 0, retryInSeconds: 0 }; return m; }));
// JavaScript mette prima le chiavi numeriche: un preset chiamato "7" cambia solo posto.
same('state.json', results.map((r) => JSON.parse(r.state)));
same('settings.json', results.map((r) => r.settings));
same('messaggio oltre 1 MB', results.map((r) => r.closed));
for (const s of servers) if (s.child.exitCode !== null) { bad += 1; console.log('terminato', s.name, s.logs().slice(-300)); }
console.log(`confronti ${count}, diversi ${bad}`);
process.exit(bad ? 1 : 0);
