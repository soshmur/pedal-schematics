import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Circuit, DIODE_MODELS, BJT_MODELS } from '../js/engine.js';
import { parseValue, formatSI, snapToSeries } from '../js/units.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('value parsing and formatting', () => {
  close(parseValue('4k7'), 4700, 1e-9, '4k7');
  close(parseValue('4.7k'), 4700, 1e-9, '4.7k');
  close(parseValue('47n'), 47e-9, 1e-18, '47n');
  close(parseValue('47nF'), 47e-9, 1e-18, '47nF');
  close(parseValue('2u2'), 2.2e-6, 1e-15, '2u2');
  close(parseValue('100R'), 100, 1e-9, '100R');
  close(parseValue('1M'), 1e6, 1e-6, '1M');
  close(parseValue('1m'), 1e-3, 1e-12, '1m');
  close(parseValue('220Ω'), 220, 1e-9, '220Ω');
  assert.ok(Number.isNaN(parseValue('abc')));
  assert.equal(formatSI(4700), '4.7k');
  assert.equal(formatSI(47e-9), '47n');
  assert.equal(formatSI(1e6), '1M');
  assert.equal(formatSI(2.2e-6), '2.2µ');
  assert.equal(snapToSeries(4600, 'E12'), 4700);
  assert.equal(snapToSeries(5000, 'E24'), 5100);
});

test('RC low-pass: AC corner and transient agree with 1/(2πRC)', () => {
  // in(1) -R- out(2) -C- gnd
  const R = 10e3, C = 15.9e-9; // fc ≈ 1 kHz
  const net = {
    nodeCount: 3, output: 2,
    elements: [
      { id: 'IN', type: 'VIN', nodes: [1, 0], R: 1e-3 },
      { id: 'R1', type: 'R', nodes: [1, 2], R },
      { id: 'C1', type: 'C', nodes: [2, 0], C },
    ],
  };
  const c = new Circuit(net, 96000);
  const fc = 1 / (2 * Math.PI * R * C);
  const { mag } = c.acSweep([fc / 100, fc]);
  close(mag[0], 0, 0.01, 'passband');
  close(mag[1], -3.01, 0.05, 'corner');
  // transient: amplitude of a sine at fc
  let peak = 0;
  for (let i = 0; i < 96000 / 4; i++) {
    const y = c.step(Math.sin(2 * Math.PI * fc * i / 96000));
    if (i > 96000 / 8) peak = Math.max(peak, y);
  }
  close(peak, Math.SQRT1_2, 0.01, 'transient amplitude at fc');
});

test('diode clipper limits to ~0.6 V', () => {
  const net = {
    nodeCount: 3, output: 2,
    elements: [
      { id: 'IN', type: 'VIN', nodes: [1, 0], R: 1 },
      { id: 'R1', type: 'R', nodes: [1, 2], R: 1000 },
      { id: 'D1', type: 'D', nodes: [2, 0], model: DIODE_MODELS['1N914'] },
      { id: 'D2', type: 'D', nodes: [0, 2], model: DIODE_MODELS['1N914'] },
    ],
  };
  const c = new Circuit(net, 48000);
  let max = 0, min = 0;
  for (let i = 0; i < 4800; i++) {
    const y = c.step(5 * Math.sin(2 * Math.PI * 200 * i / 48000));
    max = Math.max(max, y); min = Math.min(min, y);
  }
  assert.ok(max > 0.5 && max < 0.8, 'positive clip ' + max);
  assert.ok(min < -0.5 && min > -0.8, 'negative clip ' + min);
  assert.equal(c.stats.failures, 0);
});

test('non-inverting op-amp gain = 1 + Rf/Rg', () => {
  // vref(3) = 4.5 V; in -> C -> p(1) with 1M to vref; out(2); n(4); Rf 2->4, Rg 4->vref
  const net = {
    nodeCount: 6, output: 2,
    elements: [
      { id: 'IN', type: 'VIN', nodes: [5, 0], R: 1 },
      { id: 'C1', type: 'C', nodes: [5, 1], C: 1e-6 },
      { id: 'Rb', type: 'R', nodes: [1, 3], R: 1e6 },
      { id: 'VREF', type: 'V', nodes: [3, 0], V: 4.5 },
      { id: 'U1', type: 'OA', nodes: [1, 4, 2], model: { A: 1e5, vmid: 4.5, vsat: 4 } },
      { id: 'Rf', type: 'R', nodes: [2, 4], R: 90e3 },
      { id: 'Rg', type: 'R', nodes: [4, 3], R: 10e3 },
    ],
  };
  const c = new Circuit(net, 48000);
  close(c.nodeVoltage(2), 4.5, 1e-3, 'output biased at vref');
  const { mag } = c.acSweep([1000]);
  close(mag[0], 20, 0.05, 'gain of 10 = 20 dB');
});

test('common-emitter BJT stage biases sensibly and amplifies', () => {
  // LPB-1-ish: 9V(1); base(2) 430k to 9V, 43k to gnd; emitter(3) 390R; collector(4) 10k
  const net = {
    nodeCount: 6, output: 4,
    elements: [
      { id: 'V9', type: 'V', nodes: [1, 0], V: 9 },
      { id: 'IN', type: 'VIN', nodes: [5, 0], R: 1 },
      { id: 'C1', type: 'C', nodes: [5, 2], C: 100e-9 },
      { id: 'R1', type: 'R', nodes: [1, 2], R: 430e3 },
      { id: 'R2', type: 'R', nodes: [2, 0], R: 43e3 },
      { id: 'R3', type: 'R', nodes: [3, 0], R: 390 },
      { id: 'R4', type: 'R', nodes: [1, 4], R: 10e3 },
      { id: 'Q1', type: 'Q', nodes: [4, 2, 3], model: { ...BJT_MODELS.Si, bf: 200 } },
    ],
  };
  const c = new Circuit(net, 48000);
  assert.ok(c.dcConverged);
  const vb = c.nodeVoltage(2), ve = c.nodeVoltage(3), vc = c.nodeVoltage(4);
  assert.ok(vb - ve > 0.5 && vb - ve < 0.75, 'Vbe ' + (vb - ve));
  assert.ok(vc > 3 && vc < 7, 'collector ' + vc);
  const { mag } = c.acSweep([1000]);
  assert.ok(mag[0] > 22 && mag[0] < 29, 'gain dB ' + mag[0]);
});
