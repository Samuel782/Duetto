// Controlla se su GitHub c'è una versione più nuova di Duetto. Solo un avviso con il link:
// l'installazione automatica sul Mac richiederebbe la firma Apple.
// La richiesta va a GitHub e non contiene nulla dell'utente oltre all'indirizzo IP.
import { log } from './log.js';

export const RELEASES_API = 'https://api.github.com/repos/Samuel782/Duetto/releases/latest';

// Confronta versioni come 1.10.0 e 1.9.2, numero per numero. Ignora una "v" iniziale.
export function isNewer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// Restituisce { version, url } se c'è una versione più nuova, altrimenti null. Non lancia mai errori.
export async function checkForUpdate(current, api = RELEASES_API) {
  try {
    const res = await fetch(api, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Duetto' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const release = await res.json();
    if (release.draft || release.prerelease || !release.tag_name) return null;
    const version = String(release.tag_name).replace(/^v/i, '');
    if (!isNewer(version, current)) return null;
    const url = /^https:\/\/github\.com\//.test(release.html_url) ? release.html_url : 'https://github.com/Samuel782/Duetto/releases';
    log(`Aggiornamento disponibile: ${version}`);
    return { version, url };
  } catch {
    return null; // senza rete o con GitHub irraggiungibile non succede nulla
  }
}
