// Guscio dell'app desktop: avvia il server locale e apre le finestre.
import path from 'node:path';
import {
  app, BrowserWindow, dialog, powerSaveBlocker, screen, session, shell, systemPreferences,
} from 'electron';

const IS_TEST = process.env.DUETTO_TEST === '1';
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);

app.setName('Duetto');
if (process.env.DUETTO_DATA_DIR) app.setPath('userData', process.env.DUETTO_DATA_DIR);
// La cattura audio deve partire anche dopo un ricaricamento, senza un clic.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let origin = '';
let shutdownServer = async () => {};
let quitAsked = false;
let quitting = false;

const isOwnUrl = (url) => {
  try { return new URL(url).origin === origin; } catch { return false; }
};

function roomWindowOptions() {
  const primary = screen.getPrimaryDisplay();
  const external = screen.getAllDisplays().find((d) => d.id !== primary.id);
  const shared = { backgroundColor: '#000000', title: 'Uscita sala', webPreferences: { backgroundThrottling: false } };
  // Senza un secondo schermo resta una finestra normale, per non coprire la regia.
  if (!external) return { ...shared, width: 1280, height: 720 };
  return { ...shared, x: external.bounds.x, y: external.bounds.y, frame: false, fullscreen: true };
}

function handleOpenWindow({ url }) {
  if (!isOwnUrl(url)) {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  }
  const { pathname } = new URL(url);
  if (pathname === '/settings') {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: mainWindow, width: 720, height: 860, title: 'Impostazioni', backgroundColor: '#0d0f12', autoHideMenuBar: true,
      },
    };
  }
  if (pathname === '/overlay') return { action: 'allow', overrideBrowserWindowOptions: roomWindowOptions() };
  return { action: 'deny' };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    title: 'Duetto',
    backgroundColor: '#0d0f12',
    autoHideMenuBar: true,
    // L'audio e la riconnessione non devono rallentare con la finestra in secondo piano.
    webPreferences: { backgroundThrottling: false },
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`${origin}/control`);
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(handleOpenWindow);
  contents.on('will-navigate', (event, url) => {
    if (!isOwnUrl(url)) event.preventDefault();
  });
  // Esc chiude l'uscita sala a schermo intero.
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && new URL(contents.getURL() || origin).pathname === '/overlay') {
      event.preventDefault();
      BrowserWindow.fromWebContents(contents)?.close();
    }
  });
});

// Un evento può essere in diretta: chiudere deve essere una scelta, e deve fermare i costi.
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (quitAsked) return;
  quitAsked = true;
  const choice = IS_TEST ? 0 : dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['Chiudi', 'Annulla'],
    defaultId: 1,
    cancelId: 1,
    message: 'Chiudere Duetto?',
    detail: 'Se sei in diretta, i sottotitoli si fermano.',
  });
  if (choice !== 0) {
    quitAsked = false;
    return;
  }
  quitting = true;
  shutdownServer().finally(() => app.exit(0));
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  process.env.DESKTOP_APP = 'true';
  process.env.PORT_FALLBACK = 'true';
  process.env.DATA_DIR = userData;
  process.env.KEYTERMS_FILE = path.join(userData, 'keyterms.txt');
  process.env.GLOSSARY_FILE = path.join(userData, 'glossario.csv');
  process.env.LOG_FILE = path.join(userData, 'app.log');
  process.env.OUTPUT_DIR ||= path.join(app.getPath('documents'), 'Duetto');

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isOwnUrl(contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    ALLOWED_PERMISSIONS.has(permission) && isOwnUrl(requestingOrigin)
  ));

  if (process.platform === 'darwin' && !IS_TEST) {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Il server si carica dopo aver impostato i percorsi, che legge all'avvio.
  const server = await import('../server/index.js');
  server.hooks.openFolder = (folder) => shell.openPath(folder);
  shutdownServer = server.shutdown;
  let ready;
  try {
    ready = await server.serverReady;
  } catch (err) {
    dialog.showErrorBox('Duetto non può partire', `Nessuna porta disponibile: ${err.message}`);
    quitting = true;
    app.exit(1);
    return;
  }
  origin = `http://localhost:${ready.port}`;
  powerSaveBlocker.start('prevent-display-sleep');
  createMainWindow();
  // Al primo avvio servono le chiavi: la finestra si apre da sola.
  if (!ready.hasKeys && !IS_TEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript("window.open('/settings', 'settings'); 0", true).catch(() => {});
    });
  }
});
