import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Circuit } from '../js/engine.js';
import { PEDALS, pedalByKey } from '../js/pedals.js';
import { buildNetlist, connectivity, renderSVG, toSpice } from '../js/schematic.js';
import { formatSI } from '../js/units.js';

const FS = 48000;

// Node voltage at a part's pin
const pinVoltage = (def, circuit, net, partId, pin) => circuit.nodeVoltage(net.pinNodes[partId][pin]);

for (const def of PEDALS) {
  test(`${def.name}: schematic is fully wired`, () => {
    const { warnings } = connectivity(def);
    assert.deepEqual(warnings, []);
    const net = buildNetlist(def);
    assert.ok(net.output > 0, 'has an output node');
    assert.ok(net.elements.some((e) => e.type === 'VIN'), 'has an input');
    const svg = renderSVG(def, {}, { formatSI });
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.match(toSpice(def, net), /\.end$/);
  });

  test(`${def.name}: biases, passes audio, and stays stable`, () => {
    const net = buildNetlist(def);
    const c = new Circuit(net, FS);
    assert.ok(c.dcConverged, 'DC operating point converged');
    const { mag } = c.acSweep([1000]);
    assert.ok(isFinite(mag[0]) && mag[0] > -40, 'small-signal gain at 1k: ' + mag[0].toFixed(1) + ' dB');
    // half a second of a loud 220 Hz note
    let peak = 0, sumsq = 0;
    for (let i = 0; i < FS / 2; i++) {
      const y = c.step(0.5 * Math.sin(2 * Math.PI * 220 * i / FS));
      if (i > FS / 4) { peak = Math.max(peak, Math.abs(y)); sumsq += y * y; }
      assert.ok(Number.isFinite(y), 'finite output');
    }
    assert.ok(peak > 0.01 && peak < 9, 'output peak ' + peak);
    assert.ok(c.stats.failures / c.stats.steps < 0.001, `Newton failures ${c.stats.failures}/${c.stats.steps}`);
  });
}

test('Booster: transistor bias and gain ≈ R3/R4', () => {
  const def = pedalByKey('booster');
  const net = buildNetlist(def, { knobs: { VR1: 1 } });
  const c = new Circuit(net, FS);
  const vc = pinVoltage(def, c, net, 'Q1', 0);
  const ve = pinVoltage(def, c, net, 'Q1', 2);
  assert.ok(vc > 3 && vc < 6.5, 'collector ' + vc);
  assert.ok(ve > 0.1 && ve < 0.4, 'emitter ' + ve);
  const { mag } = c.acSweep([1000]);
  assert.ok(mag[0] > 24 && mag[0] < 29, 'gain ' + mag[0]); // ≈ 20log(10k/390)=28 minus loading
});

test('Electra: collector-feedback bias, then diodes clamp the output', () => {
  const def = pedalByKey('electra');
  const net = buildNetlist(def, { knobs: { VR1: 1 } });
  const c = new Circuit(net, FS);
  const vc = pinVoltage(def, c, net, 'Q1', 0);
  assert.ok(vc > 5.5 && vc < 8, 'collector ' + vc); // 0.65 V + Ic·(R2 + R1/hFE) with Ic = (9 − Vc)/R3
  // a loud note is clamped near the Schottky drop (~0.3 V) at full volume
  let peak = 0;
  for (let i = 0; i < FS / 2; i++) {
    const y = c.step(0.5 * Math.sin(2 * Math.PI * 220 * i / FS));
    if (i > FS / 4) peak = Math.max(peak, Math.abs(y));
  }
  assert.ok(peak > 0.15 && peak < 0.45, 'clipped peak ' + peak);
});

test('OCD: MOSFET + germanium clipping is asymmetric, gain tracks the Drive knob', () => {
  const def = pedalByKey('ocd');
  const lo = new Circuit(buildNetlist(def, { knobs: { VR1: 0, VR3: 1 } }), FS).acSweep([1000]).mag[0];
  const hi = new Circuit(buildNetlist(def, { knobs: { VR1: 1, VR3: 1 } }), FS).acSweep([1000]).mag[0];
  assert.ok(hi - lo > 20, `drive range ${lo.toFixed(1)} -> ${hi.toFixed(1)} dB`);
  // at the app's 2x oversampled rate (a sharp clipping edge overshoots for a sample at 1x)
  const fs = 2 * FS;
  const net = buildNetlist(def, { knobs: { VR1: 1, VR3: 1 } });
  const c = new Circuit(net, fs);
  const clip = net.pinNodes.R7[1];
  const vb = c.nodeVoltage(clip);
  let top = -9, bot = 9;
  for (let i = 0; i < fs / 2; i++) {
    c.step(0.3 * Math.sin(2 * Math.PI * 220 * i / fs));
    if (i > fs / 4) { const v = c.nodeVoltage(clip) - vb; top = Math.max(top, v); bot = Math.min(bot, v); }
  }
  // bottom: Q1 body diode (~0.6 V); top: 1N34 + Q2 body diode (~0.9-1 V)
  assert.ok(bot < -0.5 && bot > -0.85, 'bottom ' + bot);
  assert.ok(top > 0.8 && top < 1.2, 'top ' + top);
});

test('Fuzz Face: Q2 collector sits mid-supply-ish', () => {
  const def = pedalByKey('fuzz');
  const net = buildNetlist(def);
  const c = new Circuit(net, FS);
  const vc2 = pinVoltage(def, c, net, 'Q2', 0);
  const vb1 = pinVoltage(def, c, net, 'Q1', 1);
  assert.ok(vb1 > 0.5 && vb1 < 0.7, 'Q1 base ' + vb1);
  assert.ok(vc2 > 4 && vc2 < 5, 'Q2 collector ' + vc2);
});

test('Screamer: Drive pot changes clipping-stage gain as 1+(R2+Drive)/R3', () => {
  const def = pedalByKey('screamer');
  // measure at the op-amp output by making it the output node: compare two drive settings
  const lo = new Circuit(buildNetlist(def, { knobs: { VR1: 0, VR3: 1, VR2: 1 } }), FS).acSweep([2000]).mag[0];
  const hi = new Circuit(buildNetlist(def, { knobs: { VR1: 1, VR3: 1, VR2: 1 } }), FS).acSweep([2000]).mag[0];
  // small-signal: diodes are off, so gain goes (1+51k/4.7k)=11.9 -> (1+551k/4.7k)=118: +20 dB
  assert.ok(Math.abs((hi - lo) - 19.9) < 1.5, `drive range ${(hi - lo).toFixed(2)} dB`);
});

test('Rodent: Filter knob turned up darkens the sound', () => {
  const def = pedalByKey('rodent');
  const f = [5000];
  const open = new Circuit(buildNetlist(def, { knobs: { VR2: 0 } }), FS).acSweep(f).mag[0];
  const dark = new Circuit(buildNetlist(def, { knobs: { VR2: 1 } }), FS).acSweep(f).mag[0];
  assert.ok(open - dark > 10, `5 kHz drop ${(open - dark).toFixed(1)} dB`);
});

test('changing a value keeps state (no topology change)', () => {
  const def = pedalByKey('screamer');
  const c = new Circuit(buildNetlist(def), FS);
  const sig = c.signature;
  c.update(buildNetlist(def, { values: { R3: 2200 } }));
  assert.equal(c.signature, sig);
  c.update(buildNetlist(def, { models: { D1: 'none' } }));
  assert.notEqual(c.signature, sig);
  assert.ok(c.dcConverged);
});

test('real-time budget: each pedal simulates faster than real time', () => {
  for (const def of PEDALS) {
    const c = new Circuit(buildNetlist(def), FS * 2);
    const n = FS; // half a second at 2x oversampling
    const t0 = performance.now();
    for (let i = 0; i < n; i++) c.step(0.8 * Math.sin(2 * Math.PI * 110 * i / (FS * 2)));
    const ms = performance.now() - t0;
    const realtime = (n / (FS * 2)) * 1000;
    console.log(`  ${def.name}: ${(ms / realtime * 100).toFixed(1)}% of real time at 2x, ` +
      `${(c.stats.iterations / c.stats.steps).toFixed(2)} Newton its/sample`);
    assert.ok(ms < realtime, `${def.name} too slow: ${ms.toFixed(0)} ms for ${realtime} ms`);
  }
});

test('awkward builds still converge: LED clipping, tiny R3, germanium fuzz, slow op-amp', async () => {
  const { renderRiff } = await import('../js/riffs.js');
  const riff = renderRiff('pentatonic', FS * 2).subarray(0, FS);
  const builds = [
    ['screamer', { models: { D1: 'LED' }, values: { R3: 1000 } }],
    ['screamer', { models: { D1: 'none', D2: 'none' }, knobs: { VR1: 1 } }],
    ['fuzz', { models: { Q1: 'Ge', Q2: 'Ge' }, hfe: { Q1: 60, Q2: 90 } }],
    ['rodent', { models: { U1: 'TL072', D1: '1N34A', D2: 'LED' }, knobs: { VR1: 1 } }],
  ];
  for (const [key, st] of builds) {
    const c = new Circuit(buildNetlist(pedalByKey(key), st), FS * 2);
    for (let i = 0; i < riff.length; i++) {
      const y = c.step(riff[i] * 0.8);
      assert.ok(Number.isFinite(y) && Math.abs(y) < 20, `${key} output ${y}`);
    }
    assert.ok(c.stats.failures / c.stats.steps < 1e-4, `${key} ${JSON.stringify(st)}: ${c.stats.failures} Newton failures`);
  }
});

// ---------------------------------------------------------------- time-based pedals

// Feed a short tone burst and return the times (ms) of the loud peaks in the output.
function echoTimes(def, st, seconds) {
  const fs = 48000;
  const c = new Circuit(buildNetlist(def, st), fs);
  const out = [];
  const burst = (i) => (i >= 100 && i < 100 + fs * 0.004 ? 0.5 * Math.sin(2 * Math.PI * 500 * (i - 100) / fs) : 0);
  for (let i = 0; i < fs * seconds; i++) out.push(c.step(burst(i)));
  const base = out[90];
  const env = out.map((y) => Math.abs(y - base));
  const peaks = [];
  const win = Math.round(fs * 0.01);
  const thr = 0.05 * Math.max(...env);
  for (let i = 200; i < env.length - win; i++) {
    const t = ((i - 100) / fs) * 1000;
    // the BBD's sample-and-hold makes flat tops, so keep one peak per 10 ms
    if (env[i] > thr && env.slice(i - win, i + win).every((v) => v <= env[i]) && !(peaks.length && t - peaks[peaks.length - 1] < 10)) peaks.push(t);
  }
  return { peaks, failures: c.stats.failures };
}

test('Analog Delay: echo arrives at stages / (2 · clock) and repeats', async () => {
  const { bbdDelay, BBD_MODELS } = await import('../js/engine.js');
  const def = pedalByKey('echo');
  const st = { knobs: { VR1: 0.5, VR2: 0.85 } };
  const net = buildNetlist(def, st);
  const c = new Circuit(net, FS);
  const bbd = net.elements.find((e) => e.type === 'BBD');
  const expected = bbdDelay(bbd.model, c.nodeVoltage(bbd.nodes[2])) * 1000;
  const { peaks, failures } = echoTimes(def, st, 0.5);
  assert.equal(failures, 0);
  assert.ok(peaks.length >= 3, `expected the dry hit plus repeats, got ${peaks.map((t) => t.toFixed(1))}`);
  const gap1 = peaks[1] - peaks[0], gap2 = peaks[2] - peaks[1];
  assert.ok(Math.abs(gap1 - expected) < 1.5, `first echo after ${gap1.toFixed(1)} ms, expected ${expected.toFixed(1)} ms`);
  // U1 inverts every pass, so the loudest cycle of the 500 Hz burst can move by one period (2 ms)
  assert.ok(Math.abs(gap2 - expected) < 2.5, `second echo after ${gap2.toFixed(1)} ms`);
  assert.equal(BBD_MODELS.MN3005.stages, 4096);
});

test('Analog Delay: Time knob spans roughly 20–300 ms', async () => {
  const { bbdDelay } = await import('../js/engine.js');
  const def = pedalByKey('echo');
  const ms = (pos) => {
    const net = buildNetlist(def, { knobs: { VR1: pos } });
    const c = new Circuit(net, FS);
    const b = net.elements.find((e) => e.type === 'BBD');
    return bbdDelay(b.model, c.nodeVoltage(b.nodes[2])) * 1000;
  };
  const short = ms(0), long = ms(1);
  assert.ok(short > 15 && short < 30, 'shortest ' + short);
  assert.ok(long > 250 && long < 350, 'longest ' + long);
  assert.ok(ms(0.5) > short && ms(0.5) < long);
});

test('Analog Delay: Repeat at max with a smaller R5 self-oscillates but stays bounded', () => {
  const def = pedalByKey('echo');
  const c = new Circuit(buildNetlist(def, { knobs: { VR1: 0.2, VR2: 1 }, values: { R5: 22e3 } }), FS);
  let late = 0;
  for (let i = 0; i < FS * 1.5; i++) {
    const y = c.step(i < 200 ? 0.3 * Math.sin(i / 5) : 0);
    assert.ok(Number.isFinite(y) && Math.abs(y) < 9);
    if (i > FS) late = Math.max(late, Math.abs(y - 4.5));
  }
  assert.ok(late > 0.05, 'runaway repeats should still be ringing after 1 s: ' + late);
});

test('Chorus: LFO rate follows R6 / (4 · R5 · (R7 + Rate) · C4)', () => {
  const def = pedalByKey('chorus');
  for (const [pos, c4] of [[0.4, 1e-6], [0.9, 470e-9]]) {
    const st = { knobs: { VR1: pos }, values: { C4: c4 } };
    const net = buildNetlist(def, st);
    const c = new Circuit(net, FS);
    const tri = net.pinNodes.U2[2];
    const cross = [];
    let prev = c.nodeVoltage(tri);
    for (let i = 0; i < FS * 5; i++) {
      c.step(0);
      const v = c.nodeVoltage(tri);
      if (prev < 4.5 && v >= 4.5) cross.push(i);
      prev = v;
    }
    const per = cross.slice(1).map((v, i) => v - cross[i]);
    const f = FS / (per.reduce((a, b) => a + b, 0) / per.length);
    // Rate is a rheostat: R = 1M · (1 − taper(pos))
    const tap = (Math.pow(81, pos) - 1) / 80;
    const expected = 22e3 / (4 * 10e3 * (47e3 + 1e6 * (1 - tap)) * c4);
    assert.ok(Math.abs(f / expected - 1) < 0.03, `LFO ${f.toFixed(3)} Hz vs ${expected.toFixed(3)} Hz`);
    assert.equal(c.stats.failures, 0);
  }
});

test('Chorus: delay sweeps a few milliseconds around ~4 ms', async () => {
  const { bbdDelay } = await import('../js/engine.js');
  const def = pedalByKey('chorus');
  const net = buildNetlist(def, { knobs: { VR1: 0.9, VR2: 1 } });
  const c = new Circuit(net, FS);
  const b = net.elements.find((e) => e.type === 'BBD');
  let lo = Infinity, hi = 0;
  for (let i = 0; i < FS * 2; i++) {
    c.step(0);
    if (i > FS / 2) {
      const d = bbdDelay(b.model, c.nodeVoltage(b.nodes[2])) * 1000;
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
  }
  assert.ok(lo > 2 && lo < 4.5 && hi > 6 && hi < 10, `sweep ${lo.toFixed(2)}–${hi.toFixed(2)} ms`);
});
