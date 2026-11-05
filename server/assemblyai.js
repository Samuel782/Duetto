// Collegamento ad AssemblyAI Streaming v3: sessione attiva, riconnessione e cambio
// di sessione prima del limite di 3 ore, senza perdere né duplicare il parlato.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log, warn } from './log.js';
import { TurnSegmenter } from './segmenter.js';

const BYTES_PER_MS = 32; // PCM 16 bit, mono, 16 kHz
const AUDIO_BUFFER_BYTES = 3000 * BYTES_PER_MS; // massimo 3 secondi di buffer
const MAX_SOCKET_BACKLOG = 5000 * BYTES_PER_MS; // oltre questo la connessione è bloccata
const DEAD_AFTER_MS = 7000; // nessun messaggio né pong: connessione morta
const STALE_REPLAY_MS = 3000; // da questa età l'audio recente non è stato elaborato
const AUDIO_IDLE_MS = 15000; // senza audio chiude la sessione, che è fatturata a connessione aperta
const HANDOFF_MIN_MS = 1500; // audio minimo dato alla nuova sessione prima del passaggio
const HANDOFF_FORCE_MS = 15000; // poi chiude il turno in corso con ForceEndpoint
const HANDOFF_MAX_MS = 20000; // e infine passa comunque
const DEFAULT_SESSION_MS = 3 * 3600 * 1000;

const LANGUAGE_CODES = { AUTO: ['it', 'en'], IT: ['it'], EN: ['en'] };

// Verifica una chiave aprendo e chiudendo subito una sessione: il costo è di pochi secondi.
export function testAssemblyKey({ url, model, apiKey }) {
  return new Promise((resolve) => {
    if (!apiKey) { resolve({ ok: false, message: 'Chiave mancante' }); return; }
    let settled = false;
    let errorText = '';
    const params = new URLSearchParams({ speech_model: model, encoding: 'pcm_s16le', sample_rate: '16000' });
    const ws = new WebSocket(`${url}?${params}`, { headers: { Authorization: apiKey }, handshakeTimeout: 6000 });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      finish({ ok: false, message: 'Nessuna risposta: controlla la connessione' });
    }, 8000);
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'Begin') {
        ws.send(JSON.stringify({ type: 'Terminate' }));
        finish({ ok: true, message: 'Chiave valida' });
      } else if (m.type === 'Error') {
        errorText = m.error || '';
      }
    });
    ws.on('error', (err) => { errorText = errorText || err.message; });
    ws.on('close', () => finish({ ok: false, message: errorText || 'Connessione rifiutata' }));
  });
}

export class AssemblyLink extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.mode = 'AUTO';
    this.keyterms = [];
    this.active = false;
    this.primary = null;
    this.next = null; // sessione in preparazione per il cambio
    this.sessions = new Set();
    this.recent = []; // ultimi 3 s, per recuperare l'audio inviato a una connessione morta
    this.recentBytes = 0;
    this.backlog = []; // audio in attesa di una sessione pronta
    this.backlogBytes = 0;
    this.catchUp = true; // recupera il buffer a velocità 2x
    this.attempts = 0;
    this.retryAt = 0;
    this.reconnectTimer = null;
    this.blockedUntil = 0;
    this.lastAudioAt = 0;
    this.lastError = '';
    this.closedBilledMs = 0;
    this.fatal = false;
    this.tickTimer = setInterval(() => this._tick(), 1000);
  }

  // --- Interfaccia pubblica ---

  pushAudio(frame) {
    if (this.isShutDown) return;
    const now = Date.now();
    this.lastAudioAt = now;
    this.recent.push(frame);
    this.recentBytes += frame.length;
    while (this.recentBytes > AUDIO_BUFFER_BYTES) this.recentBytes -= this.recent.shift().length;

    if (!this.active) {
      this.active = true;
      this.fatal = false;
      this.attempts = 0;
      this._open('primary');
    }

    // La nuova sessione inizia a ricevere audio solo a buffer vuoto: così il suo orologio
    // è allineato a quello della sessione corrente.
    if (this.next?.ready && !this.next.feeding && this.primary?.ready && !this.backlog.length) {
      this.next.feeding = true;
      this.next.offsetMs = this.primary.audioMs;
      this.next.feedStart = now;
    }

    this.backlog.push(frame);
    this.backlogBytes += frame.length;
    while (this.backlogBytes > AUDIO_BUFFER_BYTES) this.backlogBytes -= this.backlog.shift().length;

    if (this.primary?.ready) {
      for (let i = this.catchUp ? 2 : 1; i > 0 && this.backlog.length; i--) {
        const out = this.backlog.shift();
        this.backlogBytes -= out.length;
        this._sendAudio(this.primary, out);
      }
    }
    if (this.next?.feeding) this._sendAudio(this.next, frame);
  }

  // Pausa: la fatturazione dipende dalla connessione aperta, quindi la sessione va chiusa.
  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.recent = [];
    this.recentBytes = 0;
    this._clearBacklog();
    this.attempts = 0;
    this.retryAt = 0;
    if (this.primary) this._drain(this.primary, true);
    if (this.next) this._drain(this.next, false);
    this.primary = this.next = null;
  }

  setMode(mode) {
    this.mode = mode;
    this._updateConfig({ language_codes: LANGUAGE_CODES[mode] });
  }

  // Una chiave nuova vale subito: non serve aspettare il prossimo tentativo di riconnessione.
  setApiKey(key) {
    if (key === this.cfg.apiKey) return;
    this.cfg.apiKey = key;
    this.fatal = false;
    this.lastError = '';
    this.attempts = 0;
    this.retryAt = 0;
    if (this.active && !this.primary) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this._open('primary');
    }
  }

  setKeyterms(terms) {
    this.keyterms = terms;
    this._updateConfig({ keyterms_prompt: terms });
  }

  // Simula una caduta di rete: chiude tutto e rifiuta di riconnettersi per N secondi.
  simulateDrop(seconds) {
    this.blockedUntil = Date.now() + seconds * 1000;
    log(`Test: caduta simulata di ${seconds} s`);
    for (const s of this.sessions) if (s.ws) s.ws.terminate();
  }

  status() {
    const now = Date.now();
    let billed = this.closedBilledMs;
    for (const s of this.sessions) if (s.openedAt) billed += now - s.openedAt;
    let state = 'idle';
    if (this.active) {
      if (this.primary?.ready) state = 'connected';
      else state = this.attempts > 0 ? 'reconnecting' : 'connecting';
    }
    return {
      state,
      fatal: this.fatal,
      lastError: this.lastError,
      sessionId: this.primary?.id || '',
      model: this.cfg.model,
      billedSeconds: Math.round(billed / 1000),
      bufferedMs: Math.round(this.backlogBytes / BYTES_PER_MS),
      retryInSeconds: this.retryAt > now ? Math.ceil((this.retryAt - now) / 1000) : 0,
      handoff: !!this.next,
    };
  }

  shutdown() {
    this.isShutDown = true; // l'audio ancora in arrivo non deve riaprire una sessione
    clearInterval(this.tickTimer);
    this.stop();
  }

  // --- Sessioni ---

  _buildUrl() {
    const params = new URLSearchParams({
      speech_model: this.cfg.model,
      encoding: 'pcm_s16le',
      sample_rate: '16000',
      language_detection: 'true',
      language_codes: JSON.stringify(LANGUAGE_CODES[this.mode]),
      session_heartbeat: 'true',
    });
    if (this.cfg.minTurnSilence) params.set('min_turn_silence', this.cfg.minTurnSilence);
    if (this.cfg.maxTurnSilence) params.set('max_turn_silence', this.cfg.maxTurnSilence);
    const base = `${this.cfg.url}?${params}`;
    if (!this.keyterms.length) return { url: base, deferred: false };
    const url = `${base}&keyterms_prompt=${encodeURIComponent(JSON.stringify(this.keyterms))}`;
    // Con liste molto lunghe evita un URL eccessivo: i termini partono subito dopo Begin.
    return url.length < 6000 ? { url, deferred: false } : { url: base, deferred: true };
  }

  _open(role) {
    if (Date.now() < this.blockedUntil) {
      if (role === 'primary') this._scheduleReconnect();
      return;
    }
    const { url, deferred } = this._buildUrl();
    const s = {
      role, ws: null, id: '', ready: false, emit: role === 'primary', audioMs: 0, turn: null,
      speechMode: null, lastFinalEnd: 0, lastFinalOrder: -1, cutMs: 0, offsetMs: 0, feeding: false,
      feedStart: 0, forced: false, openedAt: 0, lastMsgAt: Date.now(), rolloverAt: 0, fatal: false,
      deferredKeyterms: deferred, errorText: '',
    };
    if (role === 'primary') this.primary = s; else this.next = s;
    this.sessions.add(s);
    try {
      s.ws = new WebSocket(url, {
        headers: { Authorization: this.cfg.apiKey },
        handshakeTimeout: 5000,
      });
    } catch (err) {
      this.lastError = err.message;
      this._onClosed(s, 1006, '');
      return;
    }
    s.ws.on('open', () => { s.openedAt = Date.now(); s.lastMsgAt = Date.now(); });
    s.ws.on('pong', () => { s.lastMsgAt = Date.now(); });
    s.ws.on('message', (data) => this._onMessage(s, data));
    s.ws.on('error', (err) => {
      s.errorText = s.errorText || err.message;
      if (/\b40[13]\b/.test(err.message)) s.fatal = true;
    });
    s.ws.on('close', (code, reason) => this._onClosed(s, code, reason.toString()));
  }

  _onMessage(s, data) {
    s.lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case 'Begin': this._onBegin(s, m); break;
      case 'SpeechStarted': s.speechMode = this.mode; break;
      case 'Turn': this._onTurn(s, m); break;
      case 'Error':
        s.errorText = `${m.error_code ?? ''} ${m.error ?? ''}`.trim();
        // Riprovare subito è inutile con errori di chiave o saldo; è utile con il limite di sessioni.
        if (m.error_code === 1008 && !/too many/i.test(m.error || '')) s.fatal = true;
        // Se AssemblyAI rifiuta il recupero a 2x, scarta il buffer e prosegue in tempo reale.
        if (m.error_code === 3007 && /rate/i.test(m.error || '')) {
          this.catchUp = false;
          this._clearBacklog();
        }
        warn(`AssemblyAI: ${s.errorText}`);
        break;
      default: break; // Heartbeat, Termination, SpeakerRevision
    }
  }

  _onBegin(s, m) {
    s.id = m.id || '';
    s.ready = true;
    this.attempts = 0;
    this.retryAt = 0;
    this.fatal = false;
    this.lastError = '';
    const expiresAt = m.expires_at ? m.expires_at * 1000 : Date.now() + DEFAULT_SESSION_MS;
    s.rolloverAt = expiresAt - this.cfg.rolloverBeforeMs;
    if (this.cfg.sessionMaxMs) s.rolloverAt = Math.min(s.rolloverAt, Date.now() + this.cfg.sessionMaxMs);
    // I parametri errati vengono ignorati senza errore: va controllato il modello effettivo.
    const model = m.configuration?.model;
    if (model && model !== this.cfg.model) {
      this.lastError = `Modello richiesto ${this.cfg.model}, attivo ${model}`;
      warn(this.lastError);
    }
    if (s.deferredKeyterms) this._send(s, { type: 'UpdateConfiguration', keyterms_prompt: this.keyterms });
    // La modalità può essere cambiata mentre la sessione si stava aprendo.
    this._send(s, { type: 'UpdateConfiguration', language_codes: LANGUAGE_CODES[this.mode] });
    log(`AssemblyAI: sessione ${s.role === 'primary' ? 'attiva' : 'pronta per il cambio'} ${s.id}`);
  }

  _onTurn(s, m) {
    if (!s.emit) return;
    if (m.turn_order <= s.lastFinalOrder) return;
    let text = m.transcript || '';
    let words = m.words || [];

    // Dopo un cambio di sessione, le parole già trascritte dalla sessione precedente si scartano.
    if (s.cutMs > 0 && words.length) {
      const kept = words.filter((w) => w.end > s.cutMs);
      if (!kept.length) return;
      if (kept.length < words.length) {
        text = kept.map((w) => w.text).join(' ');
        words = kept;
      }
    }

    if (!s.turn || s.turn.order !== m.turn_order) {
      // La frase in corso si completa con la modalità attiva quando è iniziata. Conta l'arrivo di
      // SpeechStarted, 200-500 ms dopo l'inizio reale: i timestamp della prima parola non servono,
      // perché possono anticipare il parlato di circa 1 s.
      s.turn = {
        order: m.turn_order, mode: s.speechMode || this.mode, text: '', lastEnd: 0,
        segmenter: new TurnSegmenter(), emitted: 0,
      };
      s.speechMode = null;
    }
    const turn = s.turn;
    if (words.length) turn.lastEnd = words[words.length - 1].end;

    // U3 Pro: il turno è completo con end_of_turn e turn_is_formatted entrambi veri.
    const isPro = this.cfg.model.includes('pro');
    const isFinal = m.end_of_turn && (m.turn_is_formatted !== false || !isPro);

    if (!isFinal) {
      const { blocks, partial } = words.length ? turn.segmenter.update(words) : { blocks: [], partial: text };
      for (const block of blocks) this._emitBlock(turn, block, '');
      turn.text = partial;
      this.emit('partial', partial, turn.emitted > 0);
      return;
    }

    s.lastFinalOrder = m.turn_order;
    if (turn.lastEnd) s.lastFinalEnd = turn.lastEnd;
    s.turn = null;
    const rest = turn.segmenter.finish(words, text);
    // La lingua di AssemblyAI vale per tutto il turno: è affidabile solo se il turno è un blocco unico.
    if (rest?.text) this._emitBlock(turn, rest, turn.emitted ? '' : (m.language_code || ''));
    else this.emit('partial', '', false);
    this._tryHandoff();
  }

  _emitBlock(turn, block, detected) {
    this.emit('final', {
      text: block.text, detected, mode: turn.mode, durationMs: block.durationMs, continuation: turn.emitted > 0,
    });
    turn.emitted += 1;
    turn.mode = this.mode; // un cambio di modalità vale dal blocco successivo, anche a turno aperto
  }

  // Un turno rimasto aperto a sessione chiusa diventa finale, per non perdere il testo.
  _flushPartial(s) {
    const turn = s.turn;
    s.turn = null;
    if (!turn?.text || !s.emit) return;
    if (turn.lastEnd) s.lastFinalEnd = turn.lastEnd;
    this._emitBlock(turn, { text: turn.text, durationMs: 0 }, '');
  }

  _onClosed(s, code, reason) {
    if (s.closed) return;
    s.closed = true;
    this.sessions.delete(s);
    if (s.openedAt) this.closedBilledMs += Date.now() - s.openedAt;
    s.openedAt = 0;
    clearTimeout(s.drainTimer);

    // Il codice 1000 è una chiusura normale: il suo motivo ("Session Ended") non è un errore.
    const errorText = s.errorText || (code !== 1000 && reason && !/see error/i.test(reason) ? reason : '');
    if (errorText) this.lastError = errorText;
    else if (code !== 1000 && this.active) this.lastError = `Connessione chiusa (codice ${code})`;
    if (code === 1008 && !/too many/i.test(errorText)) s.fatal = true;

    if (s === this.next) {
      this.next = null;
      if (s.fatal) this.fatal = true;
      if (this.primary) this.primary.rolloverAt = Date.now() + 15000; // ritenta tra poco
      return;
    }
    if (s !== this.primary) { this._flushPartial(s); return; } // sessione in chiusura

    const staleMs = Date.now() - s.lastMsgAt;
    log(`AssemblyAI: connessione chiusa (codice ${code})${errorText ? `: ${errorText}` : ''}`);
    if (this.next?.ready) {
      this._promote();
      return;
    }
    this._flushPartial(s);
    this.primary = null;
    if (!this.active) return;
    if (s.fatal) this.fatal = true;
    // Connessione morta da secondi: quell'audio non è stato elaborato e si può recuperare.
    // Dopo una chiusura immediata, invece, si ripartirebbe da parlato già trascritto.
    if (staleMs >= STALE_REPLAY_MS && s.ready) {
      this.backlog = [...this.recent];
      this.backlogBytes = this.recentBytes;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    const delay = this.fatal ? 60000 : Math.min(1000 * 2 ** this.attempts, 15000);
    this.attempts += 1;
    this.retryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active && !this.primary) this._open('primary');
    }, delay);
    log(`AssemblyAI: nuovo tentativo tra ${delay / 1000} s`);
  }

  // --- Cambio di sessione senza perdita ---

  _tryHandoff() {
    const b = this.next;
    if (!b?.feeding || !this.primary) return;
    const elapsed = Date.now() - b.feedStart;
    if (elapsed < HANDOFF_MIN_MS) return;
    if (!this.primary.turn || elapsed >= HANDOFF_MAX_MS) { this._promote(); return; }
    if (elapsed >= HANDOFF_FORCE_MS && !this.primary.forced) {
      this.primary.forced = true;
      this._send(this.primary, { type: 'ForceEndpoint' });
    }
  }

  _promote() {
    const a = this.primary;
    const b = this.next;
    if (a) {
      this._flushPartial(a);
      // Il punto di taglio sono le ultime parole già trascritte, nell'orologio della nuova sessione.
      if (b.feeding) {
        b.cutMs = Math.max(0, a.lastFinalEnd - b.offsetMs);
        this._clearBacklog(); // la nuova sessione ha già ricevuto questo audio
      }
      if (!a.closed) this._drain(a, false);
    }
    b.emit = true;
    b.role = 'primary';
    this.primary = b;
    this.next = null;
    log(`AssemblyAI: passaggio alla sessione ${b.id}`);
  }

  _drain(s, keepEmitting) {
    s.emit = keepEmitting;
    s.role = 'draining';
    if (s.ws?.readyState === WebSocket.OPEN) {
      this._send(s, { type: 'Terminate' });
      // Attende Termination, altrimenti si perde l'ultimo testo finale.
      s.drainTimer = setTimeout(() => s.ws?.terminate(), 3000);
    } else {
      s.ws?.terminate();
    }
  }

  _tick() {
    const now = Date.now();
    for (const s of this.sessions) {
      if (s.ws?.readyState === WebSocket.OPEN) {
        try { s.ws.ping(); } catch { /* il controllo sotto chiude la connessione */ }
      }
      if (now - s.lastMsgAt > DEAD_AFTER_MS || (s.ws?.bufferedAmount ?? 0) > MAX_SOCKET_BACKLOG) {
        warn('AssemblyAI: connessione senza risposta, la chiudo');
        s.ws?.terminate();
      }
    }
    if (!this.active) return;
    if (now - this.lastAudioAt > AUDIO_IDLE_MS) {
      log('Nessun audio da 15 s: chiudo la sessione per non consumare crediti');
      this.stop();
      return;
    }
    const p = this.primary;
    if (p?.ready && !this.next && p.rolloverAt && now >= p.rolloverAt) {
      log('AssemblyAI: apertura della nuova sessione prima del limite di durata');
      p.rolloverAt = now + 15000; // ritenta se questa non si apre
      this._open('next');
    }
    this._tryHandoff();
  }

  // --- Invio ---

  _sendAudio(s, frame) {
    if (s.ws?.readyState !== WebSocket.OPEN) return;
    s.audioMs += frame.length / BYTES_PER_MS;
    s.ws.send(frame, { binary: true }, () => {});
  }

  _send(s, message) {
    if (s?.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(message), () => {});
  }

  _updateConfig(fields) {
    const message = { type: 'UpdateConfiguration', ...fields };
    if (this.primary?.ready) this._send(this.primary, message);
    if (this.next?.ready) this._send(this.next, message);
  }

  _clearBacklog() {
    this.backlog = [];
    this.backlogBytes = 0;
  }
}
