// Circuit simulator: modified nodal analysis (MNA) with Newton-Raphson for the
// nonlinear parts and trapezoidal companion models for capacitors.
//
// The same engine does three jobs:
//   - dcOperatingPoint(): bias voltages with capacitors open
//   - acSweep():          small-signal frequency response around that bias
//   - process():          sample-by-sample transient simulation for audio
//
// It has no dependencies so it can run in the main thread, in Node (tests)
// and inside an AudioWorklet.
//
// Netlist format (node 0 is ground):
//   { nodeCount, nodeNames?, output, elements: [
//       { id, type: 'R',   nodes: [a, b],    R },
//       { id, type: 'C',   nodes: [a, b],    C },
//       { id, type: 'V',   nodes: [p, m],    V },          // DC supply
//       { id, type: 'VIN', nodes: [p, m],    R },          // audio input, source resistance R
//       { id, type: 'D',   nodes: [a, k],    model: { Is, n } },
//       { id, type: 'Q',   nodes: [c, b, e], model: { Is, bf, br, pol } }, // pol +1 NPN, -1 PNP
//       { id, type: 'OA',  nodes: [p, n, o], model: { A, gbw, slew, vmid, vsat } },
//   ] }

export const VT = 0.025852; // thermal voltage at ~27 °C

export const DIODE_MODELS = {
  '1N914': { label: '1N914 silicon', Is: 2.52e-9, n: 1.752 },
  '1N4148': { label: '1N4148 silicon', Is: 4.35e-9, n: 1.906 },
  '1N34A': { label: '1N34A germanium', Is: 2.0e-7, n: 1.3 },
  'BAT41': { label: 'BAT41 Schottky', Is: 1.0e-8, n: 1.05 },
  'LED': { label: 'Red LED', Is: 9.3e-20, n: 1.6 },
};

export const BJT_MODELS = {
  'Si': { label: 'Silicon NPN', Is: 1.8e-14, br: 4, pol: 1 },
  'Ge': { label: 'Germanium NPN', Is: 2.0e-6, br: 2, pol: 1 },
};

const GMIN = 1e-12;
const MAX_EXP = 80;

function safeExp(x) {
  return x > MAX_EXP ? Math.exp(MAX_EXP) * (1 + x - MAX_EXP) : Math.exp(x);
}

// SPICE-style junction voltage limiting: stops Newton from jumping to a
// voltage where exp() explodes.
function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}

// In-place LU solve of A x = b (A is n*n row-major). Overwrites A and b;
// solution ends up in b. Returns false if singular.
function luSolve(A, b, n) {
  for (let k = 0; k < n; k++) {
    let p = k, max = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > max) { max = v; p = i; }
    }
    if (max < 1e-300) return false;
    if (p !== k) {
      for (let j = k; j < n; j++) {
        const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t;
      }
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    const pivot = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / pivot;
      if (f === 0) continue;
      A[i * n + k] = 0;
      for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * b[j];
    b[i] = s / A[i * n + i];
  }
  return true;
}

// Complex LU solve, separate real/imag arrays. Solution in (br, bi).
function luSolveComplex(Ar, Ai, br, bi, n) {
  for (let k = 0; k < n; k++) {
    let p = k, max = Ar[k * n + k] ** 2 + Ai[k * n + k] ** 2;
    for (let i = k + 1; i < n; i++) {
      const v = Ar[i * n + k] ** 2 + Ai[i * n + k] ** 2;
      if (v > max) { max = v; p = i; }
    }
    if (max < 1e-300) return false;
    if (p !== k) {
      for (let j = k; j < n; j++) {
        let t = Ar[k * n + j]; Ar[k * n + j] = Ar[p * n + j]; Ar[p * n + j] = t;
        t = Ai[k * n + j]; Ai[k * n + j] = Ai[p * n + j]; Ai[p * n + j] = t;
      }
      let t = br[k]; br[k] = br[p]; br[p] = t;
      t = bi[k]; bi[k] = bi[p]; bi[p] = t;
    }
    const pr = Ar[k * n + k], pi = Ai[k * n + k];
    const d = pr * pr + pi * pi;
    for (let i = k + 1; i < n; i++) {
      const ar = Ar[i * n + k], ai = Ai[i * n + k];
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / d, fi = (ai * pr - ar * pi) / d;
      Ar[i * n + k] = 0; Ai[i * n + k] = 0;
      for (let j = k + 1; j < n; j++) {
        const xr = Ar[k * n + j], xi = Ai[k * n + j];
        Ar[i * n + j] -= fr * xr - fi * xi;
        Ai[i * n + j] -= fr * xi + fi * xr;
      }
      const xr = br[k], xi = bi[k];
      br[i] -= fr * xr - fi * xi;
      bi[i] -= fr * xi + fi * xr;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let sr = br[i], si = bi[i];
    for (let j = i + 1; j < n; j++) {
      const ar = Ar[i * n + j], ai = Ai[i * n + j];
      sr -= ar * br[j] - ai * bi[j];
      si -= ar * bi[j] + ai * br[j];
    }
    const pr = Ar[i * n + i], pi = Ai[i * n + i];
    const d = pr * pr + pi * pi;
    br[i] = (sr * pr + si * pi) / d;
    bi[i] = (si * pr - sr * pi) / d;
  }
  return true;
}

/** A structural fingerprint: same signature means state can be carried over. */
export function topologySignature(net) {
  return net.nodeCount + '|' + net.output + '|' +
    net.elements.map((e) => e.type + ':' + e.nodes.join(',')).join(';');
}

export class Circuit {
  /**
   * @param {object} net   netlist (see top of file)
   * @param {number} fs    simulation sample rate in Hz
   * @param {object} opts  { method: 'trap' | 'be' }
   */
  constructor(net, fs, opts = {}) {
    this.fs = fs;
    this.method = opts.method || 'trap';
    this.stats = { steps: 0, iterations: 0, failures: 0 };
    this._build(net);
    this.dcOperatingPoint();
  }

  /** Replace component values. Keeps state if the topology is unchanged. */
  update(net) {
    if (topologySignature(net) === this.signature) {
      this._build(net, true);
    } else {
      this._build(net);
      this.dcOperatingPoint();
    }
  }

  setSampleRate(fs) {
    this.fs = fs;
    this._stampLinear(false);
  }

  _build(net, keepState = false) {
    const N = net.nodeCount - 1;
    const els = net.elements;
    this.net = net;
    this.signature = topologySignature(net);
    this.N = N;
    this.out = net.output - 1;

    // Element groups, with matrix indices (-1 = ground)
    const idx = (node) => node - 1;
    let extra = N;
    const prev = keepState ? this : null;
    this.res = []; this.caps = []; this.vsrc = []; this.diodes = []; this.bjts = []; this.opamps = [];
    this.input = null;
    for (const e of els) {
      const nd = e.nodes.map(idx);
      switch (e.type) {
        case 'R': this.res.push({ a: nd[0], b: nd[1], g: 1 / Math.max(e.R, 1e-3) }); break;
        case 'C': this.caps.push({ a: nd[0], b: nd[1], C: e.C, v: 0, i: 0 }); break;
        case 'V': this.vsrc.push({ p: nd[0], m: nd[1], V: e.V, row: extra++ }); break;
        case 'VIN': this.input = { p: nd[0], m: nd[1], g: 1 / Math.max(e.R || 1, 1e-3) }; break;
        case 'D': {
          const { Is, n } = e.model; const vt = n * VT;
          this.diodes.push({ a: nd[0], k: nd[1], Is, vt, vcrit: vt * Math.log(vt / (Math.SQRT2 * Is)), vd: 0 });
          break;
        }
        case 'Q': {
          const { Is, bf, br, pol } = e.model;
          this.bjts.push({ c: nd[0], b: nd[1], e: nd[2], Is, bf, br, pol: pol || 1,
            vcrit: VT * Math.log(VT / (Math.SQRT2 * Is)), vbe: 0, vbc: 0 });
          break;
        }
        case 'OA': {
          // Macro-model: a saturating transconductance (slew limit) charges an
          // internal integrator node z (dominant pole -> gain-bandwidth), and
          // the output follows z through a soft rail clip.
          const { A = 1e5, gbw = 1e6, slew = 1e6, vmid = 4.5, vsat = 3.5 } = e.model || {};
          const z = extra++;
          const Cz = A / (2 * Math.PI * gbw); // with a 1 ohm load on z
          this.caps.push({ a: z, b: -1, C: Cz, v: 0, i: 0 });
          this.opamps.push({ p: nd[0], n: nd[1], o: nd[2], z, gm: A, imax: slew * Cz, vmid, vsat, row: extra++ });
          break;
        }
        default: throw new Error('Unknown element type ' + e.type);
      }
    }
    const n = extra;
    if (prev && prev.n === n && prev.x) {
      // carry over solver + capacitor state
      const oldCaps = prev._oldCaps || [];
      this.caps.forEach((c, i) => { if (oldCaps[i]) { c.v = oldCaps[i].v; c.i = oldCaps[i].i; } });
    } else {
      this.n = n;
      this.x = new Float64Array(n);
    }
    this.n = n;
    this.A = new Float64Array(n * n);
    this.b = new Float64Array(n);
    this.base = new Float64Array(n * n);
    this.xOld = new Float64Array(n);
    this.nonlinear = this.diodes.length + this.bjts.length + this.opamps.length > 0;
    this._oldCaps = this.caps;
    this._stampLinear(false);
  }

  // Constant part of the matrix: resistors, gmin, capacitor conductances,
  // source structure. dc=true leaves capacitors open.
  _stampLinear(dc) {
    const { n, N } = this;
    const A = this.base;
    A.fill(0);
    const add = (i, j, v) => { if (i >= 0 && j >= 0) A[i * n + j] += v; };
    const cond = (a, b, g) => { add(a, a, g); add(b, b, g); add(a, b, -g); add(b, a, -g); };
    for (let i = 0; i < N; i++) A[i * n + i] += GMIN;
    for (const r of this.res) cond(r.a, r.b, r.g);
    const k = this.method === 'be' ? 1 : 2;
    for (const c of this.caps) {
      c.geq = dc ? 0 : k * c.C * this.fs;
      if (!dc) cond(c.a, c.b, c.geq);
    }
    if (this.input) cond(this.input.p, this.input.m, this.input.g);
    for (const v of this.vsrc) {
      add(v.p, v.row, 1); add(v.m, v.row, -1);
      add(v.row, v.p, 1); add(v.row, v.m, -1);
    }
    for (const o of this.opamps) {
      add(o.z, o.z, 1);
      add(o.o, o.row, 1);
      add(o.row, o.o, 1);
    }
  }

  // One Newton solve of the full nonlinear system. rhs is the constant
  // right-hand side (sources + capacitor history). Returns true if converged.
  _newton(rhs, maxIter, srcScale = 1) {
    const { n, A, b, base, x, xOld } = this;
    for (let it = 0; it < maxIter; it++) {
      A.set(base);
      b.set(rhs);
      this._stampNonlinear(A, b, n, srcScale);
      xOld.set(x);
      if (!luSolve(A, b, n)) return false;
      x.set(b);
      this.stats.iterations++;
      if (!this.nonlinear) return true;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(x[i] - xOld[i]);
        if (d > 1e-7 + 1e-6 * Math.abs(x[i])) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  _stampNonlinear(A, b, n, srcScale) {
    const x = this.x;
    const V = (i) => (i >= 0 ? x[i] : 0);
    const add = (i, j, v) => { if (i >= 0 && j >= 0) A[i * n + j] += v; };
    const inj = (i, v) => { if (i >= 0) b[i] += v; };

    for (const d of this.diodes) {
      let vd = V(d.a) - V(d.k);
      vd = pnjlim(vd, d.vd, d.vt, d.vcrit);
      d.vd = vd;
      const ex = safeExp(vd / d.vt);
      const id = d.Is * (ex - 1);
      const gd = d.Is * ex / d.vt + GMIN;
      const ieq = id - gd * vd;
      add(d.a, d.a, gd); add(d.k, d.k, gd); add(d.a, d.k, -gd); add(d.k, d.a, -gd);
      inj(d.a, -ieq); inj(d.k, ieq);
    }

    for (const q of this.bjts) {
      const p = q.pol;
      let vbe = p * (V(q.b) - V(q.e));
      let vbc = p * (V(q.b) - V(q.c));
      vbe = pnjlim(vbe, q.vbe, VT, q.vcrit);
      vbc = pnjlim(vbc, q.vbc, VT, q.vcrit);
      q.vbe = vbe; q.vbc = vbc;
      const ef = safeExp(vbe / VT), er = safeExp(vbc / VT);
      const If = q.Is * (ef - 1), Ir = q.Is * (er - 1);
      const gf = q.Is * ef / VT + GMIN, gr = q.Is * er / VT + GMIN;
      // Ebers-Moll transport model
      const Ic = If - Ir - Ir / q.br;
      const Ib = If / q.bf + Ir / q.br;
      const gcbe = gf, gcbc = -gr - gr / q.br;
      const gbbe = gf / q.bf, gbbc = gr / q.br;
      const kc = p * (Ic - gcbe * vbe - gcbc * vbc);
      const kb = p * (Ib - gbbe * vbe - gbbc * vbc);
      // collector row
      add(q.c, q.b, gcbe + gcbc); add(q.c, q.e, -gcbe); add(q.c, q.c, -gcbc); inj(q.c, -kc);
      // base row
      add(q.b, q.b, gbbe + gbbc); add(q.b, q.e, -gbbe); add(q.b, q.c, -gbbc); inj(q.b, -kb);
      // emitter row = -(collector + base)
      add(q.e, q.b, -(gcbe + gcbc + gbbe + gbbc)); add(q.e, q.e, gcbe + gbbe);
      add(q.e, q.c, gcbc + gbbc); inj(q.e, kc + kb);
    }

    for (const o of this.opamps) {
      // transconductance into z: i = imax * tanh(gm * vd / imax)
      const vd = V(o.p) - V(o.n);
      const ti = Math.tanh(o.gm * vd / o.imax);
      const gi = o.gm * (1 - ti * ti) + 1e-9;
      add(o.z, o.p, -gi); add(o.z, o.n, gi);
      b[o.z] += o.imax * ti - gi * vd;
      // output: vo = vmid + vsat * tanh(vz / vsat)
      const vz = x[o.z];
      const t = Math.tanh(vz / o.vsat);
      const g = 1 - t * t + 1e-12;
      add(o.row, o.z, -g);
      b[o.row] += o.vmid * srcScale + o.vsat * t - g * vz;
    }
  }

  _rhs(vin, dc, srcScale = 1) {
    const rhs = new Float64Array(this.n);
    for (const v of this.vsrc) rhs[v.row] = v.V * srcScale;
    if (this.input && vin) {
      const I = vin * this.input.g;
      if (this.input.p >= 0) rhs[this.input.p] += I;
      if (this.input.m >= 0) rhs[this.input.m] -= I;
    }
    if (!dc) {
      const trap = this.method !== 'be';
      for (const c of this.caps) {
        const h = c.geq * c.v + (trap ? c.i : 0);
        if (c.a >= 0) rhs[c.a] += h;
        if (c.b >= 0) rhs[c.b] -= h;
      }
    }
    return rhs;
  }

  /** Solve the bias point (capacitors open, no input) and reset state to it. */
  dcOperatingPoint() {
    this._stampLinear(true);
    this.x.fill(0);
    for (const d of this.diodes) d.vd = 0;
    for (const q of this.bjts) { q.vbe = 0; q.vbc = 0; }
    let ok = true;
    // source stepping: ramp the supplies up so Newton never has to jump far
    const steps = 20;
    for (let s = 1; s <= steps; s++) {
      const scale = s / steps;
      ok = this._newton(this._rhs(0, true, scale), 200, scale);
    }
    if (!ok) ok = this._newton(this._rhs(0, true, 1), 500, 1);
    this.dcConverged = ok;
    const V = (i) => (i >= 0 ? this.x[i] : 0);
    for (const c of this.caps) { c.v = V(c.a) - V(c.b); c.i = 0; }
    this.dcX = Float64Array.from(this.x);
    this._stampLinear(false);
    this._rhsBuf = new Float64Array(this.n);
    return ok;
  }

  /** Node voltages (by node number, 0 = ground) of the last solution. */
  nodeVoltage(node) { return node === 0 ? 0 : this.x[node - 1]; }

  /** Simulate one sample. vin in volts. Returns the output node voltage. */
  step(vin) {
    const rhs = this._rhsBuf;
    rhs.fill(0);
    for (const v of this.vsrc) rhs[v.row] = v.V;
    if (this.input) {
      const I = vin * this.input.g;
      if (this.input.p >= 0) rhs[this.input.p] += I;
      if (this.input.m >= 0) rhs[this.input.m] -= I;
    }
    const trap = this.method !== 'be';
    for (const c of this.caps) {
      const h = c.geq * c.v + (trap ? c.i : 0);
      if (c.a >= 0) rhs[c.a] += h;
      if (c.b >= 0) rhs[c.b] -= h;
    }
    this.stats.steps++;
    if (!this._newton(rhs, 40)) this.stats.failures++;
    const x = this.x;
    for (const c of this.caps) {
      const v = (c.a >= 0 ? x[c.a] : 0) - (c.b >= 0 ? x[c.b] : 0);
      c.i = trap ? c.geq * (v - c.v) - c.i : c.geq * (v - c.v);
      c.v = v;
    }
    const o = this.out;
    return o >= 0 ? x[o] : 0;
  }

  /** Process a block of input samples (volts) into output (volts). */
  process(input, output) {
    for (let i = 0; i < input.length; i++) output[i] = this.step(input[i]);
  }

  /**
   * Small-signal frequency response from the input to the output node,
   * linearised at the DC operating point. Returns { mag (dB), phase (deg) }.
   */
  acSweep(freqs) {
    const n = this.n;
    const x = this.dcX || this.x;
    const V = (i) => (i >= 0 ? x[i] : 0);
    // real part: linear conductances + linearised devices (dc=true -> caps excluded)
    this._stampLinear(true);
    const G = Float64Array.from(this.base);
    this._stampLinear(false); // restore transient conductances
    const addG = (i, j, v) => { if (i >= 0 && j >= 0) G[i * n + j] += v; };
    for (const d of this.diodes) {
      const vd = V(d.a) - V(d.k);
      const g = d.Is * safeExp(vd / d.vt) / d.vt + GMIN;
      addG(d.a, d.a, g); addG(d.k, d.k, g); addG(d.a, d.k, -g); addG(d.k, d.a, -g);
    }
    for (const q of this.bjts) {
      const p = q.pol;
      const vbe = p * (V(q.b) - V(q.e)), vbc = p * (V(q.b) - V(q.c));
      const gf = q.Is * safeExp(vbe / VT) / VT + GMIN, gr = q.Is * safeExp(vbc / VT) / VT + GMIN;
      const gcbe = gf, gcbc = -gr - gr / q.br, gbbe = gf / q.bf, gbbc = gr / q.br;
      addG(q.c, q.b, gcbe + gcbc); addG(q.c, q.e, -gcbe); addG(q.c, q.c, -gcbc);
      addG(q.b, q.b, gbbe + gbbc); addG(q.b, q.e, -gbbe); addG(q.b, q.c, -gbbc);
      addG(q.e, q.b, -(gcbe + gcbc + gbbe + gbbc)); addG(q.e, q.e, gcbe + gbbe); addG(q.e, q.c, gcbc + gbbc);
    }
    for (const o of this.opamps) {
      const ti = Math.tanh(o.gm * (V(o.p) - V(o.n)) / o.imax);
      const gi = o.gm * (1 - ti * ti) + 1e-9;
      addG(o.z, o.p, -gi); addG(o.z, o.n, gi);
      const t = Math.tanh(x[o.z] / o.vsat);
      addG(o.row, o.z, -(1 - t * t + 1e-12));
    }
    const mag = new Float64Array(freqs.length), phase = new Float64Array(freqs.length);
    const Ar = new Float64Array(n * n), Ai = new Float64Array(n * n);
    const br = new Float64Array(n), bi = new Float64Array(n);
    freqs.forEach((f, fi) => {
      Ar.set(G); Ai.fill(0); br.fill(0); bi.fill(0);
      const w = 2 * Math.PI * f;
      for (const c of this.caps) {
        const y = w * c.C;
        if (c.a >= 0) Ai[c.a * n + c.a] += y;
        if (c.b >= 0) Ai[c.b * n + c.b] += y;
        if (c.a >= 0 && c.b >= 0) { Ai[c.a * n + c.b] -= y; Ai[c.b * n + c.a] -= y; }
      }
      if (this.input) {
        if (this.input.p >= 0) br[this.input.p] += this.input.g;
        if (this.input.m >= 0) br[this.input.m] -= this.input.g;
      }
      luSolveComplex(Ar, Ai, br, bi, n);
      const o = this.out;
      const re = o >= 0 ? br[o] : 0, im = o >= 0 ? bi[o] : 0;
      mag[fi] = 20 * Math.log10(Math.hypot(re, im) + 1e-15);
      phase[fi] = Math.atan2(im, re) * 180 / Math.PI;
    });
    return { mag, phase };
  }
}

/** Log-spaced frequencies. */
export function logFreqs(f0 = 20, f1 = 20000, count = 120) {
  const out = new Float64Array(count);
  const r = Math.log(f1 / f0);
  for (let i = 0; i < count; i++) out[i] = f0 * Math.exp(r * i / (count - 1));
  return out;
}
