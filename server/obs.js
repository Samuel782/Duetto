// Sottotitoli nativi della diretta: il testo va a OBS con obs-websocket (versione 5, inclusa in
// OBS 28 e successivi) e OBS lo inserisce nello streaming come sottotitoli CEA-608, che YouTube e
// Twitch mostrano come sottotitoli attivabili dallo spettatore.
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { t } from './i18n.js';
import { log, warn } from './log.js';

const RETRY_MS = 5000;
const STATUS_EVERY_MS = 5000;
// CEA-608 mostra al massimo 32 caratteri per riga: si mandano due righe alla volta, per pezzi.
const CHUNK_CHARS = 64;
const MIN_SHOW_MS = 1500;
const MS_PER_CHAR = 45;
const MAX_QUEUE = 8; // chi parla molto veloce non deve far accumulare ritardo

// Divide una frase in pezzi di due righe, senza spezzare le parole.
export function captionChunks(text, size = CHUNK_CHARS) {
  const chunks = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= size) { line = candidate; continue; }
    if (line) chunks.push(line);
    line = word.slice(0, size);
  }
  if (line) chunks.push(line);
  return chunks;
}

// Risposta alla richiesta di password di obs-websocket: due SHA-256 in base64.
export function obsAuth(password, salt, challenge) {
  const hash = (text) => crypto.createHash('sha256').update(text).digest('base64');
  return hash(hash(password + salt) + challenge);
}

export class ObsCaptions {
  constructor() {
    this.cfg = { enabled: false, host: '127.0.0.1', port: 4455, password: '' };
    this.ws = null;
    this.state = 'off'; // off, connecting, connected
    this.streaming = false;
    this.lastError = '';
    this.queue = [];
    this.sending = false;
    this.nextId = 0;
    this.pending = new Map();
    this.retryTimer = null;
    this.statusTimer = null;
    this.sent = 0;
  }

  configure(cfg) {
    const changed = ['enabled', 'host', 'port', 'password'].some((k) => cfg[k] !== undefined && cfg[k] !== this.cfg[k]);
    Object.assign(this.cfg, cfg);
    if (!changed) return;
    this._close();
    this.lastError = '';
    if (this.cfg.enabled) this._connect();
  }

  status() {
    return {
      enabled: this.cfg.enabled, state: this.state, streaming: this.streaming,
      live: this.state === 'connected' && this.streaming, lastError: this.lastError, sent: this.sent,
    };
  }

  // Aggiunge una frase ai sottotitoli. Parte solo se OBS è collegato e in diretta.
  push(text) {
    if (!this.status().live || !text) return;
    this.queue.push(...captionChunks(text));
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this._sendNext();
  }

  _sendNext() {
    if (this.sending || !this.queue.length) return;
    const chunk = this.queue.shift();
    this.sending = true;
    this._request('SendStreamCaption', { captionText: chunk }).then((ok) => {
      if (ok) this.sent += 1;
    });
    // Ogni pezzo resta il tempo di leggerlo prima del successivo.
    setTimeout(() => {
      this.sending = false;
      this._sendNext();
    }, Math.max(MIN_SHOW_MS, chunk.length * MS_PER_CHAR));
  }

  _connect() {
    clearTimeout(this.retryTimer);
    this.state = 'connecting';
    let ws;
    try {
      ws = new WebSocket(`ws://${this.cfg.host}:${this.cfg.port}`, 'obswebsocket.json', { handshakeTimeout: 4000 });
    } catch (err) {
      this.lastError = err.message;
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      this._onMessage(ws, m);
    });
    ws.on('error', (err) => {
      this.lastError = err.code === 'ECONNREFUSED'
        ? t('OBS non risponde: è aperto, con il server WebSocket attivo?')
        : err.message;
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      // 4009: password sbagliata. Riprovare non serve finché non cambia.
      if (code === 4009) this.lastError = t('Password di OBS rifiutata');
      else if (reason?.length && !this.lastError) this.lastError = reason.toString();
      if (this.state === 'connected') warn(`OBS: collegamento perso (${code})`);
      this.ws = null;
      this.state = code === 4009 ? 'off' : 'connecting';
      this.streaming = false;
      this._failPending();
      clearInterval(this.statusTimer);
      if (code !== 4009) this._scheduleRetry();
    });
  }

  _onMessage(ws, m) {
    if (m.op === 0) { // Hello: OBS chiede chi siamo e, se serve, la password
      const auth = m.d?.authentication;
      const identify = { rpcVersion: 1, eventSubscriptions: 0 };
      if (auth) identify.authentication = obsAuth(this.cfg.password, auth.salt, auth.challenge);
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (m.op === 2) { // Identified
      this.state = 'connected';
      this.lastError = '';
      log('OBS: collegato per i sottotitoli');
      this._refreshStreaming();
      this.statusTimer = setInterval(() => this._refreshStreaming(), STATUS_EVERY_MS);
    } else if (m.op === 7) { // risposta a una richiesta
      const done = this.pending.get(m.d?.requestId);
      if (done) {
        this.pending.delete(m.d.requestId);
        done(m.d);
      }
    }
  }

  async _refreshStreaming() {
    const res = await this._request('GetStreamStatus', {});
    this.streaming = !!res?.outputActive;
  }

  // Invia una richiesta. Restituisce i dati della risposta se riuscita, altrimenti null.
  _request(type, data) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'connected') return Promise.resolve(null);
    const requestId = String(++this.nextId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(null); }, 4000);
      this.pending.set(requestId, (d) => {
        clearTimeout(timer);
        if (!d.requestStatus?.result) {
          if (type === 'SendStreamCaption') this.lastError = t('OBS ha rifiutato il sottotitolo: {error}', { error: d.requestStatus?.comment || d.requestStatus?.code });
          resolve(null);
          return;
        }
        resolve(d.responseData || {});
      });
      ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, requestData: data } }));
    });
  }

  _failPending() {
    for (const done of this.pending.values()) done({ requestStatus: { result: false } });
    this.pending.clear();
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.cfg.enabled) this.retryTimer = setTimeout(() => this._connect(), RETRY_MS);
  }

  _close() {
    clearTimeout(this.retryTimer);
    clearInterval(this.statusTimer);
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    this.state = 'off';
    this.streaming = false;
    this._failPending();
    ws?.terminate();
  }

  stop() {
    this.cfg.enabled = false;
    this._close();
  }
}
