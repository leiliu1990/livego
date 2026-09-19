// SGF (Smart Game Format) generator for 19x19 Go games.
// Spec: https://www.red-bean.com/sgf/sgf4.html

const SGF_LETTERS = 'abcdefghijklmnopqrs';

class SGFRecorder {
  constructor(gameInfo) {
    // gameInfo: { black, white, komi }
    this.gameInfo = gameInfo;
    this.moves = []; // [{color, row, col, captures}]
    this.undoStack = []; // for undo support
    this.setup = null; // after a manual fix: [{c,y,x}] added stones (SGF AB/AW)
  }

  // Manual-fix (approach A): make `board` the new starting position. Prior moves
  // are dropped; subsequent detected moves append after this setup position.
  setSetupPosition(board) {
    this.moves = [];
    this.undoStack = [];
    this.setup = [];
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) {
      const v = board[r][c];
      if (v) this.setup.push({ c: v, y: r, x: c });
    }
  }

  addMove({ color, row, col, captures }) {
    this.moves.push({ color, row, col, captures });
  }

  undoLast() {
    if (this.moves.length === 0) return null;
    const m = this.moves.pop();
    this.undoStack.push(m);
    return m;
  }

  redoLast() {
    if (this.undoStack.length === 0) return null;
    const m = this.undoStack.pop();
    this.moves.push(m);
    return m;
  }

  // Clear redo stack whenever a new move comes in (new branch)
  clearRedo() {
    this.undoStack = [];
  }

  get moveCount() { return this.moves.length; }

  lastMoveLabel() {
    if (this.moves.length === 0) return '';
    const m = this.moves[this.moves.length - 1];
    const col = String.fromCharCode(65 + m.col); // A-S
    const row = BOARD_SIZE - m.row;
    const colorLabel = m.color === STONE.BLACK ? 'B' : 'W';
    return `${colorLabel}${col}${row}`;
  }

  buildSGF() {
    const { black, white, komi } = this.gameInfo;
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    let sgf = `(;FF[4]GM[1]SZ[19]\n`;
    sgf += `PB[${esc(black || 'Black')}]\n`;
    sgf += `PW[${esc(white || 'White')}]\n`;
    sgf += `KM[${komi}]\n`;
    sgf += `DT[${date}]\n`;
    sgf += `AP[LiveGo:1.0]\n`;

    // Manual-fix setup stones become AB/AW on the root node.
    if (this.setup && this.setup.length) {
      const ab = this.setup.filter(s => s.c === STONE.BLACK).map(s => `[${colRow(s.x, s.y)}]`).join('');
      const aw = this.setup.filter(s => s.c === STONE.WHITE).map(s => `[${colRow(s.x, s.y)}]`).join('');
      if (ab) sgf += `AB${ab}\n`;
      if (aw) sgf += `AW${aw}\n`;
    }

    for (const m of this.moves) {
      const colorTag = m.color === STONE.BLACK ? 'B' : 'W';
      const coord = colRow(m.col, m.row);
      sgf += `;${colorTag}[${coord}]`;
    }

    sgf += ')';
    return sgf;
  }

  async download() {
    const sgf = this.buildSGF();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `livego-${stamp}.sgf`;
    const blob = new Blob([sgf], { type: 'text/plain' });

    // iOS Safari ignores <a download>, so prefer the Web Share API, which opens
    // the system share sheet ("Save to Files", AirDrop, Messages…). Must run
    // synchronously inside the click gesture — share() is the first await here.
    if (navigator.canShare) {
      const file = new File([blob], filename, { type: 'text/plain' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return; // user cancelled — not an error
          // otherwise fall through to the anchor method
        }
      }
    }

    // Desktop / fallback: real download via a temporary anchor.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000); // revoke after the download starts
  }
}

function colRow(col, row) {
  return SGF_LETTERS[col] + SGF_LETTERS[row];
}

function esc(s) {
  return String(s).replace(/[\[\]\\]/g, c => '\\' + c);
}
