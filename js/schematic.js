// Schematic geometry → netlist, and schematic → SVG.
//
// A pedal is described only by its drawing: parts placed on a grid and wires
// drawn between pins. The netlist the simulator runs is extracted from that
// geometry, so the schematic you see is exactly the circuit you hear.
//
// Grid units: 1 = 20 px. Rotation is clockwise in 90° steps (y points down).
//
// Connection rules (the usual schematic conventions):
//   - pins and wire vertices at the same point are connected
//   - a pin or wire end landing anywhere on a wire segment connects (T-junction)
//   - two wires crossing mid-segment do NOT connect

import { DIODE_MODELS, BJT_MODELS, OPAMP_MODELS, BBD_MODELS, MOSFET_MODELS } from './engine.js';

export const GRID = 20;

// Local pin offsets (grid units) for rotation 0.
const PINS = {
  R: [[0, 0], [4, 0]],
  C: [[0, 0], [4, 0]],
  D: [[0, 0], [4, 0]], // anode, cathode
  POT: [[0, 0], [4, 0], [2, -2]], // end 0, end 1, wiper
  OA: [[0, 0], [0, 2], [4, 1]], // inverting, non-inverting, output
  Q: [[2, -2], [0, 0], [2, 2]], // collector, base, emitter
  M: [[2, -2], [0, 0], [2, 2]], // drain, gate, source (N-channel MOSFET)
  BBD: [[0, 0], [6, 0], [3, 3]], // audio in, audio out, clock CV
  GND: [[0, 0]], VCC: [[0, 0]], VREF: [[0, 0]], IN: [[0, 0]], OUT: [[0, 0]],
};

export const SUPPLY = { VCC: 9, VREF: 4.5 };

function rotate([dx, dy], rot) {
  switch (((rot || 0) % 360 + 360) % 360) {
    case 90: return [-dy, dx];
    case 180: return [-dx, -dy];
    case 270: return [dy, -dx];
    default: return [dx, dy];
  }
}

/** Absolute pin positions of a part (grid units). */
export function pinPositions(part) {
  return PINS[part.type].map(([dx, dy]) => {
    if (part.flip) dy = (part.type === 'OA' ? 2 : 0) - dy;
    const [rx, ry] = rotate([dx, dy], part.rot);
    return [part.x + rx, part.y + ry];
  });
}

const key = (x, y) => `${x},${y}`;

function onSegment([px, py], [[ax, ay], [bx, by]]) {
  if (ax === bx) return px === ax && py >= Math.min(ay, by) && py <= Math.max(ay, by);
  if (ay === by) return py === ay && px >= Math.min(ax, bx) && px <= Math.max(ax, bx);
  // diagonal: exact collinearity
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  return cross === 0 && px >= Math.min(ax, bx) && px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

function segmentsOf(wires) {
  const segs = [];
  for (const w of wires) for (let i = 0; i + 1 < w.length; i++) segs.push([w[i], w[i + 1]]);
  return segs;
}

/**
 * Work out which points are electrically joined.
 * Returns { netOf(x,y) -> root key, pinNets: Map(partId -> [root...]), warnings, junctions }
 */
export function connectivity(def) {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const segs = segmentsOf(def.wires);
  const points = new Map(); // key -> [x,y]
  const pinsAt = new Map(); // key -> count of pins
  const partPins = new Map();
  for (const part of def.parts) {
    const pins = pinPositions(part);
    partPins.set(part.id, pins);
    for (const [x, y] of pins) {
      points.set(key(x, y), [x, y]);
      pinsAt.set(key(x, y), (pinsAt.get(key(x, y)) || 0) + 1);
      find(key(x, y));
    }
  }
  const ends = new Map(); // key -> number of segment ends there
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      points.set(key(...p), p);
      ends.set(key(...p), (ends.get(key(...p)) || 0) + 1);
    }
    union(key(...a), key(...b));
  }
  // T-junctions: any point lying on a segment joins that segment's net
  const interiorHits = new Map();
  for (const [k, p] of points) {
    for (const s of segs) {
      if (onSegment(p, s)) {
        union(k, key(...s[0]));
        const isEnd = (p[0] === s[0][0] && p[1] === s[0][1]) || (p[0] === s[1][0] && p[1] === s[1][1]);
        if (!isEnd) interiorHits.set(k, (interiorHits.get(k) || 0) + 2);
      }
    }
  }

  // junction dots: 3 or more connections meeting at a point
  const junctions = [];
  for (const [k, p] of points) {
    const degree = (pinsAt.get(k) || 0) + (ends.get(k) || 0) + (interiorHits.get(k) || 0);
    if (degree >= 3) junctions.push(p);
  }

  // warnings: pins that touch nothing, wire ends that touch nothing
  const warnings = [];
  const netSize = new Map();
  for (const [k] of pinsAt) netSize.set(find(k), (netSize.get(find(k)) || 0) + pinsAt.get(k));
  for (const part of def.parts) {
    partPins.get(part.id).forEach(([x, y], i) => {
      const lonely = (netSize.get(find(key(x, y))) || 0) < 2;
      const isWiper = part.type === 'POT' && i === 2;
      if (lonely && !isWiper) warnings.push(`${part.id} pin ${i} at (${x},${y}) is not connected`);
    });
  }
  for (const [k, p] of ends) {
    const hits = (pinsAt.get(k) || 0) + p + (interiorHits.get(k) || 0);
    if (hits < 2) warnings.push(`wire end at ${k} is not connected`);
  }

  const pinNets = new Map();
  for (const [id, pins] of partPins) pinNets.set(id, pins.map(([x, y]) => find(key(x, y))));
  return { pinNets, warnings, junctions };
}

/** Pot wiper fraction for a knob position 0..1. 'A' = audio (log) taper. */
export function taper(pos, kind) {
  const p = Math.min(1, Math.max(0, pos));
  if (kind === 'A') return (Math.pow(81, p) - 1) / 80; // 10% at half rotation
  return p;
}

/**
 * Build the simulator netlist from a pedal definition and the current
 * component values/knob positions.
 *   state.values[id]  -> number (R, C, POT value)
 *   state.models[id]  -> diode/transistor model key ('none' removes a diode)
 *   state.hfe[id]     -> transistor gain
 *   state.knobs[id]   -> 0..1
 */
export function buildNetlist(def, state = {}) {
  const { pinNets, warnings } = connectivity(def);
  const values = state.values || {}, models = state.models || {};
  const hfe = state.hfe || {}, knobs = state.knobs || {};

  // number the nets; anything touching a GND symbol is node 0
  const nodeOf = new Map();
  const names = ['0'];
  for (const part of def.parts) {
    if (part.type === 'GND') nodeOf.set(pinNets.get(part.id)[0], 0);
  }
  // nets carrying the same supply label are the same node
  const supplyNode = {};
  const node = (root, hint) => {
    if (!nodeOf.has(root)) { nodeOf.set(root, names.length); names.push(hint || `n${names.length}`); }
    return nodeOf.get(root);
  };
  for (const part of def.parts) {
    if (part.type === 'VCC' || part.type === 'VREF') {
      const root = pinNets.get(part.id)[0];
      if (supplyNode[part.type] !== undefined && !nodeOf.has(root)) nodeOf.set(root, supplyNode[part.type]);
      supplyNode[part.type] = node(root, part.type === 'VCC' ? '9V' : 'VREF');
    }
    if (part.type === 'IN') node(pinNets.get(part.id)[0], 'in');
    if (part.type === 'OUT') node(pinNets.get(part.id)[0], 'out');
  }

  const elements = [];
  const pinNodes = {};
  let output = 0;
  for (const part of def.parts) {
    const nets = pinNets.get(part.id);
    const n = nets.map((r) => node(r));
    pinNodes[part.id] = n;
    const v = values[part.id] ?? part.value;
    switch (part.type) {
      case 'R': elements.push({ id: part.id, type: 'R', nodes: n, R: v }); break;
      case 'C': elements.push({ id: part.id, type: 'C', nodes: n, C: v }); break;
      case 'D': {
        const m = models[part.id] ?? part.model;
        if (m !== 'none') elements.push({ id: part.id, type: 'D', nodes: n, model: DIODE_MODELS[m] });
        break;
      }
      case 'Q': {
        const m = models[part.id] ?? part.model;
        elements.push({ id: part.id, type: 'Q', nodes: n, model: { ...BJT_MODELS[m], bf: hfe[part.id] ?? part.hfe } });
        break;
      }
      case 'M': {
        const m = models[part.id] ?? part.model;
        elements.push({ id: part.id, type: 'M', nodes: n, model: MOSFET_MODELS[m] });
        break;
      }
      case 'BBD': {
        const chip = BBD_MODELS[models[part.id] ?? part.chip];
        elements.push({ id: part.id, type: 'BBD', nodes: n,
          model: { stages: chip.stages, swing: chip.swing, fc: values[part.id] ?? part.value, vOct: part.vOct ?? 2, vbias: SUPPLY.VREF } });
        break;
      }
      case 'OA': {
        if (part.comparator) {
          elements.push({ id: part.id, type: 'CMP', nodes: [n[1], n[0], n[2]], model: { vmid: SUPPLY.VREF, vsat: part.vsat ?? 3.5 } });
          break;
        }
        // pins are [inv, non-inv, out]; the engine wants [non-inv, inv, out]
        const chip = OPAMP_MODELS[models[part.id] ?? part.chip] || {};
        elements.push({ id: part.id, type: 'OA', nodes: [n[1], n[0], n[2]],
          model: { A: 1e5, gbw: chip.gbw ?? 1e6, slew: chip.slew ?? 1e6, vmid: SUPPLY.VREF, vsat: part.vsat ?? 3.5 } });
        break;
      }
      case 'POT': {
        const pos = knobs[part.id] ?? part.pos ?? 0.5;
        const f = taper(pos, (state.tapers || {})[part.id] ?? part.taper ?? 'B');
        // R(ccw end -> wiper) = R*f
        const ccw = part.ccw || 0;
        const [e0, e1, w] = n;
        const rA = Math.max(v * f, 1), rB = Math.max(v * (1 - f), 1);
        if (ccw === 0) {
          elements.push({ id: part.id + '.a', type: 'R', nodes: [e0, w], R: rA });
          elements.push({ id: part.id + '.b', type: 'R', nodes: [w, e1], R: rB });
        } else {
          elements.push({ id: part.id + '.a', type: 'R', nodes: [e1, w], R: rA });
          elements.push({ id: part.id + '.b', type: 'R', nodes: [w, e0], R: rB });
        }
        break;
      }
      case 'VCC': case 'VREF': break;
      case 'IN': elements.push({ id: 'IN', type: 'VIN', nodes: [n[0], 0], R: def.sourceR ?? 1000 }); break;
      case 'OUT': output = n[0]; break;
      case 'GND': break;
      default: throw new Error('Unknown part ' + part.type);
    }
  }
  for (const [type, nd] of Object.entries(supplyNode)) {
    elements.push({ id: type, type: 'V', nodes: [nd, 0], V: SUPPLY[type] });
  }
  return { nodeCount: names.length, nodeNames: names, output, elements, warnings, pinNodes };
}

/** SPICE netlist text, for checking the circuit in LTspice/ngspice. */
export function toSpice(def, net) {
  const nm = (i) => (i === 0 ? '0' : net.nodeNames[i]);
  const lines = [`* ${def.name} — exported from pedal-schematics`];
  const models = new Set();
  for (const e of net.elements) {
    const nodes = e.nodes.map(nm).join(' ');
    const id = e.id.replace(/\./g, '_');
    switch (e.type) {
      case 'R': lines.push(`R${id.replace(/^R/, '')} ${nodes} ${e.R}`); break;
      case 'C': lines.push(`C${id.replace(/^C/, '')} ${nodes} ${e.C}`); break;
      case 'V': lines.push(`V${id} ${nodes} DC ${e.V}`); break;
      case 'VIN': lines.push(`VIN in_src 0 AC 1 SIN(0 0.3 220)`, `RSRC in_src ${nm(e.nodes[0])} ${e.R}`); break;
      case 'D': {
        const m = `D_${e.model.label.split(' ')[0]}`;
        models.add(`.model ${m} D(Is=${e.model.Is} N=${e.model.n})`);
        lines.push(`D${id.replace(/^D/, '')} ${nodes} ${m}`);
        break;
      }
      case 'Q': {
        const m = `Q_${id}`;
        models.add(`.model ${m} ${e.model.pol < 0 ? 'PNP' : 'NPN'}(Is=${e.model.Is} Bf=${e.model.bf} Br=${e.model.br})`);
        lines.push(`Q${id.replace(/^Q/, '')} ${nodes} ${m}`);
        break;
      }
      case 'M': {
        const m = `M_${e.model.label}`;
        models.add(`.model ${m} NMOS(Level=1 Vto=${e.model.vth} Kp=${e.model.kp} Lambda=${e.model.lambda})`);
        models.add(`.model D_${e.model.label}_body D(Is=${e.model.Is} N=${e.model.n})`);
        const [d, g, src] = e.nodes.map(nm);
        lines.push(`M${id.replace(/^[MQ]/, '')} ${d} ${g} ${src} ${src} ${m}`, `D${id}body ${src} ${d} D_${e.model.label}_body`);
        break;
      }
      case 'OA': {
        // behavioural op-amp, same model as the simulator
        const [p, n, o] = e.nodes.map(nm);
        lines.push(`B${id} ${o} 0 V=${e.model.vmid}+${e.model.vsat}*tanh(${e.model.A}*(V(${p})-V(${n}))/${e.model.vsat})`);
        break;
      }
      case 'CMP': {
        const [p, n, o] = e.nodes.map(nm);
        lines.push(`* ${id}: op-amp used as a comparator`, `B${id} ${o} 0 V=${e.model.vmid}+${e.model.vsat}*tanh(1e4*(V(${p})-V(${n})))`);
        break;
      }
      case 'BBD': {
        const [i, o, cv] = e.nodes.map(nm);
        const ms = (e.model.stages / (2 * e.model.fc) * 1000).toFixed(1);
        lines.push(`* ${id}: ${e.model.stages}-stage BBD, clock ${e.model.fc} Hz at 4.5 V on ${cv} (${ms} ms).`,
          '* SPICE has no clocked delay line, so it is a fixed transmission-line delay here.',
          `T${id} ${i} 0 ${o}_t 0 Z0=1k TD=${ms}m`, `R${id}_t ${o}_t 0 1k`, `E${id} ${o} 0 ${o}_t 0 1`);
        break;
      }
    }
  }
  lines.push(...models, '.tran 10u 50m', `.ac dec 50 20 20k`, `.probe V(${nm(net.output)})`, '.end');
  return lines.join('\n');
}

// ---------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Symbols drawn in local pixel space for rotation 0 (pins at grid points).
function symbol(part, state) {
  const g = GRID;
  switch (part.type) {
    case 'R': {
      let d = `M0 0H${g}`;
      const n = 6, w = (2 * g) / n;
      for (let i = 0; i < n; i++) d += `L${g + w * (i + 0.5)} ${i % 2 ? 7 : -7}`;
      d += `L${3 * g} 0H${4 * g}`;
      return `<path class="body" d="${d}"/>`;
    }
    case 'POT': {
      let d = `M0 0H${g}`;
      const n = 6, w = (2 * g) / n;
      for (let i = 0; i < n; i++) d += `L${g + w * (i + 0.5)} ${i % 2 ? 7 : -7}`;
      d += `L${3 * g} 0H${4 * g}`;
      const pos = (state.knobs || {})[part.id] ?? part.pos ?? 0.5;
      // wiper arrow slides along the body with the knob position
      const fromCcw = part.ccw ? 1 - pos : pos;
      const wx = g + 2 * g * fromCcw;
      return `<path class="body" d="${d}"/>` +
        `<path class="body" d="M${2 * g} ${-2 * g}V${-1.3 * g}H${wx}V-10"/>` +
        `<path class="arrow" d="M${wx - 4} -16L${wx} -9L${wx + 4} -16Z"/>`;
    }
    case 'C': {
      const polar = part.polar;
      const p2 = polar
        ? `<path class="body" d="M${2.3 * g} -12Q${2.15 * g} 0 ${2.3 * g} 12"/>`
        : `<path class="body" d="M${2.3 * g} -12V12"/>`;
      return `<path class="body" d="M0 0H${1.7 * g}M${1.7 * g} -12V12M${(polar ? 2.2 : 2.3) * g} 0H${4 * g}"/>${p2}` +
        (polar ? `<path class="thin" d="M${1.15 * g} 11h7M${1.15 * g + 3.5} 7.5v7"/>` : '');
    }
    case 'D': {
      const m = (state.models || {})[part.id] ?? part.model;
      const off = m === 'none';
      const led = m === 'LED';
      const schottky = m === 'BAT41';
      const x0 = 1.4 * g, x1 = 2.6 * g;
      let s = `<path class="body${off ? ' removed' : ''}" d="M0 0H${x0}M${x1} 0H${4 * g}"/>` +
        `<path class="${off ? 'body removed' : 'fill'}" d="M${x0} -10L${x1} 0L${x0} 10Z"/>` +
        `<path class="body${off ? ' removed' : ''}" d="M${x1} -10V10${schottky ? `M${x1} -10h-4M${x1} 10h4` : ''}"/>`;
      if (led) s += `<path class="thin" d="M${x0 + 6} -14l6 -8M${x0 + 14} -12l6 -8"/>`;
      if (off) s += `<path class="removed-x" d="M${x0 - 2} -12L${x1 + 2} 12M${x1 + 2} -12L${x0 - 2} 12"/>`;
      return s;
    }
    case 'OA': {
      // inverting input on top; a flipped op-amp is mirrored by its transform
      const yi = 0, yn = 2 * g;
      return `<path class="body" d="M0 0H12M0 ${2 * g}H12M${3.4 * g} ${g}H${4 * g}"/>` +
        `<path class="body opamp" d="M12 -16L12 ${2 * g + 16}L${3.4 * g} ${g}Z"/>` +
        `<path class="thin" d="M17 ${yi}h8"/>` +
        `<path class="thin" d="M17 ${yn}h8M21 ${yn - 4}v8"/>`;
    }
    case 'BBD': {
      // chip body with a row of "buckets" and a clock input underneath
      let buckets = '';
      for (let i = 0; i < 6; i++) buckets += `<rect class="thin" x="${1.3 * g + i * 11}" y="-5" width="7" height="10" rx="1"/>`;
      return `<path class="body" d="M0 0H${0.8 * g}M${5.2 * g} 0H${6 * g}M${3 * g} ${1.4 * g}V${3 * g}"/>` +
        `<rect class="body opamp" x="${0.8 * g}" y="${-1.4 * g}" width="${4.4 * g}" height="${2.8 * g}" rx="3"/>` +
        buckets +
        `<path class="thin" d="M${4.5 * g - 6} 0h10l-4 -4M${4.5 * g + 4} 0l-4 4"/>` +
        `<text class="pin" x="${3 * g}" y="${1.4 * g - 5}" text-anchor="middle">clk</text>`;
    }
    case 'Q': {
      const ge = ((state.models || {})[part.id] ?? part.model) === 'Ge';
      return `<circle class="body${ge ? ' ge' : ''}" cx="${1.3 * g}" cy="0" r="${g * 1.15}"/>` +
        `<path class="body" d="M0 0H${0.95 * g}M${0.95 * g} -13V13"/>` +
        `<path class="body" d="M${0.95 * g} -6L${2 * g} -${1.2 * g}V-${2 * g}"/>` +
        `<path class="body" d="M${0.95 * g} 6L${2 * g} ${1.2 * g}V${2 * g}"/>` +
        `<path class="fill" d="M${1.75 * g} ${1.2 * g - 1}l-11 -1l5 -8Z"/>`;
    }
    case 'M': {
      // N-channel enhancement MOSFET: gate plate, broken channel, arrow into the channel, body to source
      const x0 = 0.95 * g, x1 = 1.25 * g, x2 = 2 * g;
      return `<path class="body" d="M0 0H${x0}M${x0} -13V13"/>` +
        `<path class="body" d="M${x1} -15V-7M${x1} -4V4M${x1} 7V15"/>` +
        `<path class="body" d="M${x1} -11H${x2}V-${2 * g}M${x1} 11H${x2}V${2 * g}M${x1} 0H${x2}V11"/>` +
        `<path class="fill" d="M${x1 + 1} 0l8 -4v8Z"/>`;
    }
    default: return '';
  }
}

function labelSymbol(part) {
  const g = GRID;
  const t = (x, y, s, cls = 'net', anchor = 'middle') =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`;
  const x = part.x * g, y = part.y * g;
  switch (part.type) {
    case 'GND':
      return `<path class="body" transform="translate(${x} ${y})" d="M0 0V8M-11 8H11M-7 13H7M-3 18H3"/>`;
    case 'VCC': case 'VREF': {
      const down = part.dir === 'down';
      const s = down ? 1 : -1;
      const txt = part.type === 'VCC' ? '+9V' : 'Vr 4.5V';
      return `<path class="body" transform="translate(${x} ${y})" d="M0 0V${s * 10}M-9 ${s * 10}H9"/>` +
        t(x, y + s * (down ? 24 : 15), txt);
    }
    case 'IN':
      return `<circle class="jack" cx="${x}" cy="${y}" r="5"/>` + t(x - 10, y + 4, 'IN', 'io', 'end');
    case 'OUT':
      return `<circle class="jack" cx="${x}" cy="${y}" r="5"/>` + t(x + 10, y + 4, 'OUT', 'io', 'start');
    default: return '';
  }
}

// Where to put the ref/value text so it stays upright and off the wires.
// part.lab picks the side: 't' / 'b' (one line), 'l' / 'r' (two lines).
function labelPos(part) {
  const pins = pinPositions(part);
  const g = GRID;
  if (part.type === 'OA') {
    const [, , out] = pins;
    return { x: (out[0] - 2) * g, y: out[1] * g + 2.5 * g, anchor: 'middle', stack: true };
  }
  if (part.type === 'Q' || part.type === 'M') {
    const [, b] = pins;
    return { x: b[0] * g + 2.6 * g, y: b[1] * g, anchor: 'start', stack: true };
  }
  if (part.type === 'BBD') {
    const [a] = pins;
    return { x: (a[0] + 3) * g, y: (a[1] - 1.4) * g - 8, anchor: 'middle' };
  }
  const [a, b] = pins;
  const cx = (a[0] + b[0]) / 2 * g, cy = (a[1] + b[1]) / 2 * g;
  const vertical = a[0] === b[0];
  const side = part.lab || (vertical ? 'l' : 't');
  if (side === 'l' || side === 'r') {
    const dx = side === 'r' ? 14 : -14;
    return { x: cx + dx, y: cy, anchor: side === 'r' ? 'start' : 'end', stack: true };
  }
  if (vertical) {
    const top = Math.min(a[1], b[1]) * g;
    return { x: cx, y: top - 10, anchor: 'middle' };
  }
  if (side === 'b' && part.type === 'POT') return { x: cx, y: cy + 23, anchor: 'middle', stack: true };
  return { x: cx, y: side === 'b' ? cy + 22 : cy - 13, anchor: 'middle' };
}

/** Short value text shown on the schematic. */
export function valueText(part, state, formatSI) {
  const values = state.values || {}, models = state.models || {};
  switch (part.type) {
    case 'R': case 'POT': {
      const v = values[part.id] ?? part.value;
      return formatSI(v) + (part.type === 'POT' ? ((state.tapers || {})[part.id] ?? part.taper ?? 'B') : '');
    }
    case 'C': return formatSI(values[part.id] ?? part.value) + 'F';
    case 'D': { const m = models[part.id] ?? part.model; return m === 'none' ? 'removed' : m; }
    case 'Q': return `${models[part.id] ?? part.model} hFE ${(state.hfe || {})[part.id] ?? part.hfe}`;
    case 'M': return models[part.id] ?? part.model;
    case 'OA': return part.comparator ? 'comparator' : models[part.id] ?? part.chip ?? 'op-amp';
    case 'BBD': return `${models[part.id] ?? part.chip}, clock ${formatSI(values[part.id] ?? part.value)}Hz`;
    default: return '';
  }
}

/** Render the whole schematic to an SVG string. */
export function renderSVG(def, state, { formatSI, selected, changed = new Set() }) {
  const g = GRID;
  const { junctions } = connectivity(def);
  // bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const p of def.parts) for (const [x, y] of pinPositions(p)) grow(x, y);
  for (const w of def.wires) for (const [x, y] of w) grow(x, y);
  const pad = 2.4;
  const vb = [(minX - pad) * g, (minY - pad) * g, (maxX - minX + 2 * pad) * g, (maxY - minY + 2 * pad) * g];

  let out = `<svg xmlns="http://www.w3.org/2000/svg" class="schematic" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}" role="img" aria-label="${esc(def.name)} schematic">`;
  out += '<g class="wires">';
  for (const w of def.wires) out += `<polyline points="${w.map(([x, y]) => `${x * g},${y * g}`).join(' ')}"/>`;
  out += '</g><g class="dots">';
  for (const [x, y] of junctions) out += `<circle cx="${x * g}" cy="${y * g}" r="3.6"/>`;
  out += '</g>';

  for (const part of def.parts) {
    if (['GND', 'VCC', 'VREF', 'IN', 'OUT'].includes(part.type)) { out += labelSymbol(part); continue; }
    const editable = true;
    const cls = ['part', `t-${part.type}`, editable ? 'editable' : '', selected === part.id ? 'selected' : '', changed.has(part.id) ? 'changed' : ''].join(' ');
    const tr = `translate(${part.x * g} ${part.y * g}) rotate(${part.rot || 0})${part.flip && part.type === 'OA' ? ` translate(0 ${2 * g}) scale(1 -1)` : ''}`;
    // invisible hit area so small parts are easy to tap
    const pins = pinPositions(part);
    const xs = pins.map((p) => p[0] * g), ys = pins.map((p) => p[1] * g);
    const hx = Math.min(...xs) - 14, hy = Math.min(...ys) - 14;
    const hw = Math.max(...xs) - Math.min(...xs) + 28, hh = Math.max(...ys) - Math.min(...ys) + 28;
    out += `<g class="${cls}" data-id="${esc(part.id)}"${editable ? ' tabindex="0" role="button"' : ''} aria-label="${esc(part.id)} ${esc(valueText(part, state, formatSI))}">`;
    out += `<rect class="hit" x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="6"/>`;
    // part.plus = 1 puts a polarised cap's + on pin 1 (draw mirrored)
    const mirror = part.type === 'C' && part.plus === 1 ? `<g transform="translate(${4 * g} 0) scale(-1 1)">` : '<g>';
    out += `<g transform="${tr}">${mirror}${symbol(part, state)}</g></g>`;
    const lp = labelPos(part);
    const ref = part.knob ? `${part.id} ${part.knob}` : part.id;
    const val = valueText(part, state, formatSI);
    if (lp.stack) {
      out += `<text class="ref" x="${lp.x}" y="${lp.y - 3}" text-anchor="${lp.anchor}">${esc(ref)}</text>`;
      out += `<text class="val" x="${lp.x}" y="${lp.y + 11}" text-anchor="${lp.anchor}">${esc(val)}</text>`;
    } else {
      out += `<text x="${lp.x}" y="${lp.y}" text-anchor="${lp.anchor}"><tspan class="ref">${esc(ref)}</tspan> <tspan class="val">${esc(val)}</tspan></text>`;
    }
    out += '</g>';
  }
  out += '</svg>';
  return out;
}
