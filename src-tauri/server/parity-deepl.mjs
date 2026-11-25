// DeepL in JavaScript e in Rust contro lo stesso finto server: stesse richieste, stessi risultati, stessi errori.
// Uso: cargo build --release --example deepl_probe && node parity-deepl.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DeepL } from '../../server/deepl.js';
import { setLanguage } from '../../server/i18n.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-deepl-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const G = path.join(tmp, 'g.csv');
fs.writeFileSync(G, 'italiano,inglese\nsala,room\n"a, b",c\n');
const EMPTY = path.join(tmp, 'vuoto.csv');
fs.writeFileSync(EMPTY, '# niente\n');
console.warn = () => {}; console.log2 = console.log; console.log = (...a) => (String(a[0]).startsWith('[') ? 0 : console.log2(...a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ogni scenario: risposte in fila per tipo di richiesta ("/v2/translate" ecc.); l'ultima si ripete.
const ok = (text, detected) => ({ status: 200, json: { translations: [{ detected_source_language: detected, text }] } });
const usage = (a, b) => ({ status: 200, json: { character_count: a, character_limit: b } });
const tr = (o) => ({ op: 'translate', text: 'ciao a tutti voi', lang: 'it', targets: { it: ['en'], en: ['it'], es: ['en', 'it'] }, accept: ['it', 'en', 'es'], ...o });
const st = (n) => ({ status: n, text: 'x' });
const S = [];
const add = (name, steps, answers = {}, cfg = {}) => S.push({ name, steps, answers, cfg });

add('semplice', [tr({})], { t: [ok('hello')] });
add('contesto', [tr({ context: 'prima' }), tr({ context: 'prima', detect: true })], { t: [ok('hello', 'IT')] });
add('contesto spento', [tr({ context: 'prima' })], { t: [ok('hello')] }, { useContext: false });
add('senza modello', [tr({})], { t: [ok('hello')] }, { modelType: '' });
add('più lingue', [tr({ targets: { it: ['en', 'de', 'ja', 'no', 'zh', 'pt'] } })], { t: [ok('x')] });
add('nessuna destinazione', [tr({ targets: {} }), tr({ targets: {}, detect: true })], { t: [ok('x', 'IT')] });
for (const d of ['IT', 'EN', 'ES', 'FR', 'NB', 'PL', 'xx', undefined, '']) add(`rilevata ${d}`, [tr({ detect: true, context: 'c' })], { t: [ok('uno', d), ok('due', d)] });
add('rilevata con stessa destinazione', [tr({ detect: true, targets: { it: ['en', 'de'], es: ['en', 'fr'] } })], { t: [ok('uno', 'ES'), ok('due', 'ES')] });
add('rilevata non ammessa', [tr({ detect: true, accept: ['it'] })], { t: [ok('uno', 'EN'), ok('due')] });
for (const n of [400, 401, 403, 404, 413, 429, 456, 500, 503, 529]) {
  add(`HTTP ${n}`, [tr({}), tr({ detect: true })], { t: [st(n)] });
  add(`HTTP ${n} poi ok`, [tr({}), tr({})], { t: [st(n), ok('bene', 'IT')] });
}
add('400 senza opzioni', [tr({})], { t: [st(400)] }, { modelType: '' });
add('una lingua su due', [tr({ targets: { it: ['en', 'de'] } })], { t: [ok('uno'), st(404)] }, { serial: true });
add('quota e ritorno', [tr({}), tr({}), { op: 'usage' }, tr({})], { t: [st(456), ok('bene')], u: [usage(10, 10), usage(1, 10)] });
add('quota senza ritorno', [tr({}), { op: 'usage' }, tr({})], { t: [st(456), ok('bene')], u: [usage(10, 10)] });
add('risposta vuota', [tr({})], { t: [{ status: 200, json: {} }] });
add('risposta senza testo', [tr({})], { t: [{ status: 200, json: { translations: [] } }] });
add('risposta rotta', [tr({})], { t: [{ status: 200, text: '{rotta' }] });
add('connessione chiusa', [tr({})], { t: [{ drop: true }] });
add('connessione chiusa poi ok', [tr({})], { t: [{ drop: true }, ok('bene')] });
add('timeout poi ok', [tr({})], { t: [{ wait: 3500, ...ok('tardi') }, ok('bene')] });
add('timeout doppio', [tr({})], { t: [{ wait: 3500, ...ok('tardi') }] });
add('corpo lento', [tr({})], { t: [{ bodyWait: 3500, ...ok('tardi') }, ok('bene')] });
add('coda piena', [{ op: 'many', list: Array.from({ length: 9 }, () => tr({})) }, tr({})], { t: [{ wait: 200, ...ok('x') }] });
for (const [a, b] of [[1000, 500000], [0, 1000], [490000, 500000], [500000, 500000], [600000, 500000], [0, 0]]) for (const lang of ['it', 'en']) add(`verifica ${a}/${b} ${lang}`, [{ op: 'test' }], { u: [usage(a, b)] }, { lang });
add('verifica senza numeri', [{ op: 'test' }], { u: [{ status: 200, json: {} }] });
for (const n of [403, 500, 429]) add(`verifica ${n}`, [{ op: 'test' }, { op: 'usage' }], { u: [st(n)] });
add('verifica senza chiave', [{ op: 'test' }, tr({}), { op: 'glossary', file: G }, { op: 'key', key: 'nuova:fx' }, { op: 'test' }, tr({})], { t: [ok('x')], u: [usage(1, 2)] }, { apiKey: '' });
add('chiave cambiata', [tr({}), { op: 'key', key: 'altra' }, tr({}), { op: 'key', key: 'altra' }], { t: [st(456), ok('bene')], u: [usage(5, 10)] });
const gl = [{ status: 200, json: { glossaries: [{ name: 'duetto', glossary_id: 'v1' }, { name: 'altro', glossary_id: 'no' }, { name: 'duetto', glossary_id: 'v2' }] } }];
const use = [{ op: 'glossary', file: G }, tr({}), tr({ lang: 'en' }), tr({ detect: true }), tr({ lang: 'es' }), tr({ targets: { it: ['de'] } })];
add('glossario', use, { t: [ok('x', 'IT')], g: gl, p: [{ status: 201, json: { glossary_id: 'G1' } }] });
add('glossario rifiutato in traduzione', use, { t: [st(400), ok('x', 'IT')], g: gl, p: [{ status: 201, json: { glossary_id: 'G1' } }] });
add('glossario vuoto', [{ op: 'glossary', file: EMPTY }, tr({})], { t: [ok('x')], g: gl });
add('glossario mancante', [{ op: 'glossary', file: path.join(tmp, 'no') }, tr({})], { t: [ok('x')], g: gl });
for (const n of [403, 404, 500]) { add(`glossari ${n}`, [{ op: 'glossary', file: G }, { op: 'lang', lang: 'en' }, { op: 'glossary', file: G }], { g: [st(n)] }); add(`creazione ${n}`, [{ op: 'glossary', file: G }, tr({})], { t: [ok('x')], g: gl, p: [st(n)] }); }
add('glossari senza elenco', [{ op: 'glossary', file: G }, tr({})], { t: [ok('x')], g: [{ status: 200, json: {} }], p: [{ status: 201, json: { glossary_id: 'G2' } }] });
add('inglese', [tr({}), { op: 'test' }], { t: [st(500)], u: [usage(1, 2)] }, { lang: 'en' });

async function fake(answers) {
  const seen = [];
  const count = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const kind = req.url === '/v2/translate' ? 't' : req.url === '/v2/usage' ? 'u' : req.method === 'GET' ? 'g' : req.method === 'POST' ? 'p' : 'd';
      seen.push(`${req.method} ${req.url} ${req.headers.authorization} ${req.headers['content-type'] && body ? req.headers['content-type'] : ''} ${body}`);
      const list = answers[kind] || [{ status: 200, json: kind === 'u' ? { character_count: 1, character_limit: 1000 } : {} }];
      const k = count[kind] = (count[kind] ?? -1) + 1;
      const a = list[Math.min(k, list.length - 1)];
      if (a.drop) { res.destroy(); return; }
      if (a.wait) await sleep(a.wait);
      res.writeHead(a.status, { 'Content-Type': 'application/json' });
      if (a.bodyWait) { res.flushHeaders(); await sleep(a.bodyWait); }
      res.end(a.json ? JSON.stringify(a.json) : a.text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function js(s) {
  const f = await fake(s.answers);
  const cfg = { apiKey: 'k:fx', endpoint: `${f.url}/`, modelType: 'latency_optimized', useContext: true, lang: 'it', ...s.cfg };
  setLanguage(cfg.lang);
  const d = new DeepL(cfg);
  await sleep(150);
  const one = (o) => d.translate(o.text, { ...o, targetsFor: (l) => o.targets[l] || [] });
  const out = [];
  for (const p of s.steps) {
    let r = null;
    if (p.op === 'translate') r = await one(p);
    else if (p.op === 'many') r = await Promise.all(p.list.map(one));
    else if (p.op === 'test') r = await d.test();
    else if (p.op === 'usage') await d.refreshUsage();
    else if (p.op === 'glossary') r = await d.syncGlossary(p.file);
    else if (p.op === 'key') { if (p.key !== d.cfg.apiKey) d.setApiKey(p.key); await sleep(150); } // come in saveSettings
    else if (p.op === 'lang') setLanguage(p.lang);
    out.push({ r, status: d.status() });
  }
  d.shutdown();
  f.close();
  return { out, seen: f.seen };
}

async function rust(s) {
  const f = await fake(s.answers);
  const cfg = { apiKey: 'k:fx', endpoint: `${f.url}/`, modelType: 'latency_optimized', useContext: true, lang: 'it', ...s.cfg };
  const p = spawn(new URL('target/release/examples/deepl_probe', import.meta.url).pathname, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '';
  let err = '';
  p.stdout.on('data', (d) => { text += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(JSON.stringify({ cfg, steps: s.steps }));
  await new Promise((r) => p.on('close', r));
  f.close();
  const line = text.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`${s.name}: ${err.slice(-400)}`);
  return { out: JSON.parse(line.slice(2)), seen: f.seen };
}

// I tempi variano e il testo degli errori di rete dipende dalla libreria: si confronta il resto.
const tidy = (x) => JSON.stringify(x, (k, v) => {
  if (k === 'avgMs') return undefined;
  if (typeof v === 'string') return v.replace(/(Rete|Network|Nessuna risposta|No response|glossario non caricato): .*/, '$1');
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
  return v;
});
let bad = 0;
for (const s of S) {
  const a = await js(s);
  const b = await rust(s);
  // Più lingue partono insieme: l'ordine di arrivo non conta.
  const same = tidy(a.out) === tidy(b.out) && (s.steps.some((p) => p.op === 'many' || (p.targets?.it?.length > 1)) ? tidy([...a.seen].sort()) === tidy([...b.seen].sort()) : tidy(a.seen) === tidy(b.seen));
  if (!same && !s.cfg.serial) { bad += 1; console.log2('DIVERSO', s.name, '\n  js  ', tidy(a), '\n  rust', tidy(b)); }
}
console.log2(`scenari ${S.length}, diversi ${bad}`);
process.exit(bad ? 1 : 0);
