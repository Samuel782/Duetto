// Pagina di controllo: cattura l'audio, invia i comandi al server e mostra lo stato.
const $ = (id) => document.getElementById(id);
const OUTPUTS = ['stream', 'room'];
const VIEW_KEYS = {
  1: ['stream', 'both'], 2: ['stream', 'translation'], 3: ['stream', 'original'],
  7: ['room', 'both'], 8: ['room', 'translation'], 9: ['room', 'original'],
};
const ALL_VIEW_KEYS = { 4: 'both', 5: 'translation', 6: 'original' };

let appState = null;
let schema = null;
let lastStatus = null;
let activeTab = 'stream';

const safeStore = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* facoltativo */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* facoltativo */ } },
};

// --- Connessione al server ---

let ws = null;
let wsRetryAt = 0;

function connect() {
  wsRetryAt = Date.now() + 1000;
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'schema') {
      schema = m.styleSchema;
      buildStylePanel();
      renderLinks(m.links);
      $('openFolder').hidden = !m.desktopApp;
    }
    else if (m.t === 'state') { appState = m; renderState(); }
    else if (m.t === 'status') { lastStatus = m; renderStatus(); }
    else if (m.t === 'notice') { $('notice').textContent = m.message; }
  };
  ws.onclose = () => renderStatus();
  ws.onerror = () => {};
}

// Si controlla anche a ogni blocco audio: quei messaggi non sono rallentati nelle schede in secondo piano.
function ensureConnected() {
  if ((!ws || ws.readyState === WebSocket.CLOSED) && Date.now() >= wsRetryAt) connect();
}
setInterval(ensureConnected, 1000);

const isOpen = () => ws && ws.readyState === WebSocket.OPEN;
const send = (m) => { if (isOpen()) ws.send(JSON.stringify(m)); };

// --- Cattura audio ---

let audioContext = null;
let stream = null;
let captureNode = null;
let sourceNode = null;
let wantCapture = false; // la pagina vuole l'ingresso aperto
let started = false; // Avvia è stato premuto
let sending = false; // l'audio viene inviato
let captureRetry = null;
let peakHold = 0;
let lastSignalAt = 0;
let lastClipAt = 0;
let lastFrameAt = 0;
let wakeLock = null;

async function listDevices() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const select = $('device');
    const wanted = select.value || safeStore.get('audioDevice');
    select.replaceChildren(...devices.map((d, i) => new Option(d.label || `Ingresso ${i + 1}`, d.deviceId)));
    if (devices.some((d) => d.deviceId === wanted)) select.value = wanted;
  } catch { /* gestito all'avvio della cattura */ }
}
navigator.mediaDevices?.addEventListener('devicechange', listDevices);

async function openInput() {
  closeInput();
  const deviceId = $('device').value;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    },
  });
  await listDevices(); // dopo il permesso i nomi degli ingressi sono disponibili
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('/audio-worklet.js');
  }
  await audioContext.resume();
  sourceNode = audioContext.createMediaStreamSource(stream);
  captureNode = new AudioWorkletNode(audioContext, 'capture', { numberOfOutputs: 1, channelCountMode: 'max' });
  captureNode.port.onmessage = onFrame;
  const mute = audioContext.createGain(); // tiene attivo il nodo senza far uscire suono
  mute.gain.value = 0;
  sourceNode.connect(captureNode).connect(mute).connect(audioContext.destination);
  const track = stream.getAudioTracks()[0];
  track.onended = () => {
    if (wantCapture) scheduleReopen('Ingresso audio perso: nuovo tentativo…');
  };
  lastSignalAt = lastFrameAt = Date.now();
}

function closeInput() {
  captureNode?.disconnect();
  sourceNode?.disconnect();
  stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  captureNode = sourceNode = stream = null;
}

function scheduleReopen(message) {
  setAudioNote(message, 'bad');
  clearTimeout(captureRetry);
  captureRetry = setTimeout(async () => {
    try {
      await openInput();
      renderAudioButtons();
    } catch (err) {
      scheduleReopen(`Ingresso non disponibile (${err.name}): nuovo tentativo…`);
    }
  }, 2000);
}

function onFrame({ data }) {
  ensureConnected();
  const now = Date.now();
  lastFrameAt = now;
  if (data.peak > 0.003) lastSignalAt = now;
  if (data.peak >= 0.98) lastClipAt = now;
  peakHold = Math.max(data.peak, peakHold * 0.8);
  // Durante la riconnessione col server l'audio si scarta: non si accumula ritardo.
  if (sending && isOpen() && ws.bufferedAmount < 64000) ws.send(data.pcm);
}

function setAudioNote(text, level = '') {
  const el = $('audioNote');
  el.textContent = text;
  el.className = `note ${level}`;
}

function showAudioError(err) {
  const hints = { NotAllowedError: 'consenti il microfono nel browser', OverconstrainedError: 'ingresso non trovato, scegline un altro' };
  setAudioNote(`Audio non disponibile: ${hints[err.name] || err.message}`, 'bad');
}

// L'ingresso resta aperto anche prima di Avvia: mostra il livello e i nomi, senza inviare nulla.
async function openMonitor() {
  try {
    wantCapture = true;
    await openInput();
  } catch (err) {
    wantCapture = false;
    showAudioError(err);
  }
}

async function startCapture() {
  try {
    if (!stream) {
      wantCapture = true;
      await openInput();
    }
    started = true;
    sending = true;
    safeStore.set('capturing', '1');
    audioContext?.resume();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* facoltativo */ }
  } catch (err) {
    wantCapture = false;
    showAudioError(err);
  }
  renderAudioButtons();
}

function pause() {
  if (!sending) return;
  sending = false;
  safeStore.remove('capturing');
  send({ cmd: 'pause' }); // chiude la sessione: la fatturazione è sulla connessione aperta
  renderAudioButtons();
}

function resume() {
  startCapture();
}

function renderAudioButtons() {
  $('start').disabled = started;
  $('pause').disabled = !sending;
  $('resume').disabled = !started || sending;
}

function toggleCapture() {
  if (sending) pause();
  else startCapture();
}

// Misuratore e avvisi: aggiornati 5 volte al secondo, senza animazioni continue.
setInterval(() => {
  const db = peakHold > 0 ? 20 * Math.log10(peakHold) : -90;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('level').style.width = `${pct}%`;
  $('level').classList.toggle('hot', peakHold >= 0.98);
  if (!wantCapture) return;
  const now = Date.now();
  if (audioContext?.state === 'suspended') setAudioNote('Audio sospeso dal browser: clicca sulla pagina', 'bad');
  else if (now - lastFrameAt > 2000) setAudioNote('Nessun dato dall\'ingresso audio', 'bad');
  else if (now - lastClipAt < 2000) setAudioNote('Segnale in saturazione: abbassa il livello dal mixer', 'bad');
  else if (now - lastSignalAt > 5000) setAudioNote('Segnale assente da oltre 5 secondi', 'warn');
  else if (sending) setAudioNote(`In invio, picco ${db.toFixed(0)} dB`);
  else if (started) setAudioNote(`In pausa, nessun credito consumato. Picco ${db.toFixed(0)} dB`);
  else setAudioNote(`Pronto, nessun audio inviato. Picco ${db.toFixed(0)} dB`);
}, 200);

document.addEventListener('pointerdown', () => audioContext?.state === 'suspended' && audioContext.resume());

// --- Pulsanti ---

$('start').onclick = startCapture;
$('pause').onclick = pause;
$('resume').onclick = resume;
$('device').onchange = async () => {
  safeStore.set('audioDevice', $('device').value);
  $('device').blur();
  if (wantCapture) {
    try { await openInput(); } catch (err) { scheduleReopen(`Ingresso non disponibile (${err.name})`); }
  }
};

$('modes').addEventListener('click', (e) => {
  const mode = e.target.dataset?.mode;
  if (mode) send({ cmd: 'language', mode });
});

document.querySelectorAll('.output').forEach((card) => {
  const out = card.dataset.out;
  card.addEventListener('click', (e) => {
    const { view, act } = e.target.dataset ?? {};
    if (view) send({ cmd: 'view', out, view });
    if (act) send({ cmd: act, out });
  });
});

// I pulsanti non restano a fuoco: Spazio non deve ripetere l'ultimo clic.
document.addEventListener('click', (e) => { if (e.target.closest('button')) e.target.closest('button').blur(); });

// --- Scorciatoie ---

const isTyping = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
  (el.tagName === 'INPUT' && el.type !== 'color' && el.type !== 'file'));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
  const key = e.key.toLowerCase();
  const map = { a: 'AUTO', i: 'IT', e: 'EN' };
  if (map[key]) send({ cmd: 'language', mode: map[key] });
  else if (VIEW_KEYS[key]) send({ cmd: 'view', out: VIEW_KEYS[key][0], view: VIEW_KEYS[key][1] });
  else if (ALL_VIEW_KEYS[key]) send({ cmd: 'viewAll', view: ALL_VIEW_KEYS[key] });
  else if (key === 'q') send({ cmd: 'clear', out: 'stream' });
  else if (key === 'w') send({ cmd: 'hidden', out: 'stream' });
  else if (key === 'o') send({ cmd: 'clear', out: 'room' });
  else if (key === 'p') send({ cmd: 'hidden', out: 'room' });
  else if (key === ' ') toggleCapture();
  else return;
  e.preventDefault();
});

// --- Stato ---

function renderState() {
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === appState.languageMode));
  for (const out of OUTPUTS) {
    const profile = appState.outputs[out];
    const card = document.querySelector(`.output[data-out="${out}"]`);
    card.classList.toggle('is-hidden', profile.hidden);
    card.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === profile.view));
    const hide = card.querySelector('[data-act="hidden"]');
    hide.textContent = profile.hidden ? 'Mostra' : 'Nascondi';
    hide.classList.toggle('hidden-on', profile.hidden);
  }
  syncStyleInputs();
  renderPresets();
}

const AAI_LABELS = {
  idle: ['Ferma', ''], connecting: ['Connessione…', 'st-warn'],
  reconnecting: ['Riconnessione…', 'st-bad'], connected: ['Connessa', 'st-ok'],
};
const LANG_LABELS = { it: 'Italiano', en: 'Inglese' };
const VIEW_LABELS = { both: 'Orig. + trad.', translation: 'Solo trad.', original: 'Solo orig.' };
const fmtHours = (sec) => `${Math.floor(sec / 3600)} h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')} min`;
const fmtNum = (n) => (n == null ? '—' : n.toLocaleString('it-IT'));

function renderStatus() {
  const rows = [];
  const add = (label, value, cls = '') => rows.push([label, value, cls]);
  let banner = '';
  let bannerWarn = false;

  if (!isOpen()) {
    add('Server', 'Non raggiungibile, riconnessione…', 'st-bad');
    banner = 'Connessione col server persa';
  } else if (lastStatus) {
    const { aai, deepl } = lastStatus;
    const [label, cls] = AAI_LABELS[aai.state];
    let aaiText = label;
    if (aai.state === 'reconnecting' && aai.retryInSeconds) aaiText += ` tra ${aai.retryInSeconds} s`;
    if (aai.handoff) aaiText += ' (cambio sessione)';
    add('AssemblyAI', aaiText, cls);
    if (aai.bufferedMs > 300) add('Buffer audio', `${(aai.bufferedMs / 1000).toFixed(1)} s`, 'st-warn');
    if (!aai.configured) add('Chiave', 'AssemblyAI mancante: apri Impostazioni', 'st-bad');
    if (aai.lastError) add('Ultimo errore', aai.lastError, 'st-bad');
    add('Lingua rilevata', LANG_LABELS[aai.lastDetected.slice(0, 2)] || aai.lastDetected || '—');
    if (appState) {
      add('Modalità', appState.languageMode);
      add('Streaming', `${VIEW_LABELS[appState.outputs.stream.view]} · finestre: ${lastStatus.overlays.stream}`);
      add('Sala', `${VIEW_LABELS[appState.outputs.room.view]} · finestre: ${lastStatus.overlays.room}`);
    }
    add('Latenza trad.', deepl.avgMs ? `${deepl.avgMs} ms` : '—');
    add('DeepL usati', fmtNum(deepl.used));
    add('DeepL rimasti', fmtNum(deepl.remaining), deepl.low ? 'st-bad' : '');
    if (!deepl.configured) add('Chiave', 'DeepL mancante: apri Impostazioni', 'st-bad');
    if (deepl.lastError) add('Errore DeepL', deepl.lastError, 'st-bad');
    add('Glossario', deepl.glossary);
    add('Ore di sessione', fmtHours(aai.billedSeconds));
    add('Crediti stimati', `$${aai.estimatedCost.toFixed(2)}`);
    if (lastStatus.outputDir) add('File', lastStatus.outputDir);
    $('demo').textContent = lastStatus.demo ? 'Ferma demo' : 'Avvia demo';
    $('demo').disabled = !lastStatus.demo && aai.state !== 'idle';

    if (aai.fatal) banner = `AssemblyAI rifiuta la connessione: ${aai.lastError}`;
    else if (aai.state === 'reconnecting') banner = 'AssemblyAI non raggiungibile: riconnessione in corso';
    else if (deepl.quotaExhausted) banner = 'Caratteri DeepL esauriti: si vede solo l\'originale';
    else if (deepl.low) { banner = `Caratteri DeepL sotto il 10%: ne restano ${fmtNum(deepl.remaining)}`; bannerWarn = true; }
    if (lastStatus.demo) { banner = 'DEMO ATTIVA: gli overlay aperti mostrano testo finto'; bannerWarn = true; }
  }

  $('status').replaceChildren(...rows.flatMap(([label, value, cls]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.className = cls;
    return [dt, dd];
  }));
  $('banner').hidden = !banner;
  $('banner').textContent = banner;
  $('banner').className = bannerWarn ? 'warn' : '';
}

// --- Pannello di stile, generato dallo schema del server ---

let pendingPatch = null;
let patchOut = null;

function flushPatch() {
  if (pendingPatch) send({ cmd: 'style', out: patchOut, patch: pendingPatch });
  pendingPatch = null;
}

function queuePatch(key, value) {
  if (patchOut !== activeTab) flushPatch();
  patchOut = activeTab;
  if (!pendingPatch) {
    pendingPatch = {};
    setTimeout(flushPatch, 60); // abbastanza fluido da seguire un cursore
  }
  pendingPatch[key] = value;
}

function buildStylePanel() {
  const root = $('styleFields');
  root.replaceChildren();
  for (const group of schema) {
    const box = document.createElement('div');
    box.className = 'group';
    const title = document.createElement('h3');
    title.textContent = group.group;
    const grid = document.createElement('div');
    grid.className = 'fields';
    for (const f of group.fields) {
      const label = document.createElement('label');
      label.textContent = f.label;
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach(([value, text]) => input.add(new Option(text, value)));
      } else {
        input = document.createElement('input');
        if (f.type === 'number') Object.assign(input, { type: 'number', min: f.min, max: f.max, step: f.step });
        else if (f.type === 'color') input.type = 'color';
        else { input.type = 'text'; input.setAttribute('list', 'fonts'); }
      }
      input.dataset.key = f.key;
      input.addEventListener('input', () => {
        const value = f.type === 'number' ? Number(input.value) : input.value;
        if (f.type === 'number' && (input.value === '' || !Number.isFinite(value))) return;
        queuePatch(f.key, value);
      });
      label.appendChild(input);
      grid.appendChild(label);
    }
    box.append(title, grid);
    root.appendChild(box);
  }
  syncStyleInputs();
}

function syncStyleInputs() {
  document.querySelectorAll('#styleTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === activeTab));
  if (!appState) return;
  const style = appState.outputs[activeTab].style;
  document.querySelectorAll('#styleFields [data-key]').forEach((input) => {
    if (document.activeElement !== input) input.value = style[input.dataset.key];
  });
}

$('styleTabs').addEventListener('click', (e) => {
  if (!e.target.dataset?.tab) return;
  flushPatch();
  activeTab = e.target.dataset.tab;
  syncStyleInputs();
});

$('styleReset').onclick = () => send({ cmd: 'styleReset', out: activeTab });

// --- Preset ---

function renderPresets() {
  const select = $('presetList');
  const current = select.value;
  select.replaceChildren(...Object.keys(appState.presets).sort().map((name) => new Option(name, name)));
  if (current && appState.presets[current]) select.value = current;
}

$('presetSave').onclick = () => {
  const name = $('presetName').value.trim();
  if (!name) return;
  flushPatch();
  send({ cmd: 'presetSave', name, out: activeTab });
  $('presetName').value = '';
};
$('presetLoad').onclick = () => { if ($('presetList').value) send({ cmd: 'presetLoad', name: $('presetList').value, out: activeTab }); };
$('presetDelete').onclick = () => { if ($('presetList').value) send({ cmd: 'presetDelete', name: $('presetList').value }); };
$('presetExport').onclick = () => {
  const blob = new Blob([JSON.stringify(appState.presets, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'duetto-preset.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('presetImport').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    send({ cmd: 'presetImport', presets: JSON.parse(await file.text()) });
    $('notice').textContent = `Preset importati da ${file.name}`;
  } catch {
    $('notice').textContent = 'File JSON non valido';
  }
};

// --- Collegamenti e finestre ---

function renderLinks(links) {
  const rows = [['OBS', links.stream], ['Sala', links.room], ...links.network.map((url) => ['Altro computer', url])];
  $('links').replaceChildren(...rows.map(([label, url]) => {
    const row = document.createElement('div');
    row.className = 'link-row';
    const name = document.createElement('span');
    name.textContent = label;
    const code = document.createElement('code');
    code.textContent = url;
    const copy = document.createElement('button');
    copy.textContent = 'Copia';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copiato';
        setTimeout(() => { copy.textContent = 'Copia'; }, 1500);
      } catch { /* resta visibile per la copia manuale */ }
    };
    row.append(name, code, copy);
    return row;
  }));
}

$('openSettings').onclick = () => window.open('/settings', 'settings');
$('openRoom').onclick = () => window.open('/overlay?out=room', 'room');
$('openFolder').onclick = () => send({ cmd: 'openOutputFolder' });

// --- Termini, demo e test ---

$('reloadTerms').onclick = () => send({ cmd: 'reloadTerms' });
$('demo').onclick = () => send({ cmd: 'demo', on: !lastStatus?.demo });
$('drop').onclick = () => send({ cmd: 'simulateDrop', seconds: Number($('dropSeconds').value) || 10 });

// --- Avvio ---

connect();
listDevices();
renderAudioButtons();
// Dopo un ricaricamento durante l'evento la cattura riparte da sola.
if (safeStore.get('capturing')) startCapture();
else openMonitor();
