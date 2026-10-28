/**
 * FIVE / SLICE — browser/Node AI.
 *
 * The AI understands the two unusual parts of this game:
 *   1. only the active plane can be played on, but every 5-window exists in
 *      the whole 3D lattice;
 *   2. a cut does not add a stone. Its value is positional: it can dodge an
 *      immediate threat, activate latent stones, or create a fork on the next
 *      plane.
 *
 * Levels:
 *   easy   — tactical but fallible, weighted random placement.
 *   normal — 2-ply search with threat-aware candidate generation.
 *   hard   — iterative deepening to 3 ply under a short time budget.
 */

import {
  BLACK,
  CELL_COUNT,
  DIRECTIONS,
  EMPTY,
  Game,
  SIZE,
  WHITE,
  coordOf,
  indexOf,
  otherColor,
  planeCell,
  planeCells,
  planeInfo,
  sliceTarget,
} from './engine.js';
import { AI_LEVELS } from './levels.js';

export { AI_LEVELS } from './levels.js';

const WIN = 1_000_000_000;
const TIMEOUT = Symbol('search-timeout');

/* ------------------------------------------------------------------ */
/* Precomputed 3D geometry                                            */
/* ------------------------------------------------------------------ */

const WINDOW_CELLS = [];
for (const [dx, dy, dz] of DIRECTIONS) {
  for (let x = 0; x < SIZE; x += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      for (let z = 0; z < SIZE; z += 1) {
        const endX = x + dx * 4;
        const endY = y + dy * 4;
        const endZ = z + dz * 4;
        if (endX < 0 || endX >= SIZE || endY < 0 || endY >= SIZE || endZ < 0 || endZ >= SIZE) {
          continue;
        }
        const cells = new Array(5);
        for (let step = 0; step < 5; step += 1) {
          cells[step] = indexOf(x + dx * step, y + dy * step, z + dz * step);
        }
        WINDOW_CELLS.push(cells);
      }
    }
  }
}

const CELL_WINDOWS = Array.from({ length: CELL_COUNT }, () => []);
for (let w = 0; w < WINDOW_CELLS.length; w += 1) {
  for (const cell of WINDOW_CELLS[w]) CELL_WINDOWS[cell].push(w);
}

const ON_PLANE = Array.from({ length: 27 }, (_, plane) => {
  const mask = new Uint8Array(CELL_COUNT);
  for (const cell of planeCells(plane)) mask[cell] = 1;
  return mask;
});

const PLANE_IDS = Array.from({ length: CELL_COUNT }, (_, index) => {
  const c = coordOf(index);
  return [c.x, SIZE + c.y, SIZE * 2 + c.z];
});

function isOnPlane(index, plane) {
  return ON_PLANE[plane][index] === 1;
}

function centerBias(index) {
  const c = coordOf(index);
  return 12 - (Math.abs(c.x - 4) + Math.abs(c.y - 4) + Math.abs(c.z - 4));
}

function now() {
  return Date.now();
}

/* ------------------------------------------------------------------ */
/* Threat analysis                                                    */
/* ------------------------------------------------------------------ */

/**
 * Scan every 5-window once. A "winnable" cell is an empty cell which would
 * complete four same-colour stones. We also count, per plane, how many such
 * cells are reachable if that plane becomes active.
 */
export function analyzeThreats(game) {
  const cells = game.cells;
  const winnable = [new Set(), new Set()];
  const planeCounts = [new Uint8Array(27), new Uint8Array(27)];

  const addThreat = (color, index) => {
    const bucket = winnable[color - 1];
    if (bucket.has(index)) return;
    bucket.add(index);
    for (const plane of PLANE_IDS[index]) planeCounts[color - 1][plane] += 1;
  };

  for (const window of WINDOW_CELLS) {
    let black = 0;
    let white = 0;
    let empty = -1;
    for (let i = 0; i < 5; i += 1) {
      const cell = cells[window[i]];
      if (cell === BLACK) black += 1;
      else if (cell === WHITE) white += 1;
      else empty = window[i];
    }
    if (black === 4 && white === 0 && empty >= 0) addThreat(BLACK, empty);
    else if (white === 4 && black === 0 && empty >= 0) addThreat(WHITE, empty);
  }

  const active = [null, new Set(), new Set()];
  for (const color of [BLACK, WHITE]) {
    for (const index of winnable[color - 1]) {
      if (isOnPlane(index, game.plane)) active[color].add(index);
    }
  }
  return { winnable, planeCounts, active };
}

function winningThreats(game, analysis) {
  return analysis.active[game.turn];
}

function opponentWinningThreats(game, analysis) {
  return analysis.active[otherColor(game.turn)];
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function windowValue(count, playableEmpty) {
  if (count >= 5) return 2_000_000;
  if (count === 4) return playableEmpty > 0 ? 90_000 : 900;
  if (count === 3) return playableEmpty > 0 ? 2_400 : 220;
  if (count === 2) return playableEmpty > 0 ? 130 : 30;
  return 2;
}

/**
 * Static evaluation from `rootColor`'s point of view. If the side to move has
 * a playable four, the leaf is treated as a forced win. This prevents the
 * search from stopping one ply before a kill.
 */
export function evaluatePosition(game, rootColor) {
  const cells = game.cells;
  const rootIsBlack = rootColor === BLACK;
  let score = 0;
  let blackImmediate = 0;
  let whiteImmediate = 0;

  for (const window of WINDOW_CELLS) {
    let black = 0;
    let white = 0;
    let playableEmpty = 0;
    for (let i = 0; i < 5; i += 1) {
      const index = window[i];
      const cell = cells[index];
      if (cell === BLACK) black += 1;
      else if (cell === WHITE) white += 1;
      else if (isOnPlane(index, game.plane)) playableEmpty += 1;
    }
    if (black && white) continue;
    if (black) {
      const value = windowValue(black, playableEmpty);
      score += rootIsBlack ? value : -value;
      if (black === 4 && playableEmpty > 0) blackImmediate += 1;
    } else if (white) {
      const value = windowValue(white, playableEmpty);
      score += rootIsBlack ? -value * 1.04 : value * 1.04;
      if (white === 4 && playableEmpty > 0) whiteImmediate += 1;
    }
  }

  if (game.turn === BLACK && blackImmediate > 0) {
    return rootIsBlack ? WIN - 500 : -WIN + 500;
  }
  if (game.turn === WHITE && whiteImmediate > 0) {
    return rootIsBlack ? -WIN + 500 : WIN - 500;
  }

  // Material: stones on the active plane are worth more than latent stones,
  // and unused stones are future cut resources.
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const color = cells[index];
    if (!color) continue;
    const onPlane = isOnPlane(index, game.plane);
    let value = onPlane ? 9 : 2;
    value += centerBias(index) * 0.12;
    if (!game.used[index]) value += 1.5;
    score += color === rootColor ? value : -value;
  }

  return score;
}

/* ------------------------------------------------------------------ */
/* Candidate generation                                               */
/* ------------------------------------------------------------------ */

const PLACE_ORDER = [0, 2, 24, 360, 9_000, 10_000_000];
const DEFEND_ORDER = [0, 2, 30, 480, 12_000, 10_000_000];

function placementScore(game, index, color, analysis, rng) {
  const opponent = otherColor(color);
  let score = 0;
  if (analysis.winnable[color - 1].has(index)) score += 500_000_000;
  if (analysis.winnable[opponent - 1].has(index)) score += 20_000_000;

  const cells = game.cells;
  for (const w of CELL_WINDOWS[index]) {
    let mine = 0;
    let theirs = 0;
    let playableEmpty = 0;
    for (const cell of WINDOW_CELLS[w]) {
      const stone = cells[cell];
      if (stone === color) mine += 1;
      else if (stone === opponent) theirs += 1;
      else if (isOnPlane(cell, game.plane)) playableEmpty += 1;
    }
    if (theirs === 0) {
      score += PLACE_ORDER[Math.min(5, mine + 1)] + playableEmpty * 4;
    } else if (mine === 0) {
      score += DEFEND_ORDER[Math.min(5, theirs)] * 0.9;
    }
  }

  const info = planeInfo(game.plane);
  const c = coordOf(index);
  let neighbours = 0;
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      if (!dr && !dc) continue;
      const row = c[info.vName] + dr;
      const col = c[info.uName] + dc;
      if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) continue;
      const neighbour = game.cells[planeCell(game.plane, row, col)];
      if (neighbour) neighbours += (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 ? 18 : 6);
    }
  }
  score += neighbours;
  score += centerBias(index) * 2;
  score += rng() * 6;
  return score;
}

function rankPlacements(game, color, analysis, rng) {
  const candidates = [];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (!isOnPlane(index, game.plane)) continue;
    if (game.cells[index] !== EMPTY) continue;
    candidates.push({
      type: 'place',
      row: coordOf(index)[planeInfo(game.plane).vName],
      col: coordOf(index)[planeInfo(game.plane).uName],
      index,
      score: placementScore(game, index, color, analysis, rng),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function sliceTargetScore(game, color, targetPlane, analysis) {
  const opponent = otherColor(color);
  const info = planeInfo(targetPlane);
  const cells = game.cells;
  let own = 0;
  let theirs = 0;
  let ownUnused = 0;
  let empty = 0;
  for (const index of planeCells(targetPlane)) {
    const stone = cells[index];
    if (stone === color) {
      own += 1;
      if (!game.used[index]) ownUnused += 1;
    } else if (stone === opponent) {
      theirs += 1;
    } else {
      empty += 1;
    }
  }
  if (empty === 0) return -Infinity;

  const ownThreats = analysis.planeCounts[color - 1][targetPlane];
  const oppThreats = analysis.planeCounts[opponent - 1][targetPlane];
  let score = own * 9 - theirs * 7 + ownUnused * 5;
  score += (4 - Math.abs(info.value - 4)) * 3;
  score += ownThreats * 180;
  score -= oppThreats * 4_000;
  if (analysis.active[opponent].size > 0 && oppThreats === 0) score += 900;
  return score;
}

function rankSlices(game, color, analysis, rng) {
  const info = planeInfo(game.plane);
  const opponent = otherColor(color);
  const byTarget = new Map();

  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const index = planeCell(game.plane, row, col);
      if (game.cells[index] !== color || game.used[index]) continue;
      for (const direction of ['h', 'v']) {
        const target = sliceTarget(game.plane, row, col, direction);
        const existing = byTarget.get(target.toPlane);
        const pivotCost = row + col;
        if (existing && existing.pivotCost <= pivotCost) continue;
        byTarget.set(target.toPlane, {
          type: 'slice',
          row,
          col,
          direction,
          toPlane: target.toPlane,
          pivotCost,
          score: sliceTargetScore(game, color, target.toPlane, analysis) + rng() * 4,
          oppThreats: analysis.planeCounts[opponent - 1][target.toPlane],
        });
      }
    }
  }

  const slices = [...byTarget.values()].sort((a, b) => b.score - a.score);
  return slices;
}

function toPublicAction(candidate) {
  if (candidate.type === 'place') {
    return { type: 'place', row: candidate.row, col: candidate.col };
  }
  return {
    type: 'slice',
    row: candidate.row,
    col: candidate.col,
    direction: candidate.direction,
  };
}

function uniqueActions(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const key =
      candidate.type === 'place'
        ? `p:${candidate.row}:${candidate.col}`
        : `s:${candidate.row}:${candidate.col}:${candidate.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function buildCandidates(game, config, isRoot, analysis, rng) {
  const color = game.turn;
  const opponent = otherColor(color);
  const myWins = [...winningThreats(game, analysis)];
  if (myWins.length) {
    return myWins.slice(0, 4).map((index) => {
      const c = coordOf(index);
      const info = planeInfo(game.plane);
      return {
        type: 'place',
        row: c[info.vName],
        col: c[info.uName],
        index,
        score: 1e9,
      };
    });
  }

  const oppWins = [...opponentWinningThreats(game, analysis)];
  const placements = rankPlacements(game, color, analysis, rng);
  const slices = rankSlices(game, color, analysis, rng);
  const placeLimit = isRoot ? config.rootPlace : config.innerPlace;
  const sliceLimit = isRoot ? config.rootSlice : config.innerSlice;

  if (oppWins.length) {
    const blocks = placements.filter((candidate) => oppWins.includes(candidate.index)).slice(0, 6);
    const safeSlices = slices.filter((candidate) => candidate.oppThreats === 0);
    const riskySlices = slices.filter((candidate) => candidate.oppThreats !== 0);
    const selected = [
      ...blocks,
      ...safeSlices.slice(0, Math.max(sliceLimit, isRoot ? 10 : 4)),
      ...riskySlices.slice(0, sliceLimit),
    ];
    return uniqueActions(selected)
      .sort((a, b) => b.score - a.score)
      .slice(0, isRoot ? 14 : 8);
  }

  return uniqueActions([
    ...placements.slice(0, placeLimit),
    ...slices.slice(0, sliceLimit),
  ]).sort((a, b) => b.score - a.score);
}

function applyToClone(game, action) {
  const child = game.cloneForSearch();
  child.applyAction(action);
  return child;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function minimax(game, depth, alpha, beta, ctx, ply) {
  ctx.nodes += 1;
  if ((ctx.nodes & 15) === 0 && now() > ctx.deadline) throw TIMEOUT;

  if (game.phase === 'won') {
    return game.winner === ctx.rootColor ? WIN - ply * 1_000 : -WIN + ply * 1_000;
  }
  if (game.phase === 'draw') return 0;
  if (depth <= 0) return evaluatePosition(game, ctx.rootColor);

  const maximizing = game.turn === ctx.rootColor;
  const analysis = analyzeThreats(game);
  const candidates = buildCandidates(game, ctx.config, false, analysis, ctx.rng);
  if (!candidates.length) return 0;

  if (maximizing) {
    let best = -Infinity;
    for (const candidate of candidates) {
      if (now() > ctx.deadline) throw TIMEOUT;
      const child = applyToClone(game, toPublicAction(candidate));
      const value = minimax(child, depth - 1, alpha, beta, ctx, ply + 1);
      if (value > best) best = value;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  let best = Infinity;
  for (const candidate of candidates) {
    if (now() > ctx.deadline) throw TIMEOUT;
    const child = applyToClone(game, toPublicAction(candidate));
    const value = minimax(child, depth - 1, alpha, beta, ctx, ply + 1);
    if (value < best) best = value;
    if (best < beta) beta = best;
    if (alpha >= beta) break;
  }
  return best;
}

function searchRoot(game, ctx, depth, rootAnalysis, rootCandidates) {
  let bestAction = rootCandidates.length ? toPublicAction(rootCandidates[0]) : null;
  let bestValue = -Infinity;

  for (const candidate of rootCandidates) {
    if (now() > ctx.deadline) throw TIMEOUT;
    const child = applyToClone(game, toPublicAction(candidate));
    let value;
    if (child.phase === 'won') {
      value = child.winner === ctx.rootColor ? WIN : -WIN;
    } else {
      value = minimax(child, depth - 1, -Infinity, Infinity, ctx, 1);
    }
    if (value > bestValue) {
      bestValue = value;
      bestAction = toPublicAction(candidate);
    }
    if (bestValue >= WIN - 10_000) break;
  }

  return { action: bestAction, value: bestValue };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function weightedPick(items, rng) {
  if (!items.length) return null;
  // Rank-weighted softmax: the best candidate is most likely, but upsets happen.
  const weights = items.map((_, index) => 1 / Math.pow(index + 1, 1.35));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = rng() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return items[index];
  }
  return items[items.length - 1];
}

function chooseEasy(game, config, analysis, rng) {
  const color = game.turn;
  const opponent = otherColor(color);
  const wins = [...winningThreats(game, analysis)];
  if (wins.length) {
    const c = coordOf(wins[0]);
    const info = planeInfo(game.plane);
    return { type: 'place', row: c[info.vName], col: c[info.uName] };
  }

  const oppWins = [...opponentWinningThreats(game, analysis)];
  if (oppWins.length && rng() < 0.72) {
    const chosen = oppWins[Math.floor(rng() * oppWins.length)] ?? oppWins[0];
    const c = coordOf(chosen);
    const info = planeInfo(game.plane);
    return { type: 'place', row: c[info.vName], col: c[info.uName] };
  }

  const slices = rankSlices(game, color, analysis, rng);
  if (slices.length && rng() < 0.14) {
    return toPublicAction(slices[0]);
  }

  const placements = rankPlacements(game, color, analysis, rng);
  if (!placements.length) {
    const legal = game.getLegalActions();
    return legal.length ? toPublicAction(legal[0]) : null;
  }
  const chosen = weightedPick(placements.slice(0, 8), rng);
  return toPublicAction(chosen);
}

/**
 * @param {object} snapshot engine snapshot
 * @param {object} [options]
 * @param {'easy'|'normal'|'hard'} [options.difficulty]
 * @param {number} [options.timeLimit]
 * @param {() => number} [options.rng]
 * @returns {{type:'place'|'slice',row:number,col:number,direction?:'h'|'v'}|null}
 */
export function chooseAction(snapshot, options = {}) {
  const game = Game.fromSnapshot(snapshot);
  if (game.phase !== 'playing') return null;

  const level = AI_LEVELS[options.difficulty] ?? AI_LEVELS.normal;
  const config = {
    ...level,
    timeLimit: Math.max(50, options.timeLimit ?? level.timeLimit),
  };
  const rng = options.rng ?? Math.random;
  const analysis = analyzeThreats(game);
  const color = game.turn;

  const wins = [...winningThreats(game, analysis)];
  if (wins.length) {
    const c = coordOf(wins[0]);
    const info = planeInfo(game.plane);
    return { type: 'place', row: c[info.vName], col: c[info.uName] };
  }

  if (level.key === 'easy') {
    return sanitizeAction(game, chooseEasy(game, config, analysis, rng));
  }

  const candidates = buildCandidates(game, config, true, analysis, rng);
  if (!candidates.length) {
    const legal = game.getLegalActions();
    return legal.length ? toPublicAction(legal[0]) : null;
  }

  const deadline = now() + config.timeLimit;
  const ctx = {
    rootColor: color,
    config,
    rng,
    deadline,
    nodes: 0,
  };

  let best = toPublicAction(candidates[0]);
  for (const depth of config.depths) {
    if (now() > deadline) break;
    try {
      const result = searchRoot(game, ctx, depth, analysis, candidates);
      if (result?.action) best = result.action;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
    if (now() > deadline) break;
  }

  return sanitizeAction(game, best);
}

function sanitizeAction(game, action) {
  if (!action) return null;
  const test = game.clone();
  try {
    test.applyAction(action);
    return action;
  } catch {
    const legal = game.getLegalActions();
    if (!legal.length) return null;
    return toPublicAction(legal[0]);
  }
}

/** Convenience for Node scripts/tests. */
export function describeDifficulty(key) {
  const level = AI_LEVELS[key] ?? AI_LEVELS.normal;
  return `${level.label}：${level.tagline}`;
}

export { WINDOW_CELLS };
