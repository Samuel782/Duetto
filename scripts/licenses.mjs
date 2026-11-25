// Licenze complete delle librerie Rust distribuite ed elenco dei componenti (SBOM, CycloneDX).
// Scrive dist/LICENSES.rust.txt e dist/Duetto-<versione>-sbom.cdx.json.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'];
const found = new Map();
for (const target of TARGETS) {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target,
    '--features', 'custom-protocol', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml')], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  // Solo ciò che finisce nel programma: le dipendenze di compilazione e di prova no.
  const queue = [meta.resolve.root];
  const seen = new Set(queue);
  while (queue.length) {
    for (const d of nodes.get(queue.pop()).deps) {
      if (d.dep_kinds.some((k) => k.kind === null) && !seen.has(d.pkg)) { seen.add(d.pkg); queue.push(d.pkg); }
    }
  }
  for (const id of seen) {
    const p = packages.get(id);
    if (p.source) found.set(`${p.name} ${p.version}`, p);
  }
}
const list = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const isLicence = (f) => /^(licen[cs]e|copying|copyright|notice|unlicense)/i.test(f);
const texts = new Map(); // testo -> librerie che lo usano
const without = [];
for (const p of list) {
  const dir = path.dirname(p.manifest_path);
  const files = fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isFile() && isLicence(e.name)) return [e.name];
    if (e.isDirectory() && /^licenses?$/i.test(e.name)) return fs.readdirSync(path.join(dir, e.name)).map((f) => path.join(e.name, f));
    return [];
  }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  if (!files.length) { without.push(p); continue; }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!texts.has(text)) texts.set(text, new Set());
    texts.get(text).add(`${p.name} ${p.version}`);
  }
}
const line = '='.repeat(80);
const head = list.map((p) => `${p.name} ${p.version} | ${p.license || 'see text'} | https://crates.io/crates/${p.name}/${p.version}`).join('\n');
const bare = without.map((p) => `${p.name} ${p.version} | ${p.license} | ${p.authors.join(', ') || 'authors listed in the project'} | ${p.repository || ''}`).join('\n');
// Testo di MIT per chi pubblica la libreria senza il file della licenza.
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const out = [
  `Rust libraries included in Duetto ${version}`, '',
  'The source code of every version, including those under MPL 2.0, is available unmodified at the address shown.', '', head, '',
  line, 'Libraries published without a licence file: licence, authors and project', line, '', bare, '',
  'Those offered under the MIT licence are used under these terms:', '', MIT, '',
  ...[...texts].flatMap(([text, who]) => [line, [...who].join(', '), line, '', text, '']),
].join('\n');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'LICENSES.rust.txt'), out);

const ref = `pkg:generic/duetto@${version}`;
const purl = (p) => `pkg:cargo/${p.name}@${p.version}`;
const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { 'bom-ref': ref, type: 'application', name: 'duetto', version, licenses: [{ license: { id: 'PolyForm-Noncommercial-1.0.0' } }] },
  },
  components: list.map((p) => ({
    'bom-ref': purl(p), type: 'library', name: p.name, version: p.version, purl: purl(p),
    ...(p.license && { licenses: [{ expression: p.license.replace(/\s*\/\s*/g, ' OR ') }] }),
  })),
};
fs.writeFileSync(path.join(dist, `Duetto-${version}-sbom.cdx.json`), `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`${list.length} librerie, ${texts.size} testi; senza file: ${without.map((p) => `${p.name} (${p.license})`).join(', ') || 'nessuna'}`);
