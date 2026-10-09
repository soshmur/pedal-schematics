// Canvas plots: frequency response and oscilloscope.

function css(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const FONT = '12px "Barlow Semi Condensed", system-ui, sans-serif';

/**
 * Bode magnitude plot. current/original: { freqs, mag } (mag in dB).
 */
export function drawResponse(canvas, current, original) {
  const { g, w, h } = setup(canvas);
  const pad = { l: 50, r: 12, t: 10, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const f0 = 20, f1 = 20000;
  const all = [...current.mag, ...(original ? original.mag : [])];
  let top = Math.ceil((Math.max(...all) + 3) / 10) * 10;
  let bot = top - 60;
  if (Math.min(...current.mag) > bot + 10) bot = Math.floor((Math.min(...all) - 6) / 10) * 10;
  bot = Math.max(bot, top - 80);
  const X = (f) => pad.l + pw * Math.log(f / f0) / Math.log(f1 / f0);
  const Y = (db) => pad.t + ph * (top - db) / (top - bot);

  g.font = FONT;
  g.lineWidth = 1;
  g.strokeStyle = css('--grid');
  g.fillStyle = css('--muted');
  g.textAlign = 'center';
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    g.beginPath(); g.moveTo(X(f), pad.t); g.lineTo(X(f), pad.t + ph); g.stroke();
    if ([20, 100, 1000, 10000, 20000].includes(f) || w > 520) {
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), X(f), h - 6);
    }
  }
  g.textAlign = 'right';
  for (let db = bot; db <= top; db += 10) {
    g.beginPath(); g.moveTo(pad.l, Y(db)); g.lineTo(pad.l + pw, Y(db)); g.stroke();
    g.fillText((db < 0 ? '−' : '') + Math.abs(db) + ' dB', pad.l - 6, Y(db) + 4);
  }
  const line = (data, color, width, dash) => {
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, pw, ph);
    g.clip();
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []);
    g.beginPath();
    data.freqs.forEach((f, i) => { const x = X(f), y = Y(data.mag[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.restore();
  };
  if (original) line(original, css('--ghost'), 1.5, [4, 4]);
  line(current, css('--trace'), 2.25);
}

/** Two-trace scope, triggered on a rising zero crossing of the input. */
export function drawScope(canvas, inData, outData) {
  const { g, w, h } = setup(canvas);
  g.strokeStyle = css('--grid');
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (h * i) / 4); g.lineTo(w, (h * i) / 4); g.stroke(); }
  for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo((w * i) / 8, 0); g.lineTo((w * i) / 8, h); g.stroke(); }
  const N = inData.length;
  const span = Math.min(N / 2, 1024);
  let start = 0;
  for (let i = 1; i < N - span; i++) {
    if (inData[i - 1] <= 0 && inData[i] > 0) { start = i; break; }
  }
  const peak = (d) => { let p = 0; for (let i = start; i < start + span; i++) p = Math.max(p, Math.abs(d[i])); return p; };
  const pin = peak(inData), pout = peak(outData);
  const trace = (d, p, color, width) => {
    g.strokeStyle = color; g.lineWidth = width;
    g.beginPath();
    const s = p > 1e-6 ? 0.45 / p : 0;
    for (let i = 0; i < span; i++) {
      const x = (i / (span - 1)) * w, y = h / 2 - d[start + i] * s * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  };
  trace(inData, pin, css('--ghost'), 1.5);
  trace(outData, pout, css('--trace'), 2.25);
  return { pin, pout };
}
