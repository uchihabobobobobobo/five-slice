/**
 * FIVE / SLICE — shared three-dimensional Gomoku rules.
 *
 * The board is a 9 × 9 × 9 lattice. Only one axis-aligned 9 × 9 plane is
 * active at a time. Every stone keeps its 3D coordinate for the whole game,
 * even when it is not visible on the active plane.
 *
 * A turn is exactly one of:
 *   - place a stone on an empty point of the active plane; or
 *   - use one of your own, not-yet-used stones on the active plane as a
 *     pivot, cut along its row or column, and flip the active plane 90°
 *     around that cut line into a perpendicular plane.
 *
 * Five consecutive stones in any of the 13 3D directions wins.
 */

export const SIZE = 9;
export const CELL_COUNT = SIZE * SIZE * SIZE;
export const WIN_LENGTH = 5;

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const AXES = ['x', 'y', 'z'];
export const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** Canonical half of the 26 3D directions (first non-zero component is +). */
export const DIRECTIONS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, -1, 0],
  [1, 0, 1],
  [1, 0, -1],
  [0, 1, 1],
  [0, 1, -1],
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
];

/**
 * For each possible normal axis, the active plane is displayed with
 * `u` as its columns and `v` as its rows. This ordering is what makes a
 * horizontal cut always target the `v` plane and a vertical cut the `u` plane.
 */
const PLANE_LAYOUT = [
  { u: 1, v: 2, kind: '侧切面', description: 'Y-Z 平面' },
  { u: 0, v: 2, kind: '纵切面', description: 'X-Z 平面' },
  { u: 0, v: 1, kind: '水平面', description: 'X-Y 平面' },
];

const COORD_CACHE = Array.from({ length: CELL_COUNT }, (_, index) => ({
  x: index % SIZE,
  y: Math.floor(index / SIZE) % SIZE,
  z: Math.floor(index / (SIZE * SIZE)),
}));

export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}

export function otherColor(color) {
  return color === BLACK ? WHITE : BLACK;
}

export function colorName(color) {
  return color === BLACK ? '黑' : color === WHITE ? '白' : '空';
}

export function colorKey(color) {
  return color === BLACK ? 'black' : color === WHITE ? 'white' : 'empty';
}

export function indexOf(x, y, z) {
  return x + SIZE * y + SIZE * SIZE * z;
}

export function coordOf(index) {
  return COORD_CACHE[index];
}

export function isInside(x, y, z) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE && z >= 0 && z < SIZE;
}

export function planeId(axis, value) {
  const axisIndex = typeof axis === 'string' ? AXIS_INDEX[axis] : axis;
  if (!Number.isInteger(axisIndex) || axisIndex < 0 || axisIndex > 2) {
    throw new RuleError('BAD_AXIS', '切面轴必须是 x / y / z。');
  }
  if (!Number.isInteger(value) || value < 0 || value >= SIZE) {
    throw new RuleError('BAD_PLANE', '切面坐标必须位于 0..8。');
  }
  return axisIndex * SIZE + value;
}

export function parsePlaneId(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 27) {
    throw new RuleError('BAD_PLANE', '切面编号必须位于 0..26。');
  }
  return value;
}

export function planeInfo(plane) {
  const id = parsePlaneId(plane);
  const axis = Math.floor(id / SIZE);
  const value = id % SIZE;
  const layout = PLANE_LAYOUT[axis];
  const axisName = AXES[axis];
  const uName = AXES[layout.u];
  const vName = AXES[layout.v];
  return {
    id,
    axis,
    axisName,
    value,
    u: layout.u,
    v: layout.v,
    uName,
    vName,
    kind: layout.kind,
    description: layout.description,
    label: `${axisName.toUpperCase()} = ${value}`,
    shortLabel: `${axisName.toUpperCase()}${value}`,
    orientation: `${uName.toUpperCase()} × ${vName.toUpperCase()}`,
  };
}

/** The index at a particular row/column of an active plane. */
export function planeCell(plane, row, col) {
  const info = planeInfo(plane);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
    throw new RuleError('BAD_CELL', '棋盘坐标必须位于 0..8。');
  }
  const p = [0, 0, 0];
  p[info.axis] = info.value;
  p[info.u] = col;
  p[info.v] = row;
  return indexOf(p[0], p[1], p[2]);
}

/** Display position of a 3D cell on an active plane, or null if off-plane. */
export function cellDisplay(plane, index) {
  const info = planeInfo(plane);
  const c = coordOf(index);
  if (c[info.axisName] !== info.value) return null;
  return { row: c[info.vName], col: c[info.uName] };
}

/** All 81 cell indexes of a plane, in row-major display order. */
export function planeCells(plane) {
  const cells = new Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      cells[row * SIZE + col] = planeCell(plane, row, col);
    }
  }
  return cells;
}

/**
 * Resolve the target plane for a cut. `row`/`col` are the pivot's display
 * coordinates on the current plane. A horizontal cut follows the row and
 * enters the plane normal to the row axis; a vertical cut follows the column.
 */
export function sliceTarget(plane, row, col, direction) {
  if (direction !== 'h' && direction !== 'v') {
    throw new RuleError('BAD_DIRECTION', '切面方向必须是横向 h 或纵向 v。');
  }
  const info = planeInfo(plane);
  const targetAxis = direction === 'h' ? info.v : info.u;
  const targetValue = direction === 'h' ? row : col;
  return {
    toPlane: planeId(targetAxis, targetValue),
    targetAxis,
    targetValue,
    targetAxisName: AXES[targetAxis],
    targetLabel: `${AXES[targetAxis].toUpperCase()} = ${targetValue}`,
    direction,
  };
}

/** Cells shared by two planes (always a line of 9, or empty if parallel). */
export function creaseCells(fromPlane, toPlane) {
  const a = planeInfo(fromPlane);
  const b = planeInfo(toPlane);
  if (a.axis === b.axis) return a.value === b.value ? planeCells(fromPlane) : [];
  const cells = [];
  for (const index of planeCells(fromPlane)) {
    const c = coordOf(index);
    if (c[b.axisName] === b.value) cells.push(index);
  }
  return cells;
}

function readCell(cells, x, y, z) {
  return cells[indexOf(x, y, z)];
}

/**
 * Contiguous same-colour line through `index`, in each 3D direction.
 * Returns the longest line of 5+ stones (or null).
 */
export function findWinLine(cells, index, color = cells[index]) {
  if (!color) return null;
  const origin = coordOf(index);
  let best = null;
  for (const direction of DIRECTIONS) {
    const backward = [];
    const forward = [];
    for (const sign of [-1, 1]) {
      const bucket = sign === -1 ? backward : forward;
      for (let step = 1; step < SIZE; step += 1) {
        const x = origin.x + direction[0] * step * sign;
        const y = origin.y + direction[1] * step * sign;
        const z = origin.z + direction[2] * step * sign;
        if (!isInside(x, y, z) || readCell(cells, x, y, z) !== color) break;
        bucket.push(indexOf(x, y, z));
      }
    }
    const line = [...backward.reverse(), index, ...forward];
    if (line.length >= WIN_LENGTH && (!best || line.length > best.line.length)) {
      best = { line, direction, color };
    }
  }
  return best;
}

/** Scan the whole lattice for any winning line. Used by validation/tests. */
export function scanWinner(cells) {
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (!cells[index]) continue;
    const win = findWinLine(cells, index);
    if (win) return win;
  }
  return null;
}

function assertIntInRange(value, name) {
  if (!Number.isInteger(value) || value < 0 || value >= SIZE) {
    throw new RuleError('BAD_CELL', `${name} 必须位于 0..8。`);
  }
}

function cellsToString(cells) {
  let out = '';
  for (let i = 0; i < CELL_COUNT; i += 1) out += cells[i];
  return out;
}

function stringToCells(text, length) {
  if (typeof text !== 'string' || text.length !== length) {
    throw new RuleError('BAD_SNAPSHOT', '棋盘快照格式不正确。');
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    const value = text.charCodeAt(i) - 48;
    if (value < 0 || value > 2) throw new RuleError('BAD_SNAPSHOT', '棋盘快照包含非法棋子。');
    out[i] = value;
  }
  return out;
}

function usedToString(used) {
  let out = '';
  for (let i = 0; i < CELL_COUNT; i += 1) out += used[i] ? '1' : '0';
  return out;
}

function stringToUsed(text) {
  if (typeof text !== 'string' || text.length !== CELL_COUNT) {
    throw new RuleError('BAD_SNAPSHOT', '切点快照格式不正确。');
  }
  const out = new Uint8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i += 1) out[i] = text.charCodeAt(i) === 49 ? 1 : 0;
  return out;
}

export class Game {
  constructor(options = {}) {
    this.cells = new Uint8Array(CELL_COUNT);
    this.used = new Uint8Array(CELL_COUNT);
    this.initialPlane = parsePlaneId(options.plane ?? planeId('z', 4));
    this.plane = this.initialPlane;
    this.turn = BLACK;
    this.moveNumber = 0;
    this.moves = [];
    this.lastMove = null;
    this.phase = 'playing';
    this.winner = EMPTY;
    this.winLine = null;
    this.winDirection = null;
    this.winningMove = null;
    this.version = 0;
  }

  get planeInfo() {
    return planeInfo(this.plane);
  }

  get planeLabel() {
    return this.planeInfo.label;
  }

  get over() {
    return this.phase !== 'playing';
  }

  coordAt(row, col) {
    return coordOf(planeCell(this.plane, row, col));
  }

  indexAt(row, col) {
    return planeCell(this.plane, row, col);
  }

  stoneAt(row, col) {
    return this.cells[this.indexAt(row, col)];
  }

  usedAt(row, col) {
    return this.used[this.indexAt(row, col)];
  }

  displayOf(index) {
    return cellDisplay(this.plane, index);
  }

  clone() {
    const game = new Game({ plane: this.plane });
    game.cells.set(this.cells);
    game.used.set(this.used);
    game.initialPlane = this.initialPlane;
    game.turn = this.turn;
    game.moveNumber = this.moveNumber;
    game.moves = this.moves.slice();
    game.lastMove = this.lastMove;
    game.phase = this.phase;
    game.winner = this.winner;
    game.winLine = this.winLine ? this.winLine.slice() : null;
    game.winDirection = this.winDirection ? this.winDirection.slice() : null;
    game.winningMove = this.winningMove;
    game.version = this.version;
    return game;
  }

  /** A lighter clone for AI search: history is intentionally discarded. */
  cloneForSearch() {
    const game = new Game({ plane: this.plane });
    game.cells.set(this.cells);
    game.used.set(this.used);
    game.initialPlane = this.initialPlane;
    game.turn = this.turn;
    game.moveNumber = this.moveNumber;
    game.moves = [];
    game.lastMove = null;
    game.phase = this.phase;
    game.winner = this.winner;
    game.winLine = this.winLine;
    game.winDirection = this.winDirection;
    game.winningMove = null;
    game.version = this.version;
    return game;
  }

  assertPlaying() {
    if (this.phase !== 'playing') {
      throw new RuleError('GAME_OVER', '本局已经结束。');
    }
  }

  place(row, col) {
    this.assertPlaying();
    assertIntInRange(row, '行');
    assertIntInRange(col, '列');
    const index = planeCell(this.plane, row, col);
    if (this.cells[index] !== EMPTY) {
      throw new RuleError('OCCUPIED', '这个交点已经有棋子了。');
    }

    const color = this.turn;
    this.cells[index] = color;
    this.moveNumber += 1;
    this.version += 1;
    const coord = coordOf(index);
    const move = {
      n: this.moveNumber,
      type: 'place',
      color,
      index,
      row,
      col,
      plane: this.plane,
      planeLabel: this.planeInfo.label,
      x: coord.x,
      y: coord.y,
      z: coord.z,
    };
    this.moves.push(move);
    this.lastMove = move;

    const win = findWinLine(this.cells, index, color);
    if (win) {
      this.phase = 'won';
      this.winner = color;
      this.winLine = win.line;
      this.winDirection = win.direction;
      this.winningMove = move;
      return move;
    }

    this.turn = otherColor(color);
    if (this.getLegalActions().length === 0) {
      this.phase = 'draw';
    }
    return move;
  }

  slice(row, col, direction) {
    this.assertPlaying();
    assertIntInRange(row, '行');
    assertIntInRange(col, '列');
    const index = planeCell(this.plane, row, col);
    const color = this.turn;
    if (this.cells[index] !== color) {
      throw new RuleError('NOT_YOUR_STONE', '只能选择自己的棋子作为切点。');
    }
    if (this.used[index]) {
      throw new RuleError('STONE_SPENT', '这枚棋子已经用过了，不能再次作为切点。');
    }
    const target = sliceTarget(this.plane, row, col, direction);
    const fromPlane = this.plane;
    const coord = coordOf(index);

    this.used[index] = 1;
    this.plane = target.toPlane;
    this.moveNumber += 1;
    this.version += 1;
    const move = {
      n: this.moveNumber,
      type: 'slice',
      color,
      index,
      pivot: index,
      row,
      col,
      fromPlane,
      fromLabel: planeInfo(fromPlane).label,
      toPlane: target.toPlane,
      toLabel: target.targetLabel,
      direction,
      directionLabel: direction === 'h' ? '横向' : '纵向',
      x: coord.x,
      y: coord.y,
      z: coord.z,
    };
    this.moves.push(move);
    this.lastMove = move;
    this.turn = otherColor(color);

    if (this.getLegalActions().length === 0) {
      this.phase = 'draw';
    }
    return move;
  }

  applyAction(action) {
    if (!action || typeof action !== 'object') {
      throw new RuleError('BAD_ACTION', '行动格式不正确。');
    }
    if (action.type === 'place') {
      return this.place(action.row, action.col);
    }
    if (action.type === 'slice') {
      return this.slice(action.row, action.col, action.direction);
    }
    throw new RuleError('BAD_ACTION', '未知的行动类型。');
  }

  getLegalActions() {
    if (this.phase !== 'playing') return [];
    const actions = [];
    const cells = planeCells(this.plane);
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const index = cells[row * SIZE + col];
        if (this.cells[index] === EMPTY) {
          actions.push({ type: 'place', row, col, plane: this.plane, index });
        }
      }
    }
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const index = cells[row * SIZE + col];
        if (this.cells[index] !== this.turn || this.used[index]) continue;
        for (const direction of ['h', 'v']) {
          const target = sliceTarget(this.plane, row, col, direction);
          actions.push({
            type: 'slice',
            row,
            col,
            direction,
            plane: this.plane,
            pivot: index,
            toPlane: target.toPlane,
          });
        }
      }
    }
    return actions;
  }

  /** Own stones on the active plane that can still be used as a cut pivot. */
  getCutPoints() {
    const points = [];
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const index = planeCell(this.plane, row, col);
        if (this.cells[index] === this.turn && !this.used[index]) {
          points.push({ row, col, index });
        }
      }
    }
    return points;
  }

  /** All unused stones of a colour, including those on other planes. */
  countUnused(color) {
    let count = 0;
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (this.cells[index] === color && !this.used[index]) count += 1;
    }
    return count;
  }

  countStones(color) {
    let count = 0;
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (this.cells[index] === color) count += 1;
    }
    return count;
  }

  /** Stones on a specific plane, as display cells, for the 9-layer minimap. */
  stonesOnPlane(plane) {
    const stones = [];
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const index = planeCell(plane, row, col);
        if (this.cells[index] !== EMPTY) {
          stones.push({
            row,
            col,
            color: this.cells[index],
            used: this.used[index] === 1,
            index,
          });
        }
      }
    }
    return stones;
  }

  snapshot() {
    return {
      plane: this.plane,
      initialPlane: this.initialPlane,
      turn: this.turn,
      moveNumber: this.moveNumber,
      phase: this.phase,
      winner: this.winner,
      winLine: this.winLine ? this.winLine.slice() : null,
      winDirection: this.winDirection ? this.winDirection.slice() : null,
      board: cellsToString(this.cells),
      used: usedToString(this.used),
      moves: this.moves,
      lastMove: this.lastMove,
    };
  }

  static fromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new RuleError('BAD_SNAPSHOT', '缺少对局快照。');
    }
    const game = new Game({ plane: parsePlaneId(snapshot.plane) });
    game.cells = stringToCells(snapshot.board, CELL_COUNT);
    game.used = stringToUsed(snapshot.used);
    game.initialPlane = parsePlaneId(snapshot.initialPlane ?? snapshot.plane);
    game.turn = snapshot.turn === WHITE ? WHITE : BLACK;
    game.moveNumber = Number.isInteger(snapshot.moveNumber) ? snapshot.moveNumber : 0;
    game.phase = ['playing', 'won', 'draw'].includes(snapshot.phase) ? snapshot.phase : 'playing';
    game.winner = snapshot.winner === BLACK || snapshot.winner === WHITE ? snapshot.winner : EMPTY;
    game.winLine = Array.isArray(snapshot.winLine) ? snapshot.winLine.slice() : null;
    game.winDirection = Array.isArray(snapshot.winDirection) ? snapshot.winDirection.slice() : null;
    game.moves = Array.isArray(snapshot.moves) ? snapshot.moves.slice() : [];
    game.lastMove = snapshot.lastMove ?? null;
    game.winningMove = null;
    game.version = game.moveNumber;
    return game;
  }

  /** Compact description used in logs and player-facing copy. */
  describeMove(move) {
    if (!move) return '';
    if (move.type === 'place') {
      return `落子 ${move.x},${move.y},${move.z}`;
    }
    return `${move.directionLabel}切面 ${move.fromLabel} → ${move.toLabel}`;
  }
}

export function createGame(options) {
  return new Game(options);
}
