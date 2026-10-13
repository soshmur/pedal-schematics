import { PEDALS, pedalByKey } from './pedals.js';
import { buildNetlist, renderSVG, toSpice } from './schematic.js';
import { Circuit, logFreqs, DIODE_MODELS, BJT_MODELS, OPAMP_MODELS, VT } from './engine.js';
import { parseValue, formatSI, formatValue, snapToSeries } from './units.js';
import { AudioEngine } from './audio.js';
import { drawResponse, drawScope } from './plots.js';

const $ = (s) => document.querySelector(s);
const FREQS = logFreqs(20, 20000, 160);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- state

const emptyEdits = () => ({ values: {}, models: {}, hfe: {}, knobs: {}, tapers: {} });
const state = {
  key: 'screamer',
  edits: Object.fromEntries(PEDALS.map((p) => [p.key, emptyEdits()])),
  selected: null,
  zoom: null, // null = fit
  snap: 'E24',
  bypass: false,
  net: null,
  analysis: null,
};
const def = () => pedalByKey(state.key);
const edits = () => state.edits[state.key];
const part = (id) => def().parts.find((p) => p.id === id);

function changedParts() {
  const e = edits(), out = new Set();
  for (const p of def().parts) {
    const id = p.id;
    if (id in e.values && e.values[id] !== p.value) out.add(id);
    if (id in e.models && e.models[id] !== (p.model ?? p.chip)) out.add(id);
    if (id in e.hfe && e.hfe[id] !== p.hfe) out.add(id);
    if (id in e.tapers && e.tapers[id] !== (p.taper ?? 'B')) out.add(id);
  }
  return out;
}

// ---------------------------------------------------------------- persistence

function encodeEdits(e) {
  const slim = {};
  for (const k of Object.keys(e)) if (Object.keys(e[k]).length) slim[k] = e[k];
  return btoa(unescape(encodeURIComponent(JSON.stringify(slim)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeEdits(s) {
  const json = decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  return { ...emptyEdits(), ...JSON.parse(json) };
}
function persist() {
  try { localStorage.setItem('pedal-schematics', JSON.stringify({ key: state.key, edits: state.edits, snap: state.snap })); } catch { /* storage unavailable */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem('pedal-schematics') || 'null');
    if (saved) {
      if (pedalByKey(saved.key)) state.key = saved.key;
      for (const k of Object.keys(state.edits)) if (saved.edits?.[k]) state.edits[k] = { ...emptyEdits(), ...saved.edits[k] };
      if (saved.snap) state.snap = saved.snap;
    }
  } catch { /* ignore */ }
  // a shared link wins over local state
  const m = location.hash.match(/^#([a-z]+)(?::(.+))?$/);
  if (m && pedalByKey(m[1])) {
    state.key = m[1];
    if (m[2]) {
      try { state.edits[m[1]] = decodeEdits(m[2]); } catch { toast('That link’s build couldn’t be read, so the stock circuit is loaded.'); }
    }
  }
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------------------------------------------------------------- audio

const audio = new AudioEngine();
audio.onStats = (s) => {
  const status = $('#status');
  const failRate = s.steps ? s.failures / s.steps : 0;
  if (!s.ok) {
    status.textContent = 'This circuit has no stable bias point with these values. Undo the last change or reset the part.';
    status.className = 'status warn';
  } else if (failRate > 0.003) {
    status.textContent = 'The solver is struggling with these values, so expect crackle. Try 1× oversampling or a less extreme value.';
    status.className = 'status warn';
  } else if (s.load > 0.8 && s.os > 1) {
    // too heavy for this device: drop to 1x before it starts glitching
    document.querySelector('input[name="os"][value="1"]').checked = true;
    audio.setOversample(1);
    status.textContent = 'Switched to 1× oversampling: 2× was too heavy for this device.';
    status.className = 'status warn';
  } else if (s.load > 0.85 && audio.latencyMode === 'lowest') {
    status.textContent = 'The simulation is close to its time limit, so you may hear clicks. Set Latency to Stable.';
    status.className = 'status warn';
  } else {
    const rate = Math.round(audio.ctx.sampleRate * s.os / 1000);
    status.textContent = `Simulating at ${rate} kHz, ${s.itsPerSample.toFixed(1)} Newton iterations per sample, ${Math.round(s.load * 100)}% CPU.`;
    status.className = 'status';
  }
};
// phones get 1x by default; desktop starts at 2x
if (matchMedia('(pointer: coarse)').matches) document.querySelector('input[name="os"][value="1"]').checked = true;
const osFactor = () => parseInt(document.querySelector('input[name="os"]:checked').value, 10);
const inputVolts = () => Math.pow(10, parseFloat($('#inLevel').value) / 20);
const monitorGain = () => Math.pow(10, parseFloat($('#outLevel').value) / 20);

function showLevels() {
  $('#inLevelOut').textContent = `${inputVolts().toFixed(2)} V`;
  $('#outLevelOut').textContent = `${$('#outLevel').value} dB`;
}

// ---- live input settings (remembered per browser)

const AUDIO_KEY = 'pedal-schematics-audio';
function saveAudioPrefs() {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify({
      source: $('#source').value === 'file' ? 'live' : $('#source').value,
      inputId: audio.inputId, outputId: audio.outputId, channel: audio.channel, latency: audio.latencyMode,
      inLevel: $('#inLevel').value, outLevel: $('#outLevel').value,
    }));
  } catch { /* storage unavailable */ }
}
function loadAudioPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(AUDIO_KEY) || 'null'); } catch { /* ignore */ }
  if (!p) return;
  if (p.source && $(`#source option[value="${p.source}"]`)) $('#source').value = p.source;
  audio.inputId = p.inputId || '';
  audio.outputId = p.outputId || '';
  audio.channel = p.channel || '0';
  audio.latencyMode = p.latency || 'lowest';
  if (p.inLevel) $('#inLevel').value = p.inLevel;
  if (p.outLevel) $('#outLevel').value = p.outLevel;
  $('#inChannel').value = audio.channel;
  $('#latency').value = audio.latencyMode;
}

function fillSelect(sel, devices, fallback, current) {
  const opts = [`<option value="">${fallback}</option>`];
  devices.forEach((d, i) => opts.push(`<option value="${esc(d.deviceId)}">${esc(d.label || `${fallback.replace('Default ', '')} ${i + 1}`)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = devices.some((d) => d.deviceId === current) ? current : '';
}

async function refreshDevices() {
  const { inputs, outputs } = await AudioEngine.devices();
  fillSelect($('#inDevice'), inputs, 'Default input', audio.inputId);
  fillSelect($('#outDevice'), outputs, 'Default output', audio.outputId);
  $('#outPick').hidden = !AudioEngine.outputSelectable || outputs.length === 0;
}

function showLiveUI() {
  const live = $('#source').value === 'live';
  $('#live').hidden = !live;
  if (!audio.playing) $('#play').textContent = live ? 'Start' : 'Play';
}

function showLatency() {
  const l = audio.latencyMs();
  const note = $('#liveNote');
  if (!l || audio.kind !== 'live' || !audio.playing) {
    note.textContent = 'Use headphones or your interface’s outputs. Speakers near a microphone will feed back.';
    return;
  }
  const chans = audio.streamChannels >= 2 ? '' : ' Mono device, so the channel setting has no effect.';
  note.textContent = `About ${Math.round(l.total)} ms from input to output${l.reported ? '' : ' (plus what the browser doesn’t report)'}, at ${audio.ctx.sampleRate / 1000} kHz.${chans}`;
}

function liveError(err) {
  const status = $('#status');
  status.className = 'status warn';
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
    status.textContent = 'Microphone access is blocked. Allow it for this site in the browser’s address bar, then press Start.';
  } else if (err.name === 'NotFoundError') {
    status.textContent = 'No audio input found. Plug in your interface or mic, then press Start.';
  } else if (err.name === 'NotReadableError') {
    status.textContent = 'The input is busy in another app (a DAW or call). Close it there, then press Start.';
  } else if (err.name === 'NotSupportedError') {
    status.textContent = 'Live input needs the page to be served over https or from localhost.';
  } else {
    status.textContent = `Couldn’t open the input: ${err.message}`;
  }
}

async function startPlayback(kind) {
  try {
    await audio.play(kind);
    audio.setInputVolts(inputVolts());
    audio.setOutputGain(monitorGain());
    audio.setOversample(osFactor());
    audio.setBypass(state.bypass);
    audio.setNetlist(state.net);
    $('#play').setAttribute('aria-pressed', 'true');
    $('#play').textContent = 'Stop';
    if (kind === 'live') {
      // labels only appear once permission is granted
      await refreshDevices();
      setTimeout(showLatency, 300);
    }
    saveAudioPrefs();
    scopeLoop();
  } catch (err) {
    stopPlayback();
    if (kind === 'live') liveError(err);
    else {
      $('#status').className = 'status warn';
      $('#status').textContent = `Couldn’t start audio: ${err.message}`;
    }
  }
}

function stopPlayback() {
  audio.stop();
  $('#play').setAttribute('aria-pressed', 'false');
  showLiveUI();
  setMeter(null);
  showLatency();
}
audio.onEnded = () => {
  if (audio.kind !== 'live') return;
  stopPlayback();
  $('#status').className = 'status warn';
  $('#status').textContent = 'The input device disconnected. Pick another input and press Start.';
};

// ---- input meter: peak in dBFS with a falling peak-hold marker

const meter = { hold: -Infinity, holdT: 0, clipT: 0 };
function setMeter(peak) {
  const box = $('.meter');
  if (peak === null) {
    $('#meterFill').style.width = '0';
    $('#meterPeak').style.opacity = 0;
    $('#meterOut').textContent = 'off';
    box.classList.remove('clip');
    return;
  }
  const now = performance.now();
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -Infinity;
  const pos = (d) => `${Math.max(0, Math.min(100, (d + 60) / 60 * 100))}%`;
  if (db >= meter.hold || now - meter.holdT > 1200) { meter.hold = db; meter.holdT = now; }
  if (peak >= 0.98) meter.clipT = now;
  const clipping = now - meter.clipT < 1500;
  $('#meterFill').style.width = pos(db);
  $('#meterPeak').style.left = pos(meter.hold);
  $('#meterPeak').style.opacity = meter.hold > -60 ? 1 : 0;
  $('#meterOut').textContent = clipping ? 'CLIP' : (meter.hold > -60 ? `${meter.hold.toFixed(0)} dBFS` : '< −60');
  box.classList.toggle('clip', clipping);
}

let scopeRunning = false;
function scopeLoop() {
  if (scopeRunning) return;
  scopeRunning = true;
  const inBuf = new Float32Array(2048), outBuf = new Float32Array(2048);
  const frame = () => {
    if (!audio.playing) { scopeRunning = false; return; }
    audio.inTap.getFloatTimeDomainData(inBuf);
    audio.outTap.getFloatTimeDomainData(outBuf);
    let peak = 0;
    for (let i = 0; i < inBuf.length; i++) peak = Math.max(peak, Math.abs(inBuf[i]));
    setMeter(peak);
    const v = inputVolts();
    for (let i = 0; i < inBuf.length; i++) inBuf[i] *= v;
    const { pin, pout } = drawScope($('#scope'), inBuf, outBuf);
    $('#scopeInfo').textContent = `grey: guitar ${pin.toFixed(2)} V peak, green: pedal out ${pout.toFixed(2)} V peak`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- analysis

let analysisQueued = false;
function scheduleAnalysis() {
  if (analysisQueued) return;
  analysisQueued = true;
  requestAnimationFrame(() => {
    analysisQueued = false;
    const c = new Circuit(state.net, 96000);
    const current = { freqs: FREQS, mag: c.acSweep(FREQS).mag };
    let original = null;
    if (changedParts().size) {
      const stock = buildNetlist(def(), { knobs: edits().knobs });
      original = { freqs: FREQS, mag: new Circuit(stock, 96000).acSweep(FREQS).mag };
    }
    state.analysis = { circuit: c, current, original };
    drawResponse($('#bode'), current, original);
    if (!c.dcConverged) {
      $('#status').className = 'status warn';
      $('#status').textContent = 'This circuit has no stable bias point with these values. Undo the last change or reset the part.';
    }
    if (state.selected) refreshPins();
  });
}

// ---------------------------------------------------------------- rendering

function update({ schematic = true } = {}) {
  state.net = buildNetlist(def(), edits());
  audio.setNetlist(state.net);
  if (schematic) renderSchematic();
  renderChanges();
  scheduleAnalysis();
  persist();
}

function naturalWidth() {
  const svg = $('#schematic svg');
  return svg ? svg.viewBox.baseVal.width : 800;
}

function applyZoom() {
  const svg = $('#schematic svg');
  if (!svg) return;
  const wrap = $('#schematic');
  const vb = svg.viewBox.baseVal;
  const fit = (wrap.clientWidth - 16) / vb.width;
  const z = state.zoom ?? Math.min(1.25, Math.max(fit, 0.8)); // below ~0.8 labels get too small, so scroll instead
  svg.setAttribute('width', Math.round(vb.width * z));
  svg.setAttribute('height', Math.round(vb.height * z));
  wrap.style.setProperty('--zoom', z);
  $('#zoomFit').setAttribute('aria-pressed', String(state.zoom === null));
}

function renderSchematic() {
  const wrap = $('#schematic');
  const scroll = [wrap.scrollLeft, wrap.scrollTop];
  wrap.innerHTML = renderSVG(def(), edits(), { formatSI, selected: state.selected, changed: changedParts() });
  applyZoom();
  [wrap.scrollLeft, wrap.scrollTop] = scroll;
}

function renderChanges() {
  const box = $('#changes');
  const changed = [...changedParts()];
  if (!changed.length) {
    box.innerHTML = '<span>Stock circuit. Tap any part on the schematic to change it.</span>';
    return;
  }
  box.innerHTML = `<span>Modified:</span>${changed.map((id) => `<button class="chip" data-id="${esc(id)}">${esc(id)}</button>`).join('')}` +
    '<button class="linkish" id="resetAll">Reset all parts</button>';
}

function renderTabs() {
  $('#tabs').innerHTML = PEDALS.map((p) =>
    `<button role="tab" style="--swatch:${p.color}" aria-selected="${p.key === state.key}" data-key="${p.key}">${esc(p.name)}</button>`).join('');
}

function renderPedal() {
  const d = def();
  $('#enclosure').style.setProperty('--paint', d.color);
  $('#pedalName').textContent = d.name;
  $('#pedalSub').textContent = d.subtitle;
  $('#blurb').textContent = d.blurb;
  renderTabs();
  renderKnobs();
  setLed();
}

function setLed() {
  $('#led').classList.toggle('on', !state.bypass);
  $('#stomp').setAttribute('aria-pressed', String(!state.bypass));
  $('#stomp').setAttribute('aria-label', state.bypass ? 'Bypassed (tap to switch the effect on)' : 'Effect on (tap to bypass)');
}

// ---------------------------------------------------------------- knobs

const knobPos = (p) => edits().knobs[p.id] ?? p.pos ?? 0.5;

function renderKnobs() {
  const pots = def().parts.filter((p) => p.type === 'POT' && p.knob && !p.trim);
  $('#knobs').innerHTML = pots.map((p) => `
    <div class="knob" role="slider" tabindex="0" data-id="${p.id}" aria-label="${esc(p.knob)}"
      aria-valuemin="0" aria-valuemax="10" aria-valuenow="${(knobPos(p) * 10).toFixed(1)}">
      <div class="cap"></div>
      <span class="label">${esc(p.knob)}</span>
      <span class="reading"></span>
    </div>`).join('');
  for (const el of $('#knobs').querySelectorAll('.knob')) paintKnob(el);
}

function paintKnob(el) {
  const p = part(el.dataset.id);
  const pos = knobPos(p);
  el.querySelector('.cap').style.setProperty('--angle', `${-135 + 270 * pos}deg`);
  el.querySelector('.reading').textContent = (pos * 10).toFixed(1);
  el.setAttribute('aria-valuenow', (pos * 10).toFixed(1));
}

let knobQueued = false;
function setKnob(id, pos) {
  edits().knobs[id] = Math.min(1, Math.max(0, Math.round(pos * 1000) / 1000));
  const el = $(`#knobs .knob[data-id="${id}"]`);
  if (el) paintKnob(el);
  if (knobQueued) return;
  knobQueued = true;
  requestAnimationFrame(() => {
    knobQueued = false;
    update();
    if (state.selected === id) {
      const pos = edits().knobs[id];
      const slider = $('#edPos');
      if (slider && document.activeElement !== slider) slider.value = Math.round(pos * 1000);
      if ($('#edPosOut')) $('#edPosOut').textContent = (pos * 10).toFixed(1);
    }
  });
}

function bindKnobs() {
  const box = $('#knobs');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.knob');
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    drag = { el, id: el.dataset.id, x: e.clientX, y: e.clientY, pos: knobPos(part(el.dataset.id)) };
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const delta = ((drag.y - e.clientY) + (e.clientX - drag.x)) / 180;
    setKnob(drag.id, drag.pos + delta);
  });
  const end = () => { drag = null; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.knob');
    if (el) setKnob(el.dataset.id, part(el.dataset.id).pos ?? 0.5);
  });
  box.addEventListener('keydown', (e) => {
    const el = e.target.closest('.knob');
    if (!el) return;
    const id = el.dataset.id, pos = knobPos(part(id));
    const steps = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in steps) { setKnob(id, pos + steps[e.key]); e.preventDefault(); }
    if (e.key === 'Home') { setKnob(id, 0); e.preventDefault(); }
    if (e.key === 'End') { setKnob(id, 1); e.preventDefault(); }
  });
}

// ---------------------------------------------------------------- component art

const BAND = ['#111111', '#7a4a1d', '#d0261d', '#f07a12', '#f2c80f', '#1f9a41', '#1f5fd6', '#7d3cc0', '#8a8a8a', '#f4f4f4'];
const GOLD = '#c9a227', SILVER = '#b8bec2';

function resistorBands(v) {
  if (!(v > 0)) return [];
  let digits = 2;
  const p3 = parseFloat(v.toPrecision(3));
  if (Math.abs(parseFloat(v.toPrecision(2)) - p3) / p3 > 1e-9) digits = 3;
  const exp = Math.floor(Math.log10(p3)) - (digits - 1);
  const mant = Math.round(p3 / Math.pow(10, exp));
  const ds = String(mant).padStart(digits, '0').split('').map(Number);
  const mult = exp >= 0 && exp <= 9 ? BAND[exp] : exp === -1 ? GOLD : SILVER;
  return [...ds.map((d) => BAND[d]), mult, digits === 3 ? '#7a4a1d' : GOLD];
}

function capCode(v) {
  const pf = v / 1e-12;
  if (pf < 100) return String(Math.round(pf * 10) / 10);
  const e = Math.floor(Math.log10(pf)) - 1;
  return `${Math.round(pf / Math.pow(10, e))}${e}`;
}

function artFor(p) {
  const e = edits();
  switch (p.type) {
    case 'R': case 'POT': {
      if (p.type === 'POT') return '';
      const bands = resistorBands(e.values[p.id] ?? p.value);
      const xs = bands.length === 5 ? [62, 80, 98, 116, 146] : [66, 86, 106, 146];
      return `<svg viewBox="0 0 240 60" width="240" height="60" aria-hidden="true">
        <path d="M0 30H50M190 30H240" stroke="#9aa5ab" stroke-width="4"/>
        <rect x="46" y="12" width="148" height="36" rx="16" fill="#d9c6a0" stroke="#b49e74"/>
        ${bands.map((c, i) => `<rect x="${xs[i]}" y="12.5" width="10" height="35" fill="${c}"/>`).join('')}
      </svg>`;
    }
    case 'C': {
      const v = e.values[p.id] ?? p.value;
      if (p.polar || v >= 1e-6) {
        return `<svg viewBox="0 0 240 70" width="240" height="70" aria-hidden="true">
          <path d="M0 35H60M180 35H240" stroke="#9aa5ab" stroke-width="4"/>
          <rect x="56" y="10" width="128" height="50" rx="10" fill="#1d3f73"/>
          <rect x="56" y="10" width="20" height="50" fill="#dfe6ee" opacity=".8"/>
          <text x="128" y="41" fill="#fff" font-size="16" font-weight="700" text-anchor="middle">${esc(formatSI(v))}F</text>
        </svg>`;
      }
      return `<svg viewBox="0 0 240 70" width="240" height="70" aria-hidden="true">
        <path d="M0 35H84M156 35H240" stroke="#9aa5ab" stroke-width="4"/>
        <rect x="80" y="8" width="80" height="54" rx="8" fill="#c4442f"/>
        <text x="120" y="43" fill="#fff" font-size="20" font-weight="700" text-anchor="middle">${esc(capCode(v))}</text>
      </svg>`;
    }
    case 'D': {
      const m = e.models[p.id] ?? p.model;
      if (m === 'none') return '';
      const body = m === 'LED' ? '#e0332b' : m === '1N34A' ? '#9b8a4a' : m === 'BAT41' ? '#2b2b2b' : '#e8a24a';
      return `<svg viewBox="0 0 240 50" width="240" height="50" aria-hidden="true">
        <path d="M0 25H80M160 25H240" stroke="#9aa5ab" stroke-width="3"/>
        <rect x="76" y="12" width="88" height="26" rx="12" fill="${body}" opacity="${m === 'LED' ? 1 : 0.85}"/>
        <rect x="140" y="12" width="9" height="26" fill="${m === 'BAT41' ? '#ddd' : '#1d1d1d'}"/>
      </svg>`;
    }
    case 'Q': {
      const ge = (e.models[p.id] ?? p.model) === 'Ge';
      return ge
        ? `<svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true"><circle cx="60" cy="34" r="28" fill="#b9bfc4" stroke="#8e969c" stroke-width="3"/><text x="60" y="39" text-anchor="middle" font-size="14" font-weight="700" fill="#333">Ge</text><path d="M48 62v18M60 62v18M72 62v18" stroke="#9aa5ab" stroke-width="3"/></svg>`
        : `<svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true"><path d="M30 50V24a30 30 0 0 1 60 0V50Z" fill="#1d1d1d"/><text x="60" y="38" text-anchor="middle" font-size="13" font-weight="700" fill="#ddd">Si</text><path d="M46 50v30M60 50v30M74 50v30" stroke="#9aa5ab" stroke-width="3"/></svg>`;
    }
    default: return '';
  }
}

// ---------------------------------------------------------------- editor

const KIND = { R: 'Resistor', C: 'Capacitor', D: 'Diode', Q: 'Transistor', POT: 'Potentiometer', OA: 'Op-amp' };
const RANGE = { R: [1, 10e6], POT: [100, 10e6], C: [1e-12, 1e-3] };

function pinNames(p) {
  switch (p.type) {
    case 'D': return ['Anode', 'Cathode'];
    case 'Q': return ['Collector', 'Base', 'Emitter'];
    case 'OA': return ['Inverting in (−)', 'Non-inverting in (+)', 'Output'];
    case 'POT': return p.ccw ? ['Clockwise end', 'Anticlockwise end', 'Wiper'] : ['Anticlockwise end', 'Clockwise end', 'Wiper'];
    default: return ['Pin 1', 'Pin 2'];
  }
}

function vf(model) {
  return model.n * VT * Math.log(1e-3 / model.Is + 1);
}

function valueField(p) {
  const v = edits().values[p.id] ?? p.value;
  const [lo, hi] = RANGE[p.type];
  const min = Math.max(lo, p.value / 100), max = Math.min(hi, p.value * 100);
  const t = Math.round(1000 * Math.log(v / min) / Math.log(max / min));
  const unit = p.type === 'C' ? 'F' : 'Ω';
  return `
    <label class="field">
      <span>Value (type 4k7, 47n, 2.2u…)</span>
      <span class="value-row">
        <input type="text" id="edValue" value="${esc(formatSI(v))}" inputmode="text" autocomplete="off" spellcheck="false">
        <span class="unit">${unit}</span>
        <span class="unit">stock ${esc(formatValue(p.value, p.type === 'C' ? 'C' : 'R'))}</span>
      </span>
    </label>
    <div class="field">
      <input type="range" id="edSlider" min="0" max="1000" value="${Math.min(1000, Math.max(0, t))}" aria-label="Value" data-min="${min}" data-max="${max}">
      <div class="range-ends"><span>${esc(formatSI(min))}${unit}</span><span>${esc(formatSI(max))}${unit}</span></div>
    </div>
    <div class="field">
      <span>Slider snaps to</span>
      <div class="segmented" role="radiogroup" aria-label="Preferred values">
        ${['E12', 'E24', 'off'].map((s) => `<label><input type="radio" name="snap" value="${s}" ${state.snap === s ? 'checked' : ''}>${s === 'off' ? 'Any value' : s}</label>`).join('')}
      </div>
    </div>`;
}

function renderEditor() {
  const ed = $('#editor');
  const p = part(state.selected);
  if (!p) { ed.hidden = true; return; }
  const e = edits();
  let body = '';
  if (p.type === 'R' || p.type === 'C') body = valueField(p);
  if (p.type === 'POT') {
    const taper = e.tapers[p.id] ?? p.taper ?? 'B';
    body = valueField(p) + `
      <div class="field">
        <span>Taper</span>
        <div class="segmented" role="radiogroup" aria-label="Taper">
          <label><input type="radio" name="taper" value="A" ${taper === 'A' ? 'checked' : ''}>A (log)</label>
          <label><input type="radio" name="taper" value="B" ${taper === 'B' ? 'checked' : ''}>B (linear)</label>
        </div>
      </div>
      <label class="field"><span>${p.trim ? 'Trimmer position' : `${esc(p.knob)} knob`}: <b id="edPosOut">${(knobPos(p) * 10).toFixed(1)}</b></span>
        <input type="range" id="edPos" min="0" max="1000" value="${Math.round(knobPos(p) * 1000)}">
      </label>`;
  }
  if (p.type === 'D') {
    const m = e.models[p.id] ?? p.model;
    body = `<fieldset><legend>Part</legend><div class="options">
      ${Object.entries(DIODE_MODELS).map(([k, d]) => `<label><input type="radio" name="dmodel" value="${k}" ${m === k ? 'checked' : ''}><span>${esc(d.label)}</span><small>${vf(d).toFixed(2)} V at 1 mA</small></label>`).join('')}
      <label><input type="radio" name="dmodel" value="none" ${m === 'none' ? 'checked' : ''}><span>Remove it</span><small>open circuit</small></label>
    </div></fieldset>`;
  }
  if (p.type === 'Q') {
    const m = e.models[p.id] ?? p.model;
    const h = e.hfe[p.id] ?? p.hfe;
    body = `
      <div class="field"><span>Material</span>
        <div class="segmented" role="radiogroup" aria-label="Transistor type">
          ${Object.entries(BJT_MODELS).map(([k, b]) => `<label><input type="radio" name="qmodel" value="${k}" ${m === k ? 'checked' : ''}>${esc(b.label)}</label>`).join('')}
        </div>
      </div>
      <label class="field"><span>Current gain hFE: <b id="edHfeOut">${h}</b> (stock ${p.hfe})</span>
        <input type="range" id="edHfe" min="10" max="600" step="1" value="${h}">
      </label>
      <p class="note">Germanium parts have lower turn-on voltage and far more leakage. Changing either will move the bias point, so check the DC voltages below.</p>`;
  }
  if (p.type === 'OA') {
    const m = e.models[p.id] ?? p.chip;
    body = `<fieldset><legend>Chip</legend><div class="options">
      ${Object.entries(OPAMP_MODELS).map(([k, o]) => `<label><input type="radio" name="oamodel" value="${k}" ${m === k ? 'checked' : ''}><span>${esc(o.label)}</span><small>${o.slew / 1e6} V/µs</small></label>`).join('')}
    </div></fieldset>
    <p class="note">Modelled with its gain-bandwidth and slew rate. A slow chip (low V/µs) rounds off the top of the clipped wave.</p>`;
  }
  const changed = changedParts().has(p.id);
  ed.innerHTML = `
    <div class="ed-head">
      <h2>${esc(p.id)}</h2><span class="kind">${KIND[p.type]}${p.knob ? `, ${esc(p.knob)}` : ''}</span>
      <button class="tool close" id="edClose" aria-label="Close">Done</button>
    </div>
    <div class="ed-art" id="edArt">${artFor(p)}</div>
    ${body}
    <div class="pins" id="edPins"></div>
    <div class="ed-actions">
      <button class="tool" id="edReset" ${changed ? '' : 'hidden'}>Reset to stock</button>
    </div>`;
  ed.hidden = false;
  refreshPins();
}

function refreshPins() {
  const box = $('#edPins');
  const p = part(state.selected);
  if (!box || !p || !state.analysis) return;
  const c = state.analysis.circuit;
  const nodes = state.net.pinNodes[p.id];
  const v = nodes.map((n) => c.nodeVoltage(n));
  const names = pinNames(p);
  let extra = '';
  const fmt = (x, d = 2) => (Math.abs(x) < 0.5 * Math.pow(10, -d) ? 0 : x).toFixed(d);
  if (p.type === 'Q') extra = `<dt>V<sub>BE</sub> / V<sub>CE</sub></dt><dd>${fmt(v[1] - v[2])} V / ${fmt(v[0] - v[2])} V</dd>`;
  if (p.type === 'D') extra = `<dt>Across it</dt><dd>${fmt(v[0] - v[1], 3)} V</dd>`;
  box.innerHTML = `<p>DC voltages with no signal${c.dcConverged ? '' : ' (bias did not converge)'}</p><dl>
    ${names.map((nm, i) => `<dt>${nm}</dt><dd>${fmt(v[i])} V</dd>`).join('')}${extra}</dl>`;
}

function refreshEditorArt() {
  const p = part(state.selected);
  const art = $('#edArt');
  if (art && p) art.innerHTML = artFor(p);
}

function setValue(id, v, { fromText = false } = {}) {
  edits().values[id] = v;
  update();
  refreshEditorArt();
  const input = $('#edValue');
  if (input && !fromText) { input.value = formatSI(v); input.removeAttribute('aria-invalid'); }
  refreshReset();
}

function refreshReset() {
  const reset = $('#edReset');
  if (reset) reset.hidden = !changedParts().has(state.selected);
}

const isSheet = () => matchMedia('(max-width: 860px)').matches;

function openEditor(id) {
  state.selected = id;
  document.body.classList.add('editing');
  renderSchematic();
  renderEditor();
  if (isSheet()) {
    // the editor is a bottom sheet here: make room for it and keep the part in view above it
    const sheet = $('#editor').offsetHeight;
    document.body.style.paddingBottom = `${sheet}px`;
    const el = $(`#schematic .part[data-id="${CSS.escape(id)}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      const visible = window.innerHeight - sheet;
      if (r.top < 8 || r.bottom > visible - 8) window.scrollBy({ top: r.top - (visible - r.height) / 2, behavior: 'smooth' });
      const wrap = $('#schematic');
      const wr = wrap.getBoundingClientRect();
      if (r.left < wr.left || r.right > wr.right) wrap.scrollBy({ left: r.left - wr.left - (wr.width - r.width) / 2, behavior: 'smooth' });
    }
  }
}
function closeEditor() {
  state.selected = null;
  $('#editor').hidden = true;
  document.body.classList.remove('editing');
  document.body.style.paddingBottom = '';
  renderSchematic();
}

function bindEditor() {
  const ed = $('#editor');
  ed.addEventListener('click', (e) => {
    if (e.target.id === 'edClose') closeEditor();
    if (e.target.id === 'edReset') {
      const id = state.selected, x = edits();
      delete x.values[id]; delete x.models[id]; delete x.hfe[id]; delete x.tapers[id];
      update();
      renderEditor();
    }
  });
  ed.addEventListener('input', (e) => {
    const id = state.selected, p = part(id);
    const t = e.target;
    if (t.id === 'edSlider') {
      const min = parseFloat(t.dataset.min), max = parseFloat(t.dataset.max);
      let v = min * Math.pow(max / min, t.value / 1000);
      v = state.snap === 'off' ? parseFloat(v.toPrecision(3)) : snapToSeries(v, state.snap);
      if (v !== (edits().values[id] ?? p.value)) setValue(id, v);
    }
    if (t.id === 'edValue') {
      const v = parseValue(t.value);
      t.setAttribute('aria-invalid', String(!(v > 0)));
    }
    if (t.id === 'edPos') {
      setKnob(id, t.value / 1000);
      $('#edPosOut').textContent = (t.value / 100).toFixed(1);
    }
    if (t.id === 'edHfe') {
      edits().hfe[id] = parseInt(t.value, 10);
      $('#edHfeOut').textContent = t.value;
      update();
      refreshReset();
    }
  });
  ed.addEventListener('change', (e) => {
    const id = state.selected;
    const t = e.target;
    if (t.id === 'edValue') {
      const v = parseValue(t.value);
      if (v > 0) setValue(id, v, { fromText: false });
      else t.setAttribute('aria-invalid', 'true');
    }
    if (t.name === 'snap') { state.snap = t.value; persist(); }
    if (t.name === 'taper') { edits().tapers[id] = t.value; update(); renderEditor(); }
    if (t.name === 'dmodel' || t.name === 'qmodel' || t.name === 'oamodel') {
      edits().models[id] = t.value;
      update();
      renderEditor();
    }
  });
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if (e.key === 'Enter' && e.target.id === 'edValue') e.target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// ---------------------------------------------------------------- wiring

function switchPedal(key) {
  state.key = key;
  state.selected = null;
  $('#editor').hidden = true;
  document.body.classList.remove('editing');
  document.body.style.paddingBottom = '';
  history.replaceState(null, '', `#${key}`);
  renderPedal();
  update();
}

function init() {
  restore();
  renderPedal();
  update();
  showLevels();
  bindKnobs();
  bindEditor();

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (b && b.dataset.key !== state.key) switchPedal(b.dataset.key);
  });

  const wrap = $('#schematic');
  wrap.addEventListener('click', (e) => {
    const g = e.target.closest('.part.editable');
    if (g) openEditor(g.dataset.id);
  });
  wrap.addEventListener('keydown', (e) => {
    const g = e.target.closest('.part.editable');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEditor(g.dataset.id); }
  });

  $('#changes').addEventListener('click', (e) => {
    if (e.target.id === 'resetAll') {
      const knobs = edits().knobs;
      state.edits[state.key] = { ...emptyEdits(), knobs };
      if (state.selected) renderEditor();
      update();
      toast('All parts back to stock values');
    }
    const chip = e.target.closest('.chip');
    if (chip) openEditor(chip.dataset.id);
  });

  $('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(2.5, (state.zoom ?? currentZoom()) * 1.2); applyZoom(); });
  $('#zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.35, (state.zoom ?? currentZoom()) / 1.2); applyZoom(); });
  $('#zoomFit').addEventListener('click', () => { state.zoom = null; applyZoom(); });
  const currentZoom = () => parseFloat($('#schematic svg').getAttribute('width')) / naturalWidth();
  new ResizeObserver(() => {
    if (state.zoom === null) applyZoom();
    if (state.analysis) drawResponse($('#bode'), state.analysis.current, state.analysis.original);
  }).observe($('#schematic'));

  $('#stomp').addEventListener('click', () => {
    state.bypass = !state.bypass;
    audio.setBypass(state.bypass);
    setLed();
  });

  $('#play').addEventListener('click', () => {
    if (audio.playing) stopPlayback();
    else {
      const src = $('#source').value;
      if (src === 'file') $('#file').click();
      else startPlayback(src);
    }
  });
  $('#source').addEventListener('change', (e) => {
    const src = e.target.value;
    showLiveUI();
    saveAudioPrefs();
    if (src === 'file') $('#file').click();
    else if (audio.playing) startPlayback(src);
  });
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) startPlayback({ file: f });
  });
  $('#inLevel').addEventListener('input', () => { showLevels(); audio.setInputVolts(inputVolts()); });
  $('#outLevel').addEventListener('input', () => { showLevels(); audio.setOutputGain(monitorGain()); });
  for (const id of ['#inLevel', '#outLevel']) $(id).addEventListener('change', saveAudioPrefs);

  $('#inDevice').addEventListener('change', async (e) => {
    try { await audio.setInputDevice(e.target.value); } catch (err) { liveError(err); }
    saveAudioPrefs();
    if (audio.playing) setTimeout(showLatency, 300);
  });
  $('#inChannel').addEventListener('change', (e) => { audio.setChannel(e.target.value); saveAudioPrefs(); });
  $('#outDevice').addEventListener('change', async (e) => {
    try { await audio.setOutputDevice(e.target.value); } catch (err) {
      $('#outDevice').value = '';
      $('#status').className = 'status warn';
      $('#status').textContent = `Couldn’t switch output: ${err.message}`;
    }
    saveAudioPrefs();
    setTimeout(showLatency, 300);
  });
  $('#latency').addEventListener('change', async (e) => {
    // the buffer size is fixed when the audio context is created, so rebuild it
    const wasPlaying = audio.playing, kind = audio.kind;
    audio.latencyMode = e.target.value;
    await audio.reset();
    saveAudioPrefs();
    if (wasPlaying && kind !== 'file') startPlayback(kind);
    else stopPlayback();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  loadAudioPrefs();
  showLevels();
  showLiveUI();
  refreshDevices();
  for (const r of document.querySelectorAll('input[name="os"]')) {
    r.addEventListener('change', () => audio.setOversample(osFactor()));
  }

  $('#share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#${state.key}:${encodeEdits(edits())}`;
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); toast('Link copied. It opens this exact build.'); } catch { toast('Link is in the address bar, ready to copy.'); }
  });
  $('#spice').addEventListener('click', () => {
    const text = toSpice(def(), state.net);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${state.key}.cir`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected) closeEditor();
  });
}

init();
