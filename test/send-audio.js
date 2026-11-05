#!/usr/bin/env node
// Invia un file audio al server come se fosse il microfono, a velocità reale.
// Uso: npm run send-audio -- file.wav [--loop] [--drop-at 30 --drop-for 10] [--port 8787]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const FRAME_BYTES = 3200; // 100 ms a 16 kHz, 16 bit, mono
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--drop') && args[i - 1] !== '--port');
if (!file) {
  console.error('Uso: npm run send-audio -- file.wav [--loop] [--drop-at 30 --drop-for 10] [--port 8787]');
  process.exit(1);
}
const loop = args.includes('--loop');
const port = option('port', process.env.PORT || '8787');
const dropAt = Number(option('drop-at', 0));
const dropFor = Number(option('drop-for', 10));

// Estrae il PCM se il WAV è già 16 kHz, 16 bit, mono. Altrimenti restituisce null.
function readPcm(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format = { code: data.readUInt16LE(offset + 8), channels: data.readUInt16LE(offset + 10), rate: data.readUInt32LE(offset + 12), bits: data.readUInt16LE(offset + 22) };
    } else if (id === 'data') {
      const ok = format && format.code === 1 && format.channels === 1 && format.rate === 16000 && format.bits === 16;
      return ok ? data.subarray(offset + 8, offset + 8 + size) : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function loadAudio(filePath) {
  const direct = readPcm(filePath);
  if (direct) return direct;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-'));
  const target = path.join(dir, 'audio.wav');
  try {
    try {
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', filePath, target], { stdio: 'ignore' });
    } catch {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target], { stdio: 'ignore' });
    }
    const pcm = readPcm(target);
    if (!pcm) throw new Error('conversione non valida');
    return pcm;
  } catch (err) {
    console.error(`Non riesco a convertire ${filePath}: serve afconvert (macOS) o ffmpeg. ${err.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pcm = loadAudio(file);
console.log(`Audio: ${(pcm.length / 32000).toFixed(1)} s`);

const ws = new WebSocket(`ws://localhost:${port}/ws`);
ws.on('error', (err) => { console.error(`Server non raggiungibile: ${err.message}`); process.exit(1); });
ws.on('close', () => { console.log('Connessione chiusa'); process.exit(0); });
ws.on('open', () => {
  const started = Date.now();
  let offset = 0;
  let sent = 0;
  let dropped = false;
  // Tempi calcolati sull'inizio: il ritmo resta reale anche se un timer ritarda.
  const tick = () => {
    if (dropAt && !dropped && Date.now() - started >= dropAt * 1000) {
      dropped = true;
      console.log(`Simulo una caduta di rete di ${dropFor} s`);
      ws.send(JSON.stringify({ cmd: 'simulateDrop', seconds: dropFor }));
    }
    if (offset + FRAME_BYTES > pcm.length) {
      if (!loop) {
        console.log('Fine del file');
        ws.send(JSON.stringify({ cmd: 'pause' }));
        setTimeout(() => ws.close(), 500);
        return;
      }
      offset = 0;
    }
    ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
    offset += FRAME_BYTES;
    sent += 1;
    setTimeout(tick, Math.max(0, started + sent * 100 - Date.now()));
  };
  tick();
});
