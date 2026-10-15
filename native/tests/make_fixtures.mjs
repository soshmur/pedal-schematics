// Writes each pedal's netlist plus the JS engine's output for a test signal, so the
// Rust port can be checked against the reference implementation sample by sample.
//   node native/tests/make_fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { Circuit } from '../../js/engine.js';
import { PEDALS } from '../../js/pedals.js';
import { buildNetlist } from '../../js/schematic.js';

mkdirSync('native/tests/fixtures', { recursive: true });
const FS = 96000, N = 9600 * 3;   // 0.3 s at 2x of 48 kHz
const sig = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const t = i / FS;
  // a plucked A2 + E3 dyad with a decaying envelope, loud enough to clip every pedal
  sig[i] = 0.4 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 164.8 * t)) +
           0.05 * Math.sin(2 * Math.PI * 1500 * t);
}
for (const def of PEDALS) {
  const full = buildNetlist(def);
  const net = { nodeCount: full.nodeCount, output: full.output, elements: full.elements };
  const c = new Circuit(net, FS);
  const dc = Array.from(c.x);
  const out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = c.step(sig[i]);
  // a knob change mid-stream (same topology): every value scaled a little
  const net2 = JSON.parse(JSON.stringify(net));
  for (const e of net2.elements) if (e.type === 'R') e.R *= 1.1;
  c.update(net2);
  const out2 = [];
  for (let i = 0; i < 4800; i++) out2.push(c.step(sig[i]));
  writeFileSync(`native/tests/fixtures/${def.key}.json`, JSON.stringify({
    fs: FS, net, net2, input: Array.from(sig), dc, dcConverged: c.dcConverged, out, out2, failures: c.stats.failures,
  }));
  console.log(def.key, 'elements', net.elements.length, 'nodes', net.nodeCount, 'types', [...new Set(net.elements.map(e => e.type))].join(','));
}
