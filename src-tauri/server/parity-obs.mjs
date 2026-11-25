// Collegamento a OBS in JavaScript e in Rust contro lo stesso finto OBS: stessi messaggi, stessi stati.
// Uso: cargo build --release --example obs_probe && node parity-obs.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import { ObsCaptions, obsAuth } from '../../server/obs.js';

const real = console.log;
console.log = () => {}; console.warn = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const on = (o = {}) => ({ op: 'configure', enabled: true, wait: 500, ...o });
const push = (text, wait = 300) => ({ op: 'push', text, wait });
const rest = (wait) => ({ op: 'wait', wait });
const LONG = Array.from({ length: 120 }, (_, i) => `parola${i}`).join(' ');
const S = [];
const add = (name, steps, server = {}) => S.push({ name, steps, server });
add('in diretta', [on(), push('Ciao a tutti'), rest(1500), push(''), push('Seconda 👍 frase'), rest(2000)]);
add('non in diretta', [on(), push('Ciao')], { live: false });
add('password giusta', [on({ password: 'segreta' }), push('Ciao')], { password: 'segreta' });
add('password sbagliata', [on({ password: 'no' }), rest(6000), on({ password: 'segreta' }), push('Ciao')], { password: 'segreta' });
add('password non richiesta', [on({ password: 'inutile' }), push('Ciao')]);
add('spento', [{ op: 'configure', enabled: false }, push('Ciao')]);
add('acceso e spento', [on(), { op: 'configure', enabled: false }, push('Ciao'), on(), push('Torna')]);
add('stessa configurazione', [on(), on(), push('Ciao')]);
add('fermato', [on(), push('Ciao'), { op: 'stop' }, push('Dopo')]);
add('sottotitolo rifiutato', [on(), push('Ciao'), push('Altra', 1800)], { refuse: 'uscita non attiva' });
add('rifiuto senza commento', [on(), push('Ciao')], { refuse: '' });
add('OBS chiuso', [on({ port: 1 }), push('Ciao'), rest(5500)]);
add('caduta e ritorno', [on(), push('Uno'), rest(2500), rest(5500), push('Due')], { closeAfter: 1500 });
add('chiusura con motivo', [on(), rest(1500), rest(5500)], { closeAfter: 800, code: 4010, reason: 'sessione non valida' });
add('diretta che parte dopo', [on(), push('Presto'), rest(5200), push('Ora sì')], { liveAfter: 2 });
add('frase lunga e coda', [on(), push(LONG, 400), push(LONG, 9000)]);
add('OBS muto', [on({ wait: 1500 }), push('Ciao')], { silent: true });
add('messaggi strani', [on(), push('Ciao')], { junk: true });
add('senza risposta alla domanda', [on(), push('Ciao'), rest(4500), push('Dopo')], { noStatus: true });
add('non è OBS', [on(), rest(5500)], { plain: true });
add('cambio porta', [on(), push('Uno'), { op: 'configure', port: 2, wait: 800 }], {});

async function fake(o) {
  const seen = [];
  const started = Date.now();
  if (o.plain) {
    const server = http.createServer((q, r) => r.writeHead(404).end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { seen, port: server.address().port, close: () => server.close() };
  }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => { seen.push(`protocollo ${[...p]}`); return [...p][0]; } });
  await new Promise((r) => wss.on('listening', r));
  let first = true;
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    let asked = 0;
    const send = (m) => ws.send(JSON.stringify(m));
    if (o.silent) return;
    const salt = 'sale'; const challenge = 'sfida';
    if (o.junk) { ws.send('{rotto'); ws.send('5'); send({ op: 99 }); send({ op: 7, d: { requestId: 'mai' } }); ws.send(Buffer.from([0, 255])); }
    send({ op: 0, d: { rpcVersion: 1, ...(o.password ? { authentication: { salt, challenge } } : {}) } });
    if (o.closeAfter && first) { first = false; setTimeout(() => ws.close(o.code || 1001, o.reason || ''), o.closeAfter); }
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      const kind = m.op === 6 ? m.d.requestType : `op${m.op}`;
      if (kind !== 'GetStreamStatus') seen.push(`${kind} ${JSON.stringify(m.op === 6 ? m.d.requestData : m.d)}`);
      if (m.op === 1) {
        if (o.password && m.d.authentication !== obsAuth(o.password, salt, challenge)) { ws.close(4009, 'Authentication failed.'); return; }
        send({ op: 2, d: { negotiatedRpcVersion: 1 } });
      }
      if (kind === 'GetStreamStatus') {
        asked += 1;
        if (o.noStatus && asked === 1) return;
        send({ op: 7, d: { requestId: m.d.requestId, requestType: kind, requestStatus: { result: true, code: 100 }, responseData: { outputActive: o.live !== false && asked >= (o.liveAfter || 1) } } });
      }
      if (kind === 'SendStreamCaption') {
        seen.push(`t${Math.round((Date.now() - started) / 500)}`);
        send({ op: 7, d: { requestId: m.d.requestId, requestType: kind, requestStatus: o.refuse === undefined ? { result: true, code: 100 } : { result: false, code: 501, ...(o.refuse ? { comment: o.refuse } : {}) } } });
      }
    });
  });
  return { seen, port: wss.address().port, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); } };
}
const withPort = (steps, port) => steps.map((s) => (s.op === 'configure' ? { port, ...s } : s));

async function js(s) {
  const f = await fake(s.server);
  const o = new ObsCaptions();
  const out = [];
  for (const p of withPort(s.steps, f.port)) {
    const { op, wait, ...cfg } = p;
    if (op === 'configure') o.configure(cfg);
    else if (op === 'push') o.push(p.text);
    else if (op === 'stop') o.stop();
    await sleep(wait ?? 250);
    out.push(o.status());
  }
  o.stop();
  f.close();
  return { out, seen: f.seen };
}
async function rust(s) {
  const f = await fake(s.server);
  const p = spawn(new URL('target/release/examples/obs_probe', import.meta.url).pathname, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let text = ''; let err = '';
  p.stdout.on('data', (d) => { text += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(JSON.stringify(withPort(s.steps, f.port)));
  await new Promise((r) => p.on('close', r));
  f.close();
  const line = text.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`${s.name}: ${err.slice(-400)}`);
  return { out: JSON.parse(line.slice(2)), seen: f.seen };
}
// Il testo degli errori della libreria cambia: conta che ci sia o no.
const OWN = /^(OBS |Password|sessione|$)/;
const tidy = (r, name) => JSON.stringify({ out: r.out.map((x) => ({ ...x, lastError: OWN.test(x.lastError) ? x.lastError : 'libreria' })), seen: r.seen.filter((x) => !/^t\d/.test(x)), times: r.seen.filter((x) => /^t\d/.test(x)).length });
const results = await Promise.all(S.map(async (s) => [s, ...(await Promise.all([js(s), rust(s)]))]));
let bad = 0;
for (const [s, a, b] of results) {
  const ta = a.seen.filter((x) => /^t\d/.test(x)).map((x) => +x.slice(1));
  const tb = b.seen.filter((x) => /^t\d/.test(x)).map((x) => +x.slice(1));
  const paced = ta.every((x, i) => Math.abs(x - tb[i]) <= 1);
  if (tidy(a) !== tidy(b) || !paced) { bad += 1; real('DIVERSO', s.name, '\n  js  ', tidy(a), ta.join(), '\n  rust', tidy(b), tb.join()); }
}
real(`scenari ${S.length}, diversi ${bad}`);
process.exit(bad ? 1 : 0);
