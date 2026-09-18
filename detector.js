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

// Occlusion: a hand/arm over the board shows up as one large blob that differs
// from the empty board AND touches the warped image border (the arm reaches in
// from outside). Interior stone groups never touch the border, so even dense
// positions stay valid. Ambient-compensated so a uniform shadow isn't mistaken
// for an object. A frame with such a blob is INVALID — we don't diff it at all.
const OCC_PIXEL_DELTA = 40; // brightness diff above the ambient level counted as "foreign"

const STONE = { EMPTY: 0, BLACK: 1, WHITE: 2 };

const WARP_SIZE   = 760;                                              // px — perspective-corrected board output size
const WARP_MARGIN = WARP_SIZE / (BOARD_SIZE + 1);                    // px from edge to first grid line
const WARP_STEP   = (WARP_SIZE - 2 * WARP_MARGIN) / (BOARD_SIZE - 1); // px between adjacent grid lines
const STONE_RADIUS = Math.round(WARP_STEP * 0.45);                   // sampling radius ≈ 45% of one grid cell
const OCC_BLOB_MIN = Math.round(4 * Math.PI * STONE_RADIUS * STONE_RADIUS); // blob ≥ ~4 stones ⇒ not a stone (a hand)

// Stones are classified by how much each intersection's brightness CHANGES from
// the empty board captured at the start — not by absolute brightness. This is
// essential: bright wood grain overlaps white-stone brightness (both ~210-240),
// so a global threshold classifies wood as white. But wood doesn't *change* from
// its own empty baseline, while a white stone brightens its cell markedly.
const WHITE_DELTA = 18;   // ≥ this brightening vs empty ⇒ white stone
const BLACK_DELTA = -70;  // ≤ this darkening  vs empty ⇒ black stone

// A stone is "mature" after surviving this many valid frames. Mature stones are
// protected from false disappearance (Go rules: only leave by capture); younger
// ones may still vanish, letting a transient false positive (a hand/stone briefly
// resting on a point, committed before it moved on) self-heal.
const AGE_PROTECT = 4;

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
    this._lastColor      = null;  // color of the last committed move (for batch ordering + turn parity)
    this._committedWhite = false; // has any white been committed? (activates the alternation rule)
    this._age            = Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(0)); // valid-frames a stone has survived

    this._src    = null;
    this._warped = null;
    this._gray   = null;
    this._prevGray = null;  // previous frame's warped gray, for motion detection
    this._diff     = null;
    this._diffMask = null;
    this._motion   = Infinity;
    this._ambient  = 0;     // per-frame global lighting shift vs baseline

    this._occluded = false; // is a hand/arm covering part of the board this frame?
    this._occBlob  = 0;     // largest foreign blob area (px), for debug
    this._occMats  = null;  // lazily-allocated scratch mats for occlusion

    // Empty-board reference, established from the first good frame.
    this._baseline     = null;             // 19×19 brightness of the empty board
    this._baselineGray = null;             // full warped gray of the empty board (for occlusion)
    this._colPos       = null;             // fitted grid line x-positions (in warp px)
    this._rowPos       = null;             // fitted grid line y-positions

    // ── Debug capture ──
    this.debug = {
      enabled: true,
      t0:      Date.now(),
      frameNo: 0,
      frames:  [],   // per-frame records (ring buffer)
      images:  [],   // warped-board JPEGs at key moments (ring buffer)
      maxFrames: 500,
      maxImages: 30,
      last:    { ev: '-', motion: 0, occ: false, amb: 0 }, // for the live HUD
    };
    this._dbgPending = null;  // frame data staged in _detectState, finalized in _reconcile
    this._dbgDeltas  = null;  // 19×19 delta grid this frame
    this._dbgCanvas  = null;  // offscreen canvas for image snapshots
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
      this.debug.frameNo++;
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
      this._baselineGray = this._gray.clone(); // full empty-board image for occlusion
      return null;
    }

    // Is a hand/arm over the board? If so the frame is invalid — _reconcile skips
    // it, so we never diff an occluded view. Computed before classification.
    this._computeOcclusion();

    // Estimate the ambient lighting shift so a uniform change (e.g. a shadow
    // falling over the whole board) doesn't look like stones. Each cell's delta
    // vs baseline = ambient shift (shared by all cells) + any stone (a few cells).
    // The MEDIAN delta is the shift: most cells are empty, so stones are outliers
    // that the median ignores. Subtracting it re-references the baseline to the
    // current lighting. Classification then only fires on *local* changes.
    const deltas = [];
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++) {
        const { x, y } = this._intersectionPx(r, c);
        deltas.push(sampleMean(this._gray, x, y, STONE_RADIUS) - this._baseline[r][c]);
      }
    this._ambient = medianOf(deltas);

    const state = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = [];
      for (let c = 0; c < BOARD_SIZE; c++) row.push(this._classifyIntersection(r, c));
      state.push(row);
    }

    // Stage this frame's debug data (finalized with an event in _reconcile).
    if (this.debug.enabled) {
      const dg = new Array(BOARD_SIZE * BOARD_SIZE);
      for (let i = 0; i < deltas.length; i++) dg[i] = Math.round(deltas[i] - this._ambient);
      this._dbgDeltas = dg;
      this._dbgPending = {
        i: this.debug.frameNo,
        t: Date.now() - this.debug.t0,
        motion: +this._motion.toFixed(3),
        occ: this._occluded,
        occBlob: this._occBlob,
        amb: +this._ambient.toFixed(1),
        deltas: dg,
        state: flatten(state),
      };
    }

    return state;
  }

  // Detect a hand/arm over the board. Diff the warped frame against the empty
  // board, remove the uniform lighting level (ambient) so a shadow doesn't count,
  // keep only solid regions (morphological open erases thin grid lines/noise),
  // then take the largest connected blob. A hand is large AND touches the image
  // border (the arm enters from outside); interior stone groups never do.
  _computeOcclusion() {
    if (!this._baselineGray) { this._occluded = false; return; }
    if (!this._occMats) {
      this._occMats = {
        diff:   new cv.Mat(),
        mask:   new cv.Mat(),
        kernel: cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)),
        labels: new cv.Mat(),
        stats:  new cv.Mat(),
        cent:   new cv.Mat(),
      };
    }
    const M = this._occMats;
    cv.absdiff(this._gray, this._baselineGray, M.diff);

    // Ambient level = sparse median of the diff (uniform shift from lighting).
    const data = M.diff.data;
    const samp = [];
    for (let i = 0; i < data.length; i += 997) samp.push(data[i]);
    samp.sort((a, b) => a - b);
    const amb = samp[samp.length >> 1];

    cv.threshold(M.diff, M.mask, amb + OCC_PIXEL_DELTA, 255, cv.THRESH_BINARY);
    cv.morphologyEx(M.mask, M.mask, cv.MORPH_OPEN, M.kernel);

    const n = cv.connectedComponentsWithStats(M.mask, M.labels, M.stats, M.cent, 8);
    let li = 0, larea = 0;
    for (let i = 1; i < n; i++) {
      const a = M.stats.intAt(i, cv.CC_STAT_AREA);
      if (a > larea) { larea = a; li = i; }
    }
    let touches = false;
    if (li) {
      const x = M.stats.intAt(li, cv.CC_STAT_LEFT), y = M.stats.intAt(li, cv.CC_STAT_TOP);
      const w = M.stats.intAt(li, cv.CC_STAT_WIDTH), h = M.stats.intAt(li, cv.CC_STAT_HEIGHT);
      touches = (x <= 2 || y <= 2 || x + w >= WARP_SIZE - 2 || y + h >= WARP_SIZE - 2);
    }
    this._occBlob  = larea;
    this._occluded = (larea >= OCC_BLOB_MIN && touches);
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

  _reconcile(rawState) {
    let event = 'idle';
    // Only diff VALID frames — static (no motion) AND unoccluded (no hand/arm
    // over the board). An invalid frame's readings can't be trusted, so we skip
    // it entirely. When the board next becomes visible and settled, the diff
    // reflects real play, even if several stones were placed during occlusion.
    if (this._motion > MOTION_THRESH || this._occluded) {
      this.pendingState = null;
      this.pendingCount = 0;
      this._dbgFlush(this._occluded ? 'skip-occluded' : 'skip-motion');
      return;
    }

    // Undo false disappearances before anything else: a confirmed stone that
    // reads empty but whose group still has a liberty was not captured (shadow /
    // partial occlusion dimmed it). Restore it so a real placement in the SAME
    // frame is still processed, and so the stone never triggers a phantom
    // removal that a later reappearance can't undo.
    const newState = this._restoreFalseRemovals(rawState);

    const diff = diffStates(this.boardState, newState);

    if (diff.length === 0) {
      this.pendingState = null;
      this.pendingCount = 0;
      this._dbgFlush('stable');
      return;
    }

    if (this.pendingState && statesEqual(newState, this.pendingState)) {
      this.pendingCount++;
    } else {
      this.pendingState = newState;
      this.pendingCount = 1;
    }

    event = 'pending';
    // Board has settled to a new stable state → commit after a couple of quiet
    // frames (guards against a single noisy sample).
    if (this.pendingCount >= QUIET_FRAMES) {
      if (this._alternationOK(diff)) {
        this._commitState(newState, diff);
        event = 'commit';
      } else {
        // change violates alternation/turn parity (false white from lighting, or a
        // lone wrong-colour stone) → skip; record nothing, state/baseline untouched.
        event = 'reject-alternation';
      }
      this.pendingState = null;
      this.pendingCount = 0;
    }

    this._bumpAge();
    this._dbgFlush(event, diff);
  }

  // ── Debug capture ──────────────────────────────────────────────────────────

  // Finalize the staged frame with an event and push to the ring buffers.
  _dbgFlush(event, diff) {
    if (!this.debug.enabled) return;
    const nB = countColor(this.boardState, STONE.BLACK);
    const nW = countColor(this.boardState, STONE.WHITE);
    this.debug.last = { ev: event, motion: this._motion, occ: this._occluded, amb: this._ambient, nB, nW };

    const f = this._dbgPending;
    if (!f) return;
    f.ev = event;
    f.nB = nB; f.nW = nW;
    f.board = flatten(this.boardState);
    if (diff && diff.length) {
      f.diff = diff.map(d => [d.row, d.col, d.from, d.to]);
    }
    this.debug.frames.push(f);
    if (this.debug.frames.length > this.debug.maxFrames) this.debug.frames.shift();

    // Snapshot the warped board at decision points (commit / reject / occlusion).
    if (event === 'commit' || event === 'reject-alternation' ||
        (event === 'skip-occluded' && this.debug.images.length < 4)) {
      this._dbgSnapshotImage(f.i, event);
    }
    this._dbgPending = null;
  }

  _dbgSnapshotImage(frameIdx, event) {
    try {
      if (!this._dbgCanvas) this._dbgCanvas = document.createElement('canvas');
      cv.imshow(this._dbgCanvas, this._warped);   // full warped board
      // Downscale to keep the export small.
      const small = document.createElement('canvas');
      small.width = 240; small.height = 240;
      small.getContext('2d').drawImage(this._dbgCanvas, 0, 0, 240, 240);
      this.debug.images.push({ i: frameIdx, ev: event, data: small.toDataURL('image/jpeg', 0.5) });
      if (this.debug.images.length > this.debug.maxImages) this.debug.images.shift();
    } catch (e) { /* imshow can fail if mats are freed mid-teardown */ }
  }

  // Assemble the full debug bundle as a JSON string for export.
  getDebugJSON() {
    return JSON.stringify({
      meta: {
        version: 'v20',
        savedAt: new Date().toISOString(),
        vid: { w: this.displayMeta?.vidW, h: this.displayMeta?.vidH },
        disp: { w: this.displayMeta?.dispW, h: this.displayMeta?.dispH },
        corners: this.corners,
        warpSize: WARP_SIZE,
        grid: { col: this._colPos, row: this._rowPos },
        baseline: this._baseline ? this._baseline.map(r => r.map(v => Math.round(v))) : null,
        thresholds: { whiteDelta: WHITE_DELTA, blackDelta: BLACK_DELTA, motion: MOTION_THRESH, ageProtect: AGE_PROTECT },
        finalBoard: flatten(this.boardState),
        frameCount: this.debug.frameNo,
      },
      frames: this.debug.frames,
      images: this.debug.images,
    });
  }

  // Each valid frame: occupied points age up, empty points reset. Age gates which
  // stones are "mature" enough to be protected from false disappearance.
  _bumpAge() {
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++)
        this._age[r][c] = this.boardState[r][c] !== STONE.EMPTY ? this._age[r][c] + 1 : 0;
  }

  // Return a copy of the detected state with FALSE disappearances undone. A stone
  // only leaves the board by capture: its group must be fully surrounded (no
  // liberties) once the capturing move is on the board. A stone that reads empty
  // while its group still has an empty neighbour was NOT captured — it's a false
  // disappearance (shadow / partial occlusion dimmed a real stone below
  // threshold). We restore only those; genuine captures (liberty-less groups) are
  // left removed, so real play still updates the board.
  _restoreFalseRemovals(rawState) {
    const removed = [];
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++)
        if (this.boardState[r][c] !== STONE.EMPTY && rawState[r][c] === STONE.EMPTY)
          removed.push({ r, c });
    if (removed.length === 0) return rawState;

    // Position before any capture is resolved: prev board + newly-placed stones,
    // with the vanished stones still present (they're already in boardState).
    const test = this.boardState.map(row => [...row]);
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++)
        if (this.boardState[r][c] === STONE.EMPTY && rawState[r][c] !== STONE.EMPTY)
          test[r][c] = rawState[r][c];

    const corrected = rawState.map(row => [...row]);
    for (const { r, c } of removed) {
      // Only protect MATURE stones. A young stone that vanishes was likely a
      // transient false positive → let it go (self-heal). A mature stone with a
      // liberty was not captured → restore it.
      if (this._age[r][c] >= AGE_PROTECT && groupHasLiberty(test, r, c)) {
        corrected[r][c] = this.boardState[r][c];
      }
    }
    return corrected;
  }

  // Go alternates B/W. Two checks reject changes that can't be real play:
  //
  //  1. Colour balance: between two valid frames the net new stones must satisfy
  //     |black − white| ≤ 1. A field of same-colour false stones (white from a
  //     lighting shift) fails this.
  //  2. Turn parity: once white has appeared, a SINGLE new stone must be the
  //     colour whose turn it is — the opposite of the last committed move. This
  //     catches a lone false stone of the wrong colour (a hand/stone briefly
  //     resting on a point during the opponent's turn) at commit time, before it
  //     is ever recorded.
  //
  // Black plays first, so before any white appears any number of new black stones
  // is allowed (handicap setup). The rules activate the moment white appears —
  // the first white move itself must be balanced.
  _alternationOK(diff) {
    const placed = diff.filter(d => d.from === STONE.EMPTY && d.to !== STONE.EMPTY);
    const nb = placed.filter(d => d.to === STONE.BLACK).length;
    const nw = placed.filter(d => d.to === STONE.WHITE).length;

    if (!this._committedWhite && nw === 0) return true; // pre-activation: black opening/handicap
    if (Math.abs(nb - nw) > 1) return false;            // colour balance

    if (this._committedWhite && (nb + nw) === 1) {       // turn parity for a single stone
      const stoneColor = nb === 1 ? STONE.BLACK : STONE.WHITE;
      const expected   = this._lastColor === STONE.BLACK ? STONE.WHITE : STONE.BLACK;
      if (stoneColor !== expected) return false;
    }
    return true;
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
      if (p.to === STONE.WHITE) this._committedWhite = true; // activates the alternation rule
    });
  }

  _freeMats() {
    if (this._src)      { this._src.delete();      this._src      = null; }
    if (this._warped)   { this._warped.delete();   this._warped   = null; }
    if (this._gray)     { this._gray.delete();     this._gray     = null; }
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null; }
    if (this._diff)     { this._diff.delete();     this._diff     = null; }
    if (this._diffMask) { this._diffMask.delete(); this._diffMask = null; }
    if (this._baselineGray) { this._baselineGray.delete(); this._baselineGray = null; }
    if (this._occMats) {
      for (const m of Object.values(this._occMats)) m.delete();
      this._occMats = null;
    }
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

// Flatten a 19×19 board to a single 361-length array (for compact debug JSON).
function flatten(board) {
  const out = new Array(BOARD_SIZE * BOARD_SIZE);
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      out[r * BOARD_SIZE + c] = board[r][c];
  return out;
}

// Does the stone group containing (r,c) have at least one liberty (empty
// adjacent point)? Flood-fills the connected same-colour group; returns true as
// soon as any group stone touches an empty point. Used to tell a real capture
// (no liberties) from a false disappearance (still has a liberty).
function groupHasLiberty(board, r, c) {
  const color = board[r][c];
  if (color === STONE.EMPTY) return true;
  const seen = new Set();
  const stack = [[r, c]];
  const key = (y, x) => y * BOARD_SIZE + x;
  seen.add(key(r, c));
  const nbrs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  while (stack.length) {
    const [y, x] = stack.pop();
    for (const [dy, dx] of nbrs) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || nx < 0 || ny >= BOARD_SIZE || nx >= BOARD_SIZE) continue;
      const v = board[ny][nx];
      if (v === STONE.EMPTY) return true;           // a liberty
      if (v === color && !seen.has(key(ny, nx))) {  // same-colour neighbour → extend group
        seen.add(key(ny, nx));
        stack.push([ny, nx]);
      }
    }
  }
  return false;
}
