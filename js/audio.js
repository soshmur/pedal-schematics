// Audio graph:
//   live input / clip / file -> channel pick -> input -> [pedal worklet] -> monitor gain -> limiter -> output device
//                                                  \-> inTap (meter, scope)    \-> outTap (scope)
//
// The dry input never goes to the output directly: everything you hear has
// been through the circuit (or the worklet's bypass path).
import { renderRiff } from './riffs.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.kind = 'live';
    this.playing = false;
    this.onStats = null;
    this.buffers = {};
    // live-input settings
    this.inputId = '';
    this.outputId = '';
    this.channel = '0';        // '0' = input 1 / left, '1' = input 2 / right, 'mix' = both
    this.latencyMode = 'lowest'; // 'lowest' | 'stable'
    this.stream = null;
    this.streamChannels = 0;
  }

  static get liveSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  static get outputSelectable() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  async init(sampleRate) {
    if (this.ctx) return;
    const opts = { latencyHint: this.latencyMode === 'lowest' ? 0 : 'balanced' };
    if (sampleRate) opts.sampleRate = sampleRate;
    let ctx;
    try { ctx = new AudioContext(opts); } catch { delete opts.sampleRate; ctx = new AudioContext(opts); }
    this.ctx = ctx;
    this.buffers = {};
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(ctx, 'pedal-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => { if (e.data.type === 'stats' && this.onStats) this.onStats(e.data); };
    // mono summing point for every source
    this.input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.out = ctx.createGain();
    this.out.gain.value = 0.25;
    // brick-wall-ish limiter so a fuzz at full volume can't hurt anyone
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.inTap = ctx.createAnalyser();
    this.outTap = ctx.createAnalyser();
    this.inTap.fftSize = this.outTap.fftSize = 2048;
    this.input.connect(this.node);
    this.input.connect(this.inTap);
    this.node.connect(this.outTap);
    this.node.connect(this.out).connect(this.limiter).connect(ctx.destination);
    if (this.outputId) await this.setOutputDevice(this.outputId);
    if (this.pendingNet) this.setNetlist(this.pendingNet);
  }

  /** Close the audio context; the next play() builds a fresh one. */
  async reset() {
    this._stopSource();
    this.playing = false;
    if (this.ctx) { try { await this.ctx.close(); } catch { /* already closed */ } }
    this.ctx = null;
    this.node = null;
  }

  setNetlist(net) {
    this.pendingNet = net;
    if (!this.node) return;
    // strip editor-only fields before cloning to the audio thread
    const { nodeCount, output, elements } = net;
    this.node.port.postMessage({ type: 'netlist', net: { nodeCount, output, elements } });
  }

  setBypass(on) { this.node?.port.postMessage({ type: 'bypass', on }); }
  setOversample(f) { this.node?.port.postMessage({ type: 'oversample', factor: f }); }
  setInputVolts(v) { if (this.node) this.node.parameters.get('inputVolts').setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setOutputGain(g) { if (this.out) this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02); }

  async setOutputDevice(id) {
    this.outputId = id;
    if (this.ctx && AudioEngine.outputSelectable) {
      try { await this.ctx.setSinkId(id || ''); } catch (err) { this.outputId = ''; throw err; }
    }
  }

  /** Pick which interface input feeds the pedal, without reopening the device. */
  setChannel(ch) {
    this.channel = ch;
    if (this.kind === 'live' && this.stream && this.ctx) this._wireLive();
  }

  async setInputDevice(id) {
    this.inputId = id;
    if (this.kind === 'live' && this.playing) await this.play('live');
  }

  _stopSource() {
    if (this.source) {
      try { this.source.stop?.(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    if (this.picker) { this.picker.forEach((n) => n.disconnect()); this.picker = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  async _openStream() {
    const audio = {
      // raw signal: no voice processing on a guitar
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      latency: { ideal: 0 },
    };
    if (this.inputId) audio.deviceId = { exact: this.inputId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      // the saved device was unplugged: fall back to the default input
      if (this.inputId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        this.inputId = '';
        delete audio.deviceId;
        return navigator.mediaDevices.getUserMedia({ audio });
      }
      throw err;
    }
  }

  _wireLive() {
    if (this.source) this.source.disconnect();
    if (this.picker) this.picker.forEach((n) => n.disconnect());
    this.picker = null;
    const src = this.source;
    const ch = this.channel;
    if (this.streamChannels >= 2 && ch !== 'mix') {
      const split = this.ctx.createChannelSplitter(2);
      src.connect(split);
      split.connect(this.input, parseInt(ch, 10));
      this.picker = [split];
    } else {
      // mono device, or "both": the input node sums to mono
      src.connect(this.input);
    }
  }

  /** Start a source: 'live', a demo clip key, or { file: File }. */
  async play(kind = this.kind) {
    this.kind = typeof kind === 'string' ? kind : 'file';
    if (kind === 'live') {
      if (!AudioEngine.liveSupported) throw Object.assign(new Error('insecure'), { name: 'NotSupportedError' });
      this._stopSource();
      const stream = await this._openStream();
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings ? track.getSettings() : {};
      // Run the context at the interface's own rate: no resampling, and
      // Firefox refuses to connect a stream at a different rate anyway.
      if (this.ctx && settings.sampleRate && this.ctx.sampleRate !== settings.sampleRate) await this.reset();
      await this.init(settings.sampleRate);
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this.stream = stream;
      this.streamChannels = settings.channelCount || 1;
      this.source = this.ctx.createMediaStreamSource(stream);
      this._wireLive();
      track.addEventListener('ended', () => { if (this.onEnded) this.onEnded(); });
    } else {
      await this.init();
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this._stopSource();
      let buffer;
      if (typeof kind === 'object' && kind.file) {
        buffer = await this.ctx.decodeAudioData(await kind.file.arrayBuffer());
        // normalise uploaded files so the input-level knob means the same thing
        const data = buffer.getChannelData(0);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        const mono = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
        const m = mono.getChannelData(0);
        for (let i = 0; i < data.length; i++) m[i] = data[i] / (peak || 1);
        buffer = mono;
      } else {
        if (!this.buffers[kind]) {
          const data = renderRiff(kind, this.ctx.sampleRate);
          const b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
          b.copyToChannel(data, 0);
          this.buffers[kind] = b;
        }
        buffer = this.buffers[kind];
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.start();
      this.source = src;
      this.source.connect(this.input);
    }
    this.playing = true;
  }

  stop() {
    this._stopSource();
    this.playing = false;
  }

  /** Estimated input-to-output delay in ms (what the browser reports). */
  latencyMs() {
    if (!this.ctx) return null;
    const out = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    let inp = 0;
    const track = this.stream?.getAudioTracks()[0];
    if (track?.getSettings) inp = track.getSettings().latency || 0;
    const quantum = 128 / this.ctx.sampleRate; // one worklet block
    return { total: (out + inp + quantum) * 1000, input: inp * 1000, output: out * 1000, reported: inp > 0 || this.ctx.outputLatency > 0 };
  }

  /** Audio inputs and outputs. Labels are empty until mic permission is granted. */
  static async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    const list = await navigator.mediaDevices.enumerateDevices();
    const clean = (kind) => list.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    return { inputs: clean('audioinput'), outputs: clean('audiooutput') };
  }
}
