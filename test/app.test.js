// Prove dell'intero server contro i finti servizi: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FRAME_MAGIC, startMock } from './mock-services.js';

const sha = (text) => crypto.createHash('sha256').update(text).digest('base64');
const obsAuth = (password) => sha(`${sha(`${password}sale`)}sfida`);
const EXE = process.platform === 'win32' ? '.exe' : '';
const BIN = process.env.DUETTO_SERVER_BIN || fileURLToPath(new URL(`../src-tauri/server/target/release/duetto-server${EXE}`, import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Tempo scaduto: ${label}`);
}

let nextPort = 18800 + Math.floor(Math.random() * 500);

// Avvia server, finti servizi, un client SSE e una sorgente audio a velocità reale.
async function setup(extraEnv = {}, mockOptions = {}) {
  const mock = await startMock(mockOptions);
  const port = nextPort++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-test-'));
  const child = spawn(BIN, [], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
      PORT: String(port), HOST: '127.0.0.1', DUETTO_LOCALE: 'it',
      ASSEMBLYAI_API_KEY: 'mock-key', ASSEMBLYAI_WS_URL: `ws://127.0.0.1:${mock.port}/v3/ws`,
      DEEPL_API_KEY: 'mock:fx', DEEPL_ENDPOINT: `http://127.0.0.1:${mock.port}`,
      DATA_DIR: path.join(tmp, 'data'), OUTPUT_DIR: path.join(tmp, 'output'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  await waitFor(() => logs.includes('Controllo:'), 5000, 'avvio server');

  const events = [];
  const sse = http.get(`http://127.0.0.1:${port}/events?out=stream`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    });
  });
  sse.on('error', () => {});

  const control = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const statuses = [];
  const messages = [];
  control.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'status') statuses.push(m);
    else messages.push(m);
  });
  await new Promise((r) => control.on('open', r));

  let audioTimer = null;
  let globalMs = 0;
  const startAudio = () => {
    const started = Date.now() - globalMs;
    audioTimer = setInterval(() => {
      while (globalMs + 100 <= Date.now() - started) {
        const frame = Buffer.alloc(3200);
        frame.writeUInt16LE(FRAME_MAGIC, 0);
        frame.writeUInt32LE(globalMs, 2);
        if (control.readyState === 1) control.send(frame);
        globalMs += 100;
      }
    }, 20);
  };
  const stopAudio = () => clearInterval(audioTimer);
  const close = async () => {
    stopAudio();
    control.terminate();
    sse.destroy();
    child.kill('SIGKILL');
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
  };
  const cmd = (m) => control.send(JSON.stringify(m));
  return { mock, port, events, statuses, messages, cmd, startAudio, stopAudio, close, tmp, getLogs: () => logs, control };
}

// Le parole delle frasi finali, in ordine.
const finalWords = (events) => events.filter((e) => e.t === 'final')
  .flatMap((e) => e.text.replace('.', '').split(' ')).map((w) => Number(w.slice(1)));

function assertNoLossNoDup(words, label) {
  assert.ok(words.length > 0, `${label}: nessuna parola`);
  const seen = new Set();
  for (const w of words) {
    assert.ok(!seen.has(w), `${label}: parola w${w} duplicata in ${words.join(',')}`);
    seen.add(w);
  }
  for (let i = 1; i < words.length; i++) {
    assert.equal(words[i], words[i - 1] + 1, `${label}: dopo w${words[i - 1]} arriva w${words[i]}`);
  }
}

let ctx = null;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

test('parlato senza pause: traduzione a blocchi, in ordine, lingua rilevata da DeepL', async () => {
  ctx = await setup();
  ctx.mock.stats.continuous = true;
  ctx.startAudio();
  // Il turno non finisce mai: senza i blocchi non arriverebbe nessuna traduzione.
  await waitFor(() => ctx.events.filter((e) => e.t === 'translation').length >= 6, 25000, 'traduzioni a turno aperto');
  ctx.stopAudio();
  ctx.cmd({ cmd: 'pause' });
  await waitFor(() => ctx.mock.stats.closedSessions.length === 1, 4000, 'chiusura');
  await sleep(500);

  const finals = ctx.events.filter((e) => e.t === 'final');
  assert.equal(finals[0].cont, false);
  assert.ok(finals.slice(1).every((f) => f.cont), 'i blocchi successivi proseguono il turno');

  // Nessuna parola persa o duplicata attraverso blocchi e parziali.
  const words = finals.flatMap((f) => [...f.text.matchAll(/w(\d+)/g)].map((m) => Number(m[1])));
  assertNoLossNoDup(words, 'blocchi');

  // Le traduzioni escono nell'ordine delle frasi anche se arrivano in parallelo.
  const ids = ctx.events.filter((e) => e.t === 'translation').map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  // La lingua viene da DeepL e un'ipotesi sbagliata produce la destinazione giusta.
  const bodies = ctx.mock.stats.translateBodies;
  assert.ok(bodies.some((b) => !b.source_lang), 'almeno una richiesta con lingua da rilevare');
  const lastByText = new Map(bodies.map((b) => [b.text[0], b]));
  for (const [text, body] of lastByText) {
    const first = Number(/w(\d+)/.exec(text)[1]);
    const expected = Math.floor(first / 24) % 2 ? 'IT' : 'EN-GB';
    assert.equal(body.target_lang, expected, `destinazione errata per ${text}`);
  }
});

test('frasi, traduzione e file: lingue alternate in AUTO', async () => {
  ctx = await setup();
  ctx.startAudio();
  await waitFor(() => ctx.events.filter((e) => e.t === 'translation').length >= 3, 15000, 'tre traduzioni');
  ctx.stopAudio();
  const url = new URL(ctx.mock.stats.connectUrls[0], 'http://x');
  assert.equal(url.searchParams.get('speech_model'), 'universal-3-6-pro');
  assert.equal(url.searchParams.get('language_detection'), 'true');
  assert.deepEqual(JSON.parse(url.searchParams.get('language_codes')), ['it', 'en']);
  assert.ok(JSON.parse(url.searchParams.get('keyterms_prompt')).includes('DeepL'));

  const bodies = ctx.mock.stats.translateBodies;
  assert.equal(bodies[0].target_lang, 'EN-GB');
  assert.equal(bodies[1].target_lang, 'IT');
  assert.equal(bodies.length, ctx.events.filter((e) => e.t === 'final').length, 'ipotesi giusta: una sola richiesta');
  // DeepL accetta il glossario solo con la lingua di partenza indicata: non quando la rileva.
  assert.ok(bodies.every((b) => (b.source_lang ? b.glossary_id : !b.glossary_id)), 'glossario solo con source_lang');
  assert.ok(ctx.events.some((e) => e.t === 'partial'));

  const finals = ctx.events.filter((e) => e.t === 'final');
  assert.deepEqual(finals.slice(0, 3).map((f) => f.lang), ['it', 'en', 'it']);

  const [dir] = fs.readdirSync(path.join(ctx.tmp, 'output'));
  const read = (f) => fs.readFileSync(path.join(ctx.tmp, 'output', dir, f), 'utf8');
  assert.match(read('originale.srt'), /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nw0 w1/);
  assert.match(read('inglese.srt'), /\[EN-GB\] w0/);
  assert.match(read('italiano.srt'), /^1\n.*\nw0 w1/m);
  assert.match(read('italiano.srt'), /\[IT\] w6/);
  assert.match(read('trascrizione.txt'), /\[IT\] \[modalità AUTO\]/);
});

test('AUTO: se AssemblyAI sbaglia la lingua, DeepL la corregge', async () => {
  // Caso reale: "It's in the middle of winter." preso per italiano e rimasto senza traduzione.
  ctx = await setup();
  ctx.mock.stats.wrongLanguageCode = true;
  ctx.startAudio();
  await waitFor(() => ctx.events.filter((e) => e.t === 'translation').length >= 2, 12000, 'due traduzioni');
  ctx.stopAudio();
  const translations = ctx.events.filter((e) => e.t === 'translation');
  assert.match(translations[0].text, /^\[EN-GB\] w0/, 'frase italiana tradotta in inglese');
  assert.match(translations[1].text, /^\[IT\] w6/, 'frase inglese tradotta in italiano');
  const dir = fs.readdirSync(path.join(ctx.tmp, 'output'))[0];
  const text = fs.readFileSync(path.join(ctx.tmp, 'output', dir, 'trascrizione.txt'), 'utf8');
  assert.match(text, /\[IT\] \[modalità AUTO\]\n  Originale: w0/);
  assert.match(text, /\[EN\] \[modalità AUTO\]\n  Originale: w6/);
});

test('cambio modalità: niente riconnessioni, vale dalla frase successiva', async () => {
  ctx = await setup();
  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'partial'), 5000, 'parziale');
  ctx.cmd({ cmd: 'language', mode: 'EN' });
  await waitFor(() => ctx.events.filter((e) => e.t === 'final').length >= 2, 12000, 'due frasi');
  const finals = ctx.events.filter((e) => e.t === 'final');
  // La frase in corso resta con la modalità precedente (AUTO, frase italiana); la successiva è forzata.
  assert.equal(finals[0].lang, 'it');
  assert.equal(finals[1].lang, 'en');
  assert.equal(ctx.mock.stats.sessions, 1);
  assert.ok(ctx.mock.stats.updates.some((u) => JSON.stringify(u.language_codes) === '["en"]'));
  ctx.stopAudio();
  await waitFor(() => {
    const dir = fs.existsSync(path.join(ctx.tmp, 'output')) && fs.readdirSync(path.join(ctx.tmp, 'output'))[0];
    return dir && fs.readFileSync(path.join(ctx.tmp, 'output', dir, 'trascrizione.txt'), 'utf8').includes('Modalità lingua: en');
  }, 2000, 'riga di modalità nel file');
});

test('cambio di sessione: nessuna parola persa o duplicata', async () => {
  ctx = await setup({ SESSION_MAX_SECONDS: '4' });
  ctx.startAudio();
  await waitFor(() => ctx.mock.stats.closedSessions.length >= 3, 40000, 'tre cambi di sessione');
  ctx.stopAudio();
  assertNoLossNoDup(finalWords(ctx.events), 'cambio di sessione');
});

test('caduta di 10 s: riconnessione da sola', async () => {
  ctx = await setup();
  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'final'), 8000, 'prima frase');
  ctx.cmd({ cmd: 'simulateDrop', seconds: 10 });
  await waitFor(() => ctx.statuses.at(-1)?.aai.state === 'reconnecting', 3000, 'stato di riconnessione');
  const before = ctx.events.filter((e) => e.t === 'final').length;
  await waitFor(() => ctx.statuses.at(-1)?.aai.state === 'connected', 25000, 'riconnessione');
  await waitFor(() => ctx.events.filter((e) => e.t === 'final').length > before, 8000, 'nuove frasi');
  assert.ok(ctx.statuses.at(-1).aai.billedSeconds >= 0);
});

test('connessione muta: rilevata e audio recente recuperato', async () => {
  ctx = await setup();
  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'final'), 8000, 'prima frase');
  ctx.mock.stats.stalled = true;
  await waitFor(() => ctx.mock.stats.sessions === 1 && ctx.getLogs().includes('senza risposta'), 12000, 'rilevamento');
  ctx.mock.stats.stalled = false;
  await waitFor(() => ctx.mock.stats.sessions >= 2, 8000, 'nuova sessione');
  const buffered = await waitFor(() => ctx.statuses.at(-1)?.aai.state === 'connected', 5000, 'connessa');
  assert.ok(buffered);
  assert.equal(ctx.mock.stats.audioErrors, 0);
});

test('pausa: la sessione si chiude, riprendere ne apre una nuova', async () => {
  ctx = await setup();
  ctx.startAudio();
  await waitFor(() => ctx.statuses.at(-1)?.aai.state === 'connected', 5000, 'connessa');
  ctx.stopAudio();
  ctx.cmd({ cmd: 'pause' });
  await waitFor(() => ctx.mock.stats.closedSessions.length === 1, 3000, 'Terminate inviato');
  await waitFor(() => ctx.statuses.at(-1)?.aai.state === 'idle', 3000, 'stato fermo');
  await sleep(1100);
  assert.equal(ctx.statuses.at(-1).aai.lastError, '', 'una chiusura normale non è un errore');
  ctx.startAudio();
  await waitFor(() => ctx.mock.stats.sessions === 2, 3000, 'nuova sessione');
});

test('DeepL: errore e timeout non fermano i sottotitoli', async () => {
  ctx = await setup();
  ctx.mock.stats.translateStatus = 500;
  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'translationFailed'), 10000, 'errore gestito');
  assert.ok(ctx.events.some((e) => e.t === 'final'));
  assert.equal(ctx.mock.stats.translateBodies.length, 2, 'un solo nuovo tentativo');
  ctx.mock.stats.translateStatus = 200;
  await waitFor(() => ctx.events.some((e) => e.t === 'translation'), 10000, 'traduzioni riprese');
});

test('chiave non valida: nessun crollo, errore visibile', async () => {
  ctx = await setup({ ASSEMBLYAI_API_KEY: 'sbagliata' });
  ctx.startAudio();
  await waitFor(() => ctx.statuses.at(-1)?.aai.fatal, 5000, 'errore fatale');
  assert.match(ctx.statuses.at(-1).aai.lastError, /Invalid API key/);
});

test('sicurezza: origine estranea rifiutata, nessuna chiave nelle pagine', async () => {
  ctx = await setup({ ASSEMBLYAI_API_KEY: 'mock-key', DEEPL_API_KEY: 'chiave-segreta-deepl:fx' });
  const foreign = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`, { origin: 'http://evil.example' });
  await new Promise((resolve) => { foreign.on('error', resolve); foreign.on('open', resolve); });
  assert.notEqual(foreign.readyState, WebSocket.OPEN);
  foreign.terminate();
  let all = JSON.stringify(ctx.statuses);
  for (const p of ['/control', '/control.js', '/overlay', '/overlay.js', '/audio-worklet.js']) {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`);
    assert.equal(res.status, 200, p);
    all += await res.text();
  }
  assert.ok(!all.includes('chiave-segreta-deepl'));
  assert.ok(!all.includes('mock-key'));
  assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/../.env`)).status, 404);
});

test('sicurezza: un nome estraneo che punta a questo computer viene rifiutato', async () => {
  ctx = await setup();
  const status = (p, host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path: p, headers: { Host: host }, agent: false }, (res) => { res.destroy(); resolve(res.statusCode); }).on('error', reject);
  });
  const opens = (host) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`, { headers: { Host: host, Origin: `http://${host}` } });
    ws.on('open', () => { ws.terminate(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]']) {
    const host = `${name}:${ctx.port}`;
    assert.equal(await status('/control', host), 200, host);
    assert.equal(await status('/overlay', host), 200, host);
    assert.equal(await opens(host), true, host);
  }
  for (const name of ['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example']) {
    const host = `${name}:${ctx.port}`;
    for (const p of ['/control', '/settings', '/overlay', '/events?out=room']) assert.equal(await status(p, host), 403, `${host}${p}`);
    assert.equal(await opens(host), false, host);
  }
});

test('Impostazioni: chiavi salvate e verificate, mai rimandate al browser', async () => {
  ctx = await setup({
    ASSEMBLYAI_API_KEY: '', DEEPL_API_KEY: '',
    KEYTERMS_FILE: path.join(os.tmpdir(), `kt-${process.pid}.txt`),
    GLOSSARY_FILE: path.join(os.tmpdir(), `gl-${process.pid}.csv`),
  });
  await waitFor(() => ctx.statuses.at(-1), 3000, 'stato');
  assert.equal(ctx.statuses.at(-1).aai.configured, false);

  ctx.cmd({ cmd: 'settingsSave', assemblyaiApiKey: 'sbagliata', deeplApiKey: 'chiave-di-prova:fx', keyterms: 'Maria Rossi\n', glossary: 'sala,room\n', cleanProfanity: false });
  let result = await waitFor(() => ctx.messages.find((m) => m.t === 'settingsResult'), 10000, 'prima verifica');
  assert.equal(result.assemblyai.ok, false);
  assert.match(result.assemblyai.message, /Invalid API key/);
  assert.equal(result.deepl.ok, true);
  assert.match(result.terms, /1 termini/);

  // Una chiave corretta vale subito, senza riavvio. Il campo vuoto non cancella quella di DeepL.
  ctx.messages.length = 0;
  ctx.cmd({ cmd: 'settingsSave', assemblyaiApiKey: 'mock-key', deeplApiKey: '' });
  result = await waitFor(() => ctx.messages.find((m) => m.t === 'settingsResult'), 10000, 'seconda verifica');
  assert.equal(result.assemblyai.ok, true);
  assert.equal(result.deepl.ok, true);
  const view = await waitFor(() => ctx.messages.find((m) => m.t === 'settings'), 3000, 'impostazioni');
  assert.equal(view.assemblyaiKey, '••••••••-key');
  assert.equal(view.cleanProfanity, false);
  assert.equal(view.keyterms, 'Maria Rossi\n');

  const file = path.join(ctx.tmp, 'data', 'settings.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'file leggibile solo dal proprietario');
  assert.ok(!JSON.stringify(ctx.messages).includes('chiave-di-prova'), 'chiave mai rimandata');
  assert.ok(!JSON.stringify(ctx.messages).includes('mock-key'), 'chiave mai rimandata');

  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'translation'), 10000, 'traduzione con le nuove chiavi');
  fs.rmSync(path.join(os.tmpdir(), `kt-${process.pid}.txt`), { force: true });
  fs.rmSync(path.join(os.tmpdir(), `gl-${process.pid}.csv`), { force: true });
});

test('stato persistente e valori importati validati', async () => {
  ctx = await setup();
  ctx.cmd({ cmd: 'language', mode: 'IT' });
  ctx.cmd({ cmd: 'style', out: 'room', patch: { size: 9999, colorOriginal: 'red;}', font: 'Arial</style>' } });
  ctx.cmd({ cmd: 'presetImport', presets: { Prova: { size: 50, evil: 'x' } } });
  await sleep(800);
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.tmp, 'data', 'state.json'), 'utf8'));
  assert.equal(saved.languageMode, 'it');
  assert.equal(saved.outputs.room.style.size, 200);
  assert.equal(saved.outputs.room.style.colorOriginal, '#ffffff');
  assert.equal(saved.outputs.room.style.font, 'Arial');
  assert.deepEqual(saved.presets.Prova, { size: 50, sizeTranslation: 50 });
});

test('traduzioni inglesi: ogni testo dell\'interfaccia ha la sua', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dict = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/en.json'), 'utf8'));
  // Nomi propri e sigle restano uguali nelle due lingue.
  const same = new Set(['AUTO', 'IT', 'EN', 'Duetto', 'Audio', 'Font', 'Google Font', 'Preset', 'Streaming', 'File', 'English', 'Server', 'OBS']);
  const keys = new Set();
  for (const f of ['public/control.js', 'public/settings.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  // In Rust: t(lingua, "testo", …), self.t("testo", …) e text("testo").
  for (const dir of ['src-tauri/src', 'src-tauri/server/src']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      for (const m of src.matchAll(/\bt\((?:[\w.]+, )?"((?:[^"\\]|\\.)*)", &\[|\btext\("([A-ZÀ-Ù][^"]*)"\)/g)) keys.add(m[1] ?? m[2]);
    }
  }
  assert.ok(keys.has('Chiave mancante') && keys.has('Chiudere Duetto?'), 'testi Rust trovati');
  const { schema } = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/core/src/styles.json'), 'utf8'));
  const languages = fs.readFileSync(path.join(root, 'src-tauri/core/src/languages.rs'), 'utf8');
  for (const m of languages.matchAll(/^    l\("\w+", "([^"]+)"/gm)) keys.add(m[1]);
  for (const g of schema) {
    keys.add(g.group);
    for (const f of g.fields) { keys.add(f.label); for (const [, text] of f.options || []) keys.add(text); }
  }
  for (const f of ['public/control.html', 'public/settings.html']) {
    const html = fs.readFileSync(path.join(root, f), 'utf8')
      .replace(/<head>[\s\S]*?<\/head>|<script[\s\S]*?<\/script>|<code[\s\S]*?<\/code>|<datalist[\s\S]*?<\/datalist>/g, ' ');
    for (const m of html.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)) keys.add(m[1].replace(/&#10;/g, '\n'));
    for (const m of html.matchAll(/>([^<>]+)</g)) {
      const text = m[1].trim();
      if (/[a-zà-ù]{2}/i.test(text)) keys.add(text);
    }
  }
  const missing = [...keys].filter((k) => !same.has(k) && !(k in dict));
  assert.deepEqual(missing, [], 'testi senza traduzione inglese');
  for (const [it, en] of Object.entries(dict)) {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(vars(en), vars(it), `segnaposto diversi in: ${it}`);
  }
});

test('aggiornamenti: risposta di GitHub', async () => {
  const page = 'https://github.com/Samuel782/Duetto/releases';
  const release = { tag_name: 'v1.3.0', html_url: `${page}/tag/v1.3.0` };
  for (const [answer, version, expected] of [
    [release, '1.2.0', { version: '1.3.0', url: release.html_url }],
    [release, '1.3.0', null],
    [{ ...release, prerelease: true }, '1.2.0', null],
    [{ tag_name: 'v9.0.0', html_url: 'https://altro-sito.example/trappola' }, '1.2.0', { version: '9.0.0', url: page }],
    [null, '1.2.0', null],
  ]) {
    let asked = 0;
    const server = http.createServer((req, res) => { asked += 1; res.writeHead(answer ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const c = await setup({ DUETTO_VERSION: version, DUETTO_UPDATE_API: `http://127.0.0.1:${server.address().port}/latest` });
    try {
      await waitFor(() => asked > 0, 8000, 'richiesta');
      await sleep(1500);
      assert.deepEqual(c.statuses.at(-1).update, expected, `${version} ${JSON.stringify(answer)}`);
    } finally {
      await c.close();
      server.close();
    }
  }
});

test('privacy: file disattivabili e sottotitoli chiusi alla rete', async () => {
  ctx = await setup({ HOST: '0.0.0.0' });
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const open = (p) => new Promise((resolve, reject) => {
    const req = http.get({ host: lan, port: ctx.port, path: p, agent: false }, resolve);
    req.on('error', reject);
  });
  const status = async (p) => { const res = await open(p); res.destroy(); return res.statusCode; };
  const save = async (m) => {
    const before = ctx.messages.length;
    ctx.cmd({ cmd: 'settingsSave', ...m });
    await waitFor(() => ctx.messages.slice(before).some((x) => x.t === 'settingsResult'), 8000, 'salvataggio');
  };
  const links = () => ctx.messages.filter((m) => m.t === 'links').at(-1).links;
  const schema = await waitFor(() => ctx.messages.find((m) => m.t === 'schema'), 3000, 'schema');
  assert.equal(schema.links.network.length, 0);
  if (lan) {
    for (const p of ['/overlay', '/overlay.js', '/events?out=room']) assert.equal(await status(p), 403, p);
    await save({ overlayLan: true });
    assert.ok(links().network.length > 0);
    const res = await open('/events?out=room');
    assert.equal(res.statusCode, 200);
    let closed = false;
    res.on('close', () => { closed = true; }).on('error', () => {}).resume();
    assert.equal(await status('/control'), 403, 'la regia resta chiusa');
    await save({ overlayLan: false });
    await waitFor(() => closed, 3000, 'collegamento remoto chiuso');
    assert.equal(await status('/overlay'), 403);
    assert.equal(links().network.length, 0);
  }
  await save({ saveFiles: false });
  ctx.startAudio();
  await waitFor(() => ctx.events.some((e) => e.t === 'translation'), 15000, 'traduzione');
  ctx.stopAudio();
  await sleep(500);
  assert.ok(!fs.existsSync(path.join(ctx.tmp, 'output')), 'nessun file scritto');
});

test('avviso AI: spento, predefinito nella lingua dell\'uscita, personalizzato', async () => {
  ctx = await setup();
  const notice = () => ctx.events.filter((e) => e.t === 'profile').at(-1)?.notice;
  await waitFor(() => notice() !== undefined, 3000, 'profilo');
  assert.equal(notice(), '');
  ctx.cmd({ cmd: 'settingsSave', aiNotice: true });
  await waitFor(() => /^AI-generated/.test(notice()), 5000, 'avviso in inglese');
  ctx.cmd({ cmd: 'target', out: 'stream', lang: 'it' });
  await waitFor(() => /^Sottotitoli/.test(notice()), 5000, 'avviso in italiano');
  ctx.cmd({ cmd: 'settingsSave', aiNoticeText: `  ${'x'.repeat(300)}` });
  await waitFor(() => notice() === 'x'.repeat(160), 5000, 'testo personalizzato');
  ctx.cmd({ cmd: 'settingsSave', aiNotice: false });
  await waitFor(() => notice() === '', 5000, 'avviso spento');
});

test('più lingue: ogni uscita nella sua lingua, traduce solo ciò che va in onda', async () => {
  ctx = await setup();
  ctx.cmd({ cmd: 'languages', spoken: ['it', 'en', 'es', 'xx'], targets: ['es', 'en'] });
  ctx.cmd({ cmd: 'target', out: 'stream', lang: 'es' });
  ctx.cmd({ cmd: 'target', out: 'room', lang: 'de' }); // non tra le destinazioni: ignorata
  const state = await waitFor(() => [...ctx.messages].reverse().find((m) => m.t === 'state' && m.outputs.stream.target === 'es'), 3000, 'stato');
  assert.deepEqual(state.languages, { spoken: ['it', 'en', 'es'], targets: ['es', 'en'] });
  assert.equal(state.outputs.room.target, 'en');

  ctx.startAudio();
  await waitFor(() => ctx.events.filter((e) => e.t === 'translation').length >= 3, 15000, 'tre traduzioni');
  ctx.stopAudio();
  const url = new URL(ctx.mock.stats.connectUrls[0], 'http://x');
  assert.deepEqual(JSON.parse(url.searchParams.get('language_codes')), ['it', 'en', 'es']);
  // L'uscita Streaming riceve solo lo spagnolo, qualunque lingua si parli.
  assert.ok(ctx.events.filter((e) => e.t === 'translation').every((e) => e.lang === 'es' && e.text.startsWith('[ES]')));
  // Sala in inglese: chi parla inglese viene tradotto nella prima altra lingua, lo spagnolo.
  const targets = new Set(ctx.mock.stats.translateBodies.map((b) => b.target_lang));
  assert.deepEqual([...targets].sort(), ['EN-GB', 'ES']);
  assert.ok(!ctx.mock.stats.translateBodies.some((b) => b.target_lang === 'IT'), 'nessuna lingua fuori onda');

  await sleep(500);
  const dir = path.join(ctx.tmp, 'output', fs.readdirSync(path.join(ctx.tmp, 'output'))[0]);
  const files = fs.readdirSync(dir);
  for (const f of ['originale.srt', 'spagnolo.srt', 'inglese.srt', 'italiano.srt']) assert.ok(files.includes(f), `manca ${f}`);
  assert.match(fs.readFileSync(path.join(dir, 'spagnolo.srt'), 'utf8'), /^1\n.*\n\[ES\] w0/m);
  assert.match(fs.readFileSync(path.join(dir, 'trascrizione.txt'), 'utf8'), /  ES: \[ES\] w0/);
});

test('sottotitoli nativi: OBS con password riceve il testo nella lingua scelta', async () => {
  const captions = [];
  let password = 'segreta';
  const obsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => obsServer.once('listening', r));
  obsServer.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { challenge: 'sfida', salt: 'sale' } } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 1) {
        if (m.d.authentication !== obsAuth(password)) { ws.close(4009, 'Authentication failed'); return; }
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (m.op === 6) {
        if (m.d.requestType === 'SendStreamCaption') captions.push(m.d.requestData.captionText);
        const responseData = m.d.requestType === 'GetStreamStatus' ? { outputActive: true } : undefined;
        ws.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
      }
    });
  });
  try {
    ctx = await setup();
    const obsPort = obsServer.address().port;
    ctx.cmd({ cmd: 'captionsTarget', lang: 'en' });
    ctx.cmd({ cmd: 'settingsSave', obsEnabled: true, obsHost: '127.0.0.1', obsPort, obsPassword: 'segreta' });
    await waitFor(() => ctx.statuses.at(-1)?.obs.state === 'connected' && ctx.statuses.at(-1).obs.streaming, 8000, 'OBS collegato e in diretta');

    ctx.startAudio();
    await waitFor(() => captions.length >= 2, 15000, 'due sottotitoli');
    ctx.stopAudio();
    // Frase italiana: in inglese. Frase inglese: l'originale, perché è già nella lingua scelta.
    assert.match(captions[0], /^\[EN-GB\] w0/);
    assert.ok(captions.every((c) => c.length <= 64), 'al massimo due righe CEA-608 per volta');
    await waitFor(() => captions.some((c) => /^w6/.test(c)), 10000, 'frase inglese come originale');
    assert.ok(!JSON.stringify(ctx.messages).includes('segreta'), 'password mai rimandata');

    password = 'cambiata';
    ctx.cmd({ cmd: 'settingsSave', obsPort: obsPort + 0, obsPassword: 'sbagliata' });
    await waitFor(() => ctx.statuses.at(-1)?.obs.lastError === 'Password di OBS rifiutata', 8000, 'password rifiutata');
  } finally {
    obsServer.close();
  }
});

