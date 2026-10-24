// Simulate the OCD exactly as the board wires it (from layout.py), plus pots, HP/LP switch and a guitar.
import { Circuit, MOSFET_MODELS, DIODE_MODELS, OPAMP_MODELS } from '/home/claude/pedal-schematics/js/engine.js';
import { execSync } from 'node:child_process';
const { PARTS, U1 } = JSON.parse(execSync(`cd ${process.cwd()} && python3 -c "
import json; exec(open('layout.py').read().split('# ---- placement')[0]); print(json.dumps({'PARTS':PARTS,'U1':U1}))"`).toString());
const val = (v) => { const m = v.replace('µ', 'u').match(/^([\d.]+)([pnumkM]?)/); return +m[1] * ({ '': 1, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6 }[m[2]]); };
function build(drive, tone, vol, hp) {
  const nodes = { GND: 0 }; let k = 1;
  const N = (n) => (n in nodes ? nodes[n] : (nodes[n] = k++));
  const el = [];
  for (const [id, [t, v, nets]] of Object.entries(PARTS)) {
    const nd = nets.map(N);
    if (t === 'R') el.push({ id, type: 'R', nodes: nd, R: val(v) });
    else if (t === 'C' || t === 'E') el.push({ id, type: 'C', nodes: nd, C: val(v) });
    else if (t === 'D') el.push({ id, type: 'D', nodes: nd, model: DIODE_MODELS[v] || { Is: 1e-6, n: 1.05 } });
    else if (t === 'Q') el.push({ id, type: 'M', nodes: [nd[2], nd[1], nd[0]], model: MOSFET_MODELS['2N7000'] }); // legs S,G,D
  }
  const OA = { A: 1e5, gbw: 3e6, slew: 13e6, vmid: 4.3, vsat: 3.5 };
  el.push({ id: 'U1A', type: 'OA', nodes: [N('P3'), N('P2'), N('P1')], model: OA });
  el.push({ id: 'U1B', type: 'OA', nodes: [N('P5'), N('P6'), N('P7')], model: OA });
  el.push({ id: 'VIN', type: 'VIN', nodes: [N('IN'), 0], R: 10e3 });
  el.push({ id: 'VS', type: 'V', nodes: [N('VIN'), 0], V: 9 });
  el.push({ id: 'DRIVE', type: 'R', nodes: [N('DRV'), N('P1')], R: 1e6 * drive + 1 });
  el.push({ id: 'TONE', type: 'R', nodes: [N('TNC'), 0], R: 10e3 * tone + 1 });
  el.push({ id: 'VOLa', type: 'R', nodes: [N('T2'), N('OUT')], R: 500e3 * (1 - vol) + 1 });
  el.push({ id: 'VOLb', type: 'R', nodes: [N('OUT'), 0], R: 500e3 * vol + 1 });
  el.push({ id: 'HPLP', type: 'R', nodes: [N('SWA'), N('T2')], R: hp ? 0.1 : 1e9 });
  el.push({ id: 'AMP', type: 'R', nodes: [N('OUT'), 0], R: 1e6 });
  return { net: { nodeCount: k, output: N('OUT'), elements: el }, nodes };
}
const { net, nodes } = build(0.5, 0.5, 1, true);
const c = new Circuit(net, 96000);
const v = (n) => c.nodeVoltage(nodes[n]).toFixed(2);
console.log('DC converged', c.dcConverged, '| VIN', v('VIN'), 'V9', v('V9'), 'VF (pin 8)', v('VF'), 'VB', v('VB'));
console.log('op-amp pins 1,2,3:', v('P1'), v('P2'), v('P3'), '| 5,6,7:', v('P5'), v('P6'), v('P7'), '| clip node', v('CLIP'), '| X', v('X'));
for (const [d, t, hp] of [[0, 0.5, 1], [1, 0.5, 1], [0.5, 0, 1], [0.5, 1, 1], [0.5, 1, 0]]) {
  const cc = new Circuit(build(d, t, 1, hp).net, 96000);
  console.log(`drive ${d} tone ${t} ${hp ? 'HP' : 'LP'}: gain dB @100/1k/5k`, Array.from(cc.acSweep([100, 1000, 5000]).mag).map((x) => x.toFixed(1)).join(' / '));
}
const b = build(1, 0.5, 1, true), c2 = new Circuit(b.net, 96000), clip = b.nodes.CLIP, vb = c2.nodeVoltage(clip);
let mx = -9, mn = 9;
for (let i = 0; i < 48000; i++) { c2.step(0.2 * Math.sin(2 * Math.PI * 196 * i / 96000)); if (i > 24000) { const x = c2.nodeVoltage(clip) - vb; mx = Math.max(mx, x); mn = Math.min(mn, x); } }
console.log('full drive clipping: +', mx.toFixed(2), '/', mn.toFixed(2), 'V around the bias, failures', c2.stats.failures);
