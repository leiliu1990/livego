let cvReady = false;
let cornerPicker    = null;
let detector        = null;
let recorder        = null;
let confirmedCorners     = null;
let confirmedDisplayMeta = null;

function onOpenCvReady() {
  if (cvReady) return;
  cvReady = true;
  console.log('OpenCV ready');
}

(function waitForCV() {
  if (typeof cv !== 'undefined' && cv.Mat) { onOpenCvReady(); }
  else setTimeout(waitForCV, 100);
})();

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });

    const video  = document.getElementById('video');
    const video2 = document.getElementById('video2');
    video.srcObject  = stream;
    video2.srcObject = stream;

    setupCornerUI();
  } catch (e) {
    alert('Camera access denied. Please allow camera and reload.');
    console.error(e);
  }
}

// ── Setup screen ──────────────────────────────────────────────────────────────

function setupCornerUI() {
  const video   = document.getElementById('video');
  const overlay = document.getElementById('overlay');

  cornerPicker = new CornerPicker(video, overlay, (corners, meta) => {
    confirmedCorners     = corners;
    confirmedDisplayMeta = meta;
    document.getElementById('btn-start').disabled = false;
  });
  cornerPicker.enable();

  document.getElementById('btn-undo-corner').addEventListener('click', () => {
    cornerPicker.undoLast();
    confirmedCorners = null;
    document.getElementById('btn-start').disabled = true;
  });

  document.getElementById('btn-reset-corners').addEventListener('click', () => {
    cornerPicker.reset();
    confirmedCorners = null;
    document.getElementById('btn-start').disabled = true;
  });

  document.getElementById('btn-start').addEventListener('click', showGameInfoForm);
}

function showGameInfoForm() {
  document.getElementById('game-info-form').classList.remove('hidden');
  document.getElementById('setup-ui').classList.add('hidden');

  document.getElementById('btn-cancel-form').addEventListener('click', () => {
    document.getElementById('game-info-form').classList.add('hidden');
    document.getElementById('setup-ui').classList.remove('hidden');
  }, { once: true });

  document.getElementById('btn-confirm-start').addEventListener('click', startRecording, { once: true });
}

// ── Recording screen ──────────────────────────────────────────────────────────

function startRecording() {
  if (!cvReady) {
    alert('OpenCV is still loading, please wait a moment.');
    return;
  }

  const gameInfo = {
    black: document.getElementById('input-black').value.trim(),
    white: document.getElementById('input-white').value.trim(),
    komi:  parseFloat(document.getElementById('input-komi').value) || 6.5,
  };

  recorder = new SGFRecorder(gameInfo);
  showScreen('screen-record');

  const boardCanvas = document.getElementById('board-canvas');
  boardCanvas.width  = boardCanvas.offsetWidth;
  boardCanvas.height = boardCanvas.offsetHeight;

  const video2 = document.getElementById('video2');
  detector = new BoardDetector(
    video2,
    confirmedCorners,
    confirmedDisplayMeta,
    onMoveDetected,
    (boardState) => drawBoardOverlay(boardCanvas, boardState),
  );
  detector.start();

  setStatus('green');

  document.getElementById('btn-undo-move').addEventListener('click', undoMove);
  document.getElementById('btn-recalibrate').addEventListener('click', recalibrate);
  document.getElementById('btn-export').addEventListener('click', () => recorder.download());
}

function onMoveDetected(moveObj) {
  recorder.addMove(moveObj);
  recorder.clearRedo();
  updateRecordUI();
  flashStatus();
}

function undoMove() {
  if (!recorder || recorder.moveCount === 0) return;
  const m = recorder.undoLast();
  if (m && detector) detector.undoLastMove(deepCloneBoard(detector.boardState));
  updateRecordUI();
}

function recalibrate() {
  detector.stop();
  showScreen('screen-setup');
  cornerPicker.reset();
  confirmedCorners     = null;
  confirmedDisplayMeta = null;
  document.getElementById('btn-start').disabled = true;

  document.getElementById('btn-confirm-start').addEventListener('click', () => {
    const boardCanvas = document.getElementById('board-canvas');
    boardCanvas.width  = boardCanvas.offsetWidth;
    boardCanvas.height = boardCanvas.offsetHeight;

    detector = new BoardDetector(
      document.getElementById('video2'),
      confirmedCorners,
      confirmedDisplayMeta,
      onMoveDetected,
      (boardState) => drawBoardOverlay(boardCanvas, boardState),
    );
    detector.start();
    showScreen('screen-record');
  }, { once: true });
}

// ── Board overlay ─────────────────────────────────────────────────────────────

const HOSHI = [3, 9, 15]; // star point indices on a 19x19 board

function drawBoardOverlay(canvas, boardState) {
  const ctx  = canvas.getContext('2d');
  const PAD  = 8;
  const TOP  = 56; // clear of Dynamic Island / notch
  const SIZE = Math.round(Math.min(canvas.width, canvas.height) * 0.44);

  const x0 = canvas.width - SIZE - PAD;
  const y0 = TOP;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Drop shadow + dark backing
  ctx.shadowColor   = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur    = 12;
  ctx.fillStyle     = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.roundRect(x0 - PAD / 2, y0 - PAD / 2, SIZE + PAD, SIZE + PAD, 10);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Board surface
  ctx.fillStyle = 'rgba(205, 170, 100, 0.95)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, SIZE, SIZE, 6);
  ctx.fill();

  const MARGIN = SIZE / (BOARD_SIZE + 1);
  const STEP   = (SIZE - 2 * MARGIN) / (BOARD_SIZE - 1);

  // Grid lines
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth   = 0.6;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const gx = x0 + MARGIN + i * STEP;
    const gy = y0 + MARGIN + i * STEP;
    ctx.beginPath(); ctx.moveTo(gx, y0 + MARGIN);        ctx.lineTo(gx, y0 + SIZE - MARGIN); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0 + MARGIN, gy);        ctx.lineTo(x0 + SIZE - MARGIN, gy); ctx.stroke();
  }

  // Star points
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (const r of HOSHI) {
    for (const c of HOSHI) {
      ctx.beginPath();
      ctx.arc(x0 + MARGIN + c * STEP, y0 + MARGIN + r * STEP, Math.max(1.5, STEP * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Stones
  const SR = STEP * 0.44;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const stone = boardState[r][c];
      if (stone === STONE.EMPTY) continue;
      const px = x0 + MARGIN + c * STEP;
      const py = y0 + MARGIN + r * STEP;

      const grad = ctx.createRadialGradient(px - SR * 0.3, py - SR * 0.3, SR * 0.1, px, py, SR);
      if (stone === STONE.BLACK) {
        grad.addColorStop(0, '#555');
        grad.addColorStop(1, '#111');
      } else {
        grad.addColorStop(0, '#fff');
        grad.addColorStop(1, '#ccc');
      }
      ctx.beginPath();
      ctx.arc(px, py, SR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = stone === STONE.BLACK ? '#333' : '#999';
      ctx.lineWidth   = 0.6;
      ctx.stroke();
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateRecordUI() {
  document.getElementById('move-count').textContent = `Move ${recorder.moveCount}`;
  document.getElementById('last-move').textContent  = recorder.lastMoveLabel();
}

function setStatus(state) {
  const el = document.getElementById('detection-status');
  el.className   = state === 'green' ? '' : state;
  el.textContent = '●';
}

function flashStatus() {
  const el = document.getElementById('detection-status');
  el.style.color = '#ffcc00';
  setTimeout(() => el.style.color = '', 700);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function deepCloneBoard(board) {
  return board.map(row => [...row]);
}

document.addEventListener('DOMContentLoaded', boot);
