// Link to the native engine (pedal-engine.exe) running on this computer.
// The app does the audio on the interface's own driver (ASIO) for low latency;
// this page stays the control panel and sends it the same messages the
// AudioWorklet gets. It reconnects on its own when the app is started later.

export class NativeLink {
  constructor(url = 'ws://127.0.0.1:8790') {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.info = null;
    this.onChange = null;   // (connected, info) => void
    this.onStats = null;    // (stats) => void
    this.last = {};         // latest message of each type, re-sent after a reconnect
    this.retryMs = 4000;
  }

  start() {
    if (typeof WebSocket === 'undefined') return;
    this._connect();
    // check right away when the tab comes back, instead of waiting for the timer
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.ws) { clearTimeout(this.timer); this._connect(); }
    });
  }

  _connect() {
    this.timer = null;
    let ws;
    try { ws = new WebSocket(this.url); } catch { this._retry(); return; }
    this.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') {
        this.info = m;
        this.connected = true;
        for (const msg of Object.values(this.last)) ws.send(JSON.stringify(msg));
        this.onChange?.(true, m);
      } else if (m.type === 'stats') {
        this.onStats?.(m);
      }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.ws = null;
      this.connected = false;
      if (was) this.onChange?.(false, this.info);
      this._retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _retry() {
    if (this.timer || document.hidden) return;
    this.timer = setTimeout(() => this._connect(), this.retryMs);
  }

  send(type, payload = {}) {
    const msg = { type, ...payload };
    this.last[type] = msg;
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
