// Microfono catturato dal sistema (CoreAudio, WASAPI), senza passare dal motore web: WebKit perde
// audio a ogni apertura e rallenta con la finestra nascosta.
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample,
};
use std::{
    sync::{atomic::{AtomicBool, Ordering::Relaxed}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

const RATE: f64 = 16000.0;
const FRAME: usize = 1600; // 100 ms
const SILENT_CHANNEL: f32 = 0.0005;
const RETRY: Duration = Duration::from_secs(2);
const ZEROS: f64 = 16.0; // metà larghezza del filtro, in passaggi per lo zero

/// Riporta qualsiasi frequenza a 16 kHz con un filtro che elimina ciò che diventerebbe un falso suono.
pub struct Resampler {
    step: f64,
    cut: f64,
    half: f64,
    buf: Vec<f32>,
    pos: f64, // prossimo campione da produrre, in unità di `buf`
}

impl Resampler {
    pub fn new(rate: f64) -> Self {
        let cut = (RATE / rate).min(1.0) * if rate > RATE { 0.92 } else { 1.0 };
        let half = (ZEROS / cut).ceil();
        // Il silenzio iniziale fa uscire il primo campione senza aspettare.
        Self { step: rate / RATE, cut, half, buf: vec![0.0; half as usize], pos: half }
    }

    pub fn push(&mut self, input: &[f32], mut out: impl FnMut(f32)) {
        self.buf.extend_from_slice(input);
        while self.pos + self.half < self.buf.len() as f64 {
            let first = (self.pos - self.half).ceil().max(0.0) as usize;
            let last = (self.pos + self.half).floor() as usize;
            let mut sum = 0.0;
            for i in first..=last {
                let x = i as f64 - self.pos;
                let a = std::f64::consts::PI * x * self.cut;
                let sinc = if a.abs() < 1e-9 { 1.0 } else { a.sin() / a };
                let window = 0.5 + 0.5 * (std::f64::consts::PI * x / self.half).cos();
                sum += self.buf[i] as f64 * sinc * window * self.cut;
            }
            out(sum as f32);
            self.pos += self.step;
        }
        let drop = ((self.pos - self.half).floor().max(0.0) as usize).min(self.buf.len());
        self.buf.drain(..drop);
        self.pos -= drop as f64;
    }
}

/// Media dei soli canali con segnale, tra i primi due: come fa la pagina con Electron.
pub fn mix(data: &[f32], channels: usize) -> Vec<f32> {
    let used = channels.clamp(1, 2);
    let active: Vec<usize> = (0..used)
        .filter(|c| data.iter().skip(*c).step_by(channels).any(|s| s.abs() > SILENT_CHANNEL))
        .collect();
    let active = if active.is_empty() { vec![0] } else { active };
    data.chunks_exact(channels)
        .map(|f| active.iter().map(|c| f[*c]).sum::<f32>() / active.len() as f32)
        .collect()
}

pub enum Event {
    Devices(Vec<(String, String)>),
    Opened(String),
    Failed(String),
    Frame { peak: f32, pcm: Vec<u8> },
}

/// Ingresso voluto: stringa vuota per quello predefinito del sistema.
#[derive(Clone, Default)]
pub struct Wanted(Arc<Mutex<(String, u64)>>);

impl Wanted {
    pub fn set(&self, name: String) {
        let mut w = self.0.lock().unwrap();
        *w = (name, w.1 + 1);
    }
    fn get(&self) -> (String, u64) { self.0.lock().unwrap().clone() }
}

fn name_of(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_default()
}

/// Coppie identificativo e nome: due schede uguali hanno lo stesso nome ma identificativi diversi.
fn inputs() -> Vec<(String, String)> {
    cpal::default_host().input_devices().into_iter().flatten()
        .filter_map(|d| Some((d.id().ok()?.to_string(), name_of(&d))))
        .collect()
}

fn find(id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if id.is_empty() { return host.default_input_device(); }
    host.input_devices().ok()?.find(|d| d.id().is_ok_and(|x| x.to_string() == id))
}

fn build<T: SizedSample>(dev: &cpal::Device, cfg: &cpal::StreamConfig, tx: mpsc::SyncSender<Vec<f32>>, lost: Arc<AtomicBool>) -> Result<cpal::Stream, cpal::Error>
where
    f32: FromSample<T>,
{
    let channels = cfg.channels as usize;
    dev.build_input_stream(
        *cfg,
        move |data: &[T], _: &_| {
            let floats: Vec<f32> = data.iter().map(|s| f32::from_sample(*s)).collect();
            let _ = tx.try_send(mix(&floats, channels)); // mai bloccare il filo audio
        },
        // Avvisi passeggeri (un salto di buffer, l'avvio dell'ingresso) non sono una perdita:
        // se i dati smettono davvero di arrivare se ne accorge il controllo in run().
        move |e| {
            eprintln!("microfono: {e:?}");
            if e.kind() == cpal::ErrorKind::DeviceNotAvailable || e.kind() == cpal::ErrorKind::StreamInvalidated { lost.store(true, Relaxed); }
        },
        None,
    )
}

/// Permesso del microfono: None finché la persona non risponde. Va ottenuto prima di toccare
/// CoreAudio, che altrimenti resta bloccato per tutta l'attesa.
#[cfg(target_os = "macos")]
fn permission() -> Option<bool> {
    use objc2::{class, msg_send};
    use objc2_foundation::ns_string;
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    static ASKED: AtomicBool = AtomicBool::new(false);
    let audio = ns_string!("soun");
    let status: isize = unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: audio] };
    match status {
        3 => Some(true),
        0 => {
            if !ASKED.swap(true, Relaxed) {
                let done = block2::RcBlock::new(|_: objc2::runtime::Bool| {});
                let _: () = unsafe { msg_send![class!(AVCaptureDevice), requestAccessForMediaType: audio, completionHandler: &*done] };
            }
            None
        }
        _ => Some(false),
    }
}
#[cfg(not(target_os = "macos"))]
fn permission() -> Option<bool> { Some(true) }

struct Open {
    _stream: cpal::Stream,
    rx: mpsc::Receiver<Vec<f32>>,
    lost: Arc<AtomicBool>,
    resampler: Resampler,
    samples: Vec<u8>,
    peak: f32,
    heard: Instant,
}

fn open(name: &str) -> Result<(Open, String), String> {
    let dev = find(name).ok_or("ingresso non trovato")?;
    let label = name_of(&dev);
    let supported = dev.default_input_config().map_err(|e| e.to_string())?;
    let cfg = supported.config();
    let (tx, rx) = mpsc::sync_channel(512);
    let lost = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&dev, &cfg, tx, lost.clone()),
        SampleFormat::I16 => build::<i16>(&dev, &cfg, tx, lost.clone()),
        SampleFormat::I32 => build::<i32>(&dev, &cfg, tx, lost.clone()),
        SampleFormat::U16 => build::<u16>(&dev, &cfg, tx, lost.clone()),
        other => return Err(format!("formato {other} non gestito")),
    }.map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    let o = Open {
        _stream: stream, rx, lost,
        resampler: Resampler::new(cfg.sample_rate as f64),
        samples: Vec::with_capacity(FRAME * 2), peak: 0.0, heard: Instant::now(),
    };
    Ok((o, label))
}

/// Gira per tutta la vita dell'app: riapre l'ingresso se cambia, si perde o smette di dare dati.
pub fn run(wanted: Wanted, mut emit: impl FnMut(Event)) {
    let mut current: Option<Open> = None;
    let mut seen = 0;
    let mut retry_at = Instant::now();
    let mut list: Vec<(String, String)> = Vec::new();
    let mut told = None;
    loop {
        let state = permission();
        if state == Some(true) { break; }
        if told != Some(state) {
            told = Some(state);
            emit(Event::Failed(if state.is_none() { "in attesa del permesso" } else { "permesso negato" }.into()));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let (list_tx, list_rx) = mpsc::channel();
    // Elenco su un filo a parte: interrogare il sistema può richiedere tempo.
    std::thread::spawn(move || loop {
        if list_tx.send(inputs()).is_err() { return; }
        std::thread::sleep(RETRY);
    });
    loop {
        if let Some(l) = list_rx.try_iter().last() {
            if l != list { list = l; emit(Event::Devices(list.clone())); }
        }
        let (name, version) = wanted.get();
        if version == 0 { std::thread::sleep(Duration::from_millis(20)); continue; }
        if version != seen { seen = version; current = None; retry_at = Instant::now(); }
        if current.as_ref().is_some_and(|o| o.lost.load(Relaxed) || o.heard.elapsed() > RETRY) {
            current = None;
            retry_at = Instant::now() + Duration::from_millis(200);
            emit(Event::Failed("ingresso perso".into()));
        }
        let Some(o) = current.as_mut() else {
            if Instant::now() >= retry_at {
                match open(&name) {
                    Ok((o, label)) => { current = Some(o); emit(Event::Opened(label)); }
                    Err(e) => { emit(Event::Failed(e)); retry_at = Instant::now() + RETRY; }
                }
            } else {
                std::thread::sleep(Duration::from_millis(20));
            }
            continue;
        };
        let Ok(chunk) = o.rx.recv_timeout(Duration::from_millis(50)) else { continue };
        o.heard = Instant::now();
        let (samples, peak) = (&mut o.samples, &mut o.peak);
        o.resampler.push(&chunk, |s| {
            let s = s.clamp(-1.0, 1.0);
            *peak = peak.max(s.abs());
            samples.extend_from_slice(&((s * if s < 0.0 { 32768.0 } else { 32767.0 }) as i16).to_le_bytes());
            if samples.len() == FRAME * 2 {
                emit(Event::Frame { peak: *peak, pcm: std::mem::take(samples) });
                *peak = 0.0;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: f64, hz: f64, seconds: f64) -> Vec<f32> {
        (0..(rate * seconds) as usize).map(|i| (i as f64 * hz * std::f64::consts::TAU / rate).sin() as f32 * 0.5).collect()
    }
    fn convert(rate: f64, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        for c in input.chunks(chunk) { r.push(c, |s| out.push(s)); }
        out
    }
    fn rms(v: &[f32]) -> f32 { (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt() }

    #[test]
    fn durata_corretta() {
        for rate in [8000.0, 16000.0, 44100.0, 48000.0, 96000.0] {
            let n = convert(rate, &tone(rate, 440.0, 2.0), 512).len() as i64;
            assert!((n - 32000).abs() < 50, "{rate}: {n}");
        }
    }
    #[test]
    fn voce_intatta_e_ultrasuoni_eliminati() {
        for rate in [44100.0, 48000.0, 96000.0] {
            let pass = convert(rate, &tone(rate, 1000.0, 1.0), 512);
            assert!((rms(&pass[500..15000]) - 0.3535).abs() < 0.01);
            let stop = convert(rate, &tone(rate, 10000.0, 1.0), 512);
            assert!(rms(&stop[500..15000]) < 0.002);
        }
    }
    #[test]
    fn i_blocchi_non_cambiano_il_risultato() {
        let t = tone(44100.0, 700.0, 1.0);
        let (a, b) = (convert(44100.0, &t, 37), convert(44100.0, &t, 512));
        assert!(a.len().abs_diff(b.len()) <= 1);
        assert!(a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-5)); // solo arrotondamenti
    }
    #[test]
    fn canali_muti_esclusi() {
        assert_eq!(mix(&[0.0, 0.8, 0.0, 0.6], 2), vec![0.8, 0.6]);
        assert_eq!(mix(&[0.2, 0.4], 2), vec![0.3]);
        assert_eq!(mix(&[0.5, 0.0, 0.9, 0.9], 4), vec![0.5]); // solo i primi due canali
        assert_eq!(mix(&[0.0, 0.0], 2), vec![0.0]);
    }
}
