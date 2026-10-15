// Synthesised guitar DI clips (Karplus-Strong plucked strings), so there's
// something to play through the pedal without plugging anything in.

// small deterministic PRNG so every play-through sounds the same
let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function pluck(out, fs, start, freq, dur, amp, pickPos = 0.22, bright = 0.5) {
  const n = Math.max(2, Math.round(fs / freq));
  const buf = new Float32Array(n);
  // noise burst, comb-filtered for pick position, slightly smoothed for softer attack
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const r = rand() * 2 - 1;
    prev = prev + (r - prev) * (0.35 + 0.6 * bright);
    buf[i] = prev;
  }
  const d = Math.max(1, Math.round(n * pickPos));
  for (let i = n - 1; i >= d; i--) buf[i] -= buf[i - d];
  const s0 = Math.round(start * fs), len = Math.min(Math.round(dur * fs), out.length - s0);
  const decay = 0.996 + 0.0035 * Math.min(1, 110 / freq) * 0.5;
  let idx = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const cur = buf[idx];
    const avg = decay * 0.5 * (cur + last);
    last = cur;
    buf[idx] = avg;
    idx = (idx + 1) % n;
    // short release at the end of the note
    const env = i > len - 400 ? (len - i) / 400 : 1;
    out[s0 + i] += cur * amp * env;
  }
}

const NOTE = (name) => {
  const m = name.match(/^([A-G])(#?)(\d)$/);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0);
  return 440 * Math.pow(2, (semis + (parseInt(m[3]) - 4) * 12) / 12);
};

export const RIFFS = {
  pentatonic: {
    label: 'A minor pentatonic riff',
    render(fs) {
      const bpm = 104, e = 60 / bpm / 2; // eighth notes
      const seq = [
        'A2', 'A2', 'C3', 'A2', 'D3', 'A2', 'E3', 'D3',
        'A2', 'A2', 'C3', 'A2', 'G3', 'E3', 'D3', 'C3',
        'A2', 'A2', 'C3', 'A2', 'D3', 'A2', 'E3', 'G3',
        'A3', 'G3', 'E3', 'D3', 'C3', 'D3', null, null,
      ];
      const len = seq.length * e + 2.2;
      const out = new Float32Array(Math.ceil(len * fs));
      seq.forEach((nm, i) => { if (nm) pluck(out, fs, i * e, NOTE(nm), e * 1.05, 0.8); });
      // end on an A5 power chord, slight strum
      ['A2', 'E3', 'A3'].forEach((nm, i) => pluck(out, fs, seq.length * e + i * 0.012, NOTE(nm), 2.1, 0.6));
      return out;
    },
  },
  chords: {
    label: 'Open chord strums',
    render(fs) {
      const chords = [
        ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'],
        ['A2', 'E3', 'A3', 'C#4', 'E4'],
        ['D3', 'A3', 'D4', 'F#4'],
        ['A2', 'E3', 'A3', 'C#4', 'E4'],
      ];
      const bar = 1.6;
      const out = new Float32Array(Math.ceil((chords.length * bar + 0.5) * fs));
      chords.forEach((ch, ci) => {
        for (const [off, dur] of [[0, 0.75], [0.8, 0.8]]) {
          const down = off === 0;
          const strings = down ? ch : [...ch].reverse();
          strings.forEach((nm, i) => pluck(out, fs, ci * bar + off + i * 0.014, NOTE(nm), dur, 0.42, 0.18, 0.7));
        }
      });
      return out;
    },
  },
  single: {
    label: 'Sustained low E',
    render(fs) {
      const out = new Float32Array(Math.ceil(4 * fs));
      pluck(out, fs, 0, NOTE('E2'), 4, 1, 0.25, 0.6);
      return out;
    },
  },
};

/** Render a clip normalised to a peak of 1.0. */
export function renderRiff(key, fs) {
  seed = 12345;
  const out = (RIFFS[key] || RIFFS.pentatonic).render(fs);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak;
  return out;
}
