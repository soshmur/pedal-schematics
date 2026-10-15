//! Pedal Schematics native engine.
//!
//! Runs the circuit simulation on the audio interface's own driver (ASIO on
//! Windows), so the guitar-to-ears delay is a few milliseconds instead of the
//! browser's 20+. The schematic page stays the control panel: it connects to
//! ws://127.0.0.1:8790 and sends the pedal's netlist, knob changes, bypass and
//! levels; this program sends back CPU load and input/output levels.
//!
//!   pedal-engine            start with the first ASIO device (or the system default)
//!   pedal-engine --list     show audio drivers and devices
//!   pedal-engine --device "Yamaha"   pick a device by (part of) its name
//!   pedal-engine --buffer 64         ask the driver for a buffer size

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use crossbeam_channel::{Receiver, Sender};
use pedal_engine::dsp::Processor;
use pedal_engine::engine::Netlist;
use serde::Deserialize;
use serde_json::json;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 8790;

/// Messages from the page.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum PageMsg {
    #[serde(rename = "netlist")]
    Netlist { net: Netlist },
    #[serde(rename = "bypass")]
    Bypass { on: bool },
    #[serde(rename = "oversample")]
    Oversample { factor: usize },
    #[serde(rename = "inputVolts")]
    InputVolts { v: f64 },
    #[serde(rename = "outputGain")]
    OutputGain { g: f64 },
    #[serde(rename = "run")]
    Run { on: bool },
}

/// Control for the audio thread.
enum Ctrl { Net(Box<Netlist>), Bypass(bool), Os(usize), InVolts(f64), OutGain(f64), Run(bool) }

#[derive(Clone, Copy, Default)]
struct Report {
    load: f64, failures: u64, steps: u64, iterations: u64, ok: bool, in_peak: f32, out_peak: f32,
    os: usize, fs: f64, underruns: u32, block: usize, running: bool, has_circuit: bool,
}

struct Args { list: bool, port: u16, device: Option<String>, buffer: Option<u32>, host: Option<String>, null_audio: bool }

fn parse_args() -> Args {
    let mut a = Args { list: false, port: DEFAULT_PORT, device: None, buffer: None, host: None, null_audio: false };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--list" | "-l" => a.list = true,
            "--port" => a.port = it.next().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT),
            "--device" | "-d" => a.device = it.next(),
            "--buffer" | "-b" => a.buffer = it.next().and_then(|v| v.parse().ok()),
            "--host" => a.host = it.next(),
            "--null-audio" => a.null_audio = true,
            "--help" | "-h" => {
                println!("pedal-engine {VERSION}\n  --list            show audio drivers and devices\n  --device NAME     use the device whose name contains NAME\n  --host asio|wasapi|default\n  --buffer FRAMES   ask the driver for this buffer size\n  --port N          WebSocket port (default {DEFAULT_PORT})");
                std::process::exit(0);
            }
            other => eprintln!("ignoring unknown option {other}"),
        }
    }
    a
}

fn pick_host(want: &Option<String>) -> cpal::Host {
    let hosts = cpal::available_hosts();
    if let Some(w) = want {
        if let Some(id) = hosts.iter().find(|h| h.name().to_lowercase().contains(&w.to_lowercase())) {
            if let Ok(h) = cpal::host_from_id(*id) { return h; }
        }
        eprintln!("audio driver type '{w}' not available, using the default");
    }
    // prefer ASIO: it's the low-latency path on Windows
    if let Some(id) = hosts.iter().find(|h| h.name() == "ASIO") {
        if let Ok(h) = cpal::host_from_id(*id) {
            if h.devices().map(|mut d| d.next().is_some()).unwrap_or(false) { return h; }
        }
    }
    cpal::default_host()
}

fn list_devices() {
    for id in cpal::available_hosts() {
        println!("{}:", id.name());
        let Ok(host) = cpal::host_from_id(id) else { continue };
        if let Ok(devs) = host.devices() {
            for d in devs {
                let name = d.name().unwrap_or_default();
                let i = d.default_input_config().map(|c| format!("in {} ch {:?} {}Hz", c.channels(), c.sample_format(), c.sample_rate().0)).unwrap_or_else(|_| "no input".into());
                let o = d.default_output_config().map(|c| format!("out {} ch {:?} {}Hz", c.channels(), c.sample_format(), c.sample_rate().0)).unwrap_or_else(|_| "no output".into());
                println!("  {name}  ({i}; {o})");
            }
        }
    }
}

fn main() {
    let args = parse_args();
    if args.list { list_devices(); return; }
    println!("Pedal Schematics engine {VERSION}");
    if args.null_audio { run_null_audio(args.port); return; }

    let host = pick_host(&args.host);
    let (in_dev, out_dev) = match pick_devices(&host, &args.device) {
        Ok(d) => d,
        Err(e) => { fail(&e); }
    };
    let out_cfg = match out_dev.default_output_config() { Ok(c) => c, Err(e) => fail(&format!("output: {e}")) };
    let in_cfg = match in_dev.default_input_config() { Ok(c) => c, Err(e) => fail(&format!("input: {e} (does the driver use 24-bit packed samples? try --host wasapi)")) };
    let sr = out_cfg.sample_rate();
    let buffer = match args.buffer { Some(b) => cpal::BufferSize::Fixed(b), None => cpal::BufferSize::Default };
    let in_conf = cpal::StreamConfig { channels: in_cfg.channels(), sample_rate: sr, buffer_size: buffer };
    let out_conf = cpal::StreamConfig { channels: out_cfg.channels(), sample_rate: sr, buffer_size: buffer };
    let in_name = in_dev.name().unwrap_or_default();
    let out_name = out_dev.name().unwrap_or_default();
    println!("Driver: {}", host.id().name());
    println!("Input:  {in_name} ({} ch, {:?})", in_conf.channels, in_cfg.sample_format());
    println!("Output: {out_name} ({} ch, {:?})", out_conf.channels, out_cfg.sample_format());
    println!("Sample rate: {} Hz", sr.0);

    let (ctrl_tx, ctrl_rx) = crossbeam_channel::unbounded::<Ctrl>();
    let (stats_tx, stats_rx) = crossbeam_channel::bounded::<Report>(16);
    let (prod, cons) = rtrb::RingBuffer::<f32>::new(16384);
    let block = Arc::new(AtomicU32::new(0));

    let input = match in_cfg.sample_format() {
        SampleFormat::F32 => build_input::<f32>(&in_dev, &in_conf, prod),
        SampleFormat::I32 => build_input::<i32>(&in_dev, &in_conf, prod),
        SampleFormat::I16 => build_input::<i16>(&in_dev, &in_conf, prod),
        SampleFormat::F64 => build_input::<f64>(&in_dev, &in_conf, prod),
        f => fail(&format!("input sample format {f:?} isn't supported")),
    };
    let state = AudioState::new(sr.0 as f64, cons, ctrl_rx, stats_tx, block.clone());
    let output = match out_cfg.sample_format() {
        SampleFormat::F32 => build_output::<f32>(&out_dev, &out_conf, state),
        SampleFormat::I32 => build_output::<i32>(&out_dev, &out_conf, state),
        SampleFormat::I16 => build_output::<i16>(&out_dev, &out_conf, state),
        SampleFormat::F64 => build_output::<f64>(&out_dev, &out_conf, state),
        f => fail(&format!("output sample format {f:?} isn't supported")),
    };
    let input = input.unwrap_or_else(|e| fail(&format!("couldn't open the input: {e}")));
    let output = output.unwrap_or_else(|e| fail(&format!("couldn't open the output: {e}")));
    input.play().unwrap_or_else(|e| fail(&format!("couldn't start the input: {e}")));
    output.play().unwrap_or_else(|e| fail(&format!("couldn't start the output: {e}")));

    // report the buffer size once the driver has run a few blocks
    std::thread::sleep(Duration::from_millis(300));
    let b = block.load(Ordering::Relaxed);
    if b > 0 {
        let ms = b as f64 / sr.0 as f64 * 1000.0;
        println!("Buffer: {b} samples ({ms:.1} ms). Expected guitar-to-ears delay: about {:.0} ms.", ms * 3.0 + 1.5);
    }

    let info = json!({
        "type": "hello", "version": VERSION, "driver": host.id().name(), "input": in_name, "output": out_name,
        "sampleRate": sr.0, "inChannels": in_conf.channels, "outChannels": out_conf.channels,
    });
    serve(args.port, ctrl_tx, stats_rx, info, block, sr.0);
    drop(input);
    drop(output);
}

/// Test mode without a sound card: a timer thread plays a plucked note into the
/// engine every two seconds at real-time pace and throws the output away.
fn run_null_audio(port: u16) {
    const SR: u32 = 48000;
    const BLOCK: usize = 64;
    let (ctrl_tx, ctrl_rx) = crossbeam_channel::unbounded::<Ctrl>();
    let (stats_tx, stats_rx) = crossbeam_channel::bounded::<Report>(16);
    let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(16384);
    let block = Arc::new(AtomicU32::new(BLOCK as u32));
    let mut st = AudioState::new(SR as f64, cons, ctrl_rx, stats_tx, block.clone());
    std::thread::spawn(move || {
        let mut n: u64 = 0;
        let start = Instant::now();
        let mut sink = 0.0f32;
        loop {
            for _ in 0..BLOCK {
                let t = (n % (2 * SR as u64)) as f32 / SR as f32;
                let s = 0.3 * (-t * 3.0).exp() * (2.0 * std::f32::consts::PI * 110.0 * t).sin();
                let _ = prod.push(s);
                n += 1;
            }
            st.render(&mut |_, y| sink += y.abs(), BLOCK);
            let due = start + Duration::from_secs_f64(n as f64 / SR as f64);
            if let Some(d) = due.checked_duration_since(Instant::now()) { std::thread::sleep(d); }
        }
    });
    let info = json!({ "type": "hello", "version": VERSION, "driver": "Null (test)", "input": "test tone", "output": "none",
        "sampleRate": SR, "inChannels": 1, "outChannels": 2 });
    serve(port, ctrl_tx, stats_rx, info, block, SR);
}

fn fail(msg: &str) -> ! {
    eprintln!("\nError: {msg}");
    eprintln!("Run `pedal-engine --list` to see the available devices.");
    pause_on_windows();
    std::process::exit(1);
}

fn pause_on_windows() {
    if cfg!(windows) {
        eprintln!("Press Enter to close.");
        let mut s = String::new();
        let _ = std::io::stdin().read_line(&mut s);
    }
}

fn pick_devices(host: &cpal::Host, want: &Option<String>) -> Result<(cpal::Device, cpal::Device), String> {
    let matches = |d: &cpal::Device| match want {
        Some(w) => d.name().map(|n| n.to_lowercase().contains(&w.to_lowercase())).unwrap_or(false),
        None => true,
    };
    if host.id().name() == "ASIO" {
        // one ASIO driver handles both directions
        let dev = host.devices().map_err(|e| e.to_string())?.find(|d| matches(d)).ok_or("no matching ASIO device")?;
        let dev2 = dev.clone();
        return Ok((dev, dev2));
    }
    let input = match want {
        Some(_) => host.input_devices().map_err(|e| e.to_string())?.find(|d| matches(d)),
        None => host.default_input_device(),
    }.ok_or("no input device found")?;
    let output = match want {
        Some(_) => host.output_devices().map_err(|e| e.to_string())?.find(|d| matches(d)),
        None => host.default_output_device(),
    }.ok_or("no output device found")?;
    Ok((input, output))
}

fn build_input<T>(dev: &cpal::Device, conf: &cpal::StreamConfig, mut prod: rtrb::Producer<f32>) -> Result<cpal::Stream, cpal::BuildStreamError>
where T: SizedSample, f32: FromSample<T> {
    let ch = conf.channels as usize;
    dev.build_input_stream::<T, _, _>(conf, move |data: &[T], _| {
        // sum every input at full level: a guitar on either jack arrives the same
        for frame in data.chunks(ch) {
            let s: f32 = frame.iter().map(|&v| f32::from_sample(v)).sum();
            let _ = prod.push(s);
        }
    }, |e| eprintln!("input error: {e}"), None)
}

struct AudioState {
    proc_: Processor, cons: rtrb::Consumer<f32>, ctrl: Receiver<Ctrl>, stats: Sender<Report>, block: Arc<AtomicU32>,
    running: bool, primed: bool, underruns: u32, busy: Duration, frames: usize, in_peak: f32, out_peak: f32, sr: f64,
}

impl AudioState {
    fn new(sr: f64, cons: rtrb::Consumer<f32>, ctrl: Receiver<Ctrl>, stats: Sender<Report>, block: Arc<AtomicU32>) -> Self {
        AudioState { proc_: Processor::new(sr), cons, ctrl, stats, block, running: false, primed: false, underruns: 0,
            busy: Duration::ZERO, frames: 0, in_peak: 0.0, out_peak: 0.0, sr }
    }

    fn controls(&mut self) {
        while let Ok(c) = self.ctrl.try_recv() {
            match c {
                Ctrl::Net(n) => self.proc_.set_netlist(*n),
                Ctrl::Bypass(b) => self.proc_.bypass = b,
                Ctrl::Os(f) => self.proc_.set_oversample(f),
                Ctrl::InVolts(v) => self.proc_.input_volts = v,
                Ctrl::OutGain(g) => self.proc_.output_gain = g,
                Ctrl::Run(r) => { self.running = r; self.primed = false; }
            }
        }
    }

    /// Fill one output block of `frames` mono samples.
    fn render(&mut self, out: &mut dyn FnMut(usize, f32), frames: usize) {
        let t0 = Instant::now();
        self.block.store(frames as u32, Ordering::Relaxed);
        self.controls();
        let avail = self.cons.slots();
        if !self.primed {
            // wait for one block of input so a late input callback never starves us
            if avail >= frames { self.primed = true; } else { for i in 0..frames { out(i, 0.0); } return; }
        }
        // keep the queue short: anything over two blocks is just added delay
        if avail > 2 * frames { let _ = self.cons.read_chunk(avail - frames).map(|c| c.commit_all()); }
        let live = self.running && self.proc_.circuit.is_some();
        for i in 0..frames {
            let x = match self.cons.pop() { Ok(v) => v, Err(_) => { self.underruns += 1; self.primed = false; 0.0 } };
            self.in_peak = self.in_peak.max(x.abs());
            let y = if live { self.proc_.process(x) } else { 0.0 };
            self.out_peak = self.out_peak.max(y.abs());
            out(i, y);
        }
        self.busy += t0.elapsed();
        self.frames += frames;
        if self.frames as f64 >= self.sr * 0.25 {
            let span = self.frames as f64 / self.sr;
            let c = self.proc_.circuit.as_ref();
            let st = c.map(|c| c.stats).unwrap_or_default();
            let _ = self.stats.try_send(Report {
                load: self.busy.as_secs_f64() / span, failures: st.failures, steps: st.steps, iterations: st.iterations,
                ok: c.map(|c| c.dc_converged).unwrap_or(true), in_peak: self.in_peak, out_peak: self.out_peak,
                os: self.proc_.os, fs: c.map(|c| c.fs).unwrap_or(0.0), underruns: self.underruns, block: frames,
                running: self.running, has_circuit: c.is_some(),
            });
            if let Some(c) = self.proc_.circuit.as_mut() { c.stats = Default::default(); }
            self.busy = Duration::ZERO; self.frames = 0; self.in_peak = 0.0; self.out_peak = 0.0; self.underruns = 0;
        }
    }
}

fn build_output<T>(dev: &cpal::Device, conf: &cpal::StreamConfig, mut st: AudioState) -> Result<cpal::Stream, cpal::BuildStreamError>
where T: SizedSample + FromSample<f32> {
    let ch = conf.channels as usize;
    dev.build_output_stream::<T, _, _>(conf, move |data: &mut [T], _| {
        let frames = data.len() / ch;
        st.render(&mut |i, y| { for c in 0..ch { data[i * ch + c] = T::from_sample(y); } }, frames);
    }, |e| eprintln!("output error: {e}"), None)
}

// ---------------------------------------------------------------- page link

fn origin_ok(origin: &str) -> bool {
    origin.is_empty()
        || origin.starts_with("http://localhost:") || origin == "http://localhost"
        || origin.starts_with("http://127.0.0.1:") || origin == "http://127.0.0.1"
        || origin == "https://soshmur.github.io"
}

fn serve(port: u16, ctrl: Sender<Ctrl>, stats: Receiver<Report>, info: serde_json::Value, block: Arc<AtomicU32>, sr: u32) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => fail(&format!("port {port} is busy ({e}). Is the engine already running?")),
    };
    println!("\nReady. Open the Pedal Schematics page and choose \"Native app (ASIO)\" as the input.");
    println!("(listening on ws://127.0.0.1:{port}; close this window to stop)\n");
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let (ctrl, stats, info, block) = (ctrl.clone(), stats.clone(), info.clone(), block.clone());
        std::thread::spawn(move || {
            if let Err(e) = client(stream, &ctrl, &stats, info, &block, sr) { eprintln!("page link: {e}"); }
            let _ = ctrl.send(Ctrl::Run(false)); // page closed: go quiet
            println!("Page disconnected.");
        });
    }
}

fn client(stream: TcpStream, ctrl: &Sender<Ctrl>, stats: &Receiver<Report>, mut info: serde_json::Value, block: &AtomicU32, sr: u32) -> Result<(), String> {
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).unwrap_or("");
        if origin_ok(origin) { Ok(resp) } else {
            eprintln!("refused a connection from {origin}");
            let mut r = ErrorResponse::new(Some("origin not allowed".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(r)
        }
    };
    let mut ws: WebSocket<TcpStream> = tungstenite::accept_hdr(stream, check).map_err(|e| e.to_string())?;
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(20))).map_err(|e| e.to_string())?;
    ws.get_ref().set_nodelay(true).ok();
    info["block"] = json!(block.load(Ordering::Relaxed));
    ws.send(Message::text(info.to_string())).map_err(|e| e.to_string())?;
    println!("Page connected.");
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => match serde_json::from_str::<PageMsg>(&t) {
                Ok(m) => {
                    let c = match m {
                        PageMsg::Netlist { net } => Ctrl::Net(Box::new(net)),
                        PageMsg::Bypass { on } => Ctrl::Bypass(on),
                        PageMsg::Oversample { factor } => Ctrl::Os(factor),
                        PageMsg::InputVolts { v } => Ctrl::InVolts(v),
                        PageMsg::OutputGain { g } => Ctrl::OutGain(g),
                        PageMsg::Run { on } => Ctrl::Run(on),
                    };
                    let _ = ctrl.send(c);
                }
                Err(e) => eprintln!("ignored a message from the page: {e}"),
            },
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
        let mut last = None;
        while let Ok(r) = stats.try_recv() { last = Some(r); }
        if let Some(r) = last {
            let msg = json!({
                "type": "stats", "load": r.load, "failures": r.failures, "steps": r.steps,
                "itsPerSample": if r.steps > 0 { r.iterations as f64 / r.steps as f64 } else { 0.0 },
                "ok": r.ok, "os": r.os, "fs": r.fs, "inPeak": r.in_peak, "outPeak": r.out_peak,
                "underruns": r.underruns, "block": r.block, "sampleRate": sr, "running": r.running, "hasCircuit": r.has_circuit,
            });
            if let Err(e) = ws.send(Message::text(msg.to_string())) {
                return match e { tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => Ok(()), e => Err(e.to_string()) };
            }
        }
    }
}
