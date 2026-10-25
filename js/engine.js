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
//       { id, type: 'M',   nodes: [d, g, s], model: { vth, kp, lambda, Is, n } }, // N-channel MOSFET + body diode
//       { id, type: 'OA',  nodes: [p, n, o], model: { A, gbw, slew, vmid, vsat } },
//       { id, type: 'CMP', nodes: [p, n, o], model: { vmid, vsat } },       // op-amp used as a comparator
//       { id, type: 'BBD', nodes: [in, out, cv], model: { stages, fc, vOct, swing, vbias } },
//   ] }

export const VT = 0.025852; // thermal voltage at ~27 °C

export const DIODE_MODELS = {
  '1N914': { label: '1N914 silicon', Is: 2.52e-9, n: 1.752 },
  '1N4148': { label: '1N4148 silicon', Is: 4.35e-9, n: 1.906 },
  '1N34A': { label: '1N34A germanium', Is: 2.0e-7, n: 1.3 },
  'BAT41': { label: 'BAT41 Schottky', Is: 1.0e-8, n: 1.05 },
  '1N5819': { label: '1N5819 Schottky', Is: 5.0e-7, n: 1.1 },
  'LED': { label: 'Red LED', Is: 9.3e-20, n: 1.6 },
};

export const BJT_MODELS = {
  'Si': { label: 'Silicon NPN', Is: 1.8e-14, br: 4, pol: 1 },
  'Ge': { label: 'Germanium NPN', Is: 2.0e-6, br: 2, pol: 1 },
};

// N-channel enhancement MOSFETs: square-law channel plus the body diode (source -> drain).
export const MOSFET_MODELS = {
  '2N7000': { label: '2N7000', vth: 2.1, kp: 0.1, lambda: 0.02, Is: 1e-12, n: 1.25 },
  'BS170': { label: 'BS170', vth: 2.0, kp: 0.12, lambda: 0.02, Is: 1e-12, n: 1.25 },
};

/** Drain current and its derivatives for vds >= 0 (square law, Shichman-Hodges). */
export function mosfetId(m, vgs, vds) {
  const vov = vgs - m.vth;
  if (vov <= 0) return [0, 0, 0];
  const cl = 1 + m.lambda * vds;
  if (vds < vov) {
    const id = m.kp * (vov * vds - vds * vds / 2) * cl;
    return [id, m.kp * vds * cl, m.kp * (vov - vds) * cl + m.kp * (vov * vds - vds * vds / 2) * m.lambda];
  }
  const id = m.kp / 2 * vov * vov * cl;
  return [id, m.kp * vov * cl, m.kp / 2 * vov * vov * m.lambda];
}

export const OPAMP_MODELS = {
  'JRC4558': { label: 'JRC4558 (Tube Screamer)', gbw: 3e6, slew: 1e6 },
  'TL072': { label: 'TL072 (fast, clean)', gbw: 3e6, slew: 13e6 },
  'LM308': { label: 'LM308 (RAT, slow)', gbw: 0.5e6, slew: 0.3e6 },
  'OP07': { label: 'OP07 (slow precision)', gbw: 0.6e6, slew: 0.3e6 },
  'LM741': { label: 'µA741 (vintage)', gbw: 1e6, slew: 0.5e6 },
};

// Bucket-brigade delay chips. Delay = stages / (2 · clock frequency).
export const BBD_MODELS = {
  'MN3207': { label: 'MN3207 (1024 stages, chorus)', stages: 1024, swing: 1.4 },
  'MN3007': { label: 'MN3007 (1024 stages, low noise)', stages: 1024, swing: 1.6 },
  'MN3008': { label: 'MN3008 (2048 stages)', stages: 2048, swing: 1.4 },
  'MN3005': { label: 'MN3005 (4096 stages, long delay)', stages: 4096, swing: 1.3 },
};

/** BBD clock (an exponential VCO) at control voltage cv. */
export function bbdClock(m, cv) {
  const f = m.fc * Math.pow(2, (cv - 4.5) / (m.vOct || 2));
  return Math.min(2e6, Math.max(m.fc / 16, f));
}
export const bbdDelay = (m, cv) => m.stages / (2 * bbdClock(m, cv));

const GMIN = 1e-12;
const MAX_EXP = 80;

function safeExp(x) {
  return x > MAX_EXP ? Math.exp(MAX_EXP) * (1 + x - MAX_EXP) : Math.exp(x);
}

// Current and conductance of the op-amp rail clamp at internal voltage v:
// G * (softplus(k(v - lim)) - softplus(-k(v + lim))) / k
const CLAMP_G = 1e3, CLAMP_K = 8;
function railClamp(v, lim, G = CLAMP_G) {
  const sp = (u) => (u > 30 ? u : Math.log1p(Math.exp(u)));
  const sg = (u) => 1 / (1 + Math.exp(-u));
  const a = CLAMP_K * (v - lim), b = -CLAMP_K * (v + lim);
  const i = G * (sp(a) - sp(b)) / CLAMP_K;
  const g = G * (sg(a) + sg(b)) + 1e-12;
  return [i, g];
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

// Sparse LU with a fixed pivot order. The circuit's matrix has the same
// structure every time step, so we pick the row order once (by partial
// pivoting on a real Jacobian), work out where fill-in appears, and keep a
// list of exactly which entries each elimination step touches. Per solve this
// is several times cheaper than dense elimination.
class SparseLU {
  constructor(A, pattern, n) {
    this.n = n;
    // choose row permutation from a dense pivoted factorisation
    const M = Float64Array.from(A);
    const perm = Int32Array.from({ length: n }, (_, i) => i);
    for (let k = 0; k < n; k++) {
      let p = k, max = Math.abs(M[k * n + k]);
      for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > max) { max = v; p = i; } }
      if (p !== k) {
        for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; }
        const t = perm[k]; perm[k] = perm[p]; perm[p] = t;
      }
      const piv = M[k * n + k];
      if (piv === 0) continue;
      for (let i = k + 1; i < n; i++) {
        const f = M[i * n + k] / piv;
        if (f) for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      }
    }
    this.perm = perm;
    // symbolic factorisation on the permuted pattern
    const P = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let j = 0; j < n; j++) P[r * n + j] = pattern[perm[r] * n + j];
    for (let k = 0; k < n; k++) P[k * n + k] = 1;
    this.rows = []; this.cols = [];
    for (let k = 0; k < n; k++) {
      const rows = [], cols = [];
      for (let i = k + 1; i < n; i++) if (P[i * n + k]) rows.push(i);
      for (let j = k + 1; j < n; j++) if (P[k * n + j]) cols.push(j);
      for (const i of rows) for (const j of cols) P[i * n + j] = 1;
      this.rows.push(Int32Array.from(rows));
      this.cols.push(Int32Array.from(cols));
    }
    this.M = new Float64Array(n * n);
    this.y = new Float64Array(n);
  }

  // Solve A x = b; result written into b. Returns false on a bad pivot.
  solve(A, b) {
    const { n, M, y, perm, rows, cols } = this;
    for (let r = 0; r < n; r++) {
      const src = perm[r] * n, dst = r * n;
      for (let j = 0; j < n; j++) M[dst + j] = A[src + j];
      y[r] = b[perm[r]];
    }
    for (let k = 0; k < n; k++) {
      const piv = M[k * n + k];
      if (!(Math.abs(piv) > 1e-280)) return false;
      const R = rows[k], C = cols[k], kn = k * n;
      for (let a = 0; a < R.length; a++) {
        const i = R[a], in_ = i * n;
        const f = M[in_ + k] / piv;
        if (f === 0) continue;
        for (let c = 0; c < C.length; c++) { const j = C[c]; M[in_ + j] -= f * M[kn + j]; }
        y[i] -= f * y[k];
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      let sum = y[k];
      const C = cols[k], kn = k * n;
      for (let c = 0; c < C.length; c++) { const j = C[c]; sum -= M[kn + j] * y[j]; }
      y[k] = sum / M[kn + k];
      if (!Number.isFinite(y[k])) return false;
    }
    b.set(y);
    return true;
  }
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
    this.abstol = opts.abstol ?? 1e-5;
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
    const oldBbds = keepState ? this.bbds || [] : [], oldCmps = keepState ? this.cmps || [] : [];
    this.res = []; this.caps = []; this.vsrc = []; this.diodes = []; this.bjts = []; this.opamps = []; this.fets = [];
    this.bbds = []; this.cmps = [];
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
        case 'M': {
          const { vth = 2, kp = 0.1, lambda = 0.02, Is = 1e-12, n = 1.25 } = e.model || {};
          this.fets.push({ d: nd[0], g: nd[1], s: nd[2], vth, kp, lambda, vgs: 0, vds: 0 });
          // body diode: anode at the source (body tied to it), cathode at the drain
          const vt = n * VT;
          this.diodes.push({ a: nd[2], k: nd[0], Is, vt, vcrit: vt * Math.log(vt / (Math.SQRT2 * Is)), vd: 0 });
          break;
        }
        case 'OA': {
          // Macro-model: a saturating transconductance (slew limit) charges an
          // internal integrator node z (dominant pole -> gain-bandwidth). z is
          // clamped near the rails (no integrator wind-up) and the output
          // follows it: vo = vmid + vz.
          const { A = 1e5, gbw = 1e6, slew = 1e6, vmid = 4.5, vsat = 3.5 } = e.model || {};
          const z = extra++;
          const Cz = A / (2 * Math.PI * gbw); // with a 1 ohm load on z
          this.caps.push({ a: z, b: -1, C: Cz, v: 0, i: 0, be: true });
          // the rail clamp must out-pull the slew current, or a fast chip driven hard swings past its rails
          this.opamps.push({ p: nd[0], n: nd[1], o: nd[2], z, gm: A, imax: slew * Cz, clampG: Math.max(CLAMP_G, 20 * slew * Cz), vmid, vsat, row: extra++ });
          break;
        }
        case 'CMP': {
          // Op-amp wired as a comparator (e.g. the Schmitt trigger in an LFO).
          // Its output is decided from the previous sample's inputs, so the
          // positive feedback that gives it hysteresis never has to be solved
          // implicitly (backward Euler would damp it and the LFO would stall).
          const { vmid = 4.5, vsat = 3.5 } = e.model || {};
          const old = oldCmps[this.cmps.length];
          this.cmps.push({ p: nd[0], n: nd[1], o: nd[2], vmid, vsat, row: extra++, held: old ? old.held : vmid });
          break;
        }
        case 'BBD': {
          const m = e.model;
          const old = oldBbds[this.bbds.length];
          const b = { in: nd[0], out: nd[1], cv: nd[2], m, row: extra++, held: old ? old.held : 0, phase: 0, buf: null, w: 0, delay: 0 };
          if (old && old.buf) { b.buf = old.buf; b.w = old.w; b.phase = old.phase; b.delay = old.delay; }
          this.bbds.push(b);
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
    this.nonlinear = this.diodes.length + this.bjts.length + this.opamps.length + this.fets.length > 0;
    this.sparse = null;
    this._oldCaps = this.caps;
    // a value edit can change a delay chip's size: resize its line, keep its output
    for (const b of this.bbds) {
      const need = Math.ceil(b.m.stages / (2 * (b.m.fc / 16)) * this.fs) + 4;
      if (!b.buf || b.buf.length !== need) {
        const v = b.buf ? b.held : (b.in >= 0 && this.x[b.in]) || 4.5;
        const held = b.held || v;
        this._bbdReset(b, v, b.cv >= 0 ? this.x[b.cv] || 4.5 : 4.5);
        b.held = held;
      }
    }
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
    const trap = this.method !== 'be';
    for (const c of this.caps) {
      c.geq = dc ? 0 : (trap && !c.be ? 2 : 1) * c.C * this.fs;
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
    // comparator / BBD outputs are voltage sources whose value is set per step
    for (const c of this.cmps) { add(c.o, c.row, 1); add(c.row, c.o, 1); }
    for (const b of this.bbds) {
      add(b.out, b.row, 1); add(b.row, b.out, 1);
      // at DC (and in the AC sweep) a delay line is just a unity buffer
      if (dc) add(b.row, b.in, -1);
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
      if (!this._solve(A, b, n)) return false;
      // Damped steps once plain Newton has had its chance: stops it bouncing
      // between two states when an op-amp sits right at a rail.
      const damp = 1;
      for (let i = 0; i < n; i++) x[i] = xOld[i] + damp * (b[i] - xOld[i]);
      this.stats.iterations++;
      if (!this.nonlinear) return true;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(b[i] - xOld[i]);
        if (d > this.abstol + 1e-4 * Math.abs(b[i])) { ok = false; break; }
      }
      if (ok) { x.set(b); return true; }
    }
    return false;
  }

  _solve(A, b, n) {
    if (!this.sparse) this.sparse = new SparseLU(A, this._pattern(), n);
    // SparseLU works on its own copy, so A and b are intact if it fails
    if (this.sparse.solve(A, b)) return true;
    // pivot went bad at this operating point: re-pick the order next time
    this.sparse = null;
    return luSolve(A, b, n);
  }

  // Every matrix entry that can ever be non-zero.
  _pattern() {
    const n = this.n, P = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) if (this.base[i] !== 0) P[i] = 1;
    for (let i = 0; i < n; i++) P[i * n + i] = 1;
    const mark = (list) => { for (const i of list) for (const j of list) if (i >= 0 && j >= 0) P[i * n + j] = 1; };
    for (const c of this.caps) mark([c.a, c.b]);
    for (const d of this.diodes) mark([d.a, d.k]);
    for (const q of this.bjts) mark([q.c, q.b, q.e]);
    for (const f of this.fets) mark([f.d, f.g, f.s]);
    for (const o of this.opamps) {
      for (const j of [o.p, o.n, o.z]) if (j >= 0) P[o.z * n + j] = 1;
      for (const j of [o.z, o.o]) if (j >= 0) P[o.row * n + j] = 1;
      if (o.o >= 0) P[o.o * n + o.row] = 1;
    }
    for (const c of this.cmps) { if (c.o >= 0) { P[c.o * n + c.row] = 1; P[c.row * n + c.o] = 1; } }
    for (const b of this.bbds) {
      if (b.out >= 0) { P[b.out * n + b.row] = 1; P[b.row * n + b.out] = 1; }
      if (b.in >= 0) P[b.row * n + b.in] = 1;
    }
    return P;
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

    for (const f of this.fets) {
      // limit how far the gate and drain voltages move per iteration
      let vgs = V(f.g) - V(f.s), vds = V(f.d) - V(f.s);
      if (Math.abs(vgs - f.vgs) > 0.5) vgs = f.vgs + 0.5 * Math.sign(vgs - f.vgs);
      if (Math.abs(vds - f.vds) > 2) vds = f.vds + 2 * Math.sign(vds - f.vds);
      f.vgs = vgs; f.vds = vds;
      // the channel is symmetric: with vds < 0 the drain and source swap roles
      let d = f.d, s = f.s, vg = vgs, vd = vds;
      if (vds < 0) { d = f.s; s = f.d; vg = vgs - vds; vd = -vds; }
      const [id, gm, gds] = mosfetId(f, vg, vd);
      const g0 = 1e-12;
      const ieq = id - gm * vg - gds * vd;
      // current id flows from d to s
      add(d, d, gds + g0); add(d, s, -gds - gm - g0); add(d, f.g, gm); inj(d, -ieq);
      add(s, d, -gds - g0); add(s, s, gds + gm + g0); add(s, f.g, -gm); inj(s, ieq);
    }

    for (const o of this.opamps) {
      // transconductance into z: i = imax * tanh(gm * vd / imax)
      const vd = V(o.p) - V(o.n);
      const ti = Math.tanh(o.gm * vd / o.imax);
      const gi = o.gm * (1 - ti * ti) + 1e-9;
      add(o.z, o.p, -gi); add(o.z, o.n, gi);
      b[o.z] += o.imax * ti - gi * vd;
      // rail clamp on z: smooth, exponentially small inside the rails.
      // Limit how far z moves per iteration (like pnjlim for junctions).
      let vz = x[o.z];
      if (o.vzl !== undefined && Math.abs(vz - o.vzl) > 1) vz = o.vzl + Math.sign(vz - o.vzl);
      o.vzl = vz;
      const [ic, gc] = railClamp(vz, o.vsat, o.clampG);
      add(o.z, o.z, gc);
      b[o.z] -= ic - gc * vz;
      // output: vo = vmid + vz
      add(o.row, o.z, -1);
      b[o.row] += o.vmid * srcScale;
    }
  }

  _rhs(vin, dc, srcScale = 1) {
    const rhs = new Float64Array(this.n);
    for (const v of this.vsrc) rhs[v.row] = v.V * srcScale;
    for (const c of this.cmps) rhs[c.row] = c.held * srcScale;
    if (this.input && vin) {
      const I = vin * this.input.g;
      if (this.input.p >= 0) rhs[this.input.p] += I;
      if (this.input.m >= 0) rhs[this.input.m] -= I;
    }
    if (!dc) {
      const trap = this.method !== 'be';
      for (const c of this.caps) {
        const h = c.geq * c.v + (trap && !c.be ? c.i : 0);
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
    for (const f of this.fets) { f.vgs = 0; f.vds = 0; }
    for (const c of this.cmps) c.held = c.vmid;
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
    // start each LFO swinging (a real one starts from power-on noise)
    for (const c of this.cmps) c.held = c.vmid + c.vsat;
    for (const b of this.bbds) this._bbdReset(b, V(b.in), V(b.cv));
    this._stampLinear(false);
    this._rhsBuf = new Float64Array(this.n);
    return ok;
  }

  _bbdReset(b, vin, cv) {
    const m = b.m;
    const maxDelay = m.stages / (2 * (m.fc / 16));
    const len = Math.ceil(maxDelay * this.fs) + 4;
    if (!b.buf || b.buf.length !== len) b.buf = new Float32Array(len);
    b.buf.fill(vin);
    b.w = 0;
    b.phase = 0;
    b.held = vin;
    b.delay = bbdDelay(m, cv);
  }

  // Advance delay lines and comparators by one sample (after the circuit solve).
  _clockDevices() {
    const x = this.x;
    const V = (i) => (i >= 0 ? x[i] : 0);
    for (const c of this.cmps) {
      const vd = V(c.p) - V(c.n);
      c.held = c.vmid + c.vsat * Math.tanh(vd * 1e4);
    }
    const fs = this.fs;
    for (const b of this.bbds) {
      const buf = b.buf, len = buf.length;
      buf[b.w] = V(b.in);
      const m = b.m;
      const f = bbdClock(m, V(b.cv));
      b.delay = m.stages / (2 * f);
      // The BBD only moves a new sample to its output once per clock period:
      // at slow clocks (long delays) this sample-and-hold is what makes a
      // BBD delay dark and gritty. Real circuits filter it afterwards.
      b.phase += f / fs;
      if (b.phase >= 1) {
        b.phase -= Math.floor(b.phase);
        let d = b.delay * fs;
        if (d > len - 3) d = len - 3;
        if (d < 1) d = 1;
        const i = Math.floor(d), frac = d - i;
        const a = buf[(b.w - i + len) % len], c = buf[(b.w - i - 1 + len) % len];
        const v = a + (c - a) * frac;
        // limited headroom around the chip's bias
        const sw = m.swing || 1.4, vb = m.vbias ?? 4.5;
        b.held = vb + sw * Math.tanh((v - vb) / sw);
      }
      b.w = (b.w + 1) % len;
    }
  }

  /** Node voltages (by node number, 0 = ground) of the last solution. */
  nodeVoltage(node) { return node === 0 ? 0 : this.x[node - 1]; }

  /** Simulate one sample. vin in volts. Returns the output node voltage. */
  step(vin) {
    this.stats.steps++;
    const prev = this.vinPrev ?? vin;
    if (!this._tryStep(vin, 25)) {
      // Newton didn't converge: roll back and cross this sample in smaller
      // time steps (input interpolated), like SPICE's timestep control.
      this._restore();
      if (!this._substep(prev, vin, 1)) this.stats.failures++;
    }
    this.vinPrev = vin;
    if (this.cmps.length || this.bbds.length) this._clockDevices();
    const o = this.out;
    return o >= 0 ? this.x[o] : 0;
  }

  _substep(v0, v1, depth) {
    const fs = this.fs;
    this.fs = fs * 2;
    this._stampLinear(false);
    let ok = true;
    for (const vin of [(v0 + v1) / 2, v1]) {
      if (!this._tryStep(vin, 25)) {
        if (depth < 6) {
          this._restore();
          const from = vin === v1 ? (v0 + v1) / 2 : v0;
          ok = this._substep(from, vin, depth + 1) && ok;
        } else {
          ok = false; // accept the best estimate and move on
          this._commitCaps();
        }
      }
    }
    this.fs = fs;
    this._stampLinear(false);
    return ok;
  }

  // Save solver + capacitor state, then attempt one time step. On success the
  // capacitors are advanced; on failure the caller can _restore().
  _tryStep(vin, maxIter) {
    this._save();
    const rhs = this._rhsBuf;
    rhs.fill(0);
    for (const v of this.vsrc) rhs[v.row] = v.V;
    for (const c of this.cmps) rhs[c.row] = c.held;
    for (const b of this.bbds) rhs[b.row] = b.held;
    if (this.input) {
      const I = vin * this.input.g;
      if (this.input.p >= 0) rhs[this.input.p] += I;
      if (this.input.m >= 0) rhs[this.input.m] -= I;
    }
    const trap = this.method !== 'be';
    for (const c of this.caps) {
      const h = c.geq * c.v + (trap && !c.be ? c.i : 0);
      if (c.a >= 0) rhs[c.a] += h;
      if (c.b >= 0) rhs[c.b] -= h;
    }
    const ok = this._newton(rhs, maxIter);
    if (ok) this._commitCaps();
    return ok;
  }

  _commitCaps() {
    const x = this.x, trap = this.method !== 'be';
    for (const c of this.caps) {
      const v = (c.a >= 0 ? x[c.a] : 0) - (c.b >= 0 ? x[c.b] : 0);
      c.i = trap && !c.be ? c.geq * (v - c.v) - c.i : c.geq * (v - c.v);
      c.v = v;
    }
  }

  _save() {
    const nj = this.diodes.length + 2 * this.bjts.length + this.opamps.length + 2 * this.fets.length;
    if (!this._saved || this._saved.x.length !== this.n || this._saved.cv.length !== this.caps.length || this._saved.j.length !== nj) {
      this._saved = { x: new Float64Array(this.n), cv: new Float64Array(this.caps.length), ci: new Float64Array(this.caps.length), j: new Float64Array(nj) };
    }
    const s = this._saved;
    s.x.set(this.x);
    const caps = this.caps;
    for (let i = 0; i < caps.length; i++) { s.cv[i] = caps[i].v; s.ci[i] = caps[i].i; }
    let k = 0;
    for (const d of this.diodes) s.j[k++] = d.vd;
    for (const q of this.bjts) { s.j[k++] = q.vbe; s.j[k++] = q.vbc; }
    for (const o of this.opamps) s.j[k++] = o.vzl ?? 0;
    for (const f of this.fets) { s.j[k++] = f.vgs; s.j[k++] = f.vds; }
  }

  _restore() {
    const s = this._saved;
    this.x.set(s.x);
    this.caps.forEach((c, i) => { c.v = s.cv[i]; c.i = s.ci[i]; });
    let k = 0;
    for (const d of this.diodes) d.vd = s.j[k++];
    for (const q of this.bjts) { q.vbe = s.j[k++]; q.vbc = s.j[k++]; }
    for (const o of this.opamps) o.vzl = s.j[k++];
    for (const f of this.fets) { f.vgs = s.j[k++]; f.vds = s.j[k++]; }
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
    for (const f of this.fets) {
      let d = f.d, s = f.s, vg = V(f.g) - V(f.s), vd = V(f.d) - V(f.s);
      if (vd < 0) { d = f.s; s = f.d; vg -= vd; vd = -vd; }
      const [, gm, gds] = mosfetId(f, vg, vd);
      addG(d, d, gds); addG(d, s, -gds - gm); addG(d, f.g, gm);
      addG(s, d, -gds); addG(s, s, gds + gm); addG(s, f.g, -gm);
    }
    for (const o of this.opamps) {
      const ti = Math.tanh(o.gm * (V(o.p) - V(o.n)) / o.imax);
      const gi = o.gm * (1 - ti * ti) + 1e-9;
      addG(o.z, o.p, -gi); addG(o.z, o.n, gi);
      addG(o.z, o.z, railClamp(x[o.z], o.vsat, o.clampG)[1]);
      addG(o.row, o.z, -1);
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
