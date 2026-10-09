// Parsing and formatting of component values ("4k7", "47n", "2.2uF", "1M").

const PREFIX = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3,
  R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};

/**
 * Parse an engineering value. Accepts "4700", "4.7k", "4k7", "47n", "47nF",
 * "2u2", "100R", "4R7", "1M", "1e-6". Returns NaN if it can't be read.
 */
export function parseValue(input) {
  if (typeof input === 'number') return input;
  let s = String(input).trim().replace(/\s+/g, '');
  s = s.replace(/(ohms?|Ω)$/i, '').replace(/[Ff]$/, '');
  if (s === '') return NaN;
  if (/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return parseFloat(s);
  const m = s.match(/^(\d*\.?\d+)([pnuµmRrkKMG])(\d*)$/);
  if (!m) return NaN;
  const [, head, letter, tail] = m;
  let num;
  if (tail) {
    if (head.includes('.')) return NaN; // "4.7k7" is ambiguous
    num = parseFloat(`${head}.${tail}`);
  } else {
    num = parseFloat(head);
  }
  return num * PREFIX[letter];
}

const STEPS = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'],
  [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

function trim(n) {
  // 3 significant figures, no trailing zeros
  let s = n.toPrecision(3);
  if (s.includes('e')) s = String(parseFloat(s));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Format with an SI prefix: 4700 -> "4.7k", 4.7e-8 -> "47n". */
export function formatSI(v) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  for (const [scale, p] of STEPS) {
    if (a >= scale * 0.9995) return trim(v / scale) + p;
  }
  return trim(v / 1e-12) + 'p';
}

/** Value with unit for a component kind: R -> Ω, C -> F. */
export function formatValue(v, kind) {
  const unit = kind === 'C' ? 'F' : kind === 'R' || kind === 'POT' ? 'Ω' : '';
  return formatSI(v) + unit;
}

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const SERIES = { E12, E24 };

/** Snap a value to the nearest preferred value (log distance). */
export function snapToSeries(v, series = 'E24') {
  const list = SERIES[series];
  if (!list || !(v > 0)) return v;
  const decade = Math.floor(Math.log10(v));
  let best = v, bestErr = Infinity;
  for (const d of [decade - 1, decade, decade + 1]) {
    for (const m of list) {
      const c = m * Math.pow(10, d);
      const err = Math.abs(Math.log(c / v));
      if (err < bestErr) { bestErr = err; best = c; }
    }
  }
  // tidy float noise (e.g. 4.7000000001e3)
  return parseFloat(best.toPrecision(3));
}
