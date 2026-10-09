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
