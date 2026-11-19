// Pagina di controllo: cattura l'audio, invia i comandi al server e mostra lo stato.
const $ = (id) => document.getElementById(id);
const { t } = I18N;
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
let catalog = []; // lingue disponibili: { code, name, spoken, latin }
let limits = { spoken: 6, targets: 8 };
const langName = (code) => catalog.find((l) => l.code === code)?.name || code?.toUpperCase() || '—';

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
      catalog = m.languages || [];
      limits = m.limits || limits;
      buildStylePanel();
      if (appState) renderState();
      renderLinks(m.links);
      $('openFolder').hidden = !m.desktopApp;
    }
    else if (m.t === 'state') { appState = m; renderState(); }
    else if (m.t === 'status') { lastStatus = m; renderStatus(); }
    else if (m.t === 'notice') { $('notice').textContent = m.message; }
    // Lingua cambiata nelle Impostazioni: si ricarica subito, ma mai mentre l'audio è in invio.
    else if (m.t === 'language' && m.lang !== I18N.lang) {
      if (!sending) location.reload();
      else $('notice').textContent = t('La nuova lingua si applica dopo la pausa: ricarica la pagina quando vuoi.');
    }
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
    select.replaceChildren(...devices.map((d, i) => new Option(d.label || t('Ingresso {n}', { n: i + 1 }), d.deviceId)));
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
    if (wantCapture) scheduleReopen(t('Ingresso audio perso: nuovo tentativo…'));
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
      scheduleReopen(t('Ingresso non disponibile ({error}): nuovo tentativo…', { error: err.name }));
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
  const hints = { NotAllowedError: t('consenti il microfono nel browser'), OverconstrainedError: t('ingresso non trovato, scegline un altro') };
  setAudioNote(t('Audio non disponibile: {error}', { error: hints[err.name] || err.message }), 'bad');
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
  $('level').style.transform = `translateX(${pct - 100}%)`;
  $('level').classList.toggle('hot', peakHold >= 0.98);
  if (!wantCapture) return;
  const now = Date.now();
  if (audioContext?.state === 'suspended') setAudioNote(t('Audio sospeso dal browser: clicca sulla pagina'), 'bad');
  else if (now - lastFrameAt > 2000) setAudioNote(t('Nessun dato dall\'ingresso audio'), 'bad');
  else if (now - lastClipAt < 2000) setAudioNote(t('Segnale in saturazione: abbassa il livello dal mixer'), 'bad');
  else if (now - lastSignalAt > 5000) setAudioNote(t('Segnale assente da oltre 5 secondi'), 'warn');
  else if (sending) setAudioNote(t('In invio, picco {db} dB', { db: db.toFixed(0) }));
  else if (started) setAudioNote(t('In pausa, nessun credito consumato. Picco {db} dB', { db: db.toFixed(0) }));
  else setAudioNote(t('Pronto, nessun audio inviato. Picco {db} dB', { db: db.toFixed(0) }));
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
    try { await openInput(); } catch (err) { scheduleReopen(t('Ingresso non disponibile ({error})', { error: err.name })); }
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
  const select = card.querySelector('[data-target]');
  select.addEventListener('change', () => { send({ cmd: 'target', out, lang: select.value }); select.blur(); });
});

$('captionsTarget').addEventListener('change', () => {
  send({ cmd: 'captionsTarget', lang: $('captionsTarget').value });
  $('captionsTarget').blur();
});

// Lingue dell'evento: un clic aggiunge in fondo o toglie. Ne resta sempre almeno una.
function toggleLanguage(kind, code) {
  const list = [...appState.languages[kind]];
  const at = list.indexOf(code);
  if (at >= 0) { if (list.length > 1) list.splice(at, 1); } else if (list.length < limits[kind]) list.push(code);
  send({ cmd: 'languages', [kind]: list });
}
$('spokenChips').addEventListener('click', (e) => { const code = e.target.closest('button')?.dataset.code; if (code) toggleLanguage('spoken', code); });
$('targetChips').addEventListener('click', (e) => { const code = e.target.closest('button')?.dataset.code; if (code) toggleLanguage('targets', code); });

// Lingua successiva tra quelle dell'evento, dopo AUTO.
function nextMode() {
  const modes = ['AUTO', ...appState.languages.spoken];
  return modes[(modes.indexOf(appState.languageMode) + 1) % modes.length];
}

// I pulsanti non restano a fuoco: Spazio non deve ripetere l'ultimo clic.
document.addEventListener('click', (e) => { if (e.target.closest('button')) e.target.closest('button').blur(); });

// --- Scorciatoie ---

const isTyping = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
  (el.tagName === 'INPUT' && el.type !== 'color' && el.type !== 'file'));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
  const key = e.key.toLowerCase();
  const map = { a: 'AUTO', i: 'it', e: 'en' };
  if (key === 'a' || ((key === 'i' || key === 'e') && appState?.languages.spoken.includes(map[key]))) send({ cmd: 'language', mode: map[key] });
  else if (key === 'l' && appState) send({ cmd: 'language', mode: nextMode() });
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

// Riempie un menu solo se le voci sono cambiate: non chiude un menu aperto a ogni aggiornamento.
function fillSelect(select, options, value) {
  const key = JSON.stringify(options);
  if (select.dataset.options !== key) {
    select.replaceChildren(...options.map(([v, text]) => new Option(text, v)));
    select.dataset.options = key;
  }
  if (document.activeElement !== select) select.value = value;
}

function renderLanguages() {
  const { spoken, targets } = appState.languages;
  // Pulsanti della lingua parlata: AUTO e una per ogni lingua dell'evento.
  const modes = $('modes');
  const wanted = ['AUTO', ...spoken].join();
  if (modes.dataset.modes !== wanted) {
    modes.querySelectorAll('button').forEach((b) => b.remove());
    for (const mode of ['AUTO', ...spoken]) {
      const b = document.createElement('button');
      b.dataset.mode = mode;
      b.textContent = mode === 'AUTO' ? 'AUTO' : mode.toUpperCase();
      if (mode !== 'AUTO') b.title = langName(mode);
      modes.appendChild(b);
    }
    modes.dataset.modes = wanted;
  }
  modes.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === appState.languageMode));

  const chips = (root, kind, list) => {
    const available = catalog.filter((l) => kind === 'targets' || l.spoken);
    root.replaceChildren(...available.map((l) => {
      const b = document.createElement('button');
      b.dataset.code = l.code;
      b.setAttribute('aria-pressed', String(list.includes(l.code)));
      b.textContent = l.name;
      // Per le destinazioni conta l'ordine: la prima fa da riserva.
      if (kind === 'targets' && list.length > 1 && list.includes(l.code)) {
        const order = document.createElement('span');
        order.className = 'order';
        order.textContent = list.indexOf(l.code) + 1;
        b.appendChild(order);
      }
      return b;
    }));
  };
  chips($('spokenChips'), 'spoken', spoken);
  chips($('targetChips'), 'targets', targets);

  const targetOptions = targets.map((code) => [code, langName(code)]);
  for (const out of OUTPUTS) {
    fillSelect(document.querySelector(`.output[data-out="${out}"] [data-target]`), targetOptions, appState.outputs[out].target);
  }
  // I sottotitoli CEA-608 mostrano solo l'alfabeto latino.
  const captionOptions = [['original', t('Originale (lingua di chi parla)')],
    ...targets.filter((code) => catalog.find((l) => l.code === code)?.latin !== false).map((code) => [code, langName(code)])];
  fillSelect($('captionsTarget'), captionOptions, appState.captionsTarget);
}

function renderState() {
  renderLanguages();
  for (const out of OUTPUTS) {
    const profile = appState.outputs[out];
    const card = document.querySelector(`.output[data-out="${out}"]`);
    card.classList.toggle('is-hidden', profile.hidden);
    card.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === profile.view));
    const hide = card.querySelector('[data-act="hidden"]');
    hide.textContent = profile.hidden ? t('Mostra') : t('Nascondi');
    hide.classList.toggle('hidden-on', profile.hidden);
  }
  syncStyleInputs();
  updateSegments();
  renderPresets();
}

const AAI_LABELS = {
  idle: [t('Ferma'), ''], connecting: [t('Connessione…'), 'st-warn'],
  reconnecting: [t('Riconnessione…'), 'st-bad'], connected: [t('Connessa'), 'st-ok'],
};
const VIEW_LABELS = { both: t('Orig. + trad.'), translation: t('Solo trad.'), original: t('Solo orig.') };
const fmtHours = (sec) => `${Math.floor(sec / 3600)} h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')} min`;
const fmtNum = (n) => (n == null ? '—' : n.toLocaleString(I18N.locale));

function renderStatus() {
  const rows = [];
  const add = (label, value, cls = '') => rows.push([label, value, cls]);
  let banner = '';
  let bannerWarn = false;

  if (!isOpen()) {
    add(t('Server'), t('Non raggiungibile, riconnessione…'), 'st-bad');
    banner = t('Connessione col server persa');
  } else if (lastStatus) {
    const { aai, deepl } = lastStatus;
    const [label, cls] = AAI_LABELS[aai.state];
    let aaiText = label;
    if (aai.state === 'reconnecting' && aai.retryInSeconds) aaiText += t(' tra {s} s', { s: aai.retryInSeconds });
    if (aai.handoff) aaiText += t(' (cambio sessione)');
    add('AssemblyAI', aaiText, cls);
    add(t('Regione'), aai.euOnly ? t('Solo Unione Europea') : t('Il più vicino (UE o USA)'));
    if (aai.bufferedMs > 300) add(t('Buffer audio'), `${(aai.bufferedMs / 1000).toFixed(1)} s`, 'st-warn');
    if (!aai.configured) add(t('Chiave'), t('AssemblyAI mancante: apri Impostazioni'), 'st-bad');
    if (aai.lastError) add(t('Ultimo errore'), aai.lastError, 'st-bad');
    add(t('Lingua rilevata'), lastStatus.lastLanguage ? langName(lastStatus.lastLanguage) : '—');
    if (appState) {
      add(t('Modalità'), appState.languageMode === 'AUTO' ? 'AUTO' : langName(appState.languageMode));
      add(t('Streaming'), t('{view} {lang} · finestre: {n}', { view: VIEW_LABELS[appState.outputs.stream.view], lang: appState.outputs.stream.target.toUpperCase(), n: lastStatus.overlays.stream }));
      add(t('Sala'), t('{view} {lang} · finestre: {n}', { view: VIEW_LABELS[appState.outputs.room.view], lang: appState.outputs.room.target.toUpperCase(), n: lastStatus.overlays.room }));
    }
    add(t('Latenza trad.'), deepl.avgMs ? `${deepl.avgMs} ms` : '—');
    add(t('DeepL usati'), fmtNum(deepl.used));
    add(t('DeepL rimasti'), fmtNum(deepl.remaining), deepl.low ? 'st-bad' : '');
    if (!deepl.configured) add(t('Chiave'), t('DeepL mancante: apri Impostazioni'), 'st-bad');
    if (deepl.lastError) add(t('Errore DeepL'), deepl.lastError, 'st-bad');
    add(t('Glossario'), deepl.glossary);
    const obs = lastStatus.obs;
    if (obs?.enabled) add(t('Sottotitoli OBS'), obsText(obs), obs.state === 'connected' && obs.streaming ? 'st-ok' : 'st-warn');
    renderCaptions(obs);
    add(t('Ore di sessione'), fmtHours(aai.billedSeconds));
    add(t('Crediti stimati'), `$${aai.estimatedCost.toFixed(2)}`);
    if (lastStatus.outputDir) add(t('File'), lastStatus.outputDir);
    $('demo').textContent = lastStatus.demo ? t('Ferma demo') : t('Avvia demo');
    $('demo').disabled = !lastStatus.demo && aai.state !== 'idle';

    if (aai.fatal) banner = t('AssemblyAI rifiuta la connessione: {error}', { error: aai.lastError });
    else if (aai.state === 'reconnecting') banner = t('AssemblyAI non raggiungibile: riconnessione in corso');
    else if (deepl.quotaExhausted) banner = t('Caratteri DeepL esauriti: si vede solo l\'originale');
    else if (deepl.low) { banner = t('Caratteri DeepL sotto il 10%: ne restano {n}', { n: fmtNum(deepl.remaining) }); bannerWarn = true; }
    if (lastStatus.demo) { banner = t('DEMO ATTIVA: gli overlay aperti mostrano testo finto'); bannerWarn = true; }
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
  renderSupport();
}

function obsText(obs) {
  if (obs.state === 'connected') return obs.streaming ? t('In diretta, {n} inviati', { n: obs.sent }) : t('Collegato, OBS non è in diretta');
  return obs.lastError || t('Collegamento…');
}

function renderCaptions(obs) {
  const note = $('captionsNote');
  if (!obs?.enabled) note.textContent = t('Disattivati: si attivano nelle Impostazioni.');
  else note.textContent = `OBS: ${obsText(obs)}`;
  note.className = `note ${obs?.enabled && !(obs.state === 'connected' && obs.streaming) ? 'warn' : ''}`;
}

// --- Invito a sostenere Duetto ---
// Compare all'apertura e sparisce per sempre, in questa sessione, appena i sottotitoli partono:
// durante un evento la regia deve mostrare solo ciò che serve.

const SUPPORT_KEY = 'duetto.supportHiddenUntil';
const SUPPORT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
let supportDismissed = Number(safeStore.get(SUPPORT_KEY)) > Date.now();

function renderSupport() {
  const busy = lastStatus && (lastStatus.aai.state !== 'idle' || lastStatus.demo);
  if (busy) supportDismissed = true;
  $('support').hidden = supportDismissed || !lastStatus;
  renderUpdate(busy);
}

// --- Nuova versione disponibile: stesso comportamento dell'invito, ma chiuso solo per quella versione ---

const UPDATE_KEY = 'duetto.updateDismissed';

function renderUpdate(busy) {
  const update = lastStatus?.update;
  const show = update && !busy && safeStore.get(UPDATE_KEY) !== update.version;
  $('update').hidden = !show;
  if (!show) return;
  $('updateTitle').textContent = t('È disponibile Duetto {version}', { version: update.version });
  $('updateLink').href = update.url;
}

$('updateClose').onclick = () => {
  if (lastStatus?.update) safeStore.set(UPDATE_KEY, lastStatus.update.version);
  renderUpdate(true);
};

$('supportClose').onclick = () => { supportDismissed = true; renderSupport(); };
$('supportSnooze').onclick = () => {
  safeStore.set(SUPPORT_KEY, String(Date.now() + SUPPORT_SNOOZE_MS));
  supportDismissed = true;
  renderSupport();
};

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
    title.textContent = t(group.group);
    const grid = document.createElement('div');
    grid.className = 'fields';
    for (const f of group.fields) {
      const label = document.createElement('label');
      label.textContent = t(f.label);
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach(([value, text]) => input.add(new Option(t(text), value)));
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
  updateSegments();
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
    $('notice').textContent = t('Preset importati da {file}', { file: file.name });
  } catch {
    $('notice').textContent = t('File JSON non valido');
  }
};

// --- Collegamenti e finestre ---

function renderLinks(links) {
  const rows = [['OBS', links.stream], [t('Sala'), links.room], ...links.network.map((url) => [t('Altro computer'), url])];
  $('links').replaceChildren(...rows.map(([label, url]) => {
    const row = document.createElement('div');
    row.className = 'link-row';
    const name = document.createElement('span');
    name.textContent = label;
    const code = document.createElement('code');
    code.textContent = url;
    const copy = document.createElement('button');
    copy.textContent = t('Copia');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = t('Copiato');
        setTimeout(() => { copy.textContent = t('Copia'); }, 1500);
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

// --- Movimento ---

// Gli indicatori dei controlli segmentati seguono lo stato confermato dal server.
function updateSegments() {
  document.querySelectorAll('.segmented').forEach((el) => el.updateThumb?.());
}
document.querySelectorAll('.segmented').forEach(Motion.segmentedControl);
document.querySelectorAll('details').forEach(Motion.disclosure);
// La linea sotto la barra compare solo quando qualcosa le scorre sotto.
addEventListener('scroll', () => document.body.classList.toggle('scrolled', scrollY > 0), { passive: true });

// --- Avvio ---

connect();
listDevices();
renderAudioButtons();
// Dopo un ricaricamento durante l'evento la cattura riparte da sola.
if (safeStore.get('capturing')) startCapture();
else openMonitor();
