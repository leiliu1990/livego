// Manages the 4-corner selection UI on the setup screen.
// Corners are stored in tap order: TL, TR, BR, BL (user can tap any order,
// but we sort them into canonical positions after 4 are chosen).
//
// Interaction: two taps per corner. Tap roughly near a grid crossing → a still
// of the current frame is captured and a large MAGNIFIED crop opens → tap the
// exact crossing there. Because the zoom draws a frozen still (one drawImage,
// canvas→canvas), it's reliable on iOS — unlike a live loupe that must redraw
// the camera feed continuously while a finger drags.

const MAX_CORNERS = 4;
const ZOOM_CROP = 140; // display-space px shown across the magnified view

class CornerPicker {
  constructor(videoEl, overlayCanvas, onComplete) {
    this.video = videoEl;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
    this.onComplete = onComplete; // called with sorted [TL,TR,BR,BL]
    this.rawCorners = []; // {x,y} in display coords

    this.zoomOverlay = null;
    this.zoomCanvas  = null;
    this.zoomCtx     = null;
    this.frame       = null;      // offscreen still of the captured frame
    this.roughPoint  = null;      // {x,y} display coords of the first (rough) tap

    this._onRoughTap  = this._onRoughTap.bind(this);
    this._onZoomTap   = this._onZoomTap.bind(this);
    this._onZoomCancel = this._onZoomCancel.bind(this);
  }

  enable() {
    this._ensureZoom();
    this.video.parentElement.addEventListener('click', this._onRoughTap);
    this._syncCanvasSize();
    window.addEventListener('resize', () => this._syncCanvasSize());
  }

  disable() {
    this.video.parentElement.removeEventListener('click', this._onRoughTap);
    this._hideZoom();
  }

  _syncCanvasSize() {
    this.canvas.width = this.canvas.offsetWidth;
    this.canvas.height = this.canvas.offsetHeight;
    this._redraw();
  }

  // ── Rough tap → open magnifier ──────────────────────────────────────────────

  _onRoughTap(e) {
    if (e.target.closest('button') || e.target.closest('#game-info-form')) return;
    if (this.rawCorners.length >= MAX_CORNERS) return;
    if (this.zoomOverlay && this.zoomOverlay.classList.contains('show')) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this._openZoom(x, y);
  }

  // ── Magnifier ───────────────────────────────────────────────────────────────

  _ensureZoom() {
    if (this.zoomOverlay) return;
    this.zoomOverlay = document.getElementById('zoom-overlay');
    this.zoomCanvas  = document.getElementById('zoom-canvas');
    if (!this.zoomOverlay || !this.zoomCanvas) return;
    this.zoomCtx = this.zoomCanvas.getContext('2d');
    this.zoomCanvas.addEventListener('click', this._onZoomTap);
    const cancel = document.getElementById('zoom-cancel');
    if (cancel) cancel.addEventListener('click', this._onZoomCancel);
  }

  _openZoom(dx, dy) {
    if (!this.zoomOverlay) { this._commitPoint(dx, dy); return; } // fallback: no zoom UI

    // Capture the current frame once into a full-resolution still.
    if (!this.frame) this.frame = document.createElement('canvas');
    this.frame.width  = this.video.videoWidth;
    this.frame.height = this.video.videoHeight;
    this.frame.getContext('2d').drawImage(this.video, 0, 0);

    this.roughPoint = { x: dx, y: dy };
    this.zoomOverlay.classList.add('show');
    this._drawZoom(dx, dy);
  }

  _drawZoom(dx, dy) {
    const rect = this.zoomCanvas.getBoundingClientRect();
    const css  = rect.width; // square
    const dpr  = window.devicePixelRatio || 1;
    this.zoomCanvas.width  = Math.round(css * dpr);
    this.zoomCanvas.height = Math.round(css * dpr);
    const ctx = this.zoomCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { vx, vy, scale } = this._displayToVideo(dx, dy);
    const srcVid = ZOOM_CROP / scale; // video px shown across the view

    ctx.clearRect(0, 0, css, css);
    ctx.imageSmoothingEnabled = false; // crisp pixels when magnified
    try {
      ctx.drawImage(this.frame, vx - srcVid / 2, vy - srcVid / 2, srcVid, srcVid, 0, 0, css, css);
    } catch (_) { /* frame not ready */ }

    // Reference crosshair at the centre (where the rough tap was).
    const c = css / 2;
    ctx.strokeStyle = 'rgba(52,199,89,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c, 0); ctx.lineTo(c, css);
    ctx.moveTo(0, c); ctx.lineTo(css, c);
    ctx.stroke();
  }

  _onZoomTap(e) {
    e.stopPropagation();
    if (!this.roughPoint) return;
    const rect = this.zoomCanvas.getBoundingClientRect();
    const css  = rect.width;
    const zx = e.clientX - rect.left;
    const zy = e.clientY - rect.top;
    // Map the tap in the zoom view back to display coords.
    const cx = this.roughPoint.x + (zx / css - 0.5) * ZOOM_CROP;
    const cy = this.roughPoint.y + (zy / css - 0.5) * ZOOM_CROP;
    this._hideZoom();
    this._commitPoint(cx, cy);
  }

  _onZoomCancel(e) {
    if (e) e.stopPropagation();
    this._hideZoom();
  }

  _hideZoom() {
    this.roughPoint = null;
    if (this.zoomOverlay) this.zoomOverlay.classList.remove('show');
  }

  // Map a display-space point to video-pixel coords (video is object-fit:cover).
  _displayToVideo(dx, dy) {
    const vidW = this.video.videoWidth, vidH = this.video.videoHeight;
    const dispW = this.canvas.offsetWidth, dispH = this.canvas.offsetHeight;
    const scale = Math.max(dispW / vidW, dispH / vidH);
    const cropX = (vidW * scale - dispW) / 2;
    const cropY = (vidH * scale - dispH) / 2;
    return { vx: (dx + cropX) / scale, vy: (dy + cropY) / scale, scale };
  }

  // ── Commit / edit ────────────────────────────────────────────────────────────

  _commitPoint(x, y) {
    if (this.rawCorners.length >= MAX_CORNERS) return;
    this.rawCorners.push({ x, y });
    this._redraw();
    this._updateUI();

    if (this.rawCorners.length === MAX_CORNERS) {
      this.disable();
      const sorted = sortCorners(this.rawCorners);
      const meta = {
        vidW:  this.video.videoWidth,
        vidH:  this.video.videoHeight,
        dispW: this.canvas.offsetWidth,
        dispH: this.canvas.offsetHeight,
      };
      this.onComplete(sorted, meta);
    }
  }

  undoLast() {
    if (this.rawCorners.length === 0) return;
    this.rawCorners.pop();
    if (this.rawCorners.length < MAX_CORNERS) {
      this.enable();
    }
    this._redraw();
    this._updateUI();
  }

  reset() {
    this.rawCorners = [];
    this.enable();
    this._redraw();
    this._updateUI();
  }

  _redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.rawCorners.length >= 3) {
      const sorted = this.rawCorners.length === 4
        ? sortCorners(this.rawCorners)
        : this.rawCorners;
      ctx.beginPath();
      ctx.moveTo(sorted[0].x, sorted[0].y);
      for (let i = 1; i < sorted.length; i++) ctx.lineTo(sorted[i].x, sorted[i].y);
      if (sorted.length === 4) ctx.closePath();
      ctx.strokeStyle = 'rgba(52, 199, 89, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(52, 199, 89, 0.12)';
      ctx.fill();
    }

    this.rawCorners.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#34c759';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px -apple-system';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, c.x, c.y);
    });
  }

  _updateUI() {
    const n = this.rawCorners.length;
    document.getElementById('corner-count').textContent = `${n} / 4 corners set`;
    document.getElementById('btn-undo-corner').disabled = n === 0;
    document.getElementById('btn-start').disabled = n < 4;
  }
}

// Sort 4 points into [TL, TR, BR, BL] order.
function sortCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;

  const TL = pts.filter(p => p.x <= cx && p.y <= cy);
  const TR = pts.filter(p => p.x >  cx && p.y <= cy);
  const BR = pts.filter(p => p.x >  cx && p.y >  cy);
  const BL = pts.filter(p => p.x <= cx && p.y >  cy);

  // Fallback: if a quadrant is empty, just sort by angle
  if ([TL, TR, BR, BL].some(q => q.length === 0)) {
    const sorted = [...pts].sort((a, b) => {
      const aA = Math.atan2(a.y - cy, a.x - cx);
      const bA = Math.atan2(b.y - cy, b.x - cx);
      return aA - bA;
    });
    return sorted;
  }

  return [
    closest(TL, { x: 0,       y: 0 }),
    closest(TR, { x: Infinity, y: 0 }),
    closest(BR, { x: Infinity, y: Infinity }),
    closest(BL, { x: 0,       y: Infinity }),
  ];
}

function closest(pts, ref) {
  return pts.reduce((best, p) =>
    dist(p, ref) < dist(best, ref) ? p : best
  );
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
