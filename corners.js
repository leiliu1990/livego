// Manages the 4-corner selection UI on the setup screen.
// Corners are stored in tap order: TL, TR, BR, BL (user can tap any order,
// but we sort them into canonical positions after 4 are chosen).
//
// Interaction: press-drag-release with a magnifier loupe. On pointer-down a
// zoomed circle appears offset above the finger showing the exact spot under it
// (with a crosshair); dragging moves it; releasing places the corner. This lets
// you land precisely on a grid crossing even though your fingertip covers it.

const MAX_CORNERS = 4;
const LOUPE_CSS   = 132; // must match #loupe width/height in CSS
const LOUPE_ZOOM  = 2.8; // magnification factor

class CornerPicker {
  constructor(videoEl, overlayCanvas, onComplete) {
    this.video = videoEl;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
    this.onComplete = onComplete; // called with sorted [TL,TR,BR,BL]
    this.rawCorners = []; // {x,y} in display coords
    this.dots = [];

    this.loupe    = null;
    this.loupeCtx = null;
    this.dragging = false;
    this.curPoint = null; // {x,y} display coords during a drag

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp   = this._onUp.bind(this);
  }

  enable() {
    this._ensureLoupe();
    const el = this.video.parentElement;
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    this._syncCanvasSize();
    window.addEventListener('resize', () => this._syncCanvasSize());
  }

  disable() {
    const el = this.video.parentElement;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    this._hideLoupe();
  }

  _syncCanvasSize() {
    this.canvas.width = this.canvas.offsetWidth;
    this.canvas.height = this.canvas.offsetHeight;
    this._redraw();
  }

  // ── Pointer handling ──────────────────────────────────────────────────────

  _onDown(e) {
    // Ignore presses on buttons / the game-info form.
    if (e.target.closest('button') || e.target.closest('#game-info-form')) return;
    if (this.rawCorners.length >= MAX_CORNERS) return;

    e.preventDefault();
    this.dragging = true;
    this.curPoint = this._eventPoint(e);
    this._updateLoupe(this.curPoint.x, this.curPoint.y);
  }

  _onMove(e) {
    if (!this.dragging) return;
    e.preventDefault();
    this.curPoint = this._eventPoint(e);
    this._updateLoupe(this.curPoint.x, this.curPoint.y);
  }

  _onUp(e) {
    if (!this.dragging) return;
    e.preventDefault();
    this.dragging = false;
    this._hideLoupe();

    const p = this.curPoint || this._eventPoint(e);
    this.curPoint = null;
    this._commitPoint(p.x, p.y);
  }

  _eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

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

  // ── Magnifier loupe ─────────────────────────────────────────────────────────

  _ensureLoupe() {
    if (this.loupe) return;
    this.loupe = document.getElementById('loupe');
    if (!this.loupe) return;
    const dpr = window.devicePixelRatio || 1;
    this.loupe.width  = LOUPE_CSS * dpr;
    this.loupe.height = LOUPE_CSS * dpr;
    this.loupeCtx = this.loupe.getContext('2d');
    this.loupeCtx.scale(dpr, dpr); // draw in CSS pixels
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

  _updateLoupe(dx, dy) {
    if (!this.loupe) return;
    const ctx  = this.loupeCtx;
    const size = LOUPE_CSS;
    const { vx, vy, scale } = this._displayToVideo(dx, dy);
    const srcVid = (size / LOUPE_ZOOM) / scale; // video px shown across the loupe

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    try {
      ctx.drawImage(this.video, vx - srcVid / 2, vy - srcVid / 2, srcVid, srcVid, 0, 0, size, size);
    } catch (_) { /* video not ready */ }
    ctx.restore();

    // Crosshair marking the exact placement point.
    const c = size / 2;
    ctx.strokeStyle = 'rgba(52,199,89,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c, c - 16); ctx.lineTo(c, c - 5);
    ctx.moveTo(c, c + 5);  ctx.lineTo(c, c + 16);
    ctx.moveTo(c - 16, c); ctx.lineTo(c - 5, c);
    ctx.moveTo(c + 5, c);  ctx.lineTo(c + 16, c);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Position the loupe above the finger; flip below if near the top edge.
    const pad = 10;
    const dispW = this.canvas.offsetWidth;
    let lx = dx - size / 2;
    let ly = dy - size - 44;
    if (ly < pad) ly = dy + 44;
    lx = Math.max(pad, Math.min(dispW - size - pad, lx));
    this.loupe.style.left = lx + 'px';
    this.loupe.style.top  = ly + 'px';
    this.loupe.classList.add('show');
  }

  _hideLoupe() {
    if (this.loupe) this.loupe.classList.remove('show');
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
      // Draw the polygon outline
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

    // Draw corner dots
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
    // rotate so topmost-left is first
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
