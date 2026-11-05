/**
 * FlashWS v2 — Ultra-low-latency persistent WebSocket client
 *
 * Improvements over v1:
 *  - 500ms initial reconnect (was 1000ms), 10s max (was 15s)
 *  - 5s ping interval (was 20s) — faster dead-connection detection
 *  - Outbound send queue — commands buffered during reconnect, flushed on open
 *  - binaryType='arraybuffer' — zero-copy binary frames into HvncRenderer
 *  - Jitter on reconnect — prevents thundering herd with multiple tabs
 */
class FlashWS extends EventTarget {
  constructor(url, { reconnectBase = 500, reconnectMax = 10000, pingInterval = 5000 } = {}) {
    super();
    this.url           = url;
    this.reconnectBase = reconnectBase;
    this.reconnectMax  = reconnectMax;
    this.pingInterval  = pingInterval;

    this._ws           = null;
    this._attempt      = 0;
    this._reconnTimer  = null;
    this._pingTimer    = null;
    this._destroyed    = false;
    this._latency      = 0;
    this._lastPing     = 0;
    this._sendQueue    = [];   // buffer commands while reconnecting
    this.connected     = false;

    this.connect();
  }

  connect() {
    if (this._destroyed) return;
    try {
      this._ws = new WebSocket(this.url);
      this._ws.binaryType = 'arraybuffer';   // ensure zero-copy ArrayBuffer for HVNC

      this._ws.onopen = () => {
        this._attempt = 0;
        this.connected = true;
        this._startPing();
        // Flush queued commands
        while (this._sendQueue.length) {
          const queued = this._sendQueue.shift();
          this._ws.send(queued);
        }
        this.dispatchEvent(new CustomEvent('open'));
      };

      this._ws.onmessage = e => {
        // Binary frame — HVNC stream — dispatch raw, zero alloc
        if (e.data instanceof ArrayBuffer) {
          this.dispatchEvent(new CustomEvent('binary', { detail: e.data }));
          return;
        }
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'pong') {
            this._latency = Date.now() - this._lastPing;
            this.dispatchEvent(new CustomEvent('latency', { detail: this._latency }));
            return;
          }
          this.dispatchEvent(new CustomEvent('message', { detail: msg }));
        } catch {}
      };

      this._ws.onclose = () => {
        this._cleanup();
        if (!this._destroyed) this._scheduleReconnect();
      };

      this._ws.onerror = () => {
        this._ws?.close();
      };
    } catch {
      if (!this._destroyed) this._scheduleReconnect();
    }
  }

  send(data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(str);
      return true;
    }
    // Queue non-binary commands during reconnect (max 32 to avoid memory growth)
    if (this._sendQueue.length < 32) this._sendQueue.push(str);
    return false;
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._lastPing = Date.now();
        this._ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, this.pingInterval);
  }

  _cleanup() {
    this.connected = false;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    this.dispatchEvent(new CustomEvent('close'));
  }

  _scheduleReconnect() {
    this._attempt++;
    // Exponential backoff + ±10% jitter to prevent thundering herd
    const base  = Math.min(this.reconnectBase * Math.pow(1.5, this._attempt - 1), this.reconnectMax);
    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    const delay  = Math.round(base + jitter);
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: this._attempt, delay } }));
    this._reconnTimer = setTimeout(() => this.connect(), delay);
  }

  get latency() { return this._latency; }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._reconnTimer);
    clearInterval(this._pingTimer);
    this._ws?.close();
  }
}

window.FlashWS = FlashWS;
