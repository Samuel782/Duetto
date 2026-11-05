// Finestra Impostazioni. Le chiavi salvate non tornano mai qui: si vedono solo le ultime 4 cifre.
const $ = (id) => document.getElementById(id);
let ws = null;
let loaded = false;

function showResult(el, result) {
  el.textContent = result ? `${result.ok ? '✓' : '✗'} ${result.message}` : '';
  el.className = `result ${result ? (result.ok ? 'st-ok' : 'st-bad') : ''}`;
}

function fill(m) {
  $('assemblyaiKey').value = '';
  $('deeplKey').value = '';
  $('assemblyaiKey').placeholder = m.assemblyaiKey ? `Salvata (${m.assemblyaiKey})` : 'Incolla qui la chiave';
  $('deeplKey').placeholder = m.deeplKey ? `Salvata (${m.deeplKey})` : 'Incolla qui la chiave';
  if (loaded) return; // non cancella ciò che si sta modificando se la connessione si ristabilisce
  loaded = true;
  $('keyterms').value = m.keyterms;
  $('glossary').value = m.glossary;
  $('cleanFillers').checked = m.cleanFillers;
  $('cleanProfanity').checked = m.cleanProfanity;
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ cmd: 'settingsGet' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'settings') fill(m);
    if (m.t === 'settingsResult') {
      showResult($('assemblyaiResult'), m.assemblyai);
      showResult($('deeplResult'), m.deepl);
      $('saveNote').textContent = m.saved ? m.terms : 'Salvataggio non riuscito';
      $('save').disabled = false;
    }
  };
  ws.onclose = () => {
    $('save').disabled = false;
    setTimeout(connect, 1000);
  };
}

$('save').onclick = () => {
  if (ws?.readyState !== WebSocket.OPEN) {
    $('saveNote').textContent = 'App non raggiungibile, riprova tra poco';
    return;
  }
  $('save').disabled = true;
  $('saveNote').textContent = 'Verifica in corso…';
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
  }));
};

connect();
