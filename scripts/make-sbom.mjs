// Elenco dei componenti distribuiti (SBOM, formato CycloneDX): librerie, Electron e ciò che contiene.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron'); // percorso dell'eseguibile
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sbom = JSON.parse(execFileSync(npm, ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], { cwd: root, encoding: 'utf8' }));
const versions = JSON.parse(execFileSync(electron, ['-p', 'JSON.stringify(process.versions)'], {
  encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
}));

// Revisione di FFmpeg indicata nel file DEPS di ogni versione di Chromium. Va aggiornata con Electron.
const FFMPEG_REVISIONS = { '156.0.8078.100': '9db86ce5b5b454dfc96c435f9f0723012980c37f' };
const ffmpeg = FFMPEG_REVISIONS[versions.chrome];
if (!ffmpeg) throw new Error(`Manca la revisione di FFmpeg per Chromium ${versions.chrome}: cercala nel suo file DEPS (ffmpeg_revision)`);

const component = (name, v, purl, licence) => ({
  'bom-ref': purl, type: 'framework', name, version: v, purl, ...(licence && { licenses: [{ license: { id: licence } }] }),
});
const bundled = [
  component('electron', versions.electron, `pkg:npm/electron@${versions.electron}`, 'MIT'),
  component('chromium', versions.chrome, `pkg:generic/chromium@${versions.chrome}`),
  component('ffmpeg', ffmpeg, `pkg:generic/ffmpeg@${ffmpeg}?vcs_url=git%2Bhttps://chromium.googlesource.com/chromium/third_party/ffmpeg.git%40${ffmpeg}`, 'LGPL-2.1-or-later'),
  component('node', versions.node, `pkg:generic/node@${versions.node}`),
];
sbom.components = [...(sbom.components || []), ...bundled];
const [electronRef, ...inside] = bundled.map((c) => c['bom-ref']);
sbom.dependencies = sbom.dependencies || [];
const own = sbom.dependencies.find((d) => d.ref === sbom.metadata.component['bom-ref']);
if (own) own.dependsOn = [...(own.dependsOn || []), electronRef];
sbom.dependencies.push({ ref: electronRef, dependsOn: inside }, ...inside.map((ref) => ({ ref, dependsOn: [] })));

const file = path.join(root, 'dist', `Duetto-${version}-sbom.cdx.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`${path.relative(root, file)}: ${sbom.components.length} componenti`);
