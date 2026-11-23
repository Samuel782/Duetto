// Traduzione con DeepL: timeout di 3 s, un solo nuovo tentativo, poi si prosegue senza traduzione.
import { locale, t } from './i18n.js';
import fs from 'node:fs';
import { codeFromDetected, language } from './languages.js';
import { log, warn } from './log.js';

const TIMEOUT_MS = 3000;
const MAX_IN_FLIGHT = 6; // coda limitata: se DeepL è bloccato non si accumula nulla
const USAGE_EVERY_MS = 60000;
const GLOSSARY_NAME = 'duetto';
// Il glossario (colonne italiano e inglese del CSV) vale in queste direzioni, e solo in queste si usa.
const GLOSSARY_DIRECTIONS = [{ from: 'it', to: 'en', cols: [0, 1] }, { from: 'en', to: 'it', cols: [1, 0] }];
const GLOSSARY_PAIRS = new Set(GLOSSARY_DIRECTIONS.map((d) => `${d.from}>${d.to}`));

// Le chiavi dei piani gratuiti finiscono con ":fx" e usano un indirizzo diverso.
const endpointForKey = (key) => ((key || '').endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');

// Un CSV a due colonne: supporta i campi tra virgolette.
export function parseGlossaryCsv(content) {
  const seen = new Set();
  const pairs = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = [...line.matchAll(/\s*("(?:[^"]|"")*"|[^,]*)\s*(?:,|$)/g)]
      .map((m) => m[1].trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const [it, en] = cells;
    if (!it || !en || it.toLowerCase() === 'italiano') continue;
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([it.replace(/\t/g, ' '), en.replace(/\t/g, ' ')]);
  }
  return pairs;
}

export class DeepL {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = (cfg.endpoint || endpointForKey(cfg.apiKey)).replace(/\/+$/, '');
    this.modelType = cfg.modelType || null;
    this.glossaryId = null;
    this.glossaryNote = t('nessun glossario');
    this.inFlight = 0;
    this.quotaExhausted = false;
    this.lastError = '';
    this.avgMs = 0;
    this.characterCount = null;
    this.characterLimit = null;
    this.usageTimer = setInterval(() => this.refreshUsage(), USAGE_EVERY_MS);
    this.refreshUsage();
  }

  setApiKey(key) {
    this.cfg.apiKey = key;
    if (!this.cfg.endpoint) this.base = endpointForKey(key);
    this.quotaExhausted = false;
    this.lastError = '';
    this.characterCount = this.characterLimit = null;
    this.refreshUsage();
  }

  // Controlla la chiave salvata e aggiorna i caratteri mostrati in regia.
  async test() {
    if (!this.cfg.apiKey) return { ok: false, message: t('Chiave mancante') };
    try {
      const res = await fetch(`${this.base}/v2/usage`, { headers: this.headers, signal: AbortSignal.timeout(6000) });
      if (res.status === 403) return { ok: false, message: t('Chiave rifiutata da DeepL') };
      if (!res.ok) return { ok: false, message: t('Errore HTTP {status}', { status: res.status }) };
      const data = await res.json();
      this.characterCount = data.character_count ?? null;
      this.characterLimit = data.character_limit ?? null;
      const left = Math.max(0, (data.character_limit ?? 0) - (data.character_count ?? 0));
      return { ok: true, message: t('Chiave valida, {n} caratteri disponibili', { n: left.toLocaleString(locale()) }) };
    } catch (err) {
      return { ok: false, message: t('Nessuna risposta: {error}', { error: err.message }) };
    }
  }

  get headers() {
    return { Authorization: `DeepL-Auth-Key ${this.cfg.apiKey}`, 'Content-Type': 'application/json' };
  }

  // Traduce una frase in una o più lingue. targetsFor(lingua) dice in quali, perché dipende dalla
  // lingua di partenza, che con detect è solo un'ipotesi: DeepL rileva quella vera alla prima
  // richiesta, e solo se l'ipotesi era sbagliata serve ripetere. accept limita le lingue
  // rilevabili a quelle dell'evento: una frase in una terza lingua resta nella lingua ipotizzata.
  // Restituisce { lang, translations: { codice: testo } }, oppure null se nessuna traduzione è riuscita.
  async translate(text, { lang, targetsFor, context = '', detect = false, accept = [] }) {
    if (!this.cfg.apiKey || this.quotaExhausted) return null;
    if (!targetsFor(lang).length && !detect) return { lang, translations: {} };
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.lastError = t('Troppe traduzioni in coda');
      return null;
    }
    this.inFlight += 1;
    const started = Date.now();
    try {
      let source = lang;
      const translations = {};
      const first = targetsFor(source)[0];
      if (detect && first) {
        const result = await this._withRetry(text, source, first, context, true);
        if (!result) {
          warn(`DeepL: ${this.lastError}`);
          return null;
        }
        const found = codeFromDetected(result.detected);
        if (found && found !== source && accept.includes(found)) source = found;
        // La prima traduzione vale se la lingua rilevata è quella usata per sceglierne la destinazione.
        if (found === source && targetsFor(source).includes(first)) translations[first] = result.text;
      }
      const rest = targetsFor(source).filter((code) => !(code in translations));
      const results = await Promise.all(rest.map((code) => this._withRetry(text, source, code, source === lang ? context : '', false)));
      rest.forEach((code, i) => { if (results[i]) translations[code] = results[i].text; });
      if (rest.length && !Object.keys(translations).length) {
        warn(`DeepL: ${this.lastError}`);
        return null;
      }
      const ms = Date.now() - started;
      this.avgMs = this.avgMs ? Math.round(this.avgMs * 0.9 + ms * 0.1) : ms;
      this.lastError = '';
      return { lang: source, translations };
    } finally {
      this.inFlight -= 1;
    }
  }

  async _withRetry(text, source, target, context, detect) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this._request(text, source, target, context, detect);
      if (result.text !== undefined) return result;
      this.lastError = result.error;
      if (!result.retry) break;
    }
    return null;
  }

  async _request(text, source, target, context, detect) {
    const body = { text: [text], target_lang: language(target).target };
    if (!detect) body.source_lang = language(source).source;
    if (context && this.cfg.useContext) body.context = context;
    if (this.modelType) body.model_type = this.modelType;
    // Il glossario ha solo italiano e inglese: con le altre coppie DeepL rifiuterebbe la richiesta.
    if (this.glossaryId && GLOSSARY_PAIRS.has(`${detect ? '' : source}>${target}`)) body.glossary_id = this.glossaryId;
    try {
      const res = await fetch(`${this.base}/v2/translate`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json();
        const first = data.translations?.[0];
        return { text: first?.text ?? '', detected: first?.detected_source_language };
      }
      await res.body?.cancel().catch(() => {});
      if (res.status === 456) {
        this.quotaExhausted = true;
        return { error: t('Quota DeepL esaurita'), retry: false };
      }
      if (res.status === 400 && (this.modelType || this.glossaryId)) {
        // Un'opzione non è accettata dal piano: si riprova senza, per non fermare le traduzioni.
        warn('DeepL: richiesta rifiutata, disattivo model_type e glossario');
        this.modelType = null;
        if (this.glossaryId) this.glossaryNote = t('glossario rifiutato da DeepL, ignorato');
        this.glossaryId = null;
        return { error: t('Richiesta rifiutata (400)'), retry: true };
      }
      return { error: t('Errore HTTP {status}', { status: res.status }), retry: res.status === 429 || res.status >= 500 };
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { error: timedOut ? t('Timeout oltre 3 s') : t('Rete: {error}', { error: err.message }), retry: true };
    }
  }

  async refreshUsage() {
    if (!this.cfg.apiKey) return;
    try {
      const res = await fetch(`${this.base}/v2/usage`, {
        headers: this.headers, signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 403) this.lastError = t('Chiave DeepL rifiutata: controlla chiave ed endpoint');
        return;
      }
      const data = await res.json();
      this.characterCount = data.character_count ?? null;
      this.characterLimit = data.character_limit ?? null;
      // La quota può tornare disponibile con il nuovo periodo o un cambio di piano.
      if (this.characterLimit && this.characterCount < this.characterLimit) this.quotaExhausted = false;
    } catch { /* riprova al prossimo giro */ }
  }

  // Crea il glossario (entrambe le direzioni), sostituendo quello creato dall'avvio precedente.
  async syncGlossary(filePath) {
    this.glossaryId = null;
    if (!this.cfg.apiKey) { this.glossaryNote = t('chiave DeepL mancante'); return this.glossaryNote; }
    let pairs = [];
    try {
      pairs = parseGlossaryCsv(fs.readFileSync(filePath, 'utf8'));
    } catch { /* file facoltativo */ }

    try {
      const list = await fetch(`${this.base}/v3/glossaries`, {
        headers: this.headers, signal: AbortSignal.timeout(5000),
      });
      if (!list.ok) {
        await list.body?.cancel().catch(() => {});
        this.glossaryNote = t('glossari non disponibili con questo piano (HTTP {status}): file ignorato', { status: list.status });
        warn(`DeepL: ${this.glossaryNote}`);
        return this.glossaryNote;
      }
      const { glossaries = [] } = await list.json();
      for (const old of glossaries.filter((g) => g.name === GLOSSARY_NAME)) {
        const del = await fetch(`${this.base}/v3/glossaries/${old.glossary_id}`, {
          method: 'DELETE', headers: this.headers, signal: AbortSignal.timeout(5000),
        });
        await del.body?.cancel().catch(() => {});
      }
      if (!pairs.length) { this.glossaryNote = t('nessun termine nel glossario'); return this.glossaryNote; }

      const toTsv = (from, to) => pairs.map((p) => `${p[from]}\t${p[to]}`).join('\n');
      const res = await fetch(`${this.base}/v3/glossaries`, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          name: GLOSSARY_NAME,
          dictionaries: GLOSSARY_DIRECTIONS.map((d) => ({
            source_lang: d.from, target_lang: d.to, entries: toTsv(...d.cols), entries_format: 'tsv',
          })),
        }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        this.glossaryNote = t('creazione del glossario rifiutata (HTTP {status}): file ignorato', { status: res.status });
        warn(`DeepL: ${this.glossaryNote}`);
        return this.glossaryNote;
      }
      this.glossaryId = (await res.json()).glossary_id;
      this.glossaryNote = t('{n} termini attivi', { n: pairs.length });
      log(`DeepL: glossario con ${pairs.length} termini`);
    } catch (err) {
      this.glossaryNote = t('glossario non caricato: {error}', { error: err.message });
      warn(`DeepL: ${this.glossaryNote}`);
    }
    return this.glossaryNote;
  }

  status() {
    const { characterCount: used, characterLimit: limit } = this;
    const remaining = limit != null && used != null ? Math.max(0, limit - used) : null;
    return {
      configured: !!this.cfg.apiKey,
      avgMs: this.avgMs,
      used,
      limit,
      remaining,
      low: remaining != null && limit > 0 && remaining / limit < 0.1,
      quotaExhausted: this.quotaExhausted,
      lastError: this.lastError,
      glossary: this.glossaryNote,
    };
  }

  shutdown() {
    clearInterval(this.usageTimer);
  }
}
