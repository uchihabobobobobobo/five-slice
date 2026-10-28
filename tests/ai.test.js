import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  EMPTY,
  Game,
  WHITE,
  indexOf,
  planeId,
} from '../public/js/engine.js';
import { AI_LEVELS, chooseAction, evaluatePosition } from '../public/js/ai.js';

function state({ stones = [], turn = BLACK, plane = planeId('z', 4), used = [] }) {
  const game = new Game({ plane });
  for (const [x, y, z, color] of stones) game.cells[indexOf(x, y, z)] = color;
  for (const [x, y, z] of used) game.used[indexOf(x, y, z)] = 1;
  game.turn = turn;
  game.phase = 'playing';
  game.moveNumber = stones.length;
  game.moves = [];
  game.lastMove = null;
  return game;
}

function isLegal(snapshot, action) {
  const game = Game.fromSnapshot(snapshot);
  const legal = game.getLegalActions();
  return legal.some((candidate) => {
    if (candidate.type !== action.type) return false;
    if (candidate.row !== action.row || candidate.col !== action.col) return false;
    if (action.type === 'slice') return candidate.direction === action.direction;
    return true;
  });
}

const seeded = (seed = 7) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
};

test('AI takes an immediate win on the active plane', () => {
  const game = state({
    stones: [
      [0, 0, 4, BLACK],
      [1, 0, 4, BLACK],
      [2, 0, 4, BLACK],
      [3, 0, 4, BLACK],
    ],
    turn: BLACK,
  });
  const action = chooseAction(game.snapshot(), { difficulty: 'hard', rng: seeded() });
  assert.deepEqual(action, { type: 'place', row: 0, col: 4 });
  game.applyAction(action);
  assert.equal(game.winner, BLACK);
});

test('AI places the fifth stone of a vertical cross-plane line', () => {
  const game = state({
    stones: [
      [0, 0, 0, BLACK],
      [0, 0, 1, BLACK],
      [0, 0, 2, BLACK],
      [0, 0, 3, BLACK],
    ],
    turn: BLACK,
  });
  const action = chooseAction(game.snapshot(), { difficulty: 'normal', rng: seeded() });
  assert.deepEqual(action, { type: 'place', row: 0, col: 0 });
  game.applyAction(action);
  assert.equal(game.winner, BLACK);
});

test('AI blocks the only immediate win when it cannot cut', () => {
  const game = state({
    stones: [
      [5, 4, 4, WHITE],
      [6, 4, 4, WHITE],
      [7, 4, 4, WHITE],
      [8, 4, 4, WHITE],
    ],
    turn: BLACK,
  });
  const snapshot = game.snapshot();
  const action = chooseAction(snapshot, { difficulty: 'normal', rng: seeded() });
  assert.equal(action.type, 'place');
  assert.equal(isLegal(snapshot, action), true);
  assert.deepEqual(action, { type: 'place', row: 4, col: 4 });
  game.applyAction(action);
  assert.equal(game.phase, 'playing');
});

test('AI uses a cut to dodge a double threat it cannot block', () => {
  const game = state({
    stones: [
      [0, 0, 4, WHITE],
      [1, 0, 4, WHITE],
      [2, 0, 4, WHITE],
      [3, 0, 4, WHITE],
      [0, 2, 4, WHITE],
      [1, 2, 4, WHITE],
      [2, 2, 4, WHITE],
      [3, 2, 4, WHITE],
      [8, 8, 4, BLACK],
    ],
    turn: BLACK,
  });
  const snapshot = game.snapshot();
  const action = chooseAction(snapshot, { difficulty: 'hard', timeLimit: 1200, rng: seeded() });
  assert.ok(action, 'AI must return an action');
  assert.equal(isLegal(snapshot, action), true);
  assert.equal(action.type, 'slice', `expected a cut to escape, got ${JSON.stringify(action)}`);
  const after = Game.fromSnapshot(snapshot);
  after.applyAction(action);
  assert.notEqual(after.plane, planeId('z', 4));
});

test('AI never returns an illegal action across a short self-play', () => {
  const game = new Game();
  const rng = seeded(19);
  let actions = 0;
  while (game.phase === 'playing' && actions < 70) {
    const snapshot = game.snapshot();
    const action = chooseAction(snapshot, { difficulty: 'easy', rng });
    assert.ok(action, 'AI returned no action while the game is live');
    assert.equal(isLegal(snapshot, action), true, JSON.stringify(action));
    game.applyAction(action);
    actions += 1;
  }
  assert.ok(actions > 0);
  assert.ok(Number.isFinite(evaluatePosition(game, BLACK)));
});

test('difficulty metadata and search limits are exposed', () => {
  assert.equal(AI_LEVELS.easy.key, 'easy');
  assert.equal(AI_LEVELS.normal.depths[0], 2);
  assert.equal(AI_LEVELS.hard.depths.at(-1), 3);
});

test('hard search respects a short time budget on a midgame position', () => {
  const game = state({
    stones: [
      [3, 3, 4, BLACK], [4, 4, 4, BLACK], [2, 4, 4, BLACK],
      [3, 4, 4, WHITE], [4, 3, 4, WHITE], [5, 5, 4, WHITE],
      [3, 2, 3, BLACK], [4, 5, 2, WHITE], [5, 3, 1, BLACK],
    ],
    turn: BLACK,
  });
  const started = Date.now();
  const action = chooseAction(game.snapshot(), {
    difficulty: 'hard',
    timeLimit: 350,
    rng: seeded(3),
  });
  const elapsed = Date.now() - started;
  assert.ok(action);
  assert.equal(isLegal(game.snapshot(), action), true);
  assert.ok(elapsed < 4000, `hard search took ${elapsed}ms`);
});

test('AI prefers a winning move over a defensive cut', () => {
  const game = state({
    stones: [
      [0, 0, 4, BLACK],
      [1, 0, 4, BLACK],
      [2, 0, 4, BLACK],
      [3, 0, 4, BLACK],
      [5, 5, 4, WHITE],
      [6, 5, 4, WHITE],
      [7, 5, 4, WHITE],
      [8, 5, 4, WHITE],
    ],
    turn: BLACK,
  });
  const snapshot = game.snapshot();
  const action = chooseAction(snapshot, { difficulty: 'normal', rng: seeded() });
  assert.deepEqual(action, { type: 'place', row: 0, col: 4 });
});
