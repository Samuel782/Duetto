// Molle per l'interfaccia della regia: ogni movimento parte dal valore visibile e conserva la
// velocità, quindi si può invertire a metà senza scatti. Parametri come in UIKit: smorzamento
// (1 = nessun rimbalzo) e risposta in secondi.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

class Spring {
  constructor(value, apply, { damping = 1, response = 0.35, onRest = null } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.apply = apply;
    this.onRest = onRest;
    this.stiffness = (2 * Math.PI / response) ** 2;
    this.friction = (4 * Math.PI * damping) / response;
    this.frame = 0;
    this.last = 0;
    this.tick = this.tick.bind(this);
  }

  // Nuovo obiettivo: la corsa in atto prosegue da dove si trova, con la sua velocità.
  set(target) {
    this.target = target;
    if (reduceMotion.matches || document.hidden) { this.jump(target, true); return; }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  // Posizionamento immediato. Con rest, conta come fine corsa (movimento ridotto).
  jump(value, rest = false) {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.value = this.target = value;
    this.velocity = 0;
    this.apply(value);
    if (rest) this.onRest?.(value);
  }

  tick(now) {
    let dt = Math.min(0.064, (now - this.last) / 1000); // dopo una scheda in pausa non si salta
    this.last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      const force = -this.stiffness * (this.value - this.target) - this.friction * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      dt -= h;
    }
    // Ferma sotto il mezzo pixel: la coda di una molla critica è invisibile ma lunga.
    if (Math.abs(this.velocity) < 10 && Math.abs(this.value - this.target) < 0.5) {
      this.frame = 0;
      this.value = this.target;
      this.velocity = 0;
      this.apply(this.value);
      this.onRest?.(this.value);
      return;
    }
    this.apply(this.value);
    this.frame = requestAnimationFrame(this.tick);
  }
}

// Controllo segmentato: l'indicatore scorre sotto la scelta attiva. Le colonne sono uguali,
// quindi si muove solo in orizzontale.
function segmentedControl(el) {
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  thumb.setAttribute('aria-hidden', 'true');
  el.prepend(thumb);
  const spring = new Spring(0, (x) => { thumb.style.transform = `translateX(${x}px)`; });
  let placed = false;

  const place = (animate) => {
    const on = el.querySelector('button.on');
    thumb.classList.toggle('visible', !!on);
    if (!on) return;
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.height = `${on.offsetHeight}px`;
    thumb.style.top = `${on.offsetTop}px`;
    if (animate && placed) spring.set(on.offsetLeft);
    else spring.jump(on.offsetLeft);
    placed = true;
  };
  new ResizeObserver(() => place(false)).observe(el);
  el.updateThumb = () => place(true);
  place(false);
}

// Sezione a scomparsa: l'altezza segue una molla, e un nuovo clic a metà corsa la inverte.
function disclosure(details) {
  const summary = details.querySelector('summary');
  const body = details.querySelector('.disclosure-body');
  let wantOpen = details.open;
  const spring = new Spring(0, (h) => {
    body.style.height = `${Math.max(0, h)}px`;
    const progress = h / (body.scrollHeight || 1);
    details.style.setProperty('--disclosure', Math.min(1, Math.max(0, progress)).toFixed(3));
  }, {
    onRest: () => {
      if (wantOpen) body.style.height = ''; // aperta: il contenuto può crescere liberamente
      else details.open = false;
    },
  });
  details.style.setProperty('--disclosure', wantOpen ? 1 : 0);

  summary.addEventListener('click', (e) => {
    e.preventDefault();
    wantOpen = !wantOpen;
    if (!details.open) {
      details.open = true;
      spring.jump(0);
    } else if (!body.style.height) {
      spring.jump(body.offsetHeight); // ferma e aperta: si parte dall'altezza visibile
    }
    spring.set(wantOpen ? body.scrollHeight : 0);
  });

  // Aperta o chiusa da codice, per esempio dagli screenshot: si allinea senza animare.
  details.addEventListener('toggle', () => {
    if (spring.frame) return;
    wantOpen = details.open;
    body.style.height = '';
    details.style.setProperty('--disclosure', wantOpen ? 1 : 0);
  });
}

window.Motion = { Spring, segmentedControl, disclosure };
