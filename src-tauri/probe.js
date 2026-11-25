// Solo prova: preme Avvia, apre la sala e pubblica nel titolo ciò che la pagina mostra.
(() => {
  if (window.top !== window || location.pathname !== '/control') return;
  setTimeout(() => document.getElementById('start').click(), 6000);
  setTimeout(() => document.getElementById('openRoom').click(), 10000);
  setInterval(() => {
    const d = document.getElementById('device');
    document.title = 'PROBE ' + JSON.stringify({ nota: document.getElementById('audioNote').textContent, ingresso: d.value || d.selectedOptions[0]?.text, ingressi: d.options.length, pausa: !document.getElementById('pause').disabled, vis: document.visibilityState });
  }, 1000);
})();
