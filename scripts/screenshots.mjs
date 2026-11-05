// Avvia l'app vera con microfono e servizi finti, salva gli screenshot del README e prova la catena.
// Uso: npx electron scripts/screenshots.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { startMock } from '../test/mock-services.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'docs', 'img');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-shots-'));

const mock = await startMock();
mock.stats.usage = { character_count: 46210, character_limit: 1000000 };
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ assemblyaiApiKey: 'mock-key', deeplApiKey: 'esempio:fx' }));
fs.writeFileSync(path.join(tmp, 'keyterms.txt'), 'Maria Rossi\nJohn Smith\nOBS Studio\n');
fs.writeFileSync(path.join(tmp, 'glossario.csv'), 'sala stampa,press room\ntavola rotonda,round table\n');
process.env.DUETTO_TEST = '1';
process.env.DUETTO_DATA_DIR = tmp;
process.env.OUTPUT_DIR = path.join(tmp, 'output');
process.env.ASSEMBLYAI_WS_URL = `ws://127.0.0.1:${mock.port}/v3/ws`;
process.env.DEEPL_ENDPOINT = `http://127.0.0.1:${mock.port}`;

await import('../electron/main.js');

async function waitForWindow(fragment) {
  for (let i = 0; i < 100; i++) {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(fragment));
    if (win && !win.webContents.isLoading()) return win;
    await sleep(100);
  }
  throw new Error(`Finestra non trovata: ${fragment}`);
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  console.log('screenshot', name, JSON.stringify(image.getSize()));
}

const run = (win, code) => win.webContents.executeJavaScript(code, true);

async function overlayShot(origin, query, name) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, transparent: false, useContentSize: true, webPreferences: { offscreen: false } });
  await win.loadURL(`${origin}/overlay?${query}`);
  await sleep(3500);
  await shot(win, name);
  win.destroy();
}

// Non va atteso qui: Electron rimanda l'evento ready finché il modulo principale non è caricato.
drive();

async function drive() {
try {
  fs.mkdirSync(OUT, { recursive: true });
  const main = await waitForWindow('/control');
  const origin = new URL(main.webContents.getURL()).origin;
  await sleep(1500);
  // Nei test il microfono si chiama "Fake": sullo schermo vero c'è il nome dell'interfaccia audio.
  await run(main, "document.querySelectorAll('#device option').forEach((o) => { o.textContent = 'Interfaccia audio USB'; })");
  // Il microfono finto è talmente forte da saturare: il livello mostrato viene riportato a un valore normale.
  await run(main, "{ const original = captureNode.port.onmessage; captureNode.port.onmessage = (e) => original({ data: { pcm: e.data.pcm, peak: e.data.peak * 0.35 } }); lastClipAt = 0; }");
  await run(main, "document.getElementById('demo').click()");
  await sleep(4200);
  await run(main, 'window.scrollTo(0, 0)');
  await sleep(200);
  await shot(main, 'regia.png');

  await run(main, "document.querySelector('details:has(#styleFields)').open = true; document.querySelector('details:has(#styleFields)').closest('section').scrollIntoView()");
  await sleep(500);
  await shot(main, 'stile.png');
  await run(main, "document.querySelector('details:has(#styleFields)').open = false; const d = document.querySelector('details:has(#links)'); d.open = true; d.closest('section').scrollIntoView(); document.querySelectorAll('#links code').forEach((c) => { c.textContent = c.textContent.replace(/\\/\\/\\d+\\.\\d+\\.\\d+\\.\\d+/, '//192.168.1.50'); })");
  await sleep(300); // l'indirizzo vero della rete non deve finire nella documentazione
  await shot(main, 'collegamenti.png');
  await run(main, "document.querySelector('details:has(#links)').open = false; window.scrollTo(0, 0)");

  await overlayShot(origin, 'out=stream&preview=1', 'uscita-streaming.png');
  await overlayShot(origin, 'out=room', 'uscita-sala.png');

  await run(main, "document.getElementById('openSettings').click()");
  const settings = await waitForWindow('/settings');
  await sleep(500);
  await run(settings, "document.getElementById('save').click()");
  await sleep(2500);
  const result = await run(settings, "[document.getElementById('assemblyaiResult').textContent, document.getElementById('deeplResult').textContent, document.getElementById('saveNote').textContent]");
  console.log('verifica chiavi', JSON.stringify(result));
  await run(settings, "document.getElementById('assemblyaiKey').placeholder = 'Salvata (••••••••a1b2)'; document.getElementById('deeplKey').placeholder = 'Salvata (••••••••c3d4)'");
  await shot(settings, 'impostazioni.png');
  settings.close();

  // Catena completa nell'app: microfono, trascrizione, traduzione, pausa.
  await run(main, "document.getElementById('demo').click()");
  await sleep(300);
  await run(main, "document.getElementById('start').click()");
  await sleep(9000);
  const live = await run(main, `({
    aai: lastStatus.aai.state, note: document.getElementById('audioNote').textContent,
    room: document.querySelector('.output[data-out=room] iframe').contentDocument.getElementById('box').innerText,
    translated: lastStatus.deepl.avgMs > 0,
  })`);
  console.log('in diretta', JSON.stringify(live));
  await run(main, "document.getElementById('pause').click()");
  await sleep(1500);
  console.log('dopo la pausa', await run(main, 'lastStatus.aai.state'), 'sessioni chiuse', mock.stats.closedSessions.length);
  await run(main, "document.getElementById('resume').click()");
  await sleep(2000);
  const before = mock.stats.closedSessions.length;
  app.once('will-quit', () => {});
  setTimeout(() => {
    console.log('chiusura: sessioni chiuse', before, '->', mock.stats.closedSessions.length);
    console.log('FINE');
  }, 1200);
  await sleep(100);
  app.quit();
} catch (err) {
  console.error('ERRORE', err);
  app.exit(1);
}
}
