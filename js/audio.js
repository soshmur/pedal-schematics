// Audio graph:  source -> [pedal worklet] -> output gain -> limiter -> speakers
//                  \-> inTap (analyser)        \-> outTap (analyser)
import { renderRiff } from './riffs.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.kind = 'pentatonic';
    this.playing = false;
    this.onStats = null;
    this.buffers = {};
  }

  async init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(ctx, 'pedal-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => { if (e.data.type === 'stats' && this.onStats) this.onStats(e.data); };
    this.input = ctx.createGain();
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
    if (this.pendingNet) this.setNetlist(this.pendingNet);
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

  _stopSource() {
    if (!this.source) return;
    try { this.source.stop?.(); } catch { /* already stopped */ }
    this.source.disconnect();
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.source = null;
  }

  /** Start a source: a demo clip key, 'mic', or { file: File }. */
  async play(kind = this.kind) {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this._stopSource();
    this.kind = typeof kind === 'string' ? kind : 'file';
    if (kind === 'mic') {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.source = this.ctx.createMediaStreamSource(this.stream);
    } else {
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
    }
    this.source.connect(this.input);
    this.playing = true;
  }

  stop() {
    this._stopSource();
    this.playing = false;
  }
}
