const BOARD_SIZE      = 19;
// Detection is motion-gated rather than time-gated: we sample often, ignore
// frames while the scene is moving (a hand placing a stone, camera shake), and
// commit as soon as the board settles. This responds to fast play — a move is
// recorded ~QUIET_FRAMES samples after the hand withdraws, not after a fixed
// multi-second wait.
const SAMPLE_INTERVAL = 400;   // ms between frames (fast; motion gating does the filtering)
const QUIET_FRAMES    = 2;     // settled (low-motion) samples of a stable state before committing
// Motion = fraction of board pixels that changed materially since the last frame.
// A hand/arm over the board changes a large contiguous area (>10%); placing one
// stone changes ~0.2%; sensor noise ~0%. Robust to exposure/noise unlike a raw
// brightness delta. Above this fraction, the scene is "moving" and we wait.
const MOTION_PIXEL_DELTA = 25;    // per-pixel gray change counted as "changed"
const MOTION_THRESH      = 0.03;  // fraction of changed pixels above which we suppress
// You can place only a stone or two between settles, but a lighting change flips
// many cells at once. If more than this many cells newly read as stones, it's not
// real play — absorb the frame as the new background instead of recording moves.
// (Removals aren't capped: a capture legitimately clears many stones.)
const MAX_PLACED_PER_STEP = 6;

const STONE = { EMPTY: 0, BLACK: 1, WHITE: 2 };

const WARP_SIZE   = 760;                                              // px — perspective-corrected board output size
const WARP_MARGIN = WARP_SIZE / (BOARD_SIZE + 1);                    // px from edge to first grid line
const WARP_STEP   = (WARP_SIZE - 2 * WARP_MARGIN) / (BOARD_SIZE - 1); // px between adjacent grid lines
const STONE_RADIUS = Math.round(WARP_STEP * 0.45);                   // sampling radius ≈ 45% of one grid cell

// Stones are classified by how much each intersection's brightness CHANGES from
// the empty board captured at the start — not by absolute brightness. This is
// essential: bright wood grain overlaps white-stone brightness (both ~210-240),
// so a global threshold classifies wood as white. But wood doesn't *change* from
// its own empty baseline, while a white stone brightens its cell markedly.
const WHITE_DELTA = 18;   // ≥ this brightening vs empty ⇒ white stone
const BLACK_DELTA = -70;  // ≤ this darkening  vs empty ⇒ black stone

class BoardDetector {
  // displayMeta: { vidW, vidH, dispW, dispH } captured at corner-pick time
  // onFrame(boardState): called after every sample (for UI overlay)
  constructor(videoEl, corners, displayMeta, onMove, onFrame) {
    this.video       = videoEl;
    this.corners     = corners;
    this.displayMeta = displayMeta;
    this.onMove      = onMove;
    this.onFrame     = onFrame || null;

    this.boardState   = Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(STONE.EMPTY));
    this.pendingState = null;
    this.pendingCount = 0;
    this.running      = false;
    this._lastColor   = null; // color of the last committed move (for batch ordering)

    this._src    = null;
    this._warped = null;
    this._gray   = null;
    this._prevGray = null;  // previous frame's warped gray, for motion detection
    this._diff     = null;
    this._diffMask = null;
    this._motion   = Infinity;
    this._ambient  = 0;     // per-frame global lighting shift vs baseline
    this._cur      = null;  // per-frame current brightness at each intersection

    // Empty-board reference, established from the first good frame.
    this._baseline = null;                 // 19×19 brightness of the empty board
    this._colPos   = null;                 // fitted grid line x-positions (in warp px)
    this._rowPos   = null;                 // fitted grid line y-positions
  }

  start() {
    this.running = true;
    this._tick();
  }

  stop() {
    this.running = false;
    this._freeMats();
  }

  undoLastMove(previousState) {
    this.boardState   = previousState;
    this.pendingState = null;
    this.pendingCount = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _tick() {
    if (!this.running) return;
    try {
      const newState = this._detectState();
      if (newState) {
        this._reconcile(newState);
        this.onFrame?.(this.boardState);
      }
    } catch (e) {
      console.warn('Detection error:', e);
    }
    setTimeout(() => this._tick(), SAMPLE_INTERVAL);
  }

  _detectState() {
    if (this.video.readyState < 2) return null;

    const cap = captureFrame(this.video);

    // cv.imread() always returns a NEW Mat — it ignores a destination argument —
    // so we must replace _src each frame. Reusing it froze detection on frame 0.
    if (this._src) this._src.delete();
    this._src = cv.imread(cap);
    if (!this._warped) {
      this._warped = new cv.Mat();
      this._gray   = new cv.Mat();
    }

    this._warpBoard();

    cv.cvtColor(this._warped, this._gray, cv.COLOR_RGBA2GRAY);
    const ksize = new cv.Size(5, 5);
    cv.GaussianBlur(this._gray, this._gray, ksize, 0);

    // Motion = fraction of pixels that changed materially since the last frame.
    // High while a hand covers part of the board; near-zero once it settles.
    if (!this._prevGray) {
      this._prevGray = new cv.Mat();
      this._diff     = new cv.Mat();
      this._diffMask = new cv.Mat();
      this._motion   = Infinity;
    } else {
      cv.absdiff(this._gray, this._prevGray, this._diff);
      cv.threshold(this._diff, this._diffMask, MOTION_PIXEL_DELTA, 255, cv.THRESH_BINARY);
      this._motion = cv.countNonZero(this._diffMask) / (this._gray.rows * this._gray.cols);
    }
    this._gray.copyTo(this._prevGray);

    // First good frame: the board is empty. Lock the grid to the real lines and
    // record each intersection's empty brightness. Commit no moves this frame.
    if (!this._baseline) {
      this._fitGrid();
      this._captureBaseline();
      return null;
    }

    // Estimate the ambient lighting shift so a uniform change (e.g. a shadow
    // falling over the whole board) doesn't look like stones. Each cell's delta
    // vs baseline = ambient shift (shared by all cells) + any stone (a few cells).
    // The MEDIAN delta is the shift: most cells are empty, so stones are outliers
    // that the median ignores. Subtracting it re-references the baseline to the
    // current lighting. Classification then only fires on *local* changes.
    this._cur = [];
    const deltas = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = [];
      for (let c = 0; c < BOARD_SIZE; c++) {
        const { x, y } = this._intersectionPx(r, c);
        const v = sampleMean(this._gray, x, y, STONE_RADIUS);
        row.push(v);
        deltas.push(v - this._baseline[r][c]);
      }
      this._cur.push(row);
    }
    this._ambient = medianOf(deltas);

    const state = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = [];
      for (let c = 0; c < BOARD_SIZE; c++) row.push(this._classifyIntersection(r, c));
      state.push(row);
    }
    return state;
  }

  // Convert a CSS-pixel tap point (from the setup screen) to video-pixel coords.
  // The video element uses object-fit:cover, so the video is scaled to fill the
  // element and then center-cropped. A simple vidW/dispW ratio is WRONG.
  _displayToVideoCoords(dx, dy) {
    const { vidW, vidH, dispW, dispH } = this.displayMeta;
    const scale     = Math.max(dispW / vidW, dispH / vidH);
    const cropX     = (vidW * scale - dispW) / 2;
    const cropY     = (vidH * scale - dispH) / 2;
    return {
      x: (dx + cropX) / scale,
      y: (dy + cropY) / scale,
    };
  }

  _warpBoard() {
    const pts = this.corners.map(c => this._displayToVideoCoords(c.x, c.y));

    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      pts[0].x, pts[0].y,
      pts[1].x, pts[1].y,
      pts[2].x, pts[2].y,
      pts[3].x, pts[3].y,
    ]);
    // The corners are the 4 outermost GRID crossings (not the board's physical
    // edge), so we map them to a rectangle inset by one cell (WARP_MARGIN). That
    // headroom keeps edge stones — which overhang the outer line by ~½ a stone —
    // inside the image, and places the outer crossings exactly on the ideal grid
    // positions (WARP_MARGIN + i·WARP_STEP). No rim-width assumption is involved.
    const m = WARP_MARGIN, e = WARP_SIZE - WARP_MARGIN;
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      m, m,
      e, m,
      e, e,
      m, e,
    ]);

    const M     = cv.getPerspectiveTransform(srcPts, dstPts);
    const dsize = new cv.Size(WARP_SIZE, WARP_SIZE);
    cv.warpPerspective(this._src, this._warped, M, dsize);
    M.delete(); srcPts.delete(); dstPts.delete();
  }

  // Refine the sampling grid to the board's actual lines. The real grid is
  // strictly straight and evenly spaced, so we keep the model RIGID — a single
  // offset and spacing per axis — and search a small range around the ideal
  // (WARP_MARGIN, WARP_STEP) for the alignment that best matches the dark lines.
  //
  // This is deliberately NOT a per-line snap: wood grain can pull an individual
  // line off its crossing, but it cannot fool the alignment of all 19 lines at
  // once. The narrow search also can't reach the board-edge line just outside
  // the grid, so it stays locked to the real crossings.
  _fitGrid() {
    this._colPos = refineUniformGrid(columnDarkness(this._gray), BOARD_SIZE);
    this._rowPos = refineUniformGrid(rowDarkness(this._gray), BOARD_SIZE);
  }

  // Record the empty-board brightness at every intersection.
  _captureBaseline() {
    this._baseline = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = [];
      for (let c = 0; c < BOARD_SIZE; c++) {
        const { x, y } = this._intersectionPx(r, c);
        row.push(sampleMean(this._gray, x, y, STONE_RADIUS));
      }
      this._baseline.push(row);
    }
  }

  _intersectionPx(r, c) {
    if (this._colPos) return { x: this._colPos[c], y: this._rowPos[r] };
    // Fallback before the grid is fitted (used only during baseline capture setup).
    return {
      x: Math.round(WARP_MARGIN + c * WARP_STEP),
      y: Math.round(WARP_MARGIN + r * WARP_STEP),
    };
  }

  _classifyIntersection(r, c) {
    const { x, y } = this._intersectionPx(r, c);
    // Subtract the ambient shift so only local (stone) changes count.
    const delta = sampleMean(this._gray, x, y, STONE_RADIUS) - this._baseline[r][c] - this._ambient;

    if (delta < BLACK_DELTA) return STONE.BLACK;
    if (delta > WHITE_DELTA) return STONE.WHITE;
    return STONE.EMPTY;
  }

  _reconcile(newState) {
    // While the scene is moving (a hand over the board, camera shake), readings
    // are unreliable — some cells are occluded. Wait for it to settle. This is
    // what lets us commit quickly afterwards instead of counting fixed seconds.
    if (this._motion > MOTION_THRESH) {
      this.pendingState = null;
      this.pendingCount = 0;
      return;
    }

    const diff = diffStates(this.boardState, newState);

    if (diff.length === 0) {
      this.pendingState = null;
      this.pendingCount = 0;
      return;
    }

    if (this.pendingState && statesEqual(newState, this.pendingState)) {
      this.pendingCount++;
    } else {
      this.pendingState = newState;
      this.pendingCount = 1;
    }

    // Board has settled to a new stable state → commit after a couple of quiet
    // frames (guards against a single noisy sample).
    if (this.pendingCount >= QUIET_FRAMES) {
      // Too many cells newly show stones at once? That's a lighting/background
      // change, not play (you can't place 7 stones in one turn). Absorb the
      // current frame as the new baseline and record nothing. Removals are not
      // counted — a capture can legitimately clear many stones at once.
      const placedNow = diff.filter(d => d.from === STONE.EMPTY && d.to !== STONE.EMPTY).length;
      if (placedNow > MAX_PLACED_PER_STEP) {
        this._rebaseline();
      } else {
        this._commitState(newState, diff);
      }
      this.pendingState = null;
      this.pendingCount = 0;
    }
  }

  // Adopt the current settled frame as the new empty-board reference, folding in
  // the ambient shift so existing (already-recorded) stones stay stones. Called
  // when a change is too large to be real play — i.e. a lighting/background shift.
  _rebaseline() {
    if (!this._cur) return;
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++) {
        // Only re-baseline EMPTY points; keep known stones anchored to their old
        // baseline so they remain detectable after the lighting change.
        if (this.boardState[r][c] === STONE.EMPTY) this._baseline[r][c] = this._cur[r][c];
      }
    this._ambient = 0;
  }

  _commitState(newState, diff) {
    const prev    = this.boardState;
    this.boardState = newState;

    const placed  = diff.filter(d => d.from === STONE.EMPTY && d.to !== STONE.EMPTY);
    const removed = diff.filter(d => d.from !== STONE.EMPTY && d.to === STONE.EMPTY);

    if (placed.length === 0) {
      if (removed.length) console.info('Stones vanished without a placement:', removed.length);
      return;
    }

    // A single sample can reveal several stones played in quick succession. Emit
    // one move per stone. Real play alternates colors, so we order the batch to
    // alternate B/W (exact order within a batch is otherwise unknowable). Captures
    // are attributed to the final move of the batch.
    const ordered = orderAlternating(placed, this._lastColor);
    ordered.forEach((p, i) => {
      const last = i === ordered.length - 1;
      this.onMove({
        row: p.row, col: p.col, color: p.to,
        captures: last ? removed.map(d => ({ row: d.row, col: d.col })) : [],
        prevBoard: i === 0 ? prev : null,
      });
      this._lastColor = p.to;
    });
  }

  _freeMats() {
    if (this._src)      { this._src.delete();      this._src      = null; }
    if (this._warped)   { this._warped.delete();   this._warped   = null; }
    if (this._gray)     { this._gray.delete();     this._gray     = null; }
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._diff)     { this._diff.delete();     this._diff     = null; }
    if (this._diffMask) { this._diffMask.delete(); this._diffMask = null; }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Order a batch of newly-placed stones so colors alternate, as real play does.
// Order within a batch is otherwise unknowable, so we only guarantee alternation.
// Starting color: the colour with more new stones must have moved first; if the
// counts are equal it's the opposite of the previous move (Black leads a new game).
function orderAlternating(placed, lastColor) {
  const blacks = placed.filter(p => p.to === STONE.BLACK);
  const whites = placed.filter(p => p.to === STONE.WHITE);

  let cur;
  if (blacks.length > whites.length)      cur = STONE.BLACK;
  else if (whites.length > blacks.length) cur = STONE.WHITE;
  else cur = lastColor === STONE.BLACK ? STONE.WHITE : STONE.BLACK;

  const seq = [];
  while (blacks.length || whites.length) {
    if (cur === STONE.BLACK) seq.push(blacks.length ? blacks.shift() : whites.shift());
    else                     seq.push(whites.length ? whites.shift() : blacks.shift());
    cur = cur === STONE.BLACK ? STONE.WHITE : STONE.BLACK;
  }
  return seq;
}

function captureFrame(video) {
  const c = document.createElement('canvas');
  c.width  = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

// Fast mean brightness of pixels within a circle, using the raw data array.
function sampleMean(grayMat, cx, cy, radius) {
  let sum = 0, count = 0;
  const r2   = radius * radius;
  const data = grayMat.data;
  const cols = grayMat.cols;
  const x0   = Math.max(0, cx - radius);
  const x1   = Math.min(cols - 1, cx + radius);
  const y0   = Math.max(0, cy - radius);
  const y1   = Math.min(grayMat.rows - 1, cy + radius);

  for (let y = y0; y <= y1; y++) {
    const dy2 = (y - cy) ** 2;
    const row = y * cols;
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + dy2 <= r2) {
        sum += data[row + x];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 128;
}

// ── Grid fitting ────────────────────────────────────────────────────────────────
// Locate the board's real grid lines in the warped image. For each column we take
// the MEDIAN darkness down the column: a vertical grid line stays dark for most
// rows even where a few stones cover it, so the median is robust to stones.

function columnDarkness(grayMat) {
  const cols = grayMat.cols, rows = grayMat.rows, data = grayMat.data;
  const prof = new Float64Array(cols);
  const tmp  = new Uint8Array(rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) tmp[y] = data[y * cols + x];
    prof[x] = 255 - medianU8(tmp);
  }
  return prof;
}

function rowDarkness(grayMat) {
  const cols = grayMat.cols, rows = grayMat.rows, data = grayMat.data;
  const prof = new Float64Array(rows);
  const tmp  = new Uint8Array(cols);
  for (let y = 0; y < rows; y++) {
    const off = y * cols;
    for (let x = 0; x < cols; x++) tmp[x] = data[off + x];
    prof[y] = 255 - medianU8(tmp);
  }
  return prof;
}

function medianU8(arr) {
  const a = Array.prototype.slice.call(arr).sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function medianOf(arr) {
  const a = [...arr].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ±1 box smoothing of a profile.
function smoothProfile(prof, size) {
  const sm = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let s = 0, c = 0;
    for (let d = -1; d <= 1; d++) { const j = i + d; if (j >= 0 && j < size) { s += prof[j]; c++; } }
    sm[i] = s / c;
  }
  return sm;
}

// Fit a RIGID uniform grid (single offset + spacing) to a darkness profile by
// searching a small range around the ideal. Because all 19 lines must align
// together, wood grain that darkens a stray column can't win — only the true
// grid maximizes the summed darkness across every line. Returns n positions.
function refineUniformGrid(prof, n) {
  const size = prof.length;
  const sm   = smoothProfile(prof, size);
  const o0 = WARP_MARGIN, s0 = WARP_STEP;
  const OFF = 18;    // offset search radius (px) — covers corner-tap error…
  const SP  = 5;     // …spacing search radius (px); stays well clear of the board edge

  let best = { o: o0, s: s0 }, bestScore = -Infinity;
  for (let o = o0 - OFF; o <= o0 + OFF; o++) {
    for (let s = s0 - SP; s <= s0 + SP; s += 0.25) {
      if (o < 0 || o + (n - 1) * s >= size) continue;
      let score = 0;
      for (let i = 0; i < n; i++) score += sm[Math.round(o + i * s)];
      if (score > bestScore) { bestScore = score; best = { o, s }; }
    }
  }
  const pos = [];
  for (let i = 0; i < n; i++) pos.push(Math.round(best.o + i * best.s));
  return pos;
}

function diffStates(a, b) {
  const d = [];
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if (a[r][c] !== b[r][c])
        d.push({ row: r, col: c, from: a[r][c], to: b[r][c] });
  return d;
}

function statesEqual(a, b) {
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if (a[r][c] !== b[r][c]) return false;
  return true;
}
