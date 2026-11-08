// Overlay: riceve testo e impostazioni dal server e impagina secondo il profilo dell'uscita.
const params = new URLSearchParams(location.search);
const out = params.get('out') === 'room' ? 'room' : 'stream';
if (params.has('preview')) document.body.classList.add('preview');

const stage = document.getElementById('stage');
const box = document.getElementById('box');
const originalEl = document.getElementById('original');
const translationEl = document.getElementById('translation');

const MAX_KEPT_ORIGINALS = 20;
const READING_CHARS_PER_SECOND = 22;
const MIN_PAGE_READ_MS = 700;

let profile = null;
let originalLines = [];
let originalPageStart = 0; // prima riga della pagina visibile
let partial = '';
let partialContinues = false;
let originals = new Map(); // id -> testo, per mostrarlo se la traduzione fallisce
let pageLines = []; // righe tradotte della pagina visibile
let pageReadUntil = 0; // quando la pagina sarà stata letta
let queuedBlocks = []; // traduzioni in attesa, ognuna divisa in righe
let pageTimer = null;
let fadeTimer = null;
const loadedFonts = new Set();

// --- Impaginazione ---

// "Caratteri per riga" vale per l'originale. La traduzione ha la stessa larghezza in pixel:
// con un carattere più piccolo ci stanno più lettere.
const originalChars = (style) => style.charsPerLine;
const translationChars = (style) => Math.max(10, Math.round(style.charsPerLine * style.size / style.sizeTranslation));

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) { line = candidate; continue; }
    if (line) lines.push(line);
    let rest = word;
    while (rest.length > width) { // parola più lunga di una riga
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

// Un blocco dello stesso turno prosegue sulla riga dell'ultimo: le righe già formate non si muovono.
function appendWrapped(lines, text, continues, width) {
  if (!continues || !lines.length) return [...lines, ...wrap(text, width)];
  return [...lines.slice(0, -1), ...wrap(`${lines[lines.length - 1]} ${text}`, width)];
}

// Le righe non si spostano mai: chi legge non deve ritrovare più in alto ciò che ha già letto.
// Ogni riga resta al suo posto e, quando la pagina è piena, la successiva riparte dall'alto.
function originalPage(style) {
  const lines = partial ? appendWrapped(originalLines, partial, partialContinues, originalChars(style)) : originalLines;
  while (lines.length > originalPageStart + style.lines) originalPageStart += style.lines;
  // Una revisione del parziale può accorciare il testo: non si torna alla pagina precedente.
  const start = Math.min(originalPageStart, Math.max(0, lines.length - 1));
  return lines.slice(start, start + style.lines).join('\n');
}

function render() {
  if (!profile) return;
  const { view, style } = profile;
  const showOriginal = view === 'both' || view === 'original';
  const showTranslation = view === 'both' || view === 'translation';
  const original = showOriginal ? originalPage(style) : '';
  const translation = showTranslation ? pageLines.slice(-style.lines).join('\n') : '';
  if (originalEl.textContent !== original) originalEl.textContent = original;
  if (translationEl.textContent !== translation) translationEl.textContent = translation;
  // Lo spazio di ogni lingua è riservato: una non sposta mai l'altra.
  const height = `${style.lines * style.lineHeight}em`;
  originalEl.style.display = showOriginal ? 'block' : 'none';
  translationEl.style.display = showTranslation ? 'block' : 'none';
  originalEl.style.height = height;
  translationEl.style.height = height;
  box.classList.toggle('empty', !original && !translation);
}

// --- Traduzione a pagine ---

// Un blocco si aggiunge sotto quelli già visibili se c'è posto. Altrimenti la pagina cambia, ma solo
// quando è passato il tempo di leggerla, così nessuna riga viene mai saltata. Se il testo si
// accumula il tempo di lettura si accorcia: il ritardo resta limitato con chi parla molto veloce.
function showBlock(lines) {
  const taken = lines.splice(0, profile.style.lines - pageLines.length);
  pageLines = [...pageLines, ...taken];
  const readMs = (taken.join(' ').length / READING_CHARS_PER_SECOND) * 1000;
  pageReadUntil = Math.max(pageReadUntil, Date.now()) + Math.max(MIN_PAGE_READ_MS, readMs);
  showText();
  render();
}

function showQueuedText() {
  clearTimeout(pageTimer);
  pageTimer = null;
  if (!profile) return;
  const max = profile.style.lines;
  while (queuedBlocks.length) {
    const lines = queuedBlocks[0];
    const fits = pageLines.length + lines.length <= max;
    // Un blocco resta intero, se può stare in una pagina. Se è più lungo, riempie la pagina vuota.
    if (fits || (!pageLines.length && lines.length > max)) {
      showBlock(lines);
      if (!lines.length) queuedBlocks.shift();
      continue;
    }
    const wait = (pageReadUntil - Date.now()) / queuedBlocks.length;
    if (wait > 0) {
      pageTimer = setTimeout(showQueuedText, wait);
      return;
    }
    pageLines = [];
  }
}

function enqueueTranslation(text) {
  queuedBlocks.push(wrap(text, translationChars(profile.style)));
  showQueuedText();
}

// --- Dissolvenza dopo il silenzio ---

function showText() {
  box.style.transitionDuration = '0s';
  box.style.opacity = '1';
  clearTimeout(fadeTimer);
  const after = (profile?.style.fadeAfter ?? 6) * 1000;
  fadeTimer = setTimeout(() => {
    if (queuedBlocks.length) { // c'è ancora testo da leggere
      showText();
      return;
    }
    const seconds = profile?.style.fadeDuration ?? 0.6;
    box.style.transitionDuration = `${seconds}s`;
    box.style.opacity = '0';
    fadeTimer = setTimeout(clearText, seconds * 1000 + 50);
  }, after);
}

function clearText() {
  clearTimeout(fadeTimer);
  clearTimeout(pageTimer);
  pageTimer = null;
  originalLines = [];
  originalPageStart = 0;
  partial = '';
  pageLines = [];
  pageReadUntil = 0;
  queuedBlocks = [];
  originals = new Map();
  render();
}

// --- Stile ---

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Il contorno è fatto con ombre radiali, che funzionano anche nel browser integrato di OBS.
function textShadow(s) {
  const parts = [];
  if (s.outlineWidth > 0) {
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      parts.push(`${(Math.cos(angle) * s.outlineWidth).toFixed(2)}px ${(Math.sin(angle) * s.outlineWidth).toFixed(2)}px 0 ${s.outlineColor}`);
    }
  }
  if (s.shadowBlur > 0 || s.shadowOffset > 0) {
    parts.push(`${s.shadowOffset}px ${s.shadowOffset}px ${s.shadowBlur}px ${s.shadowColor}`);
  }
  return parts.join(',') || 'none';
}

function loadGoogleFont(name, weight) {
  for (const family of [encodeURIComponent(name), `${encodeURIComponent(name)}:wght@${weight}`]) {
    if (loadedFonts.has(family)) continue;
    loadedFonts.add(family);
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    document.head.appendChild(el);
  }
}

function applyFont(el, font, source, weight, size, fontStyle, color) {
  if (source === 'google') loadGoogleFont(font, weight);
  const name = font.includes(',') ? font : `"${font}"`;
  Object.assign(el.style, {
    fontFamily: `${name}, Arial, sans-serif`, fontWeight: weight, fontSize: `${size}px`, fontStyle, color,
  });
}

function applyStyle() {
  const s = profile.style;
  applyFont(originalEl, s.font, s.fontSource, s.weight, s.size, s.fontStyle, s.colorOriginal);
  applyFont(translationEl, s.fontTranslation, s.fontSourceTranslation, s.weightTranslation, s.sizeTranslation,
    s.fontStyleTranslation, s.colorTranslation);
  Object.assign(stage.style, {
    padding: `${s.marginY}px ${s.marginX}px`,
    justifyContent: { top: 'flex-start', center: 'center', bottom: 'flex-end' }[s.position],
    alignItems: { left: 'flex-start', center: 'center', right: 'flex-end' }[s.align],
    textAlign: s.align,
    fontSize: `${s.size}px`, // misura di riferimento per i margini del riquadro
    lineHeight: s.lineHeight,
    textShadow: textShadow(s),
  });
  originalEl.style.order = s.order === 'original' ? 0 : 1;
  translationEl.style.order = s.order === 'original' ? 1 : 0;
  box.style.gap = `${s.gap}px`;

  const fill = hexToRgba(s.bgColor, s.bgOpacity);
  box.style.background = s.bgMode === 'box' ? fill : 'transparent';
  box.style.padding = s.bgMode === 'box' ? '0.25em 0.6em' : '0';
  const preview = document.body.classList.contains('preview');
  if (s.bgMode === 'full') document.body.style.background = fill;
  else document.body.style.background = preview ? '' : 'transparent';

  stage.style.opacity = profile.hidden ? 0 : 1;
}

function fitStage() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
addEventListener('resize', fitStage);
fitStage();

// --- Messaggi dal server ---

const handlers = {
  profile(m) {
    profile = m;
    applyStyle();
    render();
  },
  partial(m) {
    partial = m.text;
    partialContinues = !!m.cont;
    if (partial) showText();
    render();
  },
  final(m) {
    if (!profile) return;
    partial = '';
    originalLines = appendWrapped(originalLines, m.text, m.cont, originalChars(profile.style));
    // Le pagine già passate non servono più. Resta l'ultima riga, che il blocco successivo può continuare.
    const passed = Math.min(originalPageStart, originalLines.length - 1);
    originalLines = originalLines.slice(passed);
    originalPageStart -= passed;
    originals.set(m.id, m.text);
    if (originals.size > MAX_KEPT_ORIGINALS) originals.delete(originals.keys().next().value);
    showText();
    render();
  },
  translation(m) {
    if (profile) enqueueTranslation(m.text);
  },
  // Senza traduzione, chi vede solo la traduzione legge l'originale.
  translationFailed(m) {
    if (profile?.view === 'translation' && originals.has(m.id)) enqueueTranslation(originals.get(m.id));
  },
  clear: clearText,
};

// EventSource si riconnette da solo. Solo se si arrende, va ricreato.
function connect() {
  const source = new EventSource(`/events?out=${out}`);
  source.onmessage = (e) => {
    const m = JSON.parse(e.data);
    handlers[m.t]?.(m);
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
}
connect();
