// Simulate the RAT exactly as the board wires it (from layout.py), plus pots and a guitar.
import { Circuit, DIODE_MODELS } from '../../js/engine.js';
import { execSync } from 'node:child_process';
const { PARTS } = JSON.parse(execSync(`cd ${process.cwd()} && python3 -c "
import json; exec(open('layout.py').read().split('# ---- placement')[0]); print(json.dumps({'PARTS':PARTS}))"`).toString());
const val = (v) => { const m = v.replace('µ', 'u').match(/^([\d.]+)([pnumkM]?)/); return +m[1] * ({ '': 1, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6 }[m[2]]); };
function build(dist, filt, vol, chip = { gbw: 3e6, slew: 13e6 }) {
  const variant = process.env.VARIANT || '';
  const nodes = { GND: 0 }; let k = 1;
  const N = (n) => (n in nodes ? nodes[n] : (nodes[n] = k++));
  const el = [];
  for (const [id, [t, v, nets]] of Object.entries(PARTS)) {
    const nd = nets.map(N);
    if (variant.startsWith('dsep') && (id === 'D1' || id === 'D2')) { el.push({ id, type: 'D', nodes: nets.map((n) => N(n === 'VB' ? 'VC' : n)), model: DIODE_MODELS[v] }); continue; }
    if (variant === 'sep' && id === 'R2') { el.push({ id, type: 'R', nodes: [nd[0], N('VB2')], R: val(v) }); continue; }
    if (t === 'R') el.push({ id, type: 'R', nodes: nd, R: val(v) });
    else if (t === 'C' || t === 'E') el.push({ id, type: 'C', nodes: nd, C: val(v) });
    else if (t === 'D') el.push({ id, type: 'D', nodes: nd, model: DIODE_MODELS[v] || { Is: 5e-7, n: 1.1 } });
    else if (t === 'Q') el.push({ id, type: 'Q', nodes: [nd[1], nd[2], nd[0]], model: { Is: 1.8e-14, bf: 250, br: 4, pol: 1 } }); // legs E,C,B
  }
  el.push({ id: 'U1A', type: 'OA', nodes: [N('P3'), N('P2'), N('P1')], model: { A: 1e5, ...chip, vmid: 4.4, vsat: 3.5 } });
  el.push({ id: 'U1B', type: 'OA', nodes: [N('F'), N('P7'), N('P7')], model: { A: 1e5, ...chip, vmid: 4.4, vsat: 3.5 } });
  if (variant.startsWith('dsep')) {
    const r = variant === 'dsep470' ? 470 : 1e3, cap = variant === 'dsep470' ? 220e-6 : 100e-6;
    el.push({ id: 'R16', type: 'R', nodes: [N('VB'), N('VC')], R: r }); el.push({ id: 'C16', type: 'C', nodes: [N('VC'), 0], C: cap });
  }
  if (variant === 'ideal') el.push({ id: 'VBideal', type: 'V', nodes: [N('VB'), 0], V: 4.27 });
  if (variant === 'sep') { el.push({ id: 'R16', type: 'R', nodes: [N('VB'), N('VB2')], R: 1e3 }); el.push({ id: 'C16', type: 'C', nodes: [N('VB2'), 0], C: 47e-6 }); }
  el.push({ id: 'VIN', type: 'VIN', nodes: [N('IN'), 0], R: 10e3 });
  el.push({ id: 'VS', type: 'V', nodes: [N('VIN'), 0], V: 9 });
  el.push({ id: 'DIST', type: 'R', nodes: [N('P2'), N('P1')], R: 100e3 * dist + 1 });
  el.push({ id: 'FILT', type: 'R', nodes: [N('FL'), N('F')], R: 100e3 * filt + 1 });
  el.push({ id: 'VOLa', type: 'R', nodes: [N('VH'), N('OUT')], R: 100e3 * (1 - vol) + 1 });
  el.push({ id: 'VOLb', type: 'R', nodes: [N('OUT'), 0], R: 100e3 * vol + 1 });
  el.push({ id: 'AMP', type: 'R', nodes: [N('OUT'), 0], R: 1e6 });
  return { net: { nodeCount: k, output: N('OUT'), elements: el }, nodes };
}
const { net, nodes } = build(0.5, 0.2, 1);
const c = new Circuit(net, 96000);
const v = (n) => c.nodeVoltage(nodes[n]).toFixed(2);
console.log('DC converged', c.dcConverged, '| V9', v('V9'), 'VF (pin 8)', v('VF'), 'VB', v('VB'));
console.log('pin 3', v('P3'), 'pin 2', v('P2'), 'pin 1', v('P1'), '| diode node', v('D'), '| pin 5', v('F'), 'pins 6/7', v('P7'));
for (const [d, f] of [[0, 0], [0.5, 0], [1, 0], [1, 1]]) {
  const cc = new Circuit(build(d, f, 1).net, 96000);
  console.log(`distortion ${d} filter ${f}: gain dB @100/1k/5k`, Array.from(cc.acSweep([100, 1000, 5000]).mag).map((x) => x.toFixed(1)).join(' / '));
}
const fsT = +(process.env.FS || 96000);
const b = build(1, 0.2, 1), c2 = new Circuit(b.net, fsT), dn = b.nodes.D;
const rng = {}; const track = (n) => { const x = c2.nodeVoltage(b.nodes[n]); const r = rng[n] || (rng[n] = [9e9, -9e9]); r[0] = Math.min(r[0], x); r[1] = Math.max(r[1], x); };
let mx = -9, mn = 9, out = 0;
for (let i = 0; i < fsT / 2; i++) { const y = c2.step((+(process.env.AMP||0.1)) * Math.sin(2 * Math.PI * 196 * i / fsT)); if (i > fsT / 4) { for (const n of ['P1','D','F','P7','VB','OUT'].concat(b.nodes.VC ? ['VC'] : [])) track(n); const x = c2.nodeVoltage(dn) - c2.nodeVoltage(b.nodes.VB); mx = Math.max(mx, x); mn = Math.min(mn, x); out = Math.max(out, Math.abs(y)); } }
console.log(Object.entries(rng).map(([k, r]) => k + ' ' + r[0].toFixed(2) + '..' + r[1].toFixed(2)).join(' | '));
console.log('full distortion: diode node', mx.toFixed(2), '/', mn.toFixed(2), 'V, output peak', out.toFixed(2), 'V, failures', c2.stats.failures);
