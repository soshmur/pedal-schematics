//! Circuit simulator: a line-by-line port of `js/engine.js` (transient part).
//!
//! Modified nodal analysis with Newton-Raphson for the nonlinear parts and
//! trapezoidal companion models for capacitors (backward Euler for op-amp
//! internal poles). The browser keeps doing the DC readout and AC sweep for the
//! editor; this side only has to run the audio, so it implements
//! `dcOperatingPoint`, `update` and `step`.
//!
//! Keep it in step with the JS file: `tests/matches_js.rs` runs both on every
//! pedal and fails if their outputs drift apart.

use serde::Deserialize;
use serde_json::Value;

pub const VT: f64 = 0.025852; // thermal voltage at ~27 °C
const GMIN: f64 = 1e-12;
const MAX_EXP: f64 = 80.0;
const CLAMP_G: f64 = 1e3;
const CLAMP_K: f64 = 8.0;

// ---------------------------------------------------------------- netlist

#[derive(Debug, Clone, Deserialize)]
pub struct Netlist {
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    pub output: i64,
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Element {
    #[serde(rename = "type")]
    pub kind: String,
    pub nodes: Vec<i64>,
    #[serde(rename = "R", default)]
    pub r: Option<f64>,
    #[serde(rename = "C", default)]
    pub c: Option<f64>,
    #[serde(rename = "V", default)]
    pub v: Option<f64>,
    #[serde(default)]
    pub model: Option<Value>,
}

impl Netlist {
    /// Same signature means state can be carried over on a value change.
    pub fn signature(&self) -> String {
        let mut s = format!("{}|{}|", self.node_count, self.output);
        for (i, e) in self.elements.iter().enumerate() {
            if i > 0 {
                s.push(';');
            }
            s.push_str(&e.kind);
            s.push(':');
            let parts: Vec<String> = e.nodes.iter().map(|n| n.to_string()).collect();
            s.push_str(&parts.join(","));
        }
        s
    }
}

/// A number from a model object, or `default` when missing / not a number
/// (JS destructuring defaults only apply to `undefined`).
fn num(model: &Option<Value>, key: &str, default: f64) -> f64 {
    model.as_ref().and_then(|m| m.get(key)).and_then(|v| v.as_f64()).unwrap_or(default)
}
/// Like JS `m.key || default`: also replaces 0.
fn num_or(model: &Option<Value>, key: &str, default: f64) -> f64 {
    let v = num(model, key, 0.0);
    if v == 0.0 || v.is_nan() { default } else { v }
}

// ---------------------------------------------------------------- devices

#[derive(Clone)]
struct Res { a: isize, b: isize, g: f64 }
#[derive(Clone)]
struct Cap { a: isize, b: isize, c: f64, v: f64, i: f64, geq: f64, be: bool }
#[derive(Clone)]
struct Vsrc { p: isize, m: isize, v: f64, row: isize }
#[derive(Clone)]
struct Input { p: isize, m: isize, g: f64 }
#[derive(Clone)]
struct Diode { a: isize, k: isize, is: f64, vt: f64, vcrit: f64, vd: f64 }
#[derive(Clone)]
struct Bjt { c: isize, b: isize, e: isize, is: f64, bf: f64, br: f64, pol: f64, vcrit: f64, vbe: f64, vbc: f64 }
#[derive(Clone)]
struct Fet { d: isize, g: isize, s: isize, vth: f64, kp: f64, lambda: f64, vgs: f64, vds: f64 }
#[derive(Clone)]
struct Opamp { p: isize, n: isize, o: isize, z: isize, gm: f64, imax: f64, clamp_g: f64, vmid: f64, vsat: f64, row: isize, vzl: Option<f64> }
#[derive(Clone)]
struct Cmp { p: isize, n: isize, o: isize, vmid: f64, vsat: f64, row: isize, held: f64 }
#[derive(Clone)]
struct BbdModel { stages: f64, fc: f64, v_oct: f64, swing: f64, vbias: f64 }
#[derive(Clone)]
struct Bbd { inp: isize, out: isize, cv: isize, m: BbdModel, row: isize, held: f64, phase: f64, buf: Vec<f32>, w: usize, delay: f64 }

fn safe_exp(x: f64) -> f64 {
    if x > MAX_EXP { MAX_EXP.exp() * (1.0 + x - MAX_EXP) } else { x.exp() }
}

fn rail_clamp(v: f64, lim: f64, clamp_g: f64) -> (f64, f64) {
    let sp = |u: f64| if u > 30.0 { u } else { u.exp().ln_1p() };
    let sg = |u: f64| 1.0 / (1.0 + (-u).exp());
    let a = CLAMP_K * (v - lim);
    let b = -CLAMP_K * (v + lim);
    let i = clamp_g * (sp(a) - sp(b)) / CLAMP_K;
    let g = clamp_g * (sg(a) + sg(b)) + 1e-12;
    (i, g)
}

fn pnjlim(vnew: f64, vold: f64, vt: f64, vcrit: f64) -> f64 {
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * vt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vt;
            return if arg > 0.0 { vold + vt * arg.ln() } else { vcrit };
        }
        return vt * (vnew / vt).ln();
    }
    vnew
}

/// Drain current and its derivatives (gm, gds) for vds >= 0 (square law).
fn mosfet_id(f: &Fet, vgs: f64, vds: f64) -> (f64, f64, f64) {
    let vov = vgs - f.vth;
    if vov <= 0.0 { return (0.0, 0.0, 0.0); }
    let cl = 1.0 + f.lambda * vds;
    if vds < vov {
        let core = vov * vds - vds * vds / 2.0;
        (f.kp * core * cl, f.kp * vds * cl, f.kp * (vov - vds) * cl + f.kp * core * f.lambda)
    } else {
        (f.kp / 2.0 * vov * vov * cl, f.kp * vov * cl, f.kp / 2.0 * vov * vov * f.lambda)
    }
}

fn bbd_clock(m: &BbdModel, cv: f64) -> f64 {
    let f = m.fc * 2f64.powf((cv - 4.5) / m.v_oct);
    (m.fc / 16.0).max(f).min(2e6)
}

fn bbd_len(m: &BbdModel, fs: f64) -> usize {
    let max_delay = m.stages / (2.0 * (m.fc / 16.0));
    (max_delay * fs).ceil() as usize + 4
}

// ---------------------------------------------------------------- linear algebra

/// Dense LU with partial pivoting; solution left in `b`. Overwrites `a`.
fn lu_solve(a: &mut [f64], b: &mut [f64], n: usize) -> bool {
    for k in 0..n {
        let mut p = k;
        let mut max = a[k * n + k].abs();
        for i in (k + 1)..n {
            let v = a[i * n + k].abs();
            if v > max { max = v; p = i; }
        }
        if max < 1e-300 { return false; }
        if p != k {
            for j in k..n { a.swap(k * n + j, p * n + j); }
            b.swap(k, p);
        }
        let pivot = a[k * n + k];
        for i in (k + 1)..n {
            let f = a[i * n + k] / pivot;
            if f == 0.0 { continue; }
            a[i * n + k] = 0.0;
            for j in (k + 1)..n { a[i * n + j] -= f * a[k * n + j]; }
            b[i] -= f * b[k];
        }
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for j in (i + 1)..n { s -= a[i * n + j] * b[j]; }
        b[i] = s / a[i * n + i];
    }
    true
}

/// Sparse LU with a fixed pivot order, picked once from a real Jacobian.
struct SparseLu { n: usize, perm: Vec<usize>, rows: Vec<Vec<usize>>, cols: Vec<Vec<usize>>, m: Vec<f64>, y: Vec<f64> }

impl SparseLu {
    fn new(a: &[f64], pattern: &[u8], n: usize) -> Self {
        let mut m = a.to_vec();
        let mut perm: Vec<usize> = (0..n).collect();
        for k in 0..n {
            let mut p = k;
            let mut max = m[k * n + k].abs();
            for i in (k + 1)..n {
                let v = m[i * n + k].abs();
                if v > max { max = v; p = i; }
            }
            if p != k {
                for j in 0..n { m.swap(k * n + j, p * n + j); }
                perm.swap(k, p);
            }
            let piv = m[k * n + k];
            if piv == 0.0 { continue; }
            for i in (k + 1)..n {
                let f = m[i * n + k] / piv;
                if f != 0.0 {
                    for j in k..n { m[i * n + j] -= f * m[k * n + j]; }
                }
            }
        }
        let mut pp = vec![0u8; n * n];
        for r in 0..n { for j in 0..n { pp[r * n + j] = pattern[perm[r] * n + j]; } }
        for k in 0..n { pp[k * n + k] = 1; }
        let mut rows = Vec::with_capacity(n);
        let mut cols = Vec::with_capacity(n);
        for k in 0..n {
            let r: Vec<usize> = ((k + 1)..n).filter(|&i| pp[i * n + k] != 0).collect();
            let c: Vec<usize> = ((k + 1)..n).filter(|&j| pp[k * n + j] != 0).collect();
            for &i in &r { for &j in &c { pp[i * n + j] = 1; } }
            rows.push(r);
            cols.push(c);
        }
        SparseLu { n, perm, rows, cols, m: vec![0.0; n * n], y: vec![0.0; n] }
    }

    fn solve(&mut self, a: &[f64], b: &mut [f64]) -> bool {
        let n = self.n;
        let (m, y) = (&mut self.m, &mut self.y);
        for r in 0..n {
            let src = self.perm[r] * n;
            m[r * n..r * n + n].copy_from_slice(&a[src..src + n]);
            y[r] = b[self.perm[r]];
        }
        for k in 0..n {
            let piv = m[k * n + k];
            if !(piv.abs() > 1e-280) { return false; }
            let kn = k * n;
            for &i in &self.rows[k] {
                let in_ = i * n;
                let f = m[in_ + k] / piv;
                if f == 0.0 { continue; }
                for &j in &self.cols[k] { m[in_ + j] -= f * m[kn + j]; }
                y[i] -= f * y[k];
            }
        }
        for k in (0..n).rev() {
            let mut sum = y[k];
            let kn = k * n;
            for &j in &self.cols[k] { sum -= m[kn + j] * y[j]; }
            y[k] = sum / m[kn + k];
            if !y[k].is_finite() { return false; }
        }
        b.copy_from_slice(y);
        true
    }
}

// ---------------------------------------------------------------- circuit

#[derive(Default, Clone, Copy, Debug)]
pub struct Stats { pub steps: u64, pub iterations: u64, pub failures: u64 }

#[derive(Default)]
struct Saved { x: Vec<f64>, cv: Vec<f64>, ci: Vec<f64>, j: Vec<f64> }

pub struct Circuit {
    pub fs: f64,
    trap: bool,
    abstol: f64,
    pub stats: Stats,
    pub dc_converged: bool,
    signature: String,
    big_n: usize,
    out: isize,
    res: Vec<Res>, caps: Vec<Cap>, vsrc: Vec<Vsrc>, diodes: Vec<Diode>, bjts: Vec<Bjt>,
    opamps: Vec<Opamp>, cmps: Vec<Cmp>, bbds: Vec<Bbd>, fets: Vec<Fet>, input: Option<Input>,
    n: usize,
    pub x: Vec<f64>,
    a: Vec<f64>, b: Vec<f64>, base: Vec<f64>, x_old: Vec<f64>,
    nonlinear: bool,
    sparse: Option<SparseLu>,
    rhs_buf: Vec<f64>,
    saved: Saved,
    vin_prev: Option<f64>,
}

impl Circuit {
    pub fn new(net: &Netlist, fs: f64) -> Result<Self, String> {
        let mut c = Circuit {
            fs, trap: true, abstol: 1e-5, stats: Stats::default(), dc_converged: false,
            signature: String::new(), big_n: 0, out: -1,
            res: vec![], caps: vec![], vsrc: vec![], diodes: vec![], bjts: vec![], opamps: vec![],
            cmps: vec![], bbds: vec![], fets: vec![], input: None, n: 0, x: vec![], a: vec![], b: vec![], base: vec![],
            x_old: vec![], nonlinear: false, sparse: None, rhs_buf: vec![], saved: Saved::default(), vin_prev: None,
        };
        c.build(net, false)?;
        c.dc_operating_point();
        Ok(c)
    }

    /// Replace component values. Keeps state if the topology is unchanged.
    pub fn update(&mut self, net: &Netlist) -> Result<(), String> {
        if net.signature() == self.signature {
            self.build(net, true)
        } else {
            self.build(net, false)?;
            self.dc_operating_point();
            Ok(())
        }
    }

    pub fn node_voltage(&self, node: usize) -> f64 {
        if node == 0 { 0.0 } else { self.x[node - 1] }
    }

    fn build(&mut self, net: &Netlist, keep_state: bool) -> Result<(), String> {
        let big_n = net.node_count.saturating_sub(1);
        self.signature = net.signature();
        self.big_n = big_n;
        self.out = net.output as isize - 1;
        let idx = |node: i64| node as isize - 1;
        let mut extra = big_n as isize;
        let old_caps = std::mem::take(&mut self.caps);
        let old_bbds = if keep_state { std::mem::take(&mut self.bbds) } else { vec![] };
        let old_cmps = if keep_state { std::mem::take(&mut self.cmps) } else { vec![] };
        self.res.clear(); self.vsrc.clear(); self.diodes.clear(); self.bjts.clear();
        self.opamps.clear(); self.bbds.clear(); self.cmps.clear(); self.fets.clear();
        self.input = None;
        for e in &net.elements {
            let nd: Vec<isize> = e.nodes.iter().map(|&n| idx(n)).collect();
            let node = |i: usize| -> Result<isize, String> {
                nd.get(i).copied().ok_or_else(|| format!("{} element is missing node {}", e.kind, i))
            };
            match e.kind.as_str() {
                "R" => self.res.push(Res { a: node(0)?, b: node(1)?, g: 1.0 / e.r.unwrap_or(1e-3).max(1e-3) }),
                "C" => self.caps.push(Cap { a: node(0)?, b: node(1)?, c: e.c.unwrap_or(0.0), v: 0.0, i: 0.0, geq: 0.0, be: false }),
                "V" => { self.vsrc.push(Vsrc { p: node(0)?, m: node(1)?, v: e.v.unwrap_or(0.0), row: extra }); extra += 1; }
                "VIN" => {
                    let r = e.r.filter(|&r| r != 0.0).unwrap_or(1.0);
                    self.input = Some(Input { p: node(0)?, m: node(1)?, g: 1.0 / r.max(1e-3) });
                }
                "D" => {
                    let is = num(&e.model, "Is", 1e-14);
                    let vt = num(&e.model, "n", 1.0) * VT;
                    self.diodes.push(Diode { a: node(0)?, k: node(1)?, is, vt, vcrit: vt * (vt / (std::f64::consts::SQRT_2 * is)).ln(), vd: 0.0 });
                }
                "Q" => {
                    let is = num(&e.model, "Is", 1e-14);
                    self.bjts.push(Bjt {
                        c: node(0)?, b: node(1)?, e: node(2)?, is,
                        bf: num(&e.model, "bf", 100.0), br: num(&e.model, "br", 1.0), pol: num_or(&e.model, "pol", 1.0),
                        vcrit: VT * (VT / (std::f64::consts::SQRT_2 * is)).ln(), vbe: 0.0, vbc: 0.0,
                    });
                }
                "M" => {
                    let (d, g, sn) = (node(0)?, node(1)?, node(2)?);
                    self.fets.push(Fet { d, g, s: sn, vth: num(&e.model, "vth", 2.0), kp: num(&e.model, "kp", 0.1),
                        lambda: num(&e.model, "lambda", 0.02), vgs: 0.0, vds: 0.0 });
                    // body diode: anode at the source, cathode at the drain
                    let is = num(&e.model, "Is", 1e-12);
                    let vt = num(&e.model, "n", 1.25) * VT;
                    self.diodes.push(Diode { a: sn, k: d, is, vt, vcrit: vt * (vt / (std::f64::consts::SQRT_2 * is)).ln(), vd: 0.0 });
                }
                "OA" => {
                    let a = num(&e.model, "A", 1e5);
                    let gbw = num(&e.model, "gbw", 1e6);
                    let slew = num(&e.model, "slew", 1e6);
                    let z = extra; extra += 1;
                    let cz = a / (2.0 * std::f64::consts::PI * gbw);
                    self.caps.push(Cap { a: z, b: -1, c: cz, v: 0.0, i: 0.0, geq: 0.0, be: true });
                    self.opamps.push(Opamp {
                        p: node(0)?, n: node(1)?, o: node(2)?, z, gm: a, imax: slew * cz, clamp_g: CLAMP_G.max(20.0 * slew * cz),
                        vmid: num(&e.model, "vmid", 4.5), vsat: num(&e.model, "vsat", 3.5), row: extra, vzl: None,
                    });
                    extra += 1;
                }
                "CMP" => {
                    let vmid = num(&e.model, "vmid", 4.5);
                    let held = old_cmps.get(self.cmps.len()).map(|c| c.held).unwrap_or(vmid);
                    self.cmps.push(Cmp { p: node(0)?, n: node(1)?, o: node(2)?, vmid, vsat: num(&e.model, "vsat", 3.5), row: extra, held });
                    extra += 1;
                }
                "BBD" => {
                    let m = BbdModel {
                        stages: num(&e.model, "stages", 1024.0), fc: num(&e.model, "fc", 1e5),
                        v_oct: num_or(&e.model, "vOct", 2.0), swing: num_or(&e.model, "swing", 1.4),
                        vbias: num(&e.model, "vbias", 4.5),
                    };
                    let mut b = Bbd { inp: node(0)?, out: node(1)?, cv: node(2)?, m, row: extra, held: 0.0, phase: 0.0, buf: vec![], w: 0, delay: 0.0 };
                    if let Some(old) = old_bbds.get(self.bbds.len()) {
                        b.held = old.held;
                        if !old.buf.is_empty() { b.buf = old.buf.clone(); b.w = old.w; b.phase = old.phase; b.delay = old.delay; }
                    }
                    extra += 1;
                    self.bbds.push(b);
                }
                other => return Err(format!("Unknown element type {other}")),
            }
        }
        let n = extra as usize;
        if keep_state && self.n == n && !self.x.is_empty() {
            for (i, c) in self.caps.iter_mut().enumerate() {
                if let Some(o) = old_caps.get(i) { c.v = o.v; c.i = o.i; }
            }
        } else {
            self.x = vec![0.0; n];
        }
        self.n = n;
        self.a = vec![0.0; n * n];
        self.b = vec![0.0; n];
        self.base = vec![0.0; n * n];
        self.x_old = vec![0.0; n];
        if self.rhs_buf.len() != n { self.rhs_buf = vec![0.0; n]; }
        self.nonlinear = !(self.diodes.is_empty() && self.bjts.is_empty() && self.opamps.is_empty() && self.fets.is_empty());
        self.sparse = None;
        // a value edit can change a delay chip's size: resize its line, keep its output
        let fs = self.fs;
        for i in 0..self.bbds.len() {
            let need = bbd_len(&self.bbds[i].m, fs);
            if self.bbds[i].buf.len() != need {
                let had = !self.bbds[i].buf.is_empty();
                let xin = if self.bbds[i].inp >= 0 { self.x[self.bbds[i].inp as usize] } else { 0.0 };
                let v = if had { self.bbds[i].held } else if xin != 0.0 && !xin.is_nan() { xin } else { 4.5 };
                let held = if self.bbds[i].held != 0.0 { self.bbds[i].held } else { v };
                let cv = if self.bbds[i].cv >= 0 {
                    let c = self.x[self.bbds[i].cv as usize];
                    if c != 0.0 && !c.is_nan() { c } else { 4.5 }
                } else { 4.5 };
                bbd_reset(&mut self.bbds[i], v, cv, fs);
                self.bbds[i].held = held;
            }
        }
        self.stamp_linear(false);
        Ok(())
    }

    /// Constant part of the matrix. dc=true leaves capacitors open.
    fn stamp_linear(&mut self, dc: bool) {
        let n = self.n;
        let a = &mut self.base;
        a.iter_mut().for_each(|v| *v = 0.0);
        let add = |a: &mut Vec<f64>, i: isize, j: isize, v: f64| {
            if i >= 0 && j >= 0 { a[i as usize * n + j as usize] += v; }
        };
        let cond = |a: &mut Vec<f64>, p: isize, q: isize, g: f64| {
            add(a, p, p, g); add(a, q, q, g); add(a, p, q, -g); add(a, q, p, -g);
        };
        for i in 0..self.big_n { a[i * n + i] += GMIN; }
        for r in &self.res { cond(a, r.a, r.b, r.g); }
        let fs = self.fs;
        for c in self.caps.iter_mut() {
            c.geq = if dc { 0.0 } else { (if self.trap && !c.be { 2.0 } else { 1.0 }) * c.c * fs };
            if !dc { cond(a, c.a, c.b, c.geq); }
        }
        if let Some(inp) = &self.input { cond(a, inp.p, inp.m, inp.g); }
        for v in &self.vsrc {
            add(a, v.p, v.row, 1.0); add(a, v.m, v.row, -1.0);
            add(a, v.row, v.p, 1.0); add(a, v.row, v.m, -1.0);
        }
        for o in &self.opamps {
            add(a, o.z, o.z, 1.0);
            add(a, o.o, o.row, 1.0);
            add(a, o.row, o.o, 1.0);
        }
        for c in &self.cmps { add(a, c.o, c.row, 1.0); add(a, c.row, c.o, 1.0); }
        for b in &self.bbds {
            add(a, b.out, b.row, 1.0); add(a, b.row, b.out, 1.0);
            if dc { add(a, b.row, b.inp, -1.0); }
        }
    }

    fn pattern(&self) -> Vec<u8> {
        let n = self.n;
        let mut p = vec![0u8; n * n];
        for i in 0..n * n { if self.base[i] != 0.0 { p[i] = 1; } }
        for i in 0..n { p[i * n + i] = 1; }
        let mut mark = |list: &[isize]| {
            for &i in list { for &j in list { if i >= 0 && j >= 0 { p[i as usize * n + j as usize] = 1; } } }
        };
        for c in &self.caps { mark(&[c.a, c.b]); }
        for d in &self.diodes { mark(&[d.a, d.k]); }
        for q in &self.bjts { mark(&[q.c, q.b, q.e]); }
        for f in &self.fets { mark(&[f.d, f.g, f.s]); }
        let set = |p: &mut Vec<u8>, i: isize, j: isize| { if i >= 0 && j >= 0 { p[i as usize * n + j as usize] = 1; } };
        for o in &self.opamps {
            for j in [o.p, o.n, o.z] { set(&mut p, o.z, j); }
            for j in [o.z, o.o] { set(&mut p, o.row, j); }
            set(&mut p, o.o, o.row);
        }
        for c in &self.cmps { if c.o >= 0 { set(&mut p, c.o, c.row); set(&mut p, c.row, c.o); } }
        for b in &self.bbds {
            if b.out >= 0 { set(&mut p, b.out, b.row); set(&mut p, b.row, b.out); }
            if b.inp >= 0 { set(&mut p, b.row, b.inp); }
        }
        p
    }

    fn solve_system(&mut self) -> bool {
        let n = self.n;
        if self.sparse.is_none() {
            let pat = self.pattern();
            self.sparse = Some(SparseLu::new(&self.a, &pat, n));
        }
        if self.sparse.as_mut().unwrap().solve(&self.a, &mut self.b) { return true; }
        // pivot went bad at this operating point: re-pick the order next time
        self.sparse = None;
        lu_solve(&mut self.a, &mut self.b, n)
    }

    /// One Newton solve of the full nonlinear system.
    fn newton(&mut self, rhs: &[f64], max_iter: usize, src_scale: f64) -> bool {
        let n = self.n;
        for _ in 0..max_iter {
            self.a.copy_from_slice(&self.base);
            self.b.copy_from_slice(rhs);
            stamp_nonlinear(&mut self.a, &mut self.b, n, &self.x, &mut self.diodes, &mut self.bjts, &mut self.opamps, &mut self.fets, src_scale);
            self.x_old.copy_from_slice(&self.x);
            if !self.solve_system() { return false; }
            for i in 0..n { self.x[i] = self.x_old[i] + 1.0 * (self.b[i] - self.x_old[i]); }
            self.stats.iterations += 1;
            if !self.nonlinear { return true; }
            let mut ok = true;
            for i in 0..n {
                let d = (self.b[i] - self.x_old[i]).abs();
                if d > self.abstol + 1e-4 * self.b[i].abs() { ok = false; break; }
            }
            if ok { self.x.copy_from_slice(&self.b); return true; }
        }
        false
    }

    fn rhs_dc(&self, src_scale: f64) -> Vec<f64> {
        let mut rhs = vec![0.0; self.n];
        for v in &self.vsrc { rhs[v.row as usize] = v.v * src_scale; }
        for c in &self.cmps { rhs[c.row as usize] = c.held * src_scale; }
        rhs
    }

    /// Solve the bias point (capacitors open, no input) and reset state to it.
    pub fn dc_operating_point(&mut self) -> bool {
        self.stamp_linear(true);
        self.x.iter_mut().for_each(|v| *v = 0.0);
        for d in self.diodes.iter_mut() { d.vd = 0.0; }
        for q in self.bjts.iter_mut() { q.vbe = 0.0; q.vbc = 0.0; }
        for f in self.fets.iter_mut() { f.vgs = 0.0; f.vds = 0.0; }
        for c in self.cmps.iter_mut() { c.held = c.vmid; }
        let mut ok = true;
        let steps = 20;
        for s in 1..=steps {
            let scale = s as f64 / steps as f64;
            let rhs = self.rhs_dc(scale);
            ok = self.newton(&rhs, 200, scale);
        }
        if !ok {
            let rhs = self.rhs_dc(1.0);
            ok = self.newton(&rhs, 500, 1.0);
        }
        self.dc_converged = ok;
        let x = &self.x;
        let v = |i: isize| if i >= 0 { x[i as usize] } else { 0.0 };
        for c in self.caps.iter_mut() { c.v = v(c.a) - v(c.b); c.i = 0.0; }
        for c in self.cmps.iter_mut() { c.held = c.vmid + c.vsat; }
        let fs = self.fs;
        for b in self.bbds.iter_mut() {
            let (vin, cv) = (v(b.inp), v(b.cv));
            bbd_reset(b, vin, cv, fs);
        }
        self.stamp_linear(false);
        self.rhs_buf = vec![0.0; self.n];
        ok
    }

    /// Advance delay lines and comparators by one sample (after the circuit solve).
    fn clock_devices(&mut self) {
        let x = &self.x;
        let v = |i: isize| if i >= 0 { x[i as usize] } else { 0.0 };
        for c in self.cmps.iter_mut() {
            let vd = v(c.p) - v(c.n);
            c.held = c.vmid + c.vsat * (vd * 1e4).tanh();
        }
        let fs = self.fs;
        for b in self.bbds.iter_mut() {
            let len = b.buf.len();
            b.buf[b.w] = v(b.inp) as f32;
            let f = bbd_clock(&b.m, v(b.cv));
            b.delay = b.m.stages / (2.0 * f);
            b.phase += f / fs;
            if b.phase >= 1.0 {
                b.phase -= b.phase.floor();
                let mut d = b.delay * fs;
                if d > (len - 3) as f64 { d = (len - 3) as f64; }
                if d < 1.0 { d = 1.0; }
                let i = d.floor() as usize;
                let frac = d - i as f64;
                let a = b.buf[(b.w + len - i) % len] as f64;
                let c = b.buf[(b.w + len - i - 1) % len] as f64;
                let val = a + (c - a) * frac;
                let sw = b.m.swing;
                let vb = b.m.vbias;
                b.held = vb + sw * ((val - vb) / sw).tanh();
            }
            b.w = (b.w + 1) % len;
        }
    }

    /// Simulate one sample. vin in volts. Returns the output node voltage.
    pub fn step(&mut self, vin: f64) -> f64 {
        self.stats.steps += 1;
        let prev = self.vin_prev.unwrap_or(vin);
        if !self.try_step(vin, 25) {
            // roll back and cross this sample in smaller time steps
            self.restore();
            if !self.substep(prev, vin, 1) { self.stats.failures += 1; }
        }
        self.vin_prev = Some(vin);
        if !self.cmps.is_empty() || !self.bbds.is_empty() { self.clock_devices(); }
        if self.out >= 0 { self.x[self.out as usize] } else { 0.0 }
    }

    fn substep(&mut self, v0: f64, v1: f64, depth: u32) -> bool {
        let fs = self.fs;
        self.fs = fs * 2.0;
        self.stamp_linear(false);
        let mut ok = true;
        let mid = (v0 + v1) / 2.0;
        for vin in [mid, v1] {
            if !self.try_step(vin, 25) {
                if depth < 6 {
                    self.restore();
                    let from = if vin == v1 { mid } else { v0 };
                    ok = self.substep(from, vin, depth + 1) && ok;
                } else {
                    ok = false; // accept the best estimate and move on
                    self.commit_caps();
                }
            }
        }
        self.fs = fs;
        self.stamp_linear(false);
        ok
    }

    fn try_step(&mut self, vin: f64, max_iter: usize) -> bool {
        self.save();
        let mut rhs = std::mem::take(&mut self.rhs_buf);
        rhs.iter_mut().for_each(|v| *v = 0.0);
        for v in &self.vsrc { rhs[v.row as usize] = v.v; }
        for c in &self.cmps { rhs[c.row as usize] = c.held; }
        for b in &self.bbds { rhs[b.row as usize] = b.held; }
        if let Some(inp) = &self.input {
            let i = vin * inp.g;
            if inp.p >= 0 { rhs[inp.p as usize] += i; }
            if inp.m >= 0 { rhs[inp.m as usize] -= i; }
        }
        for c in &self.caps {
            let h = c.geq * c.v + if self.trap && !c.be { c.i } else { 0.0 };
            if c.a >= 0 { rhs[c.a as usize] += h; }
            if c.b >= 0 { rhs[c.b as usize] -= h; }
        }
        let ok = self.newton(&rhs, max_iter, 1.0);
        self.rhs_buf = rhs;
        if ok { self.commit_caps(); }
        ok
    }

    fn commit_caps(&mut self) {
        let x = &self.x;
        let trap = self.trap;
        for c in self.caps.iter_mut() {
            let v = (if c.a >= 0 { x[c.a as usize] } else { 0.0 }) - (if c.b >= 0 { x[c.b as usize] } else { 0.0 });
            c.i = if trap && !c.be { c.geq * (v - c.v) - c.i } else { c.geq * (v - c.v) };
            c.v = v;
        }
    }

    fn save(&mut self) {
        let nj = self.diodes.len() + 2 * self.bjts.len() + self.opamps.len() + 2 * self.fets.len();
        let s = &mut self.saved;
        if s.x.len() != self.n || s.cv.len() != self.caps.len() || s.j.len() != nj {
            *s = Saved { x: vec![0.0; self.n], cv: vec![0.0; self.caps.len()], ci: vec![0.0; self.caps.len()], j: vec![0.0; nj] };
        }
        s.x.copy_from_slice(&self.x);
        for (i, c) in self.caps.iter().enumerate() { s.cv[i] = c.v; s.ci[i] = c.i; }
        let mut k = 0;
        for d in &self.diodes { s.j[k] = d.vd; k += 1; }
        for q in &self.bjts { s.j[k] = q.vbe; s.j[k + 1] = q.vbc; k += 2; }
        for o in &self.opamps { s.j[k] = o.vzl.unwrap_or(0.0); k += 1; }
        for f in &self.fets { s.j[k] = f.vgs; s.j[k + 1] = f.vds; k += 2; }
    }

    fn restore(&mut self) {
        let s = &self.saved;
        self.x.copy_from_slice(&s.x);
        for (i, c) in self.caps.iter_mut().enumerate() { c.v = s.cv[i]; c.i = s.ci[i]; }
        let mut k = 0;
        for d in self.diodes.iter_mut() { d.vd = s.j[k]; k += 1; }
        for q in self.bjts.iter_mut() { q.vbe = s.j[k]; q.vbc = s.j[k + 1]; k += 2; }
        for o in self.opamps.iter_mut() { o.vzl = Some(s.j[k]); k += 1; }
        for f in self.fets.iter_mut() { f.vgs = s.j[k]; f.vds = s.j[k + 1]; k += 2; }
    }
}

fn bbd_reset(b: &mut Bbd, vin: f64, cv: f64, fs: f64) {
    let len = bbd_len(&b.m, fs);
    if b.buf.len() != len { b.buf = vec![0.0; len]; }
    b.buf.iter_mut().for_each(|s| *s = vin as f32);
    b.w = 0;
    b.phase = 0.0;
    b.held = vin;
    b.delay = b.m.stages / (2.0 * bbd_clock(&b.m, cv));
}

#[allow(clippy::too_many_arguments)]
fn stamp_nonlinear(a: &mut [f64], b: &mut [f64], n: usize, x: &[f64], diodes: &mut [Diode], bjts: &mut [Bjt], opamps: &mut [Opamp], fets: &mut [Fet], src_scale: f64) {
    let v = |i: isize| if i >= 0 { x[i as usize] } else { 0.0 };
    let add = |a: &mut [f64], i: isize, j: isize, val: f64| { if i >= 0 && j >= 0 { a[i as usize * n + j as usize] += val; } };
    let inj = |b: &mut [f64], i: isize, val: f64| { if i >= 0 { b[i as usize] += val; } };

    for d in diodes.iter_mut() {
        let mut vd = v(d.a) - v(d.k);
        vd = pnjlim(vd, d.vd, d.vt, d.vcrit);
        d.vd = vd;
        let ex = safe_exp(vd / d.vt);
        let id = d.is * (ex - 1.0);
        let gd = d.is * ex / d.vt + GMIN;
        let ieq = id - gd * vd;
        add(a, d.a, d.a, gd); add(a, d.k, d.k, gd); add(a, d.a, d.k, -gd); add(a, d.k, d.a, -gd);
        inj(b, d.a, -ieq); inj(b, d.k, ieq);
    }

    for q in bjts.iter_mut() {
        let p = q.pol;
        let mut vbe = p * (v(q.b) - v(q.e));
        let mut vbc = p * (v(q.b) - v(q.c));
        vbe = pnjlim(vbe, q.vbe, VT, q.vcrit);
        vbc = pnjlim(vbc, q.vbc, VT, q.vcrit);
        q.vbe = vbe; q.vbc = vbc;
        let ef = safe_exp(vbe / VT);
        let er = safe_exp(vbc / VT);
        let i_f = q.is * (ef - 1.0);
        let i_r = q.is * (er - 1.0);
        let gf = q.is * ef / VT + GMIN;
        let gr = q.is * er / VT + GMIN;
        let ic = i_f - i_r - i_r / q.br;
        let ib = i_f / q.bf + i_r / q.br;
        let gcbe = gf;
        let gcbc = -gr - gr / q.br;
        let gbbe = gf / q.bf;
        let gbbc = gr / q.br;
        let kc = p * (ic - gcbe * vbe - gcbc * vbc);
        let kb = p * (ib - gbbe * vbe - gbbc * vbc);
        add(a, q.c, q.b, gcbe + gcbc); add(a, q.c, q.e, -gcbe); add(a, q.c, q.c, -gcbc); inj(b, q.c, -kc);
        add(a, q.b, q.b, gbbe + gbbc); add(a, q.b, q.e, -gbbe); add(a, q.b, q.c, -gbbc); inj(b, q.b, -kb);
        add(a, q.e, q.b, -(gcbe + gcbc + gbbe + gbbc)); add(a, q.e, q.e, gcbe + gbbe);
        add(a, q.e, q.c, gcbc + gbbc); inj(b, q.e, kc + kb);
    }

    for f in fets.iter_mut() {
        let mut vgs = v(f.g) - v(f.s);
        let mut vds = v(f.d) - v(f.s);
        if (vgs - f.vgs).abs() > 0.5 { vgs = f.vgs + 0.5 * (vgs - f.vgs).signum(); }
        if (vds - f.vds).abs() > 2.0 { vds = f.vds + 2.0 * (vds - f.vds).signum(); }
        f.vgs = vgs; f.vds = vds;
        // symmetric channel: with vds < 0 the drain and source swap roles
        let (d, s, vg, vd) = if vds < 0.0 { (f.s, f.d, vgs - vds, -vds) } else { (f.d, f.s, vgs, vds) };
        let (id, gm, gds) = mosfet_id(f, vg, vd);
        let g0 = 1e-12;
        let ieq = id - gm * vg - gds * vd;
        add(a, d, d, gds + g0); add(a, d, s, -gds - gm - g0); add(a, d, f.g, gm); inj(b, d, -ieq);
        add(a, s, d, -gds - g0); add(a, s, s, gds + gm + g0); add(a, s, f.g, -gm); inj(b, s, ieq);
    }

    for o in opamps.iter_mut() {
        let vd = v(o.p) - v(o.n);
        let ti = (o.gm * vd / o.imax).tanh();
        let gi = o.gm * (1.0 - ti * ti) + 1e-9;
        add(a, o.z, o.p, -gi); add(a, o.z, o.n, gi);
        b[o.z as usize] += o.imax * ti - gi * vd;
        let mut vz = x[o.z as usize];
        if let Some(l) = o.vzl {
            if (vz - l).abs() > 1.0 { vz = l + (vz - l).signum(); }
        }
        o.vzl = Some(vz);
        let (ic, gc) = rail_clamp(vz, o.vsat, o.clamp_g);
        add(a, o.z, o.z, gc);
        b[o.z as usize] -= ic - gc * vz;
        add(a, o.row, o.z, -1.0);
        b[o.row as usize] += o.vmid * src_scale;
    }
}
