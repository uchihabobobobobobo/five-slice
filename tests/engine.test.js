import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  CELL_COUNT,
  Game,
  WHITE,
  cellDisplay,
  coordOf,
  creaseCells,
  findWinLine,
  indexOf,
  planeCell,
  planeCells,
  planeId,
  planeInfo,
  scanWinner,
  sliceTarget,
} from '../public/js/engine.js';

test('coordinate and plane mappings stay consistent', () => {
  assert.equal(planeId('z', 4), 22);
  assert.equal(planeId('x', 3), 3);
  assert.equal(planeId('y', 8), 17);
  assert.deepEqual(coordOf(indexOf(3, 5, 7)), { x: 3, y: 5, z: 7 });

  const z4 = planeInfo(22);
  assert.equal(z4.axisName, 'z');
  assert.equal(z4.value, 4);
  assert.equal(z4.uName, 'x');
  assert.equal(z4.vName, 'y');
  assert.equal(z4.kind, '水平面');

  assert.equal(planeCell(22, 0, 0), indexOf(0, 0, 4));
  assert.equal(planeCell(22, 5, 3), indexOf(3, 5, 4));
  assert.deepEqual(cellDisplay(22, indexOf(3, 5, 4)), { row: 5, col: 3 });
  assert.equal(cellDisplay(22, indexOf(3, 5, 3)), null);
  assert.equal(planeCells(22).length, 81);
  assert.equal(new Set(planeCells(22)).size, 81);
});

test('horizontal and vertical cuts enter the correct perpendicular plane', () => {
  const z4 = planeId('z', 4);
  const horizontal = sliceTarget(z4, 5, 3, 'h');
  assert.equal(horizontal.toPlane, planeId('y', 5));
  assert.equal(horizontal.targetLabel, 'Y = 5');
  const vertical = sliceTarget(z4, 5, 3, 'v');
  assert.equal(vertical.toPlane, planeId('x', 3));
  assert.equal(vertical.targetLabel, 'X = 3');

  const x2 = planeId('x', 2);
  assert.equal(sliceTarget(x2, 4, 6, 'h').toPlane, planeId('z', 4));
  assert.equal(sliceTarget(x2, 4, 6, 'v').toPlane, planeId('y', 6));

  const crease = creaseCells(z4, horizontal.toPlane);
  assert.equal(crease.length, 9);
  assert.ok(crease.every((index) => coordOf(index).y === 5 && coordOf(index).z === 4));
});

test('placing stones switches turns and records 3D coordinates', () => {
  const game = new Game();
  assert.equal(game.plane, planeId('z', 4));
  const move = game.place(2, 3);
  assert.equal(move.x, 3);
  assert.equal(move.y, 2);
  assert.equal(move.z, 4);
  assert.equal(game.cells[indexOf(3, 2, 4)], BLACK);
  assert.equal(game.turn, WHITE);
  assert.equal(game.moveNumber, 1);
  assert.equal(game.lastMove, move);
  assert.throws(() => game.place(2, 3), /已经有棋子/);
});

test('five in a row on the active plane wins', () => {
  const game = new Game();
  const moves = [
    [0, 0], [0, 8],
    [0, 1], [1, 8],
    [0, 2], [2, 8],
    [0, 3], [3, 8],
  ];
  for (const [row, col] of moves) game.place(row, col);
  const winning = game.place(0, 4);
  assert.equal(game.phase, 'won');
  assert.equal(game.winner, BLACK);
  assert.equal(game.winningMove, winning);
  assert.equal(game.winLine.length, 5);
  assert.ok(game.winLine.every((index) => coordOf(index).y === 0 && coordOf(index).z === 4));
  assert.equal(game.getLegalActions().length, 0);
  assert.throws(() => game.place(5, 5), /已经结束/);
});

test('a line spanning planes counts as a 3D win', () => {
  const game = new Game();
  // Four off-plane stones already sit on a vertical line; the active plane
  // contains the fifth cell.
  for (let z = 0; z < 4; z += 1) game.cells[indexOf(0, 0, z)] = BLACK;
  game.place(0, 0); // (0,0,4), active Z=4
  assert.equal(game.phase, 'won');
  assert.equal(game.winner, BLACK);
  assert.deepEqual(
    game.winLine.map((index) => coordOf(index)).sort((a, b) => a.z - b.z),
    [0, 1, 2, 3, 4].map((z) => ({ x: 0, y: 0, z })),
  );
});

test('a stone spent as a cut point still counts toward five', () => {
  const game = new Game();
  game.cells[indexOf(0, 0, 4)] = BLACK;
  game.used[indexOf(0, 0, 4)] = 1;
  for (let x = 1; x <= 3; x += 1) game.cells[indexOf(x, 0, 4)] = BLACK;
  game.turn = BLACK;
  game.place(0, 4); // (4,0,4)
  assert.equal(game.phase, 'won');
  assert.equal(game.winner, BLACK);
  assert.equal(game.winLine.length, 5);
  assert.ok(game.winLine.includes(indexOf(0, 0, 4)));
});

test('a full 3D diagonal counts as a win', () => {
  const game = new Game();
  for (let i = 0; i < 4; i += 1) game.cells[indexOf(i, i, i)] = BLACK;
  game.place(4, 4); // (4,4,4)
  assert.equal(game.phase, 'won');
  assert.equal(game.winner, BLACK);
  assert.equal(game.winLine.length, 5);
});

test('wins do not wrap around board edges', () => {
  const cells = new Uint8Array(CELL_COUNT);
  for (const [x, y, z] of [[7, 0, 4], [8, 0, 4], [0, 1, 4], [1, 1, 4]]) {
    cells[indexOf(x, y, z)] = BLACK;
  }
  assert.equal(scanWinner(cells), null);
  cells[indexOf(2, 2, 4)] = BLACK;
  assert.equal(scanWinner(cells), null);
  assert.equal(findWinLine(cells, indexOf(8, 0, 4)), null);
});

test('a slice moves the board, spends the pivot and passes the turn', () => {
  const game = new Game();
  game.place(1, 2); // black at (2,1,4)
  game.place(7, 7); // white somewhere else
  const pivotIndex = indexOf(2, 1, 4);
  assert.equal(game.turn, BLACK);

  const move = game.slice(1, 2, 'h'); // row 1 -> Y = 1
  assert.equal(move.type, 'slice');
  assert.equal(move.fromPlane, planeId('z', 4));
  assert.equal(move.toPlane, planeId('y', 1));
  assert.equal(game.plane, planeId('y', 1));
  assert.equal(game.planeInfo.label, 'Y = 1');
  assert.equal(game.used[pivotIndex], 1);
  assert.equal(game.cells[pivotIndex], BLACK);
  assert.equal(game.turn, WHITE);
  assert.equal(game.moveNumber, 3);
  assert.equal(game.moves.at(-1), move);

  // White can now place on the new plane.
  game.place(4, 4);
  assert.equal(game.turn, BLACK);

  // The pivot now displays at Z=4 / X=2 on the Y=1 plane, and cannot be reused.
  assert.throws(() => game.slice(4, 2, 'h'), /已经用过/);
});

test('vertical slice enters the column axis and exposes the cut line', () => {
  const game = new Game();
  game.place(6, 2); // black at (2,6,4)
  game.place(0, 0); // white
  const move = game.slice(6, 2, 'v'); // column 2 -> X = 2
  assert.equal(move.toPlane, planeId('x', 2));
  assert.equal(game.planeInfo.label, 'X = 2');
  const crease = creaseCells(planeId('z', 4), game.plane);
  assert.equal(crease.length, 9);
  assert.ok(crease.every((index) => coordOf(index).x === 2 && coordOf(index).z === 4));
});

test('only own, unused, on-plane stones can be cut points', () => {
  const game = new Game();
  game.place(0, 0); // black
  game.place(1, 0); // white
  assert.throws(() => game.slice(1, 0, 'h'), /自己的棋子/);
  assert.deepEqual(
    game.getCutPoints().map((point) => [point.row, point.col]),
    [[0, 0]],
  );
});

test('snapshots round-trip the complete position', () => {
  const game = new Game();
  game.place(4, 4);
  game.place(3, 3);
  game.slice(4, 4, 'v');
  game.place(2, 2);
  const snapshot = game.snapshot();
  const restored = Game.fromSnapshot(snapshot);
  assert.equal(restored.plane, game.plane);
  assert.equal(restored.turn, game.turn);
  assert.equal(restored.moveNumber, game.moveNumber);
  assert.deepEqual(restored.cells, game.cells);
  assert.deepEqual(restored.used, game.used);
  assert.deepEqual(restored.moves, game.moves);
  assert.deepEqual(restored.getLegalActions(), game.getLegalActions());
});

test('legal actions are unique and include both place and slice options', () => {
  const game = new Game();
  game.place(4, 4);
  game.place(3, 3);
  const actions = game.getLegalActions();
  assert.ok(actions.some((action) => action.type === 'place'));
  assert.ok(actions.some((action) => action.type === 'slice'));
  const keys = actions.map((action) =>
    action.type === 'place'
      ? `p:${action.row}:${action.col}`
      : `s:${action.row}:${action.col}:${action.direction}`,
  );
  assert.equal(new Set(keys).size, keys.length);
});

test('all 13 canonical directions can produce a win', () => {
  const starts = [
    [4, 4, 4],
    [4, 4, 4],
    [4, 4, 4],
    [0, 0, 4],
    [0, 4, 4],
    [0, 4, 4],
    [4, 4, 4],
    [4, 0, 4],
    [4, 4, 4],
    [0, 0, 0],
    [0, 0, 8],
    [0, 8, 0],
    [0, 8, 8],
  ];
  const dirs = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1],
    [0, 1, 1], [0, 1, -1],
    [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
  ];
  for (let i = 0; i < dirs.length; i += 1) {
    const cells = new Uint8Array(CELL_COUNT);
    const [sx, sy, sz] = starts[i];
    const [dx, dy, dz] = dirs[i];
    for (let step = 0; step < 5; step += 1) {
      cells[indexOf(sx + dx * step, sy + dy * step, sz + dz * step)] = BLACK;
    }
    assert.ok(findWinLine(cells, indexOf(sx, sy, sz)), `direction ${dirs[i]}`);
  }
});
