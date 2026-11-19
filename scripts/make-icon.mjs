// Disegna l'icona di Duetto: un'onda sonora che diventa righe di sottotitoli.
// Uso: npm run icon
//
// Dallo stesso disegno crea:
// - build/Duetto.icon: il formato di Icon Composer, con la variante scura. Il Mac lo usa per
//   l'icona adattiva (chiara, scura, colorata, trasparente, effetto vetro). Si compila solo con
//   Xcode 26 o successivo: npm run dist:mac:glass.
// - build/icon.png: l'icona classica sulla griglia Apple, per Windows e per le build senza Xcode.
// - build/icon-anteprima-chiara.png e build/icon-anteprima-scura.png: come appare nei due temi.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, 'build');

// --- Il disegno, su una tela di 1024 punti come in Icon Composer ---

// Barra verticale con le estremità tonde: un campione dell'onda sonora.
function bar(x, cy, w, h) {
  const r = w / 2;
  const y = cy - h / 2;
  return `M${x},${y + r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x},${y + h - r} Z`;
}
// Riga orizzontale con le estremità tonde: una riga di sottotitolo.
function line(x, y, w, h) {
  const r = h / 2;
  return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
}

// L'onda cresce verso il centro e si spegne verso destra, dove nasce il testo.
const WAVE = [120, 230, 340, 210, 280, 140].map((h, i) => bar(214 + i * 54, 512, 34, h)).join(' ');
// Tre righe: originale, traduzione (gialla, come nelle uscite), originale.
const LINES_WHITE = `${line(562, 416, 250, 40)} ${line(562, 568, 250, 40)}`;
const LINE_YELLOW = line(562, 492, 200, 40);

const THEMES = {
  light: { top: '#7d7af0', bottom: '#2f2ca8', glyph: '#ffffff', yellow: '#ffd60a' },
  // Tema scuro: fondo quasi nero, il disegno prende il colore al posto dello sfondo.
  dark: { top: '#2c2c2e', bottom: '#0b0b0d', glyph: '#a5a3ff', yellow: '#ffd60a' },
};

// Ingrandisce il disegno attorno al centro della tela.
const ZOOM = 'transform="translate(512 512) scale(1.15) translate(-512 -512)"';

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${body}</svg>\n`;

// --- Icon Composer: un livello per elemento, il sistema aggiunge vetro, luce e ombre ---

const color = (hex) => {
  const n = (i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5);
  return `srgb:${n(1)},${n(3)},${n(5)},1.00000`;
};

function writeIconComposer() {
  const dir = path.join(BUILD, 'Duetto.icon');
  const assets = path.join(dir, 'Assets');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(assets, { recursive: true });
  const { light, dark } = THEMES;
  fs.writeFileSync(path.join(assets, 'onda.svg'), svg(`<g ${ZOOM}><path d="${WAVE}" fill="${light.glyph}"/></g>`));
  fs.writeFileSync(path.join(assets, 'righe.svg'), svg(`<g ${ZOOM}><path d="${LINES_WHITE}" fill="${light.glyph}"/></g>`));
  fs.writeFileSync(path.join(assets, 'riga-gialla.svg'), svg(`<g ${ZOOM}><path d="${LINE_YELLOW}" fill="${light.yellow}"/></g>`));

  // Nel tema scuro onda e righe bianche cambiano colore; la riga gialla resta gialla.
  const layer = (name, darkHex) => ({
    'image-name': `${name}.svg`,
    name,
    glass: true,
    ...(darkHex && { 'fill-specializations': [{ appearance: 'dark', value: { solid: color(darkHex) } }] }),
  });
  const icon = {
    'fill-specializations': [
      { value: { 'automatic-gradient': color(light.bottom) } },
      { appearance: 'dark', value: { 'automatic-gradient': color(dark.bottom) } },
    ],
    groups: [
      {
        layers: [layer('riga-gialla'), layer('righe', dark.glyph), layer('onda', dark.glyph)],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: true, value: 0.4 },
      },
    ],
    'supported-platforms': { squares: ['macOS'] },
  };
  fs.writeFileSync(path.join(dir, 'icon.json'), `${JSON.stringify(icon, null, 2)}\n`);
}

// --- Icona classica: la forma continua dei Mac, 824 punti dentro 1024, con ombra ---

// Angoli continui come quelli di Apple: lati dritti e curvatura che cresce piano.
// Ogni angolo è un quarto di superellisse, che si attacca ai lati senza piega.
function continuousRect(x, y, size, r) {
  const L = r * 1.6;
  const n = 4;
  const corner = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * (Math.PI / 2);
    // [distanza dal lato destro, distanza dall'alto], dal lato alto al lato destro.
    corner.push([L - L * Math.sin(t) ** (2 / n), L - L * Math.cos(t) ** (2 / n)]);
  }
  const x1 = x + size;
  const y1 = y + size;
  // Ruota l'angolo sui quattro spigoli, in senso orario.
  const maps = [
    ([a, b]) => [x1 - a, y + b],
    ([a, b]) => [x1 - b, y1 - a],
    ([a, b]) => [x + a, y1 - b],
    ([a, b]) => [x + b, y + a],
  ];
  const pts = maps.flatMap((map) => corner.map(map)).map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`);
  return `M${pts.join(' L')} Z`;
}

function classicSvg(theme) {
  const t = THEMES[theme];
  // La griglia delle icone Mac: piastra di 824 punti con angoli di circa 185, centrata in 1024.
  const plate = continuousRect(100, 88, 824, 185);
  const art = 'transform="translate(100 88) scale(0.8047)"'; // la tela di 1024 dentro la piastra di 824
  return svg(`
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.top}"/><stop offset="1" stop-color="${t.bottom}"/></linearGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${theme === 'dark' ? 0.1 : 0.2}"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="plateShadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/></filter>
  <filter id="artShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.3"/></filter>
  <clipPath id="plateClip"><path d="${plate}"/></clipPath>
</defs>
<path d="${plate}" fill="url(#bg)" filter="url(#plateShadow)"/>
<g clip-path="url(#plateClip)">
  <path d="${plate}" fill="url(#sheen)"/>
  <g ${art}><g ${ZOOM} filter="url(#artShadow)">
    <path d="${WAVE}" fill="${t.glyph}"/>
    <path d="${LINES_WHITE}" fill="${t.glyph}"/>
    <path d="${LINE_YELLOW}" fill="${t.yellow}"/>
  </g></g>
</g>
<path d="${plate}" fill="none" stroke="#fff" stroke-opacity="${theme === 'dark' ? 0.22 : 0.16}" stroke-width="2"/>`);
}

// Electron disegna l'SVG su una tela e restituisce il PNG.
// Una sola finestra nascosta per tutti i disegni.
let win = null;
async function renderPng(svgText, size) {
  if (!win) {
    win = new BrowserWindow({ show: false, width: 200, height: 200 });
    await win.loadURL('about:blank');
  }
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG non valido'));
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}';
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// Non va atteso in cima al modulo: Electron rimanda l'evento ready finché il modulo non è caricato.
app.whenReady().then(async () => {
  try {
    writeIconComposer();
    const light = classicSvg('light');
    fs.writeFileSync(path.join(BUILD, 'icon.svg'), light);
    fs.writeFileSync(path.join(BUILD, 'icon.png'), await renderPng(light, 1024));
    fs.writeFileSync(path.join(BUILD, 'icon-anteprima-chiara.png'), await renderPng(light, 512));
    fs.writeFileSync(path.join(BUILD, 'icon-anteprima-scura.png'), await renderPng(classicSvg('dark'), 512));
    console.log('Icona creata: build/icon.png, build/Duetto.icon e le anteprime chiara e scura');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
