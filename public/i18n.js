// Traduzione delle pagine. Il server antepone a questo file la lingua scelta e il dizionario:
// window.DUETTO_LANG e window.DUETTO_DICT. I testi italiani nell'HTML e nel codice fanno da chiave.
(() => {
  const lang = window.DUETTO_LANG === 'en' ? 'en' : 'it';
  const dict = lang === 'en' ? (window.DUETTO_DICT || {}) : {};

  const t = (text, vars = {}) => (dict[text] ?? text)
    .replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));

  // Traduce i testi già scritti nella pagina: nodi di testo e alcuni attributi.
  const ATTRS = ['placeholder', 'aria-label', 'title'];
  function translateTree(root) {
    if (lang === 'it') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('script, style, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text && dict[text]) node.nodeValue = node.nodeValue.replace(text, dict[text]);
    }
    root.querySelectorAll?.('*').forEach((el) => {
      for (const attr of ATTRS) {
        const value = el.getAttribute(attr);
        if (value && dict[value]) el.setAttribute(attr, dict[value]);
      }
    });
  }

  document.documentElement.lang = lang;
  if (dict[document.title]) document.title = dict[document.title];
  window.I18N = {
    lang,
    locale: lang === 'en' ? 'en-GB' : 'it-IT',
    t,
    translateTree,
  };
  // Lo script è in fondo alla pagina: il contenuto statico è già presente.
  translateTree(document.body);
})();
