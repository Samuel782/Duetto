// AssemblyAI finta e maleducata: server Node e server Rust devono reagire allo stesso modo.
// Uso: cargo build --release && node parity-assembly.mjs [nome]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = new URL('target/release/duetto-server', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-aai-'));
const kids = new Set();
process.on('exit', () => { for (const k of kids) k.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ text: `w${from + i}`, start: (from + i) * 300, end: (from + i) * 300 + 250 }));
const turn = (order, words, end = false, extra = {}) => ({ type: 'Turn', turn_order: order, end_of_turn: end, turn_is_formatted: end, transcript: words.map((w) => w.text).join(' ') + (end ? '.' : ''), words, language_code: 'it', ...extra });
const S = [];
// on(sessione, n): cosa fa il finto servizio all'apertura numero n. ms: durata. acts: [quando, azione].
const add = (name, ms, on, opts = {}) => S.push({ name, ms, on, ...opts });
const begin = (x, n, extra = {}) => x.send({ type: 'Begin', id: `s${n}`, expires_at: Math.floor(Date.now() / 1000) + 10800, configuration: { model: 'universal-3-6-pro' }, ...extra });
const after = (x, ms, f) => setTimeout(() => x.ws.readyState === 1 && f(), ms);

add('normale', 4000, (x, n) => { begin(x, n); after(x, 500, () => x.send(turn(0, W(3)))); after(x, 1000, () => x.send(turn(0, W(5), true))); after(x, 1500, () => x.send(turn(1, W(4, 5), true))); });
add('troppe sessioni', 6000, (x, n) => { if (n === 1) { x.send({ type: 'Error', error_code: 1008, error: 'Too many concurrent sessions' }); x.ws.close(1008, 'See Error message'); } else begin(x, n); });
add('saldo esaurito', 5000, (x) => { x.send({ type: 'Error', error_code: 1008, error: 'Insufficient balance' }); x.ws.close(1008, 'See Error message'); });
add('chiusura 1008 senza errore', 5000, (x) => x.ws.close(1008, 'Not authorized'));
add('rifiuto del recupero', 6000, (x, n) => { if (n === 1) setTimeout(() => { begin(x, n); after(x, 300, () => { x.send({ type: 'Error', error_code: 3007, error: 'Audio transmission rate exceeded' }); x.ws.close(3007, 'x'); }); }, 1500); else begin(x, n); });
for (const [c, r] of [[1000, 'Session Ended'], [1000, ''], [1011, ''], [1011, 'guasto'], [4001, 'See Error message']]) add(`chiusura ${c} ${r}`, 4500, (x, n) => { begin(x, n); if (n === 1) { after(x, 500, () => x.send(turn(0, W(3)))); after(x, 800, () => x.ws.close(c, r)); } });
add('caduta a metà frase', 6000, (x, n) => { begin(x, n); if (n === 1) { after(x, 500, () => x.send(turn(0, W(3)))); after(x, 800, () => x.ws.terminate()); } else after(x, 500, () => x.send(turn(0, W(4), true))); });
add('mai Begin', 12000, () => {});
for (const code of [401, 403, 500, 429]) add(`HTTP ${code}`, 5000, null, { http: code });
add('porta chiusa', 5000, null, { dead: true });
add('modello diverso', 3000, (x, n) => begin(x, n, { configuration: { model: 'universal-2' } }));
add('termini lunghi', 3000, (x, n) => begin(x, n), { keyterms: Array.from({ length: 100 }, (_, i) => `Termine è + & lungo numero ${i} con testo`).join('\n') });
add('termini corti', 3000, (x, n) => begin(x, n), { keyterms: 'Caffè + latte & co\nDue' });
add('messaggi rotti', 4000, (x, n) => { x.ws.send('{rotto'); x.ws.send('5'); x.ws.send('[]'); x.send({}); x.send({ type: 'Boh' }); begin(x, n); after(x, 300, () => { x.send({ type: 'Turn' }); x.send({ type: 'Turn', turn_order: 0, words: [], transcript: 'solo testo' }); x.send({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'solo testo.' }); x.send(turn(0, W(3), true)); x.send(turn(2, W(3), true)); x.send(turn(1, W(2), true)); x.send(turn(3, [], true)); x.send({ type: 'Heartbeat' }); x.send({ type: 'Error' }); }); });
add('parlato continuo', 6000, (x, n) => { begin(x, n); for (let k = 1; k < 40; k++) after(x, 300 + k * 100, () => x.send(turn(0, W(k)))); after(x, 4600, () => x.send(turn(0, W(40), true))); });
add('non formattato', 3500, (x, n) => { begin(x, n); after(x, 300, () => x.send(turn(0, W(4), true, { turn_is_formatted: false }))); after(x, 800, () => x.send(turn(0, W(4), true))); });
add('pausa in apertura', 4500, (x, n) => { setTimeout(() => begin(x, n), 2000); }, { acts: [[700, 'stop'], [800, { cmd: 'pause' }]] });
add('pausa a metà frase', 6000, (x, n) => { begin(x, n); after(x, 300, () => x.send(turn(0, W(3)))); x.terminate = () => { setTimeout(() => { x.send(turn(0, W(5), true)); x.send({ type: 'Termination' }); x.ws.close(1000, 'Session Ended'); }, 800); }; }, { acts: [[1200, 'stop'], [1300, { cmd: 'pause' }]] });
add('Terminate ignorato', 7000, (x, n) => { begin(x, n); after(x, 300, () => x.send(turn(0, W(3)))); x.terminate = () => {}; }, { acts: [[1200, 'stop'], [1300, { cmd: 'pause' }]] });
add('cambio lingua', 5000, (x, n) => { begin(x, n); after(x, 500, () => { x.send({ type: 'SpeechStarted' }); x.send(turn(0, W(3))); }); after(x, 2000, () => x.send(turn(0, W(5), true))); after(x, 2500, () => x.send(turn(1, W(5), true))); }, { acts: [[1000, { cmd: 'language', mode: 'en' }], [3000, { cmd: 'languages', spoken: ['it', 'es'] }]] });
add('silenzio della sorgente', 19500, (x, n) => begin(x, n), { acts: [[1500, 'stop']] });
const short = { env: { SESSION_MAX_SECONDS: '2' } };
add('cambio a turno chiuso', 8000, (x, n) => { begin(x, n); after(x, 500, () => x.send(turn(0, W(3), true))); }, short);
add('cambio con turno aperto', 24500, (x, n) => { begin(x, n); if (n === 1) { after(x, 500, () => x.send(turn(0, W(3)))); x.force = () => { x.send(turn(0, W(8), true)); }; } else if (n === 2) after(x, 22500, () => 0); }, short);
add('cambio senza risposta', 27500, (x, n) => { begin(x, n); if (n === 1) { after(x, 500, () => x.send(turn(0, W(3)))); x.force = () => {}; } }, short);
add('nuova sessione rifiutata', 7000, (x, n) => { if (n === 2) { x.send({ type: 'Error', error_code: 1008, error: 'Too many sessions' }); x.ws.close(1008, ''); } else begin(x, n); }, short);
add('cade la vecchia con la nuova pronta', 8000, (x, n) => { begin(x, n); if (n === 1) { after(x, 500, () => x.send(turn(0, W(3)))); after(x, 3500, () => x.ws.terminate()); } else if (n === 2) after(x, 3000, () => x.send(turn(0, W(6), true))); }, short);
add('parole già dette scartate', 9000, (x, n) => { begin(x, n); if (n === 1) after(x, 1500, () => x.send(turn(0, W(8), true))); else if (n === 2) { after(x, 2600, () => x.send(turn(0, W(4).map((w) => ({ ...w, start: w.start - 500, end: w.end - 500 })), true))); after(x, 3000, () => x.send(turn(1, W(6, 2), true))); } }, short);
add('chiave cambiata', 7000, (x, n) => begin(x, n), { key: true, acts: [[2500, { cmd: 'settingsSave', assemblyaiApiKey: 'mock-key' }]], env: { ASSEMBLYAI_API_KEY: 'sbagliata' } });
add('caduta simulata', 9000, (x, n) => begin(x, n), { acts: [[1500, { cmd: 'simulateDrop', seconds: 3 }]] });
add('arresto del server', 5500, (x, n) => { begin(x, n); after(x, 300, () => x.send(turn(0, W(3)))); x.terminate = () => { setTimeout(() => { x.send(turn(0, W(5), true)); x.ws.close(1000, 'Session Ended'); }, 500); }; }, { acts: [[1500, 'SIGTERM']] });
add('arresto con sorgente attiva', 5500, (x, n) => { begin(x, n); }, { acts: [[1500, 'SIGTERM']] });

let port = 19100;
async function run(kind, s) {
  const seen = [];
  const audio = [];
  let n = 0;
  let open = 0;
  const server = http.createServer((q, r) => r.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    if (s.http) { seen.push('tentativo'); sock.end(`HTTP/1.1 ${s.http} No\r\nContent-Length: 0\r\n\r\n`); return; }
    if (s.key && req.headers.authorization !== 'mock-key') { seen.push('chiave no'); sock.end('HTTP/1.1 401 No\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      n += 1; open += 1;
      const id = n;
      const u = new URL(req.url, 'http://x');
      seen.push(`${id} apre ${JSON.stringify([...u.searchParams].sort())}`);
      audio[id] = 0;
      const x = { ws, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
      ws.on('error', () => {});
      ws.on('close', () => { open -= 1; seen.push(`${id} chiusa`); });
      ws.on('message', (d, bin) => {
        if (bin) { audio[id] += d.length; return; }
        const m = JSON.parse(d);
        seen.push(`${id} ${JSON.stringify(m)}`);
        if (m.type === 'Terminate') { if (x.terminate) x.terminate(); else { x.send({ type: 'Termination' }); ws.close(1000, 'Session Ended'); } }
        if (m.type === 'ForceEndpoint') x.force?.();
      });
      s.on(x, id);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const aai = server.address().port;
  if (s.dead) server.close();
  const dir = fs.mkdtempSync(path.join(tmp, 'x-'));
  fs.writeFileSync(path.join(dir, 'k.txt'), s.keyterms || '');
  const p = port++;
  const child = spawn(kind === 'rust' ? BIN : process.execPath, kind === 'rust' ? [] : ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: String(p), HOST: '127.0.0.1', DUETTO_LOCALE: 'it', ASSEMBLYAI_API_KEY: 'mock-key', ASSEMBLYAI_WS_URL: `ws://127.0.0.1:${aai}/v3/ws`,
      DATA_DIR: path.join(dir, 'd'), OUTPUT_DIR: path.join(dir, 'o'), KEYTERMS_FILE: path.join(dir, 'k.txt'), GLOSSARY_FILE: path.join(dir, 'g'), ...s.env },
  });
  kids.add(child);
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  let exit = null;
  child.on('exit', (c) => { exit = c; });
  for (let i = 0; i < 200 && !logs.includes('Overlay sala'); i++) await sleep(50);
  await sleep(200);
  const events = [];
  http.get({ host: '127.0.0.1', port: p, path: '/events?out=stream', agent: false }, (r) => { let b = ''; r.on('data', (d) => { b += d; const l = b.split('\n\n'); b = l.pop(); for (const e of l) { const m = /^data: (.*)/m.exec(e); if (m) events.push(JSON.parse(m[1])); } }); r.on('error', () => {}); }).on('error', () => {});
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
  ws.on('error', () => {});
  let status;
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'status') status = m; });
  await new Promise((r) => ws.on('open', r));
  const feed = setInterval(() => ws.readyState === 1 && ws.send(Buffer.alloc(3200)), 100);
  for (const [at, a] of s.acts || []) setTimeout(() => { if (a === 'stop') clearInterval(feed); else if (a === 'SIGTERM') child.kill('SIGTERM'); else ws.send(JSON.stringify(a)); }, at);
  await sleep(s.ms);
  clearInterval(feed);
  const text = fs.existsSync(path.join(dir, 'o')) ? fs.readdirSync(path.join(dir, 'o')).map((f) => fs.readFileSync(path.join(dir, 'o', f, 'originale.srt'), 'utf8').split('\n').filter((l) => /^[a-z]/i.test(l)).join('|')).join() : '';
  const a = status?.aai || {};
  const out = {
    seen: [...seen], audio: audio.slice(1), text, exit, open,
    events: events.filter((e) => ['partial', 'final'].includes(e.t)).map((e) => `${e.t}${e.cont ? '+' : ''}:${e.text}`),
    status: { state: a.state, fatal: a.fatal, lastError: a.lastError, sessionId: a.sessionId, handoff: a.handoff, retry: a.retryInSeconds, billed: a.billedSeconds, buffered: a.bufferedMs },
  };
  ws.terminate();
  child.kill('SIGKILL');
  kids.delete(child);
  for (const c of wss.clients) c.terminate();
  server.close();
  return out;
}
const OWN = /^(|Chiave.*|Connessione chiusa.*|Modello.*|\d{4} .*|Insufficient.*|Not authorized|guasto|Too many.*|Unexpected server response.*)$/;
const tidy = (r, s) => {
  // Le righe di sessioni diverse possono incrociarsi: si confrontano sessione per sessione.
  const by = {};
  for (const l of r.seen) (by[l.split(' ')[0]] ??= []).push(l);
  // Con sessioni di 2 s i cambi continuano: ciò che segue il primo dipende dall'istante in cui si guarda.
  if (s.env === short.env) { for (const k of Object.keys(by)) if (k > '2') delete by[k]; by[2] = by[2]?.slice(0, 2); r = { ...r, open: 0, status: { lastError: '' } }; }
  // La verifica della chiave e la sessione vera partono insieme: l'ordine non conta. I termini cambiati
  // durante l'apertura Rust li manda all'avvio della sessione, Node solo se è già pronta.
  if (s.key) return JSON.stringify([r.seen.filter((l) => !l.includes('keyterms_prompt')).map((l) => l.replace(/^\d /, '')).sort(), r.text, r.status.state, r.status.lastError]);
  return JSON.stringify({ by, text: r.text, exit: r.exit, open: r.open, events: r.events, status: { ...r.status, lastError: OWN.test(r.status.lastError ?? '') ? r.status.lastError : 'libreria', billed: 0, buffered: 0, retry: 0 } });
};
const list = S.filter((s) => !process.argv[2] || s.name.includes(process.argv[2]));
const results = await Promise.all(list.map(async (s, i) => { await sleep(i * 120); return [s, ...(await Promise.all([run('node', s), run('rust', s)]))]; }));
let bad = 0;
for (const [s, a, b] of results) {
  const near = a.audio.length === b.audio.length && a.audio.every((x, i) => Math.abs(x - b.audio[i]) <= 3200 * 6)
    && Math.abs((a.status.billed || 0) - (b.status.billed || 0)) <= 1 && Math.abs((a.status.retry || 0) - (b.status.retry || 0)) <= 1 && Math.abs((a.status.buffered || 0) - (b.status.buffered || 0)) <= 400;
  const ok = s.key || (s.env === short.env ? Math.abs(a.audio[0] - b.audio[0]) <= 3200 * 11 : near);
  if (tidy(a, s) !== tidy(b, s) || !ok) { bad += 1; console.log('DIVERSO', s.name, '\n  node', tidy(a, s), JSON.stringify(a.audio), JSON.stringify(a.status), '\n  rust', tidy(b, s), JSON.stringify(b.audio), JSON.stringify(b.status)); }
}
console.log(`scenari ${list.length}, diversi ${bad}`);
process.exit(bad ? 1 : 0);
