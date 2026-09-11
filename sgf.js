// SGF (Smart Game Format) generator for 19x19 Go games.
// Spec: https://www.red-bean.com/sgf/sgf4.html

const SGF_LETTERS = 'abcdefghijklmnopqrs';

class SGFRecorder {
  constructor(gameInfo) {
    // gameInfo: { black, white, komi }
    this.gameInfo = gameInfo;
    this.moves = []; // [{color, row, col, captures}]
    this.undoStack = []; // for undo support
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

    for (const m of this.moves) {
      const colorTag = m.color === STONE.BLACK ? 'B' : 'W';
      const coord = colRow(m.col, m.row);
      sgf += `;${colorTag}[${coord}]`;
    }

    sgf += ')';
    return sgf;
  }

  download() {
    const sgf = this.buildSGF();
    const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    a.href = url;
    a.download = `livego-${stamp}.sgf`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function colRow(col, row) {
  return SGF_LETTERS[col] + SGF_LETTERS[row];
}

function esc(s) {
  return String(s).replace(/[\[\]\\]/g, c => '\\' + c);
}
