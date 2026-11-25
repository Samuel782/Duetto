// Solo prova: preme Avvia, apre la sala, la chiude con Esc e pubblica nel titolo ciò che si vede.
(() => {
  if (window.top !== window) return;
  if (location.pathname === '/overlay') {
    let n = 0;
    const tick = () => { n += 1; requestAnimationFrame(tick); };
    tick();
    setInterval(() => { document.title = 'PROBE sala ' + JSON.stringify({ fps: n, vis: document.visibilityState, w: innerWidth, h: innerHeight, testo: document.body.innerText.slice(0, 40) }); n = 0; }, 1000);
    return;
  }
  if (location.pathname !== '/control') return;
  setTimeout(() => document.getElementById('start').click(), 6000);
  setTimeout(() => document.getElementById('openRoom').click(), 10000);
  setInterval(() => {
    const d = document.getElementById('device');
    document.title = 'PROBE regia ' + JSON.stringify({ nota: document.getElementById('audioNote').textContent, ingresso: d.selectedOptions[0]?.text, ingressi: d.options.length, pausa: !document.getElementById('pause').disabled, vis: document.visibilityState });
  }, 1000);
})();
