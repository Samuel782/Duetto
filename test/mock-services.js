#!/usr/bin/env node
// Finti AssemblyAI e DeepL, per provare l'app senza rete e senza consumare crediti.
// Si comportano secondo la documentazione: formato dei messaggi, limiti dei blocchi audio, errori.
//
// Il "parlato" dipende dall'audio ricevuto. Se i primi 4 byte di un blocco contengono il tempo
// assoluto in ms preceduto da una firma, due sessioni parallele sentono le stesse parole: è ciò
// che serve per verificare che un cambio di sessione non perda e non duplichi nulla.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const FRAME_MAGIC = 0x5ab1;
const WORD_MS = 300;
const GAP_MS = 1200; // pausa tra le frasi, oltre il silenzio che chiude un turno

// Parole numerate, così un test può verificare che compaiano tutte e una sola volta.
export function wordAt(index) {
  return `w${index}`;
}

// Ogni frase ha 6 parole e le lingue si alternano.
function scheduleFor(globalMs) {
  const sentenceMs = 6 * WORD_MS + GAP_MS;
  const sentence = Math.floor(globalMs / sentenceMs);
  return { sentence, startMs: sentence * sentenceMs, words: 6, lang: sentence % 2 === 0 ? 'it' : 'en' };
}

export function startMock({ port = 0, expiresInSeconds = 10800, log = () => {} } = {}) {
  const stats = {
    sessions: 0, updates: [], connectUrls: [], translateBodies: [], glossaries: [], forceEndpoints: 0,
    audioErrors: 0, usage: { character_count: 1000, character_limit: 500000 },
    translateDelayMs: 0, translateStatus: 200, glossaryStatus: 201, stalled: false, closedSessions: [],
  };
  const glossaries = new Map();

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json ? JSON.stringify(json) : undefined);
      };
      if (!auth.startsWith('DeepL-Auth-Key ')) { send(403, { message: 'Authorization failed' }); return; }
      if (req.url === '/v2/usage') { send(200, stats.usage); return; }
      if (req.url === '/v2/translate' && req.method === 'POST') {
        const data = JSON.parse(body);
        stats.translateBodies.push(data);
        if (stats.translateDelayMs < 0) { res.destroy(); return; }
        setTimeout(() => {
          if (stats.translateStatus !== 200) { send(stats.translateStatus, { message: 'errore' }); return; }
          stats.usage.character_count += data.text[0].length;
          send(200, { translations: [{ detected_source_language: data.source_lang, text: `[${data.target_lang}] ${data.text[0]}` }] });
        }, stats.translateDelayMs);
        return;
      }
      if (req.url === '/v3/glossaries') {
        if (req.method === 'GET') { send(200, { glossaries: [...glossaries.values()] }); return; }
        if (stats.glossaryStatus !== 201) { send(stats.glossaryStatus, { message: 'non disponibile' }); return; }
        const data = JSON.parse(body);
        const id = `g${glossaries.size + 1}-${Date.now()}`;
        const entry = { glossary_id: id, name: data.name, dictionaries: data.dictionaries };
        glossaries.set(id, entry);
        stats.glossaries.push(entry);
        send(201, entry);
        return;
      }
      if (req.url.startsWith('/v3/glossaries/') && req.method === 'DELETE') {
        glossaries.delete(req.url.split('/').pop());
        send(204);
        return;
      }
      send(404, { message: 'non trovato' });
    });
  });

  // autoPong spento: i pong si possono sospendere per simulare una connessione morta.
  const wss = new WebSocketServer({ server, path: '/v3/ws', autoPong: false });

  wss.on('connection', (ws, req) => {
    if (req.headers.authorization !== 'mock-key') {
      ws.send(JSON.stringify({ type: 'Error', error_code: 1008, error: 'Invalid API key' }));
      ws.close(1008, 'See Error message for details');
      return;
    }
    const url = new URL(req.url, 'http://x');
    stats.sessions += 1;
    stats.connectUrls.push(req.url);
    const session = {
      id: `sess-${stats.sessions}`,
      localMs: 0,
      turnOrder: 0,
      words: new Map(), // indice parola -> {start,end} in ms locali
      current: null,
      languageCodes: JSON.parse(url.searchParams.get('language_codes') || '[]'),
      openedAt: Date.now(),
    };
    log(`mock: apertura ${session.id}`);
    ws.send(JSON.stringify({
      type: 'Begin',
      id: session.id,
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
      configuration: { model: url.searchParams.get('speech_model'), api_version: '2025-05-12' },
    }));

    ws.on('ping', (data) => { if (!stats.stalled) ws.pong(data); });

    const finishTurn = () => {
      const c = session.current;
      if (!c) return;
      const list = [...c.words.values()];
      const transcript = `${list.map((w) => w.text).join(' ')}.`;
      // language_codes vale dal turno successivo: conta il valore all'inizio di questo turno.
      const languageCode = c.languageCodes.length === 1 ? c.languageCodes[0] : c.lang;
      ws.send(JSON.stringify({
        type: 'Turn', turn_order: session.turnOrder, turn_is_formatted: true, end_of_turn: true,
        end_of_turn_confidence: 1, transcript, utterance: transcript,
        language_code: languageCode, language_confidence: 0.98,
        words: list.map((w, i) => ({ ...w, text: i === list.length - 1 ? `${w.text}.` : w.text, word_is_final: true, confidence: 0.99 })),
      }));
      session.turnOrder += 1;
      session.current = null;
    };

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString());
        if (m.type === 'UpdateConfiguration') {
          stats.updates.push({ session: session.id, ...m });
          if (m.language_codes) session.languageCodes = m.language_codes;
        } else if (m.type === 'ForceEndpoint') {
          stats.forceEndpoints += 1;
          finishTurn();
        } else if (m.type === 'Terminate') {
          finishTurn();
          const duration = (Date.now() - session.openedAt) / 1000;
          ws.send(JSON.stringify({ type: 'Termination', audio_duration_seconds: session.localMs / 1000, session_duration_seconds: duration }));
          stats.closedSessions.push(session.id);
          log(`mock: chiusura ${session.id}`);
          ws.close(1000, 'Session Ended');
        } else {
          ws.send(JSON.stringify({ type: 'Error', error_code: 3006, error: 'Invalid Message Type' }));
          ws.close(3006, 'See Error message for details');
        }
        return;
      }
      if (stats.stalled) return;
      const ms = data.length / 32;
      if (ms < 50 || ms > 1000) {
        stats.audioErrors += 1;
        ws.send(JSON.stringify({ type: 'Error', error_code: 3007, error: `Input duration violation: ${ms} ms. Expected between 50 and 1000 ms` }));
        ws.close(3007, 'See Error message for details');
        return;
      }
      const globalMs = data.readUInt16LE(0) === FRAME_MAGIC ? data.readUInt32LE(2) : session.localMs;
      const localStart = session.localMs;
      session.localMs += ms;

      const plan = scheduleFor(globalMs);
      const inSpeech = globalMs - plan.startMs < plan.words * WORD_MS;
      if (inSpeech) {
        const wordIndex = plan.sentence * plan.words + Math.floor((globalMs - plan.startMs) / WORD_MS);
        const c = session.current || (session.current = { words: new Map(), lang: plan.lang, sentence: plan.sentence, languageCodes: session.languageCodes });
        if (c.sentence !== plan.sentence) { finishTurn(); return; }
        if (!c.words.has(wordIndex)) {
          c.words.set(wordIndex, { text: wordAt(wordIndex), start: localStart, end: localStart + WORD_MS });
          if (c.words.size === 1) ws.send(JSON.stringify({ type: 'SpeechStarted', timestamp: localStart, confidence: 0.98 }));
          const list = [...c.words.values()];
          ws.send(JSON.stringify({
            type: 'Turn', turn_order: session.turnOrder, turn_is_formatted: false, end_of_turn: false,
            end_of_turn_confidence: 0, transcript: list.map((w) => w.text).join(' '), utterance: '',
            words: list.map((w) => ({ ...w, word_is_final: false, confidence: 0.9 })),
          }));
        }
      } else if (session.current) {
        finishTurn();
      }
    });
    ws.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        wss,
        close: () => new Promise((done) => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

// Avvio manuale: npm run mock
if (process.argv[1]?.endsWith('mock-services.js')) {
  const port = Number(process.env.MOCK_PORT) || 9099;
  const mock = await startMock({ port, log: console.log });
  console.log(`Finti servizi su porta ${mock.port}. Avvia l'app con:`);
  console.log(`ASSEMBLYAI_API_KEY=mock-key ASSEMBLYAI_WS_URL=ws://127.0.0.1:${mock.port}/v3/ws DEEPL_API_KEY=mock:fx DEEPL_ENDPOINT=http://127.0.0.1:${mock.port} node server/index.js`);
}
