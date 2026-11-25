// Confronta i moduli Rust con quelli JavaScript su casi fissi e casuali (sempre gli stessi).
// Uso: cargo build --release --example parity && node parity.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleaner } from '../../server/textclean.js';
import { parseGlossaryCsv } from '../../server/deepl.js';
import { captionChunks, obsAuth } from '../../server/obs.js';
import { isNewer } from '../../server/updates.js';
import { noticeText } from '../../server/notice.js';
import * as i18n from '../../server/i18n.js';
import * as languages from '../../server/languages.js';
import * as store from '../../server/store.js';
import { Settings, maskKey } from '../../server/settings.js';
import { TurnSegmenter } from '../../server/segmenter.js';
import { Transcript } from '../../server/transcript.js';

const N = Number(process.argv[2]) || 400;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const many = (n, f) => Array.from({ length: n }, f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true }));
console.warn = () => {};

const cases = [];
const add = (name, args, expected) => cases.push({ name, args, expected });

const WORDS = ['ciao', 'Ehm', 'ehm,', 'uhm', 'mmm', 'cioè', 'Cioè,', 'cioè cioè', 'you know', 'You know,', 'YOU KNOW you know', 'i mean', 'like', ', like,', 'like,',
  'cazzo', 'CAZZATA', 'merda!', 'fuck', 'fucking', 'shit.', 'porco dio', 'bastardi', 'scunthorpe', 'mandolino', 'emme', 'è', 'più', 'perché', 'perché…', 'E', 'eh', 'ehh', 'er',
  '.', ',', '?', '…', ';', ':', ' , ', '  ', ' ', '﻿', '\u0085', '\t', '\n', 'école', 'Straße', 'ÀÈ', 'İstanbul', '日本語', '👍🏽', '𝒳yz', "l'acqua", '3', '10,5', '"', '""', 'di', 'the', 'che'];
const phrase = (n = 12) => many(int(n) + 1, () => pick(WORDS)).join(rnd() < 0.85 ? ' ' : '');
for (const x of ['', '  ', 'Ehm, allora iniziamo', 'Um.', 'cioè, cioè, cioè bene', 'Well, you know, it works.', 'eh eh eh', '😀', 'Ehm ßtest', '...', 'ma, , però']) {
  for (const f of [true, false]) for (const p of [true, false]) add('clean', [x, f, p], createCleaner({ fillers: f, profanity: p })(x));
}
for (let i = 0; i < N * 10; i++) {
  const x = phrase(); const f = rnd() < 0.8; const p = rnd() < 0.8;
  add('clean', [x, f, p], createCleaner({ fillers: f, profanity: p })(x));
}
const CSV = ['uno', 'two', '"a, b"', '"di ""x"""', ',', ', ', ' ,', '\n', '\r\n', '#', 'Italiano', 'italiano,inglese', '\t', '"', '""', ' ', '﻿', 'È', 'è', ''];
for (let i = 0; i < N * 3; i++) { const x = many(int(14) + 1, () => pick(CSV)).join(''); add('glossary', [x], parseGlossaryCsv(x)); }
add('glossary', [fs.readFileSync(new URL('../../glossario.csv', import.meta.url), 'utf8')], parseGlossaryCsv(fs.readFileSync(new URL('../../glossario.csv', import.meta.url), 'utf8')));
for (let i = 0; i < N; i++) {
  const x = phrase(30).replaceAll('𝒳', '');
  const size = pick([64, 20, 8]);
  // Dove JavaScript spezza un'emoji a metà, Rust la lascia intera: caso escluso dal confronto.
  if (!/\p{Extended_Pictographic}/u.test(x)) add('chunks', [x, size], captionChunks(x, size));
  add('obsAuth', [phrase(2), phrase(1), String(i)], null);
  const c = cases[cases.length - 1]; c.expected = obsAuth(...c.args);
}
const VERS = ['1.2.1', '1.10.0', 'v1.9.2', 'Duetto_1.2.1', 'x', '', '1', '2.', '1.2.3.4', '1..2', '0.0.1', 'a1b2.3', '10.0', '1.2', 'rel-2026.11'];
for (const a of VERS) for (const b of VERS) add('isNewer', [a, b], isNewer(a, b));
for (const on of [true, false]) for (const c of ['', 'mio']) for (const l of ['it', 'en', 'fr', 'ja', '']) add('notice', [on, c, l], noticeText(on, c, l));
for (const lang of ['it', 'en']) {
  i18n.setLanguage(lang);
  for (const k of [...Object.keys(i18n.englishDictionary()), 'manca {n} {x} {', '{}{{n}}{error}', 'à{n}é']) add('t', [lang, k], i18n.t(k, { n: 5, error: 'x{n}' }));
}
for (const c of ['auto', 'it', 'en', 'fr', '']) for (const l of ['it-IT', 'it', 'IT', 'it_IT', 'ita', 'it.UTF-8', 'en-GB', '', 'i', 'it5', 'itè']) add('resolve', [c, l], i18n.resolveLanguage(c, l));
const CODES = languages.LANGUAGES.map((l) => l.code);
for (const c of [...CODES, 'EN', 'en-US', 'NB', 'nn-NO', 'ZH_hans', 'xx', '', 'PL', 'it-', '-it']) add('detected', [c], languages.codeFromDetected(c));
add('languages', [], languages.LANGUAGES.map((l) => [l.code, l.name, l.file, l.source || '', l.target, l.latin, l.spoken]));
const junk = () => pick([null, 5, 'it', true, 'zz', 'IT', {}, ...CODES]);
for (let i = 0; i < N; i++) {
  const targets = many(int(5), () => pick(CODES));
  const a = pick(CODES); const b = pick([...CODES, '']);
  add('effective', [a, b, targets], languages.effectiveTarget(a, b, targets));
  add('captionsTarget', [pick([...CODES, 'original', 'x']), targets], null);
  let c = cases[cases.length - 1]; c.expected = store.pickCaptionsTarget(...c.args);
  add('mode', [pick(['auto', ' AUTO ', 'IT', 'it', 'xx', '', 'En ']), targets], null);
  c = cases[cases.length - 1]; c.expected = store.normalizeMode(...c.args);
  const input = { spoken: pick([null, 'it', many(int(12), junk)]), targets: pick([7, many(int(14), junk)]) };
  add('sanitizeLanguages', [input], store.sanitizeLanguages(input));
}
add('schema', [], [store.STYLE_SCHEMA, store.DEFAULT_STYLES]);
const FIELDS = store.STYLE_SCHEMA.flatMap((g) => g.fields);
const VALUES = [null, true, false, 0, 5, -3, 44.5, 1e9, '12', ' 7 ', '0x10', '', 'abc', '1e2', '1.5.2', '+3', '-', [], [5], [1, 2], ['8'], {}, '#ffffff', '#FFF', '#12345g', '#ffffff\n',
  'normal', 'italic', 'google', 'none', 'left', 'Arial', "Font d'oro, 2", 'Tinos\n', 'x'.repeat(81), 'é-1', '<b>', '日本'];
const style = () => Object.fromEntries(many(int(12), () => [pick([...FIELDS.map((f) => f.key), 'x']), pick(VALUES)]));
for (const f of FIELDS) for (const v of VALUES) add('style', [{ [f.key]: v }], store.sanitizeStyle({ [f.key]: v }));
for (const v of [null, 5, 'x', [], [1]]) add('style', [v], store.sanitizeStyle(v));
const presets = () => Object.fromEntries(many(int(6), () => [`${pick([' ', 'p', 'è', 'lungo'.repeat(20)])}${pick(['a', 'b', ' ', ''])}`, pick([style(), null, 3])]));
for (let i = 0; i < N; i++) { const p = presets(); add('presets', [p], store.sanitizePresets(p)); }
for (const k of ['', 'abc', 'abcdefgh', '1234']) add('mask', [k], maskKey(k));

// Parlato continuo con revisioni: parole che cambiano, si uniscono, si raddoppiano.
const SPEECH = ['allora', 'oggi', 'parliamo', 'di', 'questo', 'progetto,', 'che', 'è', 'nato', 'per', 'caso.', 'We', 'are', 'going', 'to', 'the', 'next', 'point,', 'please?', 'perché', 'il', 'mercato;', 'è', '-', '…', 'straordinariamente', 'e', 'la', 'ragione:', 'a'];
for (let i = 0; i < N; i++) {
  let time = 0;
  const full = many(int(60) + 2, () => { const start = time; time += 60 + int(500); return { text: pick(SPEECH), start, end: time - int(40) }; });
  const steps = [];
  for (let n = 1; n <= full.length; n += 1 + int(3)) {
    let w = full.slice(0, n).map((x) => ({ ...x, start: x.start + int(300), end: x.end + int(300) }));
    if (rnd() < 0.2 && w.length > 3) w.splice(int(w.length), 1);
    if (rnd() < 0.15) { const k = int(w.length); w.splice(k, 0, { ...w[k] }); }
    if (rnd() < 0.2) w[w.length - 1].text += '.';
    steps.push(w);
  }
  const seg = new TurnSegmenter();
  const out = steps.map((w) => seg.update(w));
  out.push(seg.finish(full, 'testo finale'));
  add('segment', [steps, full, 'testo finale'], out);
}

// File scritti da JavaScript e da Rust: devono coincidere byte per byte.
for (let i = 0; i < N / 2; i++) {
  const data = {
    envLanguageMode: pick(['AUTO', 'IT', 'it', undefined]), languageMode: pick(['AUTO', 'it', 'EN', 'zz', undefined]),
    languages: pick([undefined, { spoken: ['it', 'fr'], targets: ['ja', 'de'] }, { spoken: many(3, junk), targets: many(3, junk) }]),
    lastLanguage: pick(['it', 'fr', null, 'zz']), captionsTarget: pick(['original', 'de', 'ja', 'it']), presets: presets(),
    outputs: pick([undefined, {}, { stream: { view: pick(['both', 'x', 'original']), hidden: pick([true, 1, false]), target: pick(CODES), style: style() }, room: {} }]),
  };
  const text = pick([JSON.stringify(data), JSON.stringify(data), JSON.stringify(data), '{rotto', '{}']);
  const mode = pick(['', 'AUTO', 'it', 'FR']);
  const js = path.join(tmp, `js${i}.json`);
  fs.writeFileSync(js, text);
  new store.Store(js, mode);
  add('store', [path.join(tmp, `rs${i}.json`), text, mode], fs.readFileSync(js, 'utf8'));
}
for (let i = 0; i < N / 2; i++) {
  const some = (o) => Object.fromEntries(Object.entries(o).filter(() => rnd() < 0.5));
  const saved = some({ assemblyaiApiKey: 'chiave-finta', deeplApiKey: '', assemblyaiRegion: pick(['eu', 'x']), uiLanguage: pick(['it', 'zz']), checkUpdates: false, saveFiles: true, aiNotice: true, aiNoticeText: 'ciao', cleanFillers: pick([null, true]), obsPort: 4456, obsHost: 'studio', obsPassword: 'finta' });
  const change = some({ assemblyaiApiKey: pick(['', '  nuova ', 5, null]), assemblyaiRegion: pick(['eu', 'auto', 'zz']), uiLanguage: pick(['it', 'en', 1]), checkUpdates: pick([true, 'x', null]), overlayLan: true, aiNoticeText: pick([' è ', 'x'.repeat(200), 3]), cleanProfanity: pick([false, null]), obsHost: pick([' 10.0.0.2 ', 'a b', 'é', '']), obsPort: pick([1, '4460', 0, 70000, 'x', null, 1.5]), obsEnabled: true });
  const js = path.join(tmp, `sjs${i}.json`);
  fs.writeFileSync(js, JSON.stringify(saved));
  new Settings(js).update(change);
  add('settings', [path.join(tmp, `srs${i}.json`), JSON.stringify(saved), change], fs.readFileSync(js, 'utf8'));
}

// Cifratura: Rust legge ciò che scrive Node (formato di node-host.mjs), e viceversa.
const key = Buffer.alloc(32, 7);
const seal = (text) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64'); };
const open = (data) => { const r = Buffer.from(data, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, r.subarray(0, 12), { authTagLength: 16 }); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]).toString('utf8'); };
for (const x of ['', 'finta-123', 'è👍']) { add('decrypt', [seal(x)], x); add('encrypt', [x], { check: (got) => open(got) === x }); }
const bad = Buffer.from(seal('x'), 'base64'); bad[30 - 2] ^= 1;
for (const x of [bad.toString('base64'), '', 'non base64!', 'AAAA']) add('decrypt', [x], null);

const read = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
for (let i = 0; i < 20; i++) {
  const t = new Transcript(path.join(tmp, `tjs${i}`));
  let at = Date.UTC(2026, 10, 25, 12) + int(1e6);
  const entries = many(8, () => {
    at += int(3000);
    const targets = many(int(4), () => pick(CODES)).filter((c, k, a) => a.indexOf(c) === k);
    return { text: phrase(), lang: pick(CODES), targets, translations: Object.fromEntries(targets.filter(() => rnd() < 0.7).map((c) => [c, pick(['', phrase()])])), mode: 'AUTO', startAt: at, endAt: at + int(4000) };
  });
  entries.forEach((e) => t.addSentence(e));
  add('transcript', [path.join(tmp, `trs${i}`), entries], { check: (dir) => JSON.stringify(read(dir)) === JSON.stringify(read(t.dir)) });
}

const bin = new URL('target/release/examples/parity', import.meta.url).pathname;
const res = spawnSync(bin, { input: cases.map((c) => JSON.stringify([c.name, c.args])).join('\n'), encoding: 'utf8', maxBuffer: 1 << 29 });
const lines = res.stdout.trim().split('\n');
if (lines.length !== cases.length) { console.log('Rust si è fermato al caso', lines.length, JSON.stringify(cases[lines.length]).slice(0, 400), res.stderr.slice(-400)); process.exit(1); }
const tally = {};
cases.forEach((c, i) => {
  const got = JSON.parse(lines[i]);
  const ok = c.expected?.check ? c.expected.check(got) : JSON.stringify(got) === JSON.stringify(JSON.parse(JSON.stringify(c.expected)));
  const row = (tally[c.name] ??= { ok: 0, no: 0 });
  row[ok ? 'ok' : 'no'] += 1;
  if (!ok && row.no <= 3) console.log('DIVERSO', c.name, JSON.stringify(c.args).slice(0, 300), '\n  js  ', JSON.stringify(c.expected)?.slice(0, 400), '\n  rust', lines[i].slice(0, 400));
});
for (const [k, v] of Object.entries(tally)) console.log(v.no ? 'NO' : 'ok', k, `${v.ok}/${v.ok + v.no}`);
console.log('casi', cases.length);
process.exit(Object.values(tally).some((v) => v.no) ? 1 : 0);
