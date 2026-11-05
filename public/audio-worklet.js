// Converte l'ingresso in PCM 16 bit mono 16 kHz e invia blocchi da 100 ms con il livello di picco.
const FRAME_SAMPLES = 1600;
const SILENT_CHANNEL = 0.0005;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.count = 0;
    this.peak = 0;
    this.step = sampleRate / 16000; // 1 quando il browser fornisce già 16 kHz
    this.position = 0;
    this.previous = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const size = channels[0].length;

    // Un'uscita aux può arrivare su un solo lato: media dei soli canali con segnale.
    const active = channels.filter((c) => {
      for (let i = 0; i < size; i++) if (Math.abs(c[i]) > SILENT_CHANNEL) return true;
      return false;
    });
    const sources = active.length ? active : [channels[0]];

    for (let i = 0; i < size; i++) {
      let sample = 0;
      for (const c of sources) sample += c[i];
      sample /= sources.length;

      if (this.step === 1) {
        this.push(sample);
      } else {
        // Ricampionamento lineare, se il browser non concede 16 kHz.
        while (this.position <= 1) {
          this.push(this.previous + (sample - this.previous) * this.position);
          this.position += this.step;
        }
        this.position -= 1;
        this.previous = sample;
      }
    }
    return true;
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const abs = Math.abs(clamped);
    if (abs > this.peak) this.peak = abs;
    this.frame[this.count++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.count === FRAME_SAMPLES) {
      const pcm = this.frame.buffer;
      this.port.postMessage({ pcm, peak: this.peak }, [pcm]);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.count = 0;
      this.peak = 0;
    }
  }
}

registerProcessor('capture', Capture);
