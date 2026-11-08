// Prove dell'intero server contro i finti servizi: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { parseGlossaryCsv } from '../server/deepl.js';
import { TurnSegmenter } from '../server/segmenter.js';
import { Store } from '../server/store.js';
import { createCleaner } from '../server/textclean.js';
import { FRAME_MAGIC, startMock } from './mock-services.js';

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
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      PORT: String(port), HOST: '127.0.0.1',
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
    fs.rmSync(tmp, { recursive: true, force: true });
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

test('pulizia del testo', () => {
  const clean = createCleaner();
  assert.equal(clean('Ehm, vorrei cioè cioè dire una cosa.'), 'Vorrei cioè dire una cosa.');
  assert.equal(clean('It was, you know, a good idea.'), 'It was, a good idea.');
  assert.equal(clean('I like, um, pizza and I like you.'), 'I like, pizza and I like you.');
  assert.equal(clean('Che cazzo succede?'), 'Che c***o succede?');
  assert.equal(clean('This is bullshit.'), 'This is b******t.');
  assert.equal(clean('Ehm.'), '');
  const off = createCleaner({ fillers: false, profanity: false });
  assert.equal(off('Ehm, che cazzo.'), 'Ehm, che cazzo.');
});

test('glossario CSV', () => {
  const pairs = parseGlossaryCsv('# nota\nitaliano,inglese\nsala stampa,press room\n"a, b",c\nsala stampa,doppione\n');
  assert.deepEqual(pairs, [['sala stampa', 'press room'], ['a, b', 'c']]);
});

test('segmentatore su parlato reale: blocchi brevi, nessuna parola persa', () => {
  // 49 s di parlato continuo registrati da AssemblyAI: un unico turno da 991 caratteri.
  const file = new URL('./fixtures/parlato-continuo.json', import.meta.url);
  const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
  const toWords = (m) => m.words.map(([text, start, end]) => ({ text, start, end }));
  const seg = new TurnSegmenter();
  const blocks = [];
  for (const m of messages) {
    if (m.end_of_turn) {
      const rest = seg.finish(toWords(m), m.transcript);
      if (rest) blocks.push(rest.text);
    } else {
      blocks.push(...seg.update(toWords(m)).blocks.map((b) => b.text));
    }
  }
  assert.ok(blocks.length >= 10, `troppo pochi blocchi: ${blocks.length}`);
  assert.ok(blocks.every((b) => b.length <= 90), `blocco troppo lungo: ${Math.max(...blocks.map((b) => b.length))}`);
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const said = norm(messages.at(-1).transcript);
  const got = norm(blocks.join(' '));
  assert.ok(Math.abs(said.length - got.length) <= 2, `parole: ${said.length} contro ${got.length}`);
  // Conta le parole in ordine, tollerando le revisioni isolate dei parziali.
  let j = 0;
  for (const word of got) if (said.indexOf(word, j) >= 0 && said.indexOf(word, j) <= j + 3) j = said.indexOf(word, j) + 1;
  assert.ok(j >= said.length - 2, `allineate solo ${j} parole su ${said.length}`);
});

test('segmentatore: tempi instabili e parole ripetute non creano doppioni', () => {
  // Caso reale: "…input channels or mix channels." ripetuto perché i tempi si spostavano.
  const script = 'so you are not eating up any of those input channels or mix channels, every input channel has a preamp section, a gate and a compressor for the sound';
  const all = script.split(' ').map((text, i) => ({ text, start: i * 300, end: i * 300 + 300 }));
  const seg = new TurnSegmenter();
  const blocks = [];
  for (let n = 1; n <= all.length; n++) {
    // A ogni messaggio i tempi delle parole già dette si spostano fino a 2 s in avanti o indietro.
    const shift = (n % 5 - 2) * 1000;
    const words = all.slice(0, n).map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
    // L'ultima parola è più avanti, così le precedenti risultano stabili.
    words[words.length - 1] = { ...words[words.length - 1], end: words[words.length - 1].end + 2500 };
    blocks.push(...seg.update(words).blocks.map((b) => b.text));
  }
  const rest = seg.finish(all, script);
  if (rest) blocks.push(rest.text);
  assert.ok(blocks.length >= 2, 'il turno viene diviso');
  assert.equal(blocks.join(' '), script);
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
  assert.ok(bodies.every((b) => b.glossary_id), 'glossario applicato');
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
  assert.match(text, /\[IT\] \[modalità AUTO\]\n  Originale:  w0/);
  assert.match(text, /\[EN\] \[modalità AUTO\]\n  Originale:  w6/);
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
    return dir && fs.readFileSync(path.join(ctx.tmp, 'output', dir, 'trascrizione.txt'), 'utf8').includes('Modalità lingua: EN');
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
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'file leggibile solo dal proprietario');
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
  assert.equal(saved.languageMode, 'IT');
  assert.equal(saved.outputs.room.style.size, 200);
  assert.equal(saved.outputs.room.style.colorOriginal, '#ffffff');
  assert.equal(saved.outputs.room.style.font, 'Arial');
  assert.deepEqual(saved.presets.Prova, { size: 50, sizeTranslation: 50 });
});

test('stili della 1.0.1: la traduzione eredita il carattere unico', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-store-'));
  const file = path.join(tmp, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    outputs: { room: { style: { font: 'Verdana', weight: 400, size: 90 } } },
    presets: { Vecchio: { size: 30 }, Nuovo: { size: 30, sizeTranslation: 20 } },
  }));
  const store = new Store(file, 'AUTO');
  const room = store.state.outputs.room.style;
  assert.equal(room.fontTranslation, 'Verdana');
  assert.equal(room.weightTranslation, 400);
  assert.equal(room.sizeTranslation, 90);
  assert.equal(store.state.outputs.stream.style.sizeTranslation, 44, 'uscita non personalizzata');
  assert.equal(store.state.presets.Vecchio.sizeTranslation, 30);
  assert.equal(store.state.presets.Nuovo.sizeTranslation, 20, 'valore separato già scelto');
  fs.rmSync(tmp, { recursive: true, force: true });
});
