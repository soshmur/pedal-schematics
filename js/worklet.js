// AudioWorklet: runs the circuit simulation on the audio thread.
// Messages in:  { type: 'netlist', net } | { type: 'bypass', on } | { type: 'oversample', factor }
// Messages out: { type: 'stats', failures, steps, itsPerSample, ok }
import { Circuit } from './engine.js';

// 2nd-order low-pass section (RBJ cookbook), used for the decimation filter.
function lowpass(fc, fs, q) {
  const w = 2 * Math.PI * fc / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  const a0 = 1 + a;
  return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, z1: 0, z2: 0 };
}
function biquad(f, x) {
  const y = f.b0 * x + f.z1;
  f.z1 = f.b1 * x - f.a1 * y + f.z2;
  f.z2 = f.b2 * x - f.a2 * y;
  return y;
}

class PedalProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // volts at the pedal input for a full-scale (1.0) sample
    return [{ name: 'inputVolts', defaultValue: 0.4, minValue: 0.01, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.circuit = null;
    this.bypass = false;
    this.os = 2;
    this.prevIn = 0;
    this.dc = { x: 0, y: 0 };
    this.lastStats = 0;
    this.pending = null;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg.type === 'netlist') {
      this.pending = msg.net;
      this.netForRebuild = msg.net;
    } else if (msg.type === 'bypass') {
      this.bypass = msg.on;
    } else if (msg.type === 'oversample') {
      this.os = msg.factor;
      if (this.netForRebuild) this.build(this.netForRebuild);
    }
  }

  build(net) {
    const fs = sampleRate * this.os;
    if (this.circuit && this.circuit.fs === fs) {
      this.circuit.update(net); // keeps state when only values changed
    } else {
      this.circuit = new Circuit(net, fs);
    }
    // 4th-order Butterworth at 0.45·fs (only used when oversampling)
    this.aa = [lowpass(sampleRate * 0.45, fs, 0.5412), lowpass(sampleRate * 0.45, fs, 1.3066)];
    this.dcOffset = this.circuit.nodeVoltage(net.output);
  }

  process(inputs, outputs, params) {
    const t0 = Date.now();
    const out = outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    if (this.pending) { this.build(this.pending); this.pending = null; }
    const gain = params.inputVolts[0];
    const c = this.circuit;
    const os = this.os;
    for (let i = 0; i < out.length; i++) {
      const x = (inp ? inp[i] : 0) * gain;
      let y;
      if (this.bypass || !c) {
        y = x;
      } else if (os === 1) {
        y = c.step(x);
      } else {
        // linear-interpolated upsampling, filtered decimation
        for (let k = 1; k <= os; k++) {
          const xi = this.prevIn + (x - this.prevIn) * (k / os);
          y = biquad(this.aa[1], biquad(this.aa[0], c.step(xi)));
        }
      }
      this.prevIn = x;
      // DC blocker (~5 Hz) so a pedal's bias voltage never reaches the speakers
      const d = this.dc;
      const yy = y - d.x + 0.9993 * d.y;
      d.x = y; d.y = yy;
      out[i] = yy;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);

    // CPU load: time spent here vs. the audio time it produced
    this.busy = (this.busy || 0) + (Date.now() - t0);
    if (c && currentTime - this.lastStats > 0.5) {
      const span = (currentTime - this.lastStats) * 1000;
      const load = this.lastStats ? this.busy / span : 0;
      this.lastStats = currentTime;
      this.busy = 0;
      this.port.postMessage({
        type: 'stats',
        load,
        os: this.os,
        failures: c.stats.failures,
        steps: c.stats.steps,
        itsPerSample: c.stats.steps ? c.stats.iterations / c.stats.steps : 0,
        ok: c.dcConverged,
      });
      c.stats.failures = 0; c.stats.steps = 0; c.stats.iterations = 0;
    }
    return true;
  }
}

registerProcessor('pedal-processor', PedalProcessor);
