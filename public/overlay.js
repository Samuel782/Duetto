// Overlay: riceve testo e impostazioni dal server e impagina secondo il profilo dell'uscita.
const params = new URLSearchParams(location.search);
const out = params.get('out') === 'room' ? 'room' : 'stream';
if (params.has('preview')) document.body.classList.add('preview');

const stage = document.getElementById('stage');
const box = document.getElementById('box');
const originalEl = document.getElementById('original');
const translationEl = document.getElementById('translation');

const MAX_SENTENCES = 8; // nessuna cronologia: solo ciò che può stare a schermo
let profile = null;
let sentences = []; // { id, text, translation, failed }
let partial = '';
let fadeTimer = null;
let loadedFonts = new Set();

// --- Impaginazione ---

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

// Ogni frase inizia su una riga nuova; oltre il massimo scorre via il testo più vecchio.
function lastLines(texts, width, max) {
  return texts.flatMap((t) => wrap(t, width)).slice(-max).join('\n');
}

function render() {
  if (!profile) return;
  const { view, style } = profile;
  const originals = sentences.map((s) => s.text);
  if (partial) originals.push(partial);
  let original = '';
  let translation = '';
  if (view === 'both' || view === 'original') {
    original = lastLines(originals, style.charsPerLine, style.lines);
  }
  if (view === 'both') {
    translation = lastLines(sentences.filter((s) => s.translation).map((s) => s.translation), style.charsPerLine, style.lines);
  } else if (view === 'translation') {
    // Niente parziali. Se la traduzione è fallita resta visibile l'originale.
    const ready = sentences.filter((s) => s.translation || s.failed).map((s) => s.translation || s.text);
    translation = lastLines(ready, style.charsPerLine, style.lines);
  }
  if (originalEl.textContent !== original) originalEl.textContent = original;
  if (translationEl.textContent !== translation) translationEl.textContent = translation;
  box.classList.toggle('empty', !original && !translation);
}

// --- Dissolvenza dopo il silenzio ---

function showText() {
  box.style.transitionDuration = '0s';
  box.style.opacity = '1';
  clearTimeout(fadeTimer);
  const after = (profile?.style.fadeAfter ?? 6) * 1000;
  fadeTimer = setTimeout(() => {
    const seconds = profile?.style.fadeDuration ?? 0.6;
    box.style.transitionDuration = `${seconds}s`;
    box.style.opacity = '0';
    fadeTimer = setTimeout(clearText, seconds * 1000 + 50);
  }, after);
}

function clearText() {
  clearTimeout(fadeTimer);
  sentences = [];
  partial = '';
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

function applyStyle() {
  const s = profile.style;
  if (s.fontSource === 'google') loadGoogleFont(s.font, s.weight);
  const fontName = s.font.includes(',') ? s.font : `"${s.font}"`;
  Object.assign(stage.style, {
    padding: `${s.marginY}px ${s.marginX}px`,
    justifyContent: { top: 'flex-start', center: 'center', bottom: 'flex-end' }[s.position],
    alignItems: { left: 'flex-start', center: 'center', right: 'flex-end' }[s.align],
    textAlign: s.align,
    fontFamily: `${fontName}, Arial, sans-serif`,
    fontWeight: s.weight,
    fontSize: `${s.size}px`,
    lineHeight: s.lineHeight,
    textShadow: textShadow(s),
  });
  originalEl.style.color = s.colorOriginal;
  translationEl.style.color = s.colorTranslation;
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
    if (partial) showText();
    render();
  },
  final(m) {
    partial = '';
    sentences.push({ id: m.id, text: m.text, translation: '', failed: false });
    if (sentences.length > MAX_SENTENCES) sentences.shift();
    showText();
    render();
  },
  translation(m) {
    const s = sentences.find((x) => x.id === m.id);
    if (!s) return;
    s.translation = m.text;
    showText();
    render();
  },
  translationFailed(m) {
    const s = sentences.find((x) => x.id === m.id);
    if (!s) return;
    s.failed = true;
    render();
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
