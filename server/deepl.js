// Traduzione con DeepL: timeout di 3 s, un solo nuovo tentativo, poi si prosegue senza traduzione.
import fs from 'node:fs';
import { log, warn } from './log.js';

const TIMEOUT_MS = 3000;
const MAX_IN_FLIGHT = 6; // coda limitata: se DeepL è bloccato non si accumula nulla
const USAGE_EVERY_MS = 60000;
const GLOSSARY_NAME = 'duetto';
const TARGET = { it: 'EN-GB', en: 'IT' };
const SOURCE = { it: 'IT', en: 'EN' };

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
    this.glossaryNote = 'nessun glossario';
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
    if (!this.cfg.apiKey) return { ok: false, message: 'Chiave mancante' };
    try {
      const res = await fetch(`${this.base}/v2/usage`, { headers: this.headers, signal: AbortSignal.timeout(6000) });
      if (res.status === 403) return { ok: false, message: 'Chiave rifiutata da DeepL' };
      if (!res.ok) return { ok: false, message: `Errore HTTP ${res.status}` };
      const data = await res.json();
      this.characterCount = data.character_count ?? null;
      this.characterLimit = data.character_limit ?? null;
      const left = Math.max(0, (data.character_limit ?? 0) - (data.character_count ?? 0));
      return { ok: true, message: `Chiave valida, ${left.toLocaleString('it-IT')} caratteri disponibili` };
    } catch (err) {
      return { ok: false, message: `Nessuna risposta: ${err.message}` };
    }
  }

  get headers() {
    return { Authorization: `DeepL-Auth-Key ${this.cfg.apiKey}`, 'Content-Type': 'application/json' };
  }

  // Restituisce il testo tradotto, oppure null: chi chiama continua con il solo originale.
  async translate(text, sourceLang, context) {
    if (!this.cfg.apiKey || this.quotaExhausted) return null;
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.lastError = 'Troppe traduzioni in coda';
      return null;
    }
    this.inFlight += 1;
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await this._request(text, sourceLang, context);
        if (result.text !== undefined) {
          const ms = Date.now() - started;
          this.avgMs = this.avgMs ? Math.round(this.avgMs * 0.9 + ms * 0.1) : ms;
          this.lastError = '';
          return result.text;
        }
        this.lastError = result.error;
        if (!result.retry) break;
      }
      warn(`DeepL: ${this.lastError}`);
      return null;
    } finally {
      this.inFlight -= 1;
    }
  }

  async _request(text, sourceLang, context) {
    const body = { text: [text], source_lang: SOURCE[sourceLang], target_lang: TARGET[sourceLang] };
    if (context && this.cfg.useContext) body.context = context;
    if (this.modelType) body.model_type = this.modelType;
    if (this.glossaryId) body.glossary_id = this.glossaryId;
    try {
      const res = await fetch(`${this.base}/v2/translate`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.translations?.[0]?.text ?? '' };
      }
      await res.body?.cancel().catch(() => {});
      if (res.status === 456) {
        this.quotaExhausted = true;
        return { error: 'Quota DeepL esaurita', retry: false };
      }
      if (res.status === 400 && (this.modelType || this.glossaryId)) {
        // Un'opzione non è accettata dal piano: si riprova senza, per non fermare le traduzioni.
        warn('DeepL: richiesta rifiutata, disattivo model_type e glossario');
        this.modelType = null;
        if (this.glossaryId) this.glossaryNote = 'glossario rifiutato da DeepL, ignorato';
        this.glossaryId = null;
        return { error: 'Richiesta rifiutata (400)', retry: true };
      }
      return { error: `Errore HTTP ${res.status}`, retry: res.status === 429 || res.status >= 500 };
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { error: timedOut ? 'Timeout oltre 3 s' : `Rete: ${err.message}`, retry: true };
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
        if (res.status === 403) this.lastError = 'Chiave DeepL rifiutata: controlla chiave ed endpoint';
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
    if (!this.cfg.apiKey) { this.glossaryNote = 'chiave DeepL mancante'; return this.glossaryNote; }
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
        this.glossaryNote = `glossari non disponibili con questo piano (HTTP ${list.status}): file ignorato`;
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
      if (!pairs.length) { this.glossaryNote = 'nessun termine nel glossario'; return this.glossaryNote; }

      const toTsv = (from, to) => pairs.map((p) => `${p[from]}\t${p[to]}`).join('\n');
      const res = await fetch(`${this.base}/v3/glossaries`, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          name: GLOSSARY_NAME,
          dictionaries: [
            { source_lang: 'it', target_lang: 'en', entries: toTsv(0, 1), entries_format: 'tsv' },
            { source_lang: 'en', target_lang: 'it', entries: toTsv(1, 0), entries_format: 'tsv' },
          ],
        }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        this.glossaryNote = `creazione del glossario rifiutata (HTTP ${res.status}): file ignorato`;
        warn(`DeepL: ${this.glossaryNote}`);
        return this.glossaryNote;
      }
      this.glossaryId = (await res.json()).glossary_id;
      this.glossaryNote = `${pairs.length} termini attivi`;
      log(`DeepL: glossario con ${pairs.length} termini`);
    } catch (err) {
      this.glossaryNote = `glossario non caricato: ${err.message}`;
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
