//! The processing chain around the circuit, ported from `js/worklet.js` and the
//! output stage of `js/audio.js`: input scaling, oversampling with a 4th-order
//! Butterworth decimation filter, DC blocker, monitor gain and a peak limiter.

use crate::engine::{Circuit, Netlist};

/// 2nd-order low-pass section (RBJ cookbook).
#[derive(Clone, Copy, Default)]
pub struct Biquad { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z1: f64, z2: f64 }

impl Biquad {
    pub fn lowpass(fc: f64, fs: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * fc / fs;
        let (c, s) = (w.cos(), w.sin());
        let a = s / (2.0 * q);
        let a0 = 1.0 + a;
        Biquad { b0: (1.0 - c) / 2.0 / a0, b1: (1.0 - c) / a0, b2: (1.0 - c) / 2.0 / a0, a1: -2.0 * c / a0, a2: (1.0 - a) / a0, z1: 0.0, z2: 0.0 }
    }
    #[inline]
    pub fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Peak limiter: instant-ish attack, slow release, ceiling at -3 dBFS
/// (stands in for the browser's DynamicsCompressor limiter).
pub struct Limiter { env: f64, att: f64, rel: f64, ceil: f64 }

impl Limiter {
    pub fn new(sr: f64) -> Self {
        Limiter { env: 0.0, att: (-1.0 / (0.002 * sr)).exp(), rel: (-1.0 / (0.1 * sr)).exp(), ceil: 10f64.powf(-3.0 / 20.0) }
    }
    #[inline]
    pub fn run(&mut self, x: f64) -> f64 {
        let a = x.abs();
        let k = if a > self.env { self.att } else { self.rel };
        self.env = a + k * (self.env - a);
        let g = if self.env > self.ceil { self.ceil / self.env } else { 1.0 };
        (x * g).clamp(-1.0, 1.0)
    }
}

pub struct Processor {
    pub sample_rate: f64,
    pub circuit: Option<Circuit>,
    net: Option<Netlist>,
    pub bypass: bool,
    pub os: usize,
    pub input_volts: f64,
    pub output_gain: f64,
    prev_in: f64,
    dc_x: f64,
    dc_y: f64,
    aa: [Biquad; 2],
    limiter: Limiter,
    pub last_error: Option<String>,
}

impl Processor {
    pub fn new(sample_rate: f64) -> Self {
        Processor {
            sample_rate, circuit: None, net: None, bypass: false, os: 2, input_volts: 0.4, output_gain: 0.25,
            prev_in: 0.0, dc_x: 0.0, dc_y: 0.0, aa: [Biquad::default(); 2], limiter: Limiter::new(sample_rate), last_error: None,
        }
    }

    pub fn set_netlist(&mut self, net: Netlist) {
        self.net = Some(net);
        self.build();
    }

    pub fn set_oversample(&mut self, f: usize) {
        self.os = f.clamp(1, 4);
        self.build();
    }

    fn build(&mut self) {
        let Some(net) = &self.net else { return };
        let fs = self.sample_rate * self.os as f64;
        let res = match &mut self.circuit {
            Some(c) if c.fs == fs => c.update(net),
            _ => Circuit::new(net, fs).map(|c| { self.circuit = Some(c); }),
        };
        self.last_error = res.err();
        self.aa = [Biquad::lowpass(self.sample_rate * 0.45, fs, 0.5412), Biquad::lowpass(self.sample_rate * 0.45, fs, 1.3066)];
    }

    /// One audio sample in (digital full scale), one out (digital, after level + limiter).
    #[inline]
    pub fn process(&mut self, input: f32) -> f32 {
        let x = input as f64 * self.input_volts;
        let os = self.os;
        let y = match &mut self.circuit {
            Some(c) if !self.bypass => {
                if os == 1 {
                    c.step(x)
                } else {
                    // linear-interpolated upsampling, filtered decimation
                    let mut y = 0.0;
                    for k in 1..=os {
                        let xi = self.prev_in + (x - self.prev_in) * (k as f64 / os as f64);
                        let s = c.step(xi);
                        let s0 = self.aa[0].run(s);
                        y = self.aa[1].run(s0);
                    }
                    y
                }
            }
            _ => x,
        };
        self.prev_in = x;
        // DC blocker (~5 Hz) so a pedal's bias voltage never reaches the speakers
        let yy = y - self.dc_x + 0.9993 * self.dc_y;
        self.dc_x = y;
        self.dc_y = yy;
        self.limiter.run(yy * self.output_gain) as f32
    }
}
