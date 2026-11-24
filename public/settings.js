// Finestra Impostazioni. Le chiavi salvate non tornano mai qui: si vedono solo le ultime 4 cifre.
const $ = (id) => document.getElementById(id);
const { t } = I18N;
let ws = null;
let loaded = false;
let reloadAfterResult = false;

function showResult(el, result) {
  el.textContent = result ? `${result.ok ? '✓' : '✗'} ${result.message}` : '';
  el.className = `result ${result ? (result.ok ? 'st-ok' : 'st-bad') : ''}`;
}

function fill(m) {
  $('assemblyaiKey').value = '';
  $('deeplKey').value = '';
  $('assemblyaiKey').placeholder = m.assemblyaiKey ? t('Salvata ({key})', { key: m.assemblyaiKey }) : t('Incolla qui la chiave');
  $('deeplKey').placeholder = m.deeplKey ? t('Salvata ({key})', { key: m.deeplKey }) : t('Incolla qui la chiave');
  $('obsPassword').value = '';
  $('obsPassword').placeholder = m.obsPassword ? t('Salvata ({key})', { key: m.obsPassword }) : t('Vuota se OBS non la chiede');
  if (loaded) return; // non cancella ciò che si sta modificando se la connessione si ristabilisce
  loaded = true;
  $('keyterms').value = m.keyterms;
  $('glossary').value = m.glossary;
  $('cleanFillers').checked = m.cleanFillers;
  $('cleanProfanity').checked = m.cleanProfanity;
  $('checkUpdates').checked = m.checkUpdates;
  $('saveFiles').checked = m.saveFiles;
  $('overlayLan').checked = m.overlayLan;
  $('aiNotice').checked = m.aiNotice;
  $('aiNoticeText').value = m.aiNoticeText;
  $('obsEnabled').checked = m.obsEnabled;
  $('obsHost').value = m.obsHost;
  $('obsPort').value = m.obsPort;
  $('assemblyaiRegion').value = m.assemblyaiRegion;
  $('uiLanguage').value = m.uiLanguage;
  if (m.keysEncrypted) $('keysNote').textContent = t('Servono per trascrivere e tradurre. Restano solo su questo computer, cifrate con il portachiavi del sistema.');
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ cmd: 'settingsGet' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'settings') fill(m);
    // Lingua cambiata: la finestra si ricarica appena la verifica delle chiavi è finita.
    if (m.t === 'language' && m.lang !== I18N.lang) reloadAfterResult = true;
    if (m.t === 'settingsResult') {
      showResult($('assemblyaiResult'), m.assemblyai);
      showResult($('deeplResult'), m.deepl);
      $('saveNote').textContent = m.saved ? m.terms : t('Salvataggio non riuscito');
      $('save').disabled = false;
      if (reloadAfterResult) setTimeout(() => location.reload(), 2000);
    }
  };
  ws.onclose = () => {
    $('save').disabled = false;
    setTimeout(connect, 1000);
  };
}

$('save').onclick = () => {
  if (ws?.readyState !== WebSocket.OPEN) {
    $('saveNote').textContent = t('App non raggiungibile, riprova tra poco');
    return;
  }
  $('save').disabled = true;
  $('saveNote').textContent = t('Verifica in corso…');
  showResult($('assemblyaiResult'), null);
  showResult($('deeplResult'), null);
  ws.send(JSON.stringify({
    cmd: 'settingsSave',
    assemblyaiApiKey: $('assemblyaiKey').value,
    deeplApiKey: $('deeplKey').value,
    keyterms: $('keyterms').value,
    glossary: $('glossary').value,
    cleanFillers: $('cleanFillers').checked,
    cleanProfanity: $('cleanProfanity').checked,
    checkUpdates: $('checkUpdates').checked,
    saveFiles: $('saveFiles').checked,
    overlayLan: $('overlayLan').checked,
    aiNotice: $('aiNotice').checked,
    aiNoticeText: $('aiNoticeText').value,
    obsEnabled: $('obsEnabled').checked,
    obsHost: $('obsHost').value,
    obsPort: Number($('obsPort').value),
    obsPassword: $('obsPassword').value,
    assemblyaiRegion: $('assemblyaiRegion').value,
    uiLanguage: $('uiLanguage').value,
  }));
};

if (I18N.lang === 'en') $('privacyLink').href = 'https://github.com/Samuel782/Duetto/blob/main/PRIVACY.md';

connect();
