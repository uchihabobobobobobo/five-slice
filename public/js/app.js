/**
 * FIVE / SLICE — browser application.
 *
 * The board here is intentionally flat and legible. The third dimension is
 * carried by the 9-layer stack on the right, the cut/flip transition, and the
 * 3D result drawing.
 */

import {
  BLACK,
  EMPTY,
  Game,
  WHITE,
  colorName,
  coordOf,
  creaseCells,
  otherColor,
  planeInfo,
  sliceTarget,
} from './engine.js';
import { AI_LEVELS, difficultyName } from './levels.js';
import { drawResultCube, mountHero } from './visuals.js';

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const MODAL_IDS = ['rules-modal', 'result-modal', 'notice-modal', 'confirm-modal'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const AI_NAME = '镜面引擎';

/* -------------------------------------------------------------------------- */
/* Storage / small utilities                                                   */
/* -------------------------------------------------------------------------- */

const store = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // Private mode / disabled storage: the game still works for this tab.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore.
    }
  },
};

const seatKey = (code) => `fiveslice:seat:${code}`;
const NAME_KEY = 'fiveslice:name';
const DIFFICULTY_KEY = 'fiveslice:difficulty';
const SOUND_KEY = 'fiveslice:sound';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function normalizeName(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
    .trim();
  return [...normalized].slice(0, 16).join('').trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeText(node, text) {
  if (node) node.textContent = text ?? '';
}

function setBusyButton(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.wasDisabled = button.disabled ? '1' : '';
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
  } else {
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

function setFormError(id, message) {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('is-visible', Boolean(message));
  if (message) {
    node.classList.remove('is-visible');
    // Restart the tiny shake without layout thrash.
    void node.offsetWidth;
    node.classList.add('is-visible');
  }
}

class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body, timeout = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || `服务器返回 ${response.status}`, {
        status: response.status,
        code: payload?.error?.code || '',
      });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ApiError('请求超时，请检查网络或确认服务器仍在运行。');
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError('无法连接服务器。请在项目目录运行 npm start，并通过终端显示的地址访问。');
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const initialDifficulty = store.get(DIFFICULTY_KEY, 'normal');
const S = {
  screen: 'home',
  mode: null,
  game: null,
  myColor: BLACK,
  round: 0,
  aiLevel: AI_LEVELS[initialDifficulty] ? initialDifficulty : 'normal',
  soundOn: store.get(SOUND_KEY, 'on') !== 'off',
  ai: {
    worker: null,
    workerBroken: false,
    requestId: 0,
    thinking: false,
    timer: null,
    gameId: 0,
    pendingSnapshot: null,
  },
  online: {
    code: null,
    token: null,
    seat: null,
    state: null,
    queue: [],
    processing: false,
    lastQueuedSeq: -1,
    lastSeq: 0,
    actionPending: false,
    stream: null,
    streamDown: false,
    reconnectTimer: null,
    resyncTimer: null,
    pollTimer: null,
    lastOpponentConnected: null,
    lastPhase: null,
    noticeKey: null,
    rematchPending: false,
    leaving: false,
  },
  ui: {
    sliceMode: false,
    selectedPivot: null,
    hoverDirection: null,
    busy: false,
    animating: false,
    resultRoundKey: null,
    resultOpen: false,
    resultTimer: null,
    crease: null,
    focusRow: 4,
    focusCol: 4,
    boardPlane: null,
    lastAnimatedMove: 0,
    logLength: 0,
    layerCanvases: [],
    layerNodes: [],
    previousFocus: null,
    modal: null,
    heroStop: null,
    confirmAction: null,
    invitationRoom: null,
  },
};

/* -------------------------------------------------------------------------- */
/* Sound                                                                       */
/* -------------------------------------------------------------------------- */

const Sound = {
  ctx: null,
  noiseBuffer: null,
  ensure() {
    if (!S.soundOn) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    } catch {
      return null;
    }
  },
  env(gain, time, attack = 0.005, decay = 0.14) {
    exportGain(gain);
    function exportGain(node) {
      node.gain.setValueAtTime(0.0001, time);
      node.gain.exponentialRampToValueAtTime(gain, time + attack);
      node.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    }
  },
  tone(frequency, duration = 0.12, options = {}) {
    if (!S.soundOn) return;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const {
        type = 'sine',
        gain = 0.025,
        when = 0,
        slideTo = null,
        attack = 0.005,
      } = options;
      const start = ctx.currentTime + when;
      const oscillator = ctx.createOscillator();
      const amp = ctx.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + attack);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(amp).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    } catch {
      // Audio can fail on some locked-down browsers; the game should not.
    }
  },
  noise(duration = 0.3, gain = 0.03, when = 0, band = 1200) {
    if (!S.soundOn) return;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      if (!this.noiseBuffer) {
        const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.6), ctx.sampleRate);
        const channel = buffer.getChannelData(0);
        let last = 0;
        for (let i = 0; i < channel.length; i += 1) {
          const white = Math.random() * 2 - 1;
          last = last * 0.7 + white * 0.3;
          channel[i] = last;
        }
        this.noiseBuffer = buffer;
      }
      const start = ctx.currentTime + when;
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(band, start);
      filter.frequency.exponentialRampToValueAtTime(Math.max(180, band * 0.35), start + duration);
      filter.Q.value = 0.8;
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter).connect(amp).connect(ctx.destination);
      source.start(start);
      source.stop(start + duration + 0.03);
    } catch {
      // Ignore.
    }
  },
  click() {
    this.tone(760, 0.035, { type: 'triangle', gain: 0.012 });
  },
  select() {
    this.tone(540, 0.07, { type: 'sine', gain: 0.02, slideTo: 760 });
  },
  stone() {
    this.noise(0.06, 0.035, 0, 2200);
    this.tone(240, 0.075, { type: 'sine', gain: 0.03, slideTo: 160 });
    this.tone(880, 0.035, { type: 'triangle', gain: 0.009, when: 0.012 });
  },
  cut() {
    this.noise(0.48, 0.045, 0, 1700);
    this.tone(260, 0.42, { type: 'sawtooth', gain: 0.012, slideTo: 80 });
    this.tone(1220, 0.1, { type: 'sine', gain: 0.012, when: 0.18, slideTo: 600 });
  },
  win() {
    const notes = [392, 523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
      this.tone(frequency, 0.28, {
        type: index % 2 ? 'sine' : 'triangle',
        gain: 0.022,
        when: index * 0.085,
      });
    });
  },
  lose() {
    [330, 293.66, 246.94, 196].forEach((frequency, index) => {
      this.tone(frequency, 0.3, { type: 'sine', gain: 0.018, when: index * 0.11 });
    });
  },
  error() {
    this.tone(160, 0.1, { type: 'square', gain: 0.012 });
  },
};

/* -------------------------------------------------------------------------- */
/* Toasts / loading / live announcements                                       */
/* -------------------------------------------------------------------------- */

function toast(message, type = 'info', duration = 2800) {
  const stack = $('toast-stack');
  if (!stack) return;
  while (stack.children.length >= 3) stack.firstChild?.remove();
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' is-error' : type === 'gold' ? ' is-gold' : ''}`;
  node.textContent = message;
  stack.append(node);
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 240);
  }, duration);
}

function clearToasts() {
  $('toast-stack')?.replaceChildren();
}

function announce(message) {
  const live = $('live-region');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => {
    live.textContent = message;
  }, 40);
}

function showLoading(text = '正在进入空间…') {
  safeText($('loading-text'), text);
  $('loading-screen').hidden = false;
}

function hideLoading() {
  $('loading-screen').hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Modals                                                                     */
/* -------------------------------------------------------------------------- */

function isModalOpen() {
  return !$('modal-layer').hidden;
}

function getFocusable(modal) {
  return $$(
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    modal,
  ).filter((node) => node.offsetParent !== null);
}

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  if (!isModalOpen()) S.ui.previousFocus = document.activeElement;
  S.ui.modal = id;
  $('modal-layer').hidden = false;
  for (const modalId of MODAL_IDS) {
    const node = $(modalId);
    if (node) node.hidden = modalId !== id;
  }
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    const focusable = getFocusable(modal);
    (focusable[0] || modal).focus?.();
  });
}

function closeModals({ restoreFocus = true } = {}) {
  const wasOpen = isModalOpen();
  $('modal-layer').hidden = true;
  for (const id of MODAL_IDS) {
    const node = $(id);
    if (node) node.hidden = true;
  }
  document.body.classList.remove('modal-open');
  if (idOfModal() === 'result-modal') S.ui.resultOpen = false;
  S.ui.modal = null;
  if (restoreFocus && wasOpen && S.ui.previousFocus?.isConnected) {
    try {
      S.ui.previousFocus.focus({ preventScroll: true });
    } catch {
      // Ignore.
    }
  }
  S.ui.previousFocus = null;
  if (S.game) renderStatusAndDock();
}

function idOfModal() {
  return S.ui.modal;
}

function closeResultView() {
  closeModals();
  S.ui.resultOpen = false;
  if (S.game) renderStatusAndDock();
}

/* -------------------------------------------------------------------------- */
/* Screen / header                                                            */
/* -------------------------------------------------------------------------- */

function setScreen(name) {
  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
  };
  for (const [key, node] of Object.entries(screens)) {
    if (node) node.hidden = key !== name;
  }
  S.screen = name;
  document.body.dataset.screen = name;
  $('leave-btn').hidden = name === 'home';
  $('context-copy').hidden = !(
    S.mode === 'online' && (name === 'lobby' || name === 'game')
  );
  if (name === 'home') {
    stopHero();
    mountHomeHero();
    document.title = '切面战争 · FIVE / SLICE — 三维五子棋';
  } else {
    stopHero();
    document.title =
      name === 'lobby'
        ? `等待对手 · ${S.online.code || ''} — 切面战争`
        : '对局中 — 切面战争';
  }
  updateHeaderContext();
  window.scrollTo(0, 0);
}

function mountHomeHero() {
  if (S.ui.heroStop || $('screen-home').hidden) return;
  const canvas = $('hero-canvas');
  if (canvas) S.ui.heroStop = mountHero(canvas);
}

function stopHero() {
  if (S.ui.heroStop) {
    S.ui.heroStop();
    S.ui.heroStop = null;
  }
}

function updateHeaderContext() {
  const text = $('context-text');
  if (!text) return;
  let label = '三维五子棋';
  if (S.mode === 'ai' && S.screen !== 'home') {
    label = `人机 · ${difficultyName(S.aiLevel)} · 第 ${Math.max(1, S.round)} 局`;
  } else if (S.mode === 'online' && S.screen !== 'home') {
    if (S.screen === 'lobby') {
      label = `房间 ${S.online.code || '······'} · 等待对手`;
    } else {
      label = `房间 ${S.online.code || '······'} · 第 ${Math.max(1, S.round)} 局`;
    }
  }
  text.textContent = label;
  $('context-copy').hidden = !(
    S.mode === 'online' && (S.screen === 'lobby' || S.screen === 'game')
  );
}

function setConnection(text, state = 'ok') {
  const box = $('connection');
  if (!box) return;
  box.hidden = S.mode !== 'online' || S.screen !== 'game';
  safeText($('connection-text'), text);
  box.classList.toggle('is-reconnecting', state === 'reconnecting');
  box.classList.toggle('is-offline', state === 'offline');
}

function updateConnectionUI() {
  if (S.mode !== 'online' || S.screen !== 'game') {
    $('connection').hidden = true;
    return;
  }
  const state = S.online.state;
  if (S.online.streamDown) {
    setConnection('重连中…', 'reconnecting');
    return;
  }
  if (state?.phase === 'abandoned') {
    setConnection('对局结束', 'offline');
    return;
  }
  if (!state || !state.you) {
    setConnection('连接中…', 'reconnecting');
    return;
  }
  if (!state.you.connected) {
    setConnection('连接中…', 'reconnecting');
    return;
  }
  if (state.opponent && !state.opponent.connected) {
    setConnection('对手离线 · 等待重连', 'reconnecting');
    return;
  }
  setConnection('实时同步', 'ok');
}

/* -------------------------------------------------------------------------- */
/* Board scaffold                                                             */
/* -------------------------------------------------------------------------- */

function buildBoardScaffold() {
  const grid = $('board-grid');
  const parts = [];
  for (let i = 0; i < 9; i += 1) {
    const position = 50 + i * 100;
    parts.push(
      `<line x1="${position}" y1="50" x2="${position}" y2="850" />`,
      `<line x1="50" y1="${position}" x2="850" y2="${position}" />`,
    );
  }
  for (const [col, row] of [
    [2, 2],
    [6, 2],
    [4, 4],
    [2, 6],
    [6, 6],
  ]) {
    parts.push(`<circle class="grid-star" cx="${50 + col * 100}" cy="${50 + row * 100}" r="4.2" />`);
  }
  grid.innerHTML = parts.join('');
}

function buildCells() {
  const container = $('board-cells');
  container.replaceChildren();
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell is-static';
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.tabIndex = row === 4 && col === 4 ? 0 : -1;
      cell.setAttribute('aria-label', `第 ${row + 1} 行，第 ${col + 1} 列，空点`);
      container.append(cell);
    }
  }
}

function buildLayerScaffold() {
  const grid = $('layer-grid');
  grid.replaceChildren();
  S.ui.layerCanvases = [];
  S.ui.layerNodes = [];
  for (let value = 0; value < 9; value += 1) {
    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.setAttribute('role', 'img');
    layer.setAttribute('aria-label', `第 ${value} 层切面缩略图`);
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.className = 'layer-label';
    label.textContent = `?${value}`;
    layer.append(canvas, label);
    grid.append(layer);
    S.ui.layerCanvases.push(canvas);
    S.ui.layerNodes.push(layer);
  }
}

/* -------------------------------------------------------------------------- */
/* Board rendering                                                            */
/* -------------------------------------------------------------------------- */

function columnName(index) {
  return String.fromCharCode(65 + index);
}

function focusStoredCell({ scroll = false } = {}) {
  const row = clamp(S.ui.focusRow, 0, 8);
  const col = clamp(S.ui.focusCol, 0, 8);
  const cells = $$('.cell', $('board-cells'));
  cells.forEach((cell) => {
    cell.tabIndex = -1;
  });
  const target = cells[row * 9 + col];
  if (!target) return;
  target.tabIndex = 0;
  if (scroll) target.focus({ preventScroll: true });
}

function setAxisLabels(info, pivot = null) {
  const top = $('axis-top');
  const left = $('axis-left');
  const topFrag = document.createDocumentFragment();
  const leftFrag = document.createDocumentFragment();
  for (let index = 0; index < 9; index += 1) {
    const column = document.createElement('span');
    column.textContent = `${info.uName.toUpperCase()}${index}`;
    if (pivot && pivot.col === index) column.classList.add('is-cut');
    topFrag.append(column);

    const row = document.createElement('span');
    row.textContent = `${info.vName.toUpperCase()}${index}`;
    if (pivot && pivot.row === index) row.classList.add('is-cut');
    leftFrag.append(row);
  }
  top.replaceChildren(topFrag);
  left.replaceChildren(leftFrag);
  $('axis-corner').textContent = `${info.axisName.toUpperCase()}=${info.value}`;
}

function stoneNode(color, { spent = false, animate = false } = {}) {
  const stone = document.createElement('span');
  stone.className = `stone ${color === BLACK ? 'black' : 'white'}${spent ? ' is-spent' : ''}`;
  if (animate) stone.classList.add('stone-enter');
  const glint = document.createElement('span');
  glint.className = 'stone-glint';
  const spentMark = document.createElement('span');
  spentMark.className = 'stone-spent';
  stone.append(glint, spentMark);
  return stone;
}

function svgNode(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function drawWinOverlay() {
  const overlay = $('board-overlay');
  overlay.replaceChildren();
  if (!S.game?.winLine) return;
  const points = S.game.winLine
    .map((index) => S.game.displayOf(index))
    .filter(Boolean)
    .map(({ row, col }) => ({
      x: 50 + col * 100,
      y: 50 + row * 100,
    }));
  if (points.length < 2) return;
  const first = points[0];
  const last = points[points.length - 1];
  overlay.append(
    svgNode('line', {
      x1: first.x,
      y1: first.y,
      x2: last.x,
      y2: last.y,
      stroke: 'rgba(227,184,111,.16)',
      'stroke-width': 18,
    }),
    svgNode('line', {
      x1: first.x,
      y1: first.y,
      x2: last.x,
      y2: last.y,
      stroke: 'rgba(255,220,156,.88)',
      'stroke-width': 2,
      'stroke-dasharray': '1 0',
    }),
  );
  for (const point of points) {
    overlay.append(
      svgNode('circle', {
        cx: point.x,
        cy: point.y,
        r: 31,
        fill: 'none',
        stroke: 'rgba(240,197,120,.22)',
        'stroke-width': 1.5,
      }),
    );
  }
}

function drawCreaseOverlay() {
  if (!S.ui.crease || S.ui.crease.plane !== S.game?.plane) return;
  const overlay = $('board-overlay');
  const points = S.ui.crease.cells
    .map((index) => S.game.displayOf(index))
    .filter(Boolean)
    .map(({ row, col }) => ({ x: 50 + col * 100, y: 50 + row * 100 }));
  if (points.length < 2) return;
  const sameRow = points.every((point) => point.y === points[0].y);
  const sameColumn = points.every((point) => point.x === points[0].x);
  if (!sameRow && !sameColumn) return;
  const first = sameRow
    ? points.reduce((a, b) => (a.x < b.x ? a : b))
    : points.reduce((a, b) => (a.y < b.y ? a : b));
  const last = sameRow
    ? points.reduce((a, b) => (a.x > b.x ? a : b))
    : points.reduce((a, b) => (a.y > b.y ? a : b));
  overlay.append(
    svgNode('line', {
      x1: first.x,
      y1: first.y,
      x2: last.x,
      y2: last.y,
      stroke: 'rgba(126,231,216,.11)',
      'stroke-width': 13,
    }),
    svgNode('line', {
      x1: first.x,
      y1: first.y,
      x2: last.x,
      y2: last.y,
      stroke: 'rgba(150,255,240,.62)',
      'stroke-width': 1.1,
      'stroke-dasharray': '4 9',
    }),
    svgNode('circle', { cx: first.x, cy: first.y, r: 2.6, fill: 'rgba(185,255,246,.8)' }),
    svgNode('circle', { cx: last.x, cy: last.y, r: 2.6, fill: 'rgba(185,255,246,.8)' }),
  );
}

function drawCutPreview(pivot) {
  const overlay = $('board-overlay');
  const x = 50 + pivot.col * 100;
  const y = 50 + pivot.row * 100;
  const direction = S.ui.hoverDirection;
  const horizontalAlpha = direction === 'v' ? 0.16 : direction === 'h' ? 0.92 : 0.55;
  const verticalAlpha = direction === 'h' ? 0.16 : direction === 'v' ? 0.92 : 0.55;
  overlay.append(
    svgNode('line', {
      x1: 0,
      y1: y,
      x2: 900,
      y2: y,
      stroke: `rgba(126,231,216,${horizontalAlpha * 0.13})`,
      'stroke-width': 14,
    }),
    svgNode('line', {
      x1: 0,
      y1: y,
      x2: 900,
      y2: y,
      stroke: `rgba(150,255,240,${horizontalAlpha})`,
      'stroke-width': 1.4,
      'stroke-dasharray': '7 7',
    }),
    svgNode('line', {
      x1: x,
      y1: 0,
      x2: x,
      y2: 900,
      stroke: `rgba(126,231,216,${verticalAlpha * 0.13})`,
      'stroke-width': 14,
    }),
    svgNode('line', {
      x1: x,
      y1: 0,
      x2: x,
      y2: 900,
      stroke: `rgba(150,255,240,${verticalAlpha})`,
      'stroke-width': 1.4,
      'stroke-dasharray': '7 7',
    }),
    svgNode('circle', {
      cx: x,
      cy: y,
      r: 34,
      fill: 'rgba(126,231,216,.025)',
      stroke: 'rgba(126,231,216,.85)',
      'stroke-width': 1.2,
    }),
    svgNode('circle', {
      cx: x,
      cy: y,
      r: 5,
      fill: '#b9fff6',
    }),
  );
}

function renderBoard({ animateLast = false } = {}) {
  if (!S.game) return;
  const game = S.game;
  const info = game.planeInfo;
  const planeChanged = S.ui.boardPlane !== game.plane;
  S.ui.boardPlane = game.plane;

  setAxisLabels(
    info,
    S.ui.sliceMode && S.ui.selectedPivot ? S.ui.selectedPivot : null,
  );

  const canAct = currentActionAllowed();
  const cutPoints = S.ui.sliceMode && game.phase === 'playing'
    ? game.getCutPoints()
    : [];
  const cutSet = new Set(cutPoints.map((point) => point.index));
  const selectedIndex = S.ui.selectedPivot
    ? game.indexAt(S.ui.selectedPivot.row, S.ui.selectedPivot.col)
    : -1;
  const winSet = new Set(game.winLine || []);
  const lastMove = game.lastMove;
  const lastIndex = lastMove ? lastMove.index : -1;
  const shouldAnimate =
    animateLast &&
    lastMove?.type === 'place' &&
    S.ui.lastAnimatedMove !== lastMove.n;
  if (shouldAnimate) S.ui.lastAnimatedMove = lastMove.n;

  const cells = $$('.cell', $('board-cells'));
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const cell = cells[row * 9 + col];
      const index = game.indexAt(row, col);
      const color = game.cells[index];
      const used = game.used[index] === 1;
      const isCuttable =
        S.ui.sliceMode &&
        color === S.myColor &&
        game.turn === S.myColor &&
        !used &&
        game.phase === 'playing';
      const isSelected = isCuttable && S.ui.selectedPivot?.row === row && S.ui.selectedPivot?.col === col;
      const isPlayable = canAct && !S.ui.sliceMode && color === EMPTY;
      const isStatic = !canAct || (S.ui.sliceMode && !isCuttable);

      cell.className = 'cell';
      if (isStatic) cell.classList.add('is-static');
      if (isPlayable) cell.classList.add('is-playable');
      if (isCuttable) cell.classList.add('is-cuttable');
      if (isSelected) cell.classList.add('is-cut-selected');
      if (lastIndex === index) cell.classList.add('is-last');
      if (winSet.has(index)) cell.classList.add('is-win');
      cell.setAttribute('aria-disabled', String(!isPlayable && !isCuttable));

      const c = coordOf(index);
      const coordLabel = `${info.uName.toUpperCase()}${c[info.uName]} ${info.vName.toUpperCase()}${c[info.vName]} ${info.axisName.toUpperCase()}${c[info.axisName]}`;
      if (color === EMPTY) {
        cell.replaceChildren();
        if (isPlayable) {
          cell.setAttribute(
            'aria-label',
            `${info.uName.toUpperCase()}${c[info.uName]}，${info.vName.toUpperCase()}${c[info.vName]}，空点，可落子`,
          );
        } else {
          cell.setAttribute('aria-label', `${coordLabel}，空点`);
        }
      } else {
        const stone = stoneNode(color, {
          spent: used,
          animate: shouldAnimate && lastIndex === index,
        });
        cell.replaceChildren(stone);
        let label = `${coordLabel}，${colorName(color)}棋`;
        if (used) label += '，已用作切点';
        if (isCuttable) label += '，可作切点';
        cell.setAttribute('aria-label', label);
      }

      cell.classList.toggle('is-cut-selected', isSelected);
    }
  }

  $('board').style.setProperty(
    '--ghost-border',
    S.myColor === BLACK ? 'rgba(192,241,234,.46)' : 'rgba(255,246,224,.62)',
  );
  $('board').style.setProperty(
    '--ghost-fill',
    S.myColor === BLACK ? 'rgba(15,31,35,.28)' : 'rgba(248,237,216,.22)',
  );

  focusStoredCell();
  $('board-overlay').replaceChildren();
  if (game.winLine) {
    drawWinOverlay();
  } else {
    if (S.ui.crease?.plane === game.plane) drawCreaseOverlay();
    if (S.ui.sliceMode && S.ui.selectedPivot) drawCutPreview(S.ui.selectedPivot);
  }

  const hint = boardHintText();
  safeText($('board-hint'), hint);
  $('board').setAttribute(
    'aria-label',
    `当前切面 ${info.label}，${info.kind}。第 ${game.moveNumber} 手。`,
  );
  if (planeChanged) {
    // Re-draw once the new plane's labels and cells have a laid-out size.
    requestAnimationFrame(() => {
      if (S.game?.plane === game.plane) renderLayerCanvas();
    });
  }
}

function boardHintText() {
  if (!S.game) return '';
  if (
    S.mode === 'online' &&
    S.online.state?.phase === 'abandoned' &&
    S.game.phase === 'playing'
  ) {
    return '对手已离开 · 对局已中止';
  }
  if (S.game.phase !== 'playing') {
    if (S.game.phase === 'won') {
      const hidden = (S.game.winLine || []).some((index) => !S.game.displayOf(index));
      return hidden ? '五连完成 · 完整胜利线在结果图中' : '五连完成 · 三维胜利线已标出';
    }
    return '棋盘暂无合法行动 · 本局判和';
  }
  if (!currentActionAllowed()) {
    return S.mode === 'online'
      ? '等待对手行动 · 右侧层积图会同步所有层'
      : '镜面引擎正在推演 · 观察层积图';
  }
  if (S.ui.sliceMode) {
    if (S.ui.selectedPivot) return '选择横向或纵向切面 · Esc 取消';
    return '点击带青色虚线圈的己方棋子作为切点';
  }
  return '点击空点落子 · 或发动一次切面';
}

function flashBoard() {
  const flash = $('board-flash');
  if (!flash) return;
  flash.classList.remove('is-flashing');
  void flash.offsetWidth;
  flash.classList.add('is-flashing');
}

/* -------------------------------------------------------------------------- */
/* Game metadata / players / status / action dock                             */
/* -------------------------------------------------------------------------- */

function currentActionAllowed() {
  if (!S.game || S.game.phase !== 'playing') return false;
  if (S.ui.busy || S.ui.animating || isModalOpen()) return false;
  if (S.mode === 'ai') {
    return S.game.turn === S.myColor && !S.ai.thinking;
  }
  if (S.mode === 'online') {
    if (S.online.state?.phase !== 'playing') return false;
    if (S.game.turn !== S.myColor) return false;
    if (S.online.actionPending) return false;
    return true;
  }
  return false;
}

function playerColorForSide(side) {
  if (S.mode === 'ai') return side === 'you' ? S.myColor : otherColor(S.myColor);
  const state = S.online.state;
  if (!state) return side === 'you' ? S.myColor : otherColor(S.myColor);
  const seat = state.you?.seat;
  const player = state.players?.find((entry) => (side === 'you' ? entry.seat === seat : entry.seat !== seat));
  return player?.color ?? (side === 'you' ? S.myColor : otherColor(S.myColor));
}

function playerForSide(side) {
  if (S.mode === 'ai') {
    return side === 'you'
      ? { name: '你', color: S.myColor, connected: true, isAI: false }
      : { name: AI_NAME, color: otherColor(S.myColor), connected: true, isAI: true };
  }
  const state = S.online.state;
  const seat = state?.you?.seat;
  const fallbackColor = side === 'you' ? S.myColor : otherColor(S.myColor);
  if (!state) return { name: side === 'you' ? '你' : '对手', color: fallbackColor, connected: false };
  if (side === 'you') {
    return {
      ...(state.you || {}),
      color: state.you?.color ?? fallbackColor,
      connected: Boolean(state.you?.connected),
    };
  }
  if (state.opponent) {
    return {
      ...state.opponent,
      color: state.opponent.color ?? otherColor(fallbackColor),
      connected: Boolean(state.opponent.connected),
    };
  }
  const player = state.players?.find((entry) => entry.seat !== seat);
  return player
    ? { ...player, connected: Boolean(player.connected) }
    : { name: '等待对手', color: otherColor(fallbackColor), connected: false };
}

function countCuts(color) {
  if (!S.game) return 0;
  return S.game.countUnused(color);
}

function updatePlayerCard(side, player) {
  const isYou = side === 'you';
  const prefix = isYou ? 'you' : 'opp';
  const color = player.color ?? (isYou ? S.myColor : otherColor(S.myColor));
  const orb = $(`${prefix}-orb`);
  orb.classList.toggle('is-black', color === BLACK);
  orb.classList.toggle('is-white', color === WHITE);
  safeText(
    $(`${prefix}-role`),
    `${isYou ? '你' : '对手'} · ${colorName(color)}棋${!isYou && S.mode === 'ai' ? ' · AI' : ''}`,
  );

  let name = player.name || (isYou ? '你' : '对手');
  if (S.mode === 'online' && isYou) name = player.name || '你';
  safeText($(`${prefix}-name`), name);

  const cuts = countCuts(color);
  let meta = `切点 ${cuts}`;
  if (!isYou && player.isAI) meta = `${difficultyName(S.aiLevel)} AI · 切点 ${cuts}`;
  if (S.mode === 'online' && player.left) meta = '已离开';
  else if (S.mode === 'online' && player.connected === false && !isYou) meta += ' · 离线';
  safeText($(`${prefix}-meta`), meta);

  const card = $(isYou ? 'player-you' : 'player-opponent');
  card.classList.toggle('is-active', Boolean(S.game && S.game.phase === 'playing' && S.game.turn === color));
  card.classList.toggle('player-you', isYou);
  const lamp = $(`${prefix}-lamp`);
  lamp.hidden = false;
}

function renderPlayers() {
  const you = playerForSide('you');
  const opponent = playerForSide('opponent');
  updatePlayerCard('opponent', opponent);
  updatePlayerCard('you', you);
}

function statusCopy() {
  if (!S.game) {
    return { eyebrow: 'WAITING', text: '正在连接对局…' };
  }
  if (S.game.phase === 'won') {
    return {
      eyebrow: 'GAME OVER',
      text: `${colorName(S.game.winner)}棋五连 · 对局结束`,
    };
  }
  if (S.game.phase === 'draw') {
    return { eyebrow: 'DRAW', text: '没有合法行动 · 本局判和' };
  }
  if (S.online.state?.phase === 'abandoned') {
    return { eyebrow: 'ROOM CLOSED', text: '对手已离开 · 对局中止' };
  }
  const myTurn = S.game.turn === S.myColor;
  if (!myTurn) {
    if (S.mode === 'ai') {
      return { eyebrow: 'AI THINKING', text: `${AI_NAME} 正在推演…` };
    }
    const opponent = playerForSide('opponent');
    return { eyebrow: 'OPPONENT', text: `等待 ${opponent.name || '对手'} 行动…` };
  }
  if (S.ui.sliceMode) {
    return {
      eyebrow: S.ui.selectedPivot ? 'CUT READY' : 'CUT MODE',
      text: S.ui.selectedPivot ? '选择切面方向' : '选择一枚棋子作为切点',
    };
  }
  return { eyebrow: 'YOUR TURN', text: '轮到你 · 落子或切面' };
}

function renderStatusAndDock() {
  if (!S.game) return;
  const copy = statusCopy();
  safeText($('status-eyebrow'), copy.eyebrow);
  safeText($('status-text'), copy.text);

  const canAct = currentActionAllowed();
  const myTurn = S.game.turn === S.myColor;
  const gameOver = S.game.phase !== 'playing';
  const canPressCut = gameOver || canAct;
  const dock = $('action-dock');
  dock.classList.toggle('is-active', canAct);
  dock.classList.toggle('is-slice-mode', S.ui.sliceMode);

  const cutPoints = S.game.phase === 'playing' ? S.game.getCutPoints() : [];
  const onPlaneCount = myTurn ? cutPoints.length : 0;
  const totalCount = countCuts(S.myColor);
  const cutButton = $('cut-button');
  const cutLabel = $('cut-label');
  const cutCount = $('cut-count');
  const cutIcon = cutButton.querySelector('use');
  let showChooser = false;
  const abandoned =
    S.mode === 'online' && S.online.state?.phase === 'abandoned';

  if (gameOver) {
    safeText($('dock-eyebrow'), 'GAME OVER');
    safeText($('dock-title'), '对局已经结束');
    safeText($('dock-sub'), '查看结果，或回到棋盘复盘三维胜利线。');
    cutButton.disabled = false;
    cutLabel.textContent = '查看结果';
    cutCount.hidden = true;
    cutIcon?.setAttribute('href', '#i-refresh');
    showChooser = false;
  } else if (abandoned) {
    safeText($('dock-eyebrow'), 'ROOM CLOSED');
    safeText($('dock-title'), '对局已经中止');
    safeText($('dock-sub'), '对手已经离开房间。留下可以复盘棋盘，或返回首页开始新对局。');
    cutButton.disabled = true;
    cutLabel.textContent = '对手已离开';
    cutCount.hidden = true;
    cutIcon?.setAttribute('href', '#i-door');
    showChooser = false;
  } else if (!myTurn) {
    safeText($('dock-eyebrow'), S.mode === 'ai' ? 'MIRROR ENGINE' : 'OPPONENT MOVE');
    safeText(
      $('dock-title'),
      S.mode === 'ai' ? `${AI_NAME} 正在推演` : `等待 ${playerForSide('opponent').name || '对手'}`,
    );
    safeText(
      $('dock-sub'),
      S.mode === 'ai'
        ? 'AI 会同时评估当前切面与跨切面的五连。'
        : '对手行动后，棋盘会自动同步到你的切面。',
    );
    cutButton.disabled = true;
    cutLabel.textContent = '发动切面';
    cutCount.hidden = false;
    cutCount.textContent = String(totalCount);
    cutIcon?.setAttribute('href', '#i-cut');
  } else if (S.ui.sliceMode) {
    safeText($('dock-eyebrow'), 'CUT MODE');
    safeText(
      $('dock-title'),
      S.ui.selectedPivot ? '选择切面方向' : '选择切点',
    );
    safeText(
      $('dock-sub'),
      S.ui.selectedPivot
        ? '棋盘会绕切痕翻转 90°，随后由对手先在新切面落子。'
        : '点击带青色虚线圈的己方棋子。切点整局只能使用一次。',
    );
    cutButton.disabled = !canAct;
    cutLabel.textContent = S.ui.selectedPivot ? '重新选择' : '退出切面';
    cutCount.hidden = false;
    cutCount.textContent = String(onPlaneCount);
    cutIcon?.setAttribute('href', '#i-cut');
    showChooser = Boolean(S.ui.selectedPivot) && canAct;
  } else {
    safeText($('dock-eyebrow'), 'YOUR ACTION');
    safeText($('dock-title'), '轮到你行动');
    safeText($('dock-sub'), '在空点落子，或消耗一枚棋子发动一次切面。');
    cutButton.disabled = !canPressCut || onPlaneCount === 0;
    cutLabel.textContent = onPlaneCount > 0 ? '发动切面' : '当前面无可切棋子';
    cutCount.hidden = onPlaneCount === 0;
    cutCount.textContent = String(onPlaneCount);
    cutIcon?.setAttribute('href', '#i-cut');
  }

  $('slice-chooser').hidden = !showChooser;
  if (showChooser && S.ui.selectedPivot) {
    const { row, col } = S.ui.selectedPivot;
    const horizontal = sliceTarget(S.game.plane, row, col, 'h');
    const vertical = sliceTarget(S.game.plane, row, col, 'v');
    safeText($('dir-h-label'), `→ ${horizontal.targetLabel} 切面`);
    safeText($('dir-v-label'), `→ ${vertical.targetLabel} 切面`);
  }

  $('dir-h').classList.toggle('is-hover', S.ui.hoverDirection === 'h');
  $('dir-v').classList.toggle('is-hover', S.ui.hoverDirection === 'v');

  safeText($('tip-text'), tipCopy());
  $('slice-chooser').hidden = !showChooser;
  document.body.classList.toggle('is-choosing-cut', showChooser);
}

function tipCopy() {
  if (!S.game) return '落子或切面，一回合只能做一件事。';
  if (S.game.phase !== 'playing') {
    return '结果卡里的三维图会显示完整的五连，包括不在当前切面上的棋子。';
  }
  if (S.ui.sliceMode) {
    return '切点整局限用一次。新切面中的第一手由对手落下，所以切面也是一次节奏交换。';
  }
  if (S.mode === 'online' && S.online.state?.phase === 'abandoned') {
    return '对手已经离开。棋盘会保留，方便你复盘刚才的三维战场。';
  }
  return '切面会消耗一枚棋子作为切点。那枚棋子仍参与五连，但整局不能再切。';
}

function renderGameMeta() {
  if (!S.game) return;
  const info = S.game.planeInfo;
  safeText($('plane-label'), info.label);
  safeText($('plane-kind'), info.kind);
  safeText($('plane-axes'), `${info.uName.toUpperCase()} × ${info.vName.toUpperCase()}`);
  safeText($('board-round'), `第 ${Math.max(1, S.round)} 局`);
  $('axis-cube').dataset.axis = info.axisName;
  safeText($('space-plane'), info.label);
  safeText($('space-axes'), `${info.uName.toUpperCase()} × ${info.vName.toUpperCase()}`);
  safeText($('space-count'), '9 层');
  updateHeaderContext();
}

/* -------------------------------------------------------------------------- */
/* Space map / log                                                            */
/* -------------------------------------------------------------------------- */

function renderLayerCanvas() {
  if (!S.game || S.screen !== 'game') return;
  const info = S.game.planeInfo;
  const winSet = new Set(S.game.winLine || []);
  const lastIndex = S.game.lastMove?.index ?? -1;
  for (let value = 0; value < 9; value += 1) {
    const plane = info.axis * 9 + value;
    const canvas = S.ui.layerCanvases[value];
    const layer = S.ui.layerNodes[value];
    if (!canvas || !layer) continue;
    layer.classList.toggle('is-current', plane === S.game.plane);
    const label = layer.querySelector('.layer-label');
    if (label) label.textContent = `${info.axisName.toUpperCase()}${value}`;
    drawLayer(canvas, plane, winSet, lastIndex);
    let black = 0;
    let white = 0;
    // Count stones for accessible labels without depending on the board's
    // current plane orientation.
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const index = planeCellFor(plane, row, col);
        if (S.game.cells[index] === BLACK) black += 1;
        else if (S.game.cells[index] === WHITE) white += 1;
      }
    }
    layer.setAttribute(
      'aria-label',
      `${info.axisName.toUpperCase()}=${value} 切面，黑棋 ${black} 枚，白棋 ${white} 枚${plane === S.game.plane ? '，当前切面' : ''}`,
    );
  }
}

// Engine helper kept local so the render loop doesn't need to know plane layout.
function planeCellFor(plane, row, col) {
  const info = planeInfo(plane);
  const p = [0, 0, 0];
  p[info.axis] = info.value;
  p[info.u] = col;
  p[info.v] = row;
  return p[0] + 9 * p[1] + 81 * p[2];
}

function drawLayer(canvas, plane, winSet, lastIndex) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const cell = rect.width / 9;

  ctx.save();
  ctx.strokeStyle = 'rgba(227, 184, 111, 0.14)';
  ctx.lineWidth = 0.55;
  for (let i = 0; i < 9; i += 1) {
    const p = (i + 0.5) * cell;
    ctx.beginPath();
    ctx.moveTo(p, cell * 0.5);
    ctx.lineTo(p, rect.height - cell * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cell * 0.5, p);
    ctx.lineTo(rect.width - cell * 0.5, p);
    ctx.stroke();
  }
  ctx.restore();

  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const index = planeCellFor(plane, row, col);
      const color = S.game.cells[index];
      if (!color) continue;
      const x = (col + 0.5) * cell;
      const y = (row + 0.5) * cell;
      const radius = cell * 0.29;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (color === BLACK) {
        ctx.fillStyle = '#0a1114';
        ctx.fill();
        ctx.strokeStyle = 'rgba(178, 224, 218, 0.3)';
      } else {
        ctx.fillStyle = '#e9dfcd';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 249, 235, 0.35)';
      }
      ctx.lineWidth = 0.7;
      ctx.stroke();

      if (S.game.used[index]) {
        ctx.strokeStyle = 'rgba(126, 231, 216, 0.8)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x - radius * 0.55, y + radius * 0.5);
        ctx.lineTo(x + radius * 0.45, y - radius * 0.6);
        ctx.stroke();
      }
      if (winSet.has(index)) {
        ctx.strokeStyle = 'rgba(240, 196, 116, 0.95)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(x, y, radius + 1.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (index === lastIndex) {
        ctx.strokeStyle = 'rgba(227, 184, 111, 0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, radius + 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

function renderSpace() {
  if (!S.game) return;
  renderLayerCanvas();
}

function moveText(move) {
  if (!move) return '';
  if (move.type === 'place') {
    return `落子 ${move.planeLabel || ''} · ${move.x},${move.y},${move.z}`;
  }
  return `${move.direction === 'h' ? '横向切' : '纵向切'} ${move.fromLabel} → ${move.toLabel}`;
}

function renderLog() {
  if (!S.game) return;
  const list = $('move-log');
  const moves = S.game.moves || [];
  list.replaceChildren();
  for (const move of moves) {
    const item = document.createElement('li');
    item.className = `move-item${move.type === 'slice' ? ' is-cut' : ''}`;
    const num = document.createElement('span');
    num.className = 'move-num';
    num.textContent = String(move.n).padStart(2, '0');
    const dot = document.createElement('span');
    dot.className = `move-dot ${move.color === BLACK ? 'black' : 'white'}`;
    const text = document.createElement('span');
    text.className = 'move-text';
    const description = moveText(move);
    if (move.type === 'slice') {
      const emphasis = document.createElement('em');
      emphasis.textContent = description;
      text.append(emphasis);
    } else {
      text.textContent = description;
    }
    item.append(num, dot, text);
    list.append(item);
  }
  safeText($('move-total'), `${moves.length} 手`);
  $('log-empty').hidden = moves.length > 0;
  if (moves.length > S.ui.logLength) {
    list.scrollTop = list.scrollHeight;
  }
  S.ui.logLength = moves.length;
}

function renderAll({ animateLast = false } = {}) {
  if (!S.game) return;
  renderGameMeta();
  renderBoard({ animateLast });
  renderPlayers();
  renderStatusAndDock();
  renderSpace();
  renderLog();
  updateConnectionUI();
}

/* -------------------------------------------------------------------------- */
/* Slice interaction                                                          */
/* -------------------------------------------------------------------------- */

function clearSliceMode() {
  S.ui.sliceMode = false;
  S.ui.selectedPivot = null;
  S.ui.hoverDirection = null;
  $('slice-chooser').hidden = true;
  document.body.classList.remove('is-choosing-cut');
  if (S.game) {
    renderBoard();
    renderStatusAndDock();
  }
}

function enterSliceMode() {
  if (!currentActionAllowed() || !S.game) return;
  const points = S.game.getCutPoints();
  if (points.length === 0) {
    toast('当前切面上没有可用切点了，先落一子吧。', 'error');
    return;
  }
  S.ui.sliceMode = true;
  S.ui.selectedPivot = null;
  S.ui.hoverDirection = null;
  Sound.select();
  renderBoard();
  renderStatusAndDock();
  const first = points[0];
  if (first) {
    S.ui.focusRow = first.row;
    S.ui.focusCol = first.col;
    focusStoredCell();
  }
  announce('切面模式。请选择一枚己方棋子作为切点。');
}

function handleCutButton() {
  if (!S.game) return;
  if (S.game.phase !== 'playing') {
    if (S.game.over) showResultModal();
    return;
  }
  if (!currentActionAllowed()) return;
  if (S.ui.sliceMode) {
    if (S.ui.selectedPivot) {
      S.ui.selectedPivot = null;
      S.ui.hoverDirection = null;
      renderBoard();
      renderStatusAndDock();
      announce('已取消切面方向，请重新选择切点。');
    } else {
      clearSliceMode();
      announce('已退出切面模式。');
    }
    return;
  }
  enterSliceMode();
}

function choosePivot(row, col) {
  if (!S.game || !S.ui.sliceMode || !currentActionAllowed()) return;
  const index = S.game.indexAt(row, col);
  const color = S.game.cells[index];
  if (color !== S.game.turn || S.game.used[index]) {
    toast('请选择一枚属于你、且没有裂痕的棋子。', 'error', 1800);
    return;
  }
  if (S.ui.selectedPivot?.row === row && S.ui.selectedPivot?.col === col) {
    S.ui.selectedPivot = null;
    S.ui.hoverDirection = null;
    renderBoard();
    renderStatusAndDock();
    return;
  }
  S.ui.selectedPivot = { row, col };
  S.ui.focusRow = row;
  S.ui.focusCol = col;
  S.ui.hoverDirection = null;
  Sound.select();
  renderBoard();
  renderStatusAndDock();
  announce('已选择切点。请选择横向切或纵向切。');
}

async function chooseDirection(direction) {
  if (!S.game || !S.ui.selectedPivot || !S.ui.sliceMode) return;
  if (!currentActionAllowed()) return;
  const { row, col } = S.ui.selectedPivot;
  S.ui.hoverDirection = null;
  if (S.mode === 'ai') {
    await executeLocalAction({ type: 'slice', row, col, direction }, 'human');
  } else if (S.mode === 'online') {
    await sendOnlineAction({ type: 'slice', row, col, direction });
  }
}

/* -------------------------------------------------------------------------- */
/* Local game / AI                                                            */
/* -------------------------------------------------------------------------- */

function cleanupLocalGame() {
  S.ai.requestId += 1;
  S.ai.thinking = false;
  clearTimeout(S.ai.timer);
  S.ai.timer = null;
  clearTimeout(S.ui.resultTimer);
  S.ui.resultTimer = null;
  S.ui.lastAnimatedMove = 0;
  S.ui.logLength = 0;
  S.ui.crease = null;
  S.ui.sliceMode = false;
  S.ui.selectedPivot = null;
  S.ui.hoverDirection = null;
  S.ui.busy = false;
  S.ui.animating = false;
  S.ui.resultRoundKey = null;
  S.ui.resultOpen = false;
  $('slice-chooser').hidden = true;
  document.body.classList.remove('is-choosing-cut');
  $('board-stage').classList.remove('is-slicing');
  const board = $('board');
  if (board) {
    try {
      for (const animation of board.getAnimations()) animation.cancel();
    } catch {
      // WAAPI unavailable — the inline reset below is still enough.
    }
    board.style.transform = '';
    board.style.transformOrigin = '';
  }
}

function startAiGame({ swapSides = false } = {}) {
  stopAiWorkerRequest();
  cleanupLocalGame();
  closeModals({ restoreFocus: false });
  clearToasts();
  closeOnlineStream({ clearToken: false, clearUrl: false, silent: true });
  S.mode = 'ai';
  S.online.state = null;
  S.myColor = swapSides ? WHITE : BLACK;
  const nextRound = S.game?.over && S.round > 0 ? S.round + 1 : 1;
  S.round = nextRound;
  S.ai.gameId += 1;
  S.game = new Game();
  S.ui.resultRoundKey = null;
  S.ui.resultOpen = false;
  S.ui.focusRow = 4;
  S.ui.focusCol = 4;
  S.ui.boardPlane = null;
  S.ui.lastAnimatedMove = 0;
  S.ui.logLength = 0;
  $('slice-chooser').hidden = true;
  clearRoomUrl();
  setScreen('game');
  renderAll();
  updateHeaderContext();
  announce(`人机对局开始。你执${colorName(S.myColor)}棋。${S.myColor === BLACK ? '你先手。' : 'AI 先手。'}`);
  if (S.game.turn !== S.myColor) {
    scheduleAiMove(650);
  } else {
    focusStoredCell();
  }
  updateHeaderContext();
}

function showResultSoon(delay = 760) {
  if (S.ui.resultOpen || S.ui.resultRoundKey) return;
  clearTimeout(S.ui.resultTimer);
  S.ui.resultTimer = setTimeout(() => {
    if (S.screen !== 'game' || !S.game?.over) return;
    // The player may have opened and dismissed the result card manually
    // while this timer was pending. Never force it back open.
    if (S.ui.resultRoundKey) return;
    showResultModal();
  }, delay);
}

async function executeLocalAction(action, actor = 'human') {
  if (!S.game || S.game.phase !== 'playing') return false;
  if (actor === 'human' && !currentActionAllowed()) return false;
  if (actor === 'ai' && (S.mode !== 'ai' || S.game.turn === S.myColor)) return false;

  const previous = S.game.clone();
  let move;
  try {
    move = S.game.applyAction(action);
  } catch (error) {
    if (actor === 'human') {
      toast(error.message || '这一步无法执行。', 'error');
      Sound.error();
      renderStatusAndDock();
    } else {
      S.ai.thinking = false;
      S.ui.busy = false;
      renderStatusAndDock();
    }
    return false;
  }

  S.ai.thinking = false;
  clearTimeout(S.ai.timer);
  S.ai.timer = null;
  S.ui.sliceMode = false;
  S.ui.selectedPivot = null;
  S.ui.hoverDirection = null;
  S.ui.busy = true;

  if (move.type === 'slice') {
    // Close the direction sheet immediately; the flip itself is the feedback.
    $('slice-chooser').hidden = true;
    document.body.classList.remove('is-choosing-cut');
    renderStatusAndDock();
    await playSliceTransition(previous, S.game, move);
    S.ui.busy = false;
    renderAll();
  } else {
    S.ui.busy = false;
    renderAll({ animateLast: true });
    Sound.stone();
  }

  announce(
    `${move.color === S.myColor ? '你' : AI_NAME}${move.type === 'slice' ? `发动了${move.direction === 'h' ? '横向' : '纵向'}切面，进入 ${move.toLabel}` : `在 ${move.x},${move.y},${move.z} 落子`}`,
  );

  if (S.game.phase !== 'playing') {
    S.ai.thinking = false;
    if (S.game.phase === 'won') {
      setTimeout(() => {
        if (S.game?.winner === S.myColor) Sound.win();
        else Sound.lose();
      }, 260);
    }
    showResultSoon(850);
    updateHeaderContext();
    return true;
  }

  if (S.game.turn !== S.myColor) {
    scheduleAiMove(440);
  } else {
    focusStoredCell();
  }
  updateHeaderContext();
  return true;
}

function playSliceTransition(previous, next, move, { onMidpoint } = {}) {
  return new Promise((resolve) => {
    const board = $('board');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const row = Number.isInteger(move?.row) ? move.row : 4;
    const col = Number.isInteger(move?.col) ? move.col : 4;
    const horizontal = move?.direction === 'h';
    const origin = horizontal
      ? `50% ${((row + 0.5) / 9) * 100}%`
      : `${((col + 0.5) / 9) * 100}% 50%`;

    S.ui.animating = true;
    S.ui.busy = true;
    $('board-stage').classList.add('is-slicing');
    Sound.cut();
    flashBoard();

    if (reduce) {
      S.game = next;
      S.ui.crease = creaseForMove(move);
      S.ui.boardPlane = null;
      renderAll();
      onMidpoint?.();
      S.ui.animating = false;
      $('board-stage').classList.remove('is-slicing');
      resolve();
      return;
    }

    board.style.transformOrigin = origin;
    let first;
    try {
      first = board.animate(
        [
          { transform: 'rotateX(0deg) rotateY(0deg) scale(1)', filter: 'brightness(1)' },
          {
            transform: horizontal
              ? 'rotateX(-88deg) scale(.985)'
              : 'rotateY(88deg) scale(.985)',
            filter: 'brightness(.64)',
          },
        ],
        {
          duration: 260,
          easing: 'cubic-bezier(.55,0,.85,.4)',
          fill: 'forwards',
        },
      );
    } catch {
      first = null;
    }

    const midpoint = () => {
      S.game = next;
      S.ui.crease = creaseForMove(move);
      S.ui.boardPlane = null;
      renderAll();
      flashBoard();
      onMidpoint?.();
    };

    if (!first) {
      midpoint();
      board.style.transformOrigin = '';
      S.ui.animating = false;
      $('board-stage').classList.remove('is-slicing');
      resolve();
      return;
    }

    first.finished
      .catch(() => {})
      .then(() => {
        midpoint();
        let second;
        try {
          second = board.animate(
            [
              {
                transform: horizontal
                  ? 'rotateX(88deg) scale(.985)'
                  : 'rotateY(-88deg) scale(.985)',
                filter: 'brightness(.64)',
              },
              { transform: 'rotateX(0deg) rotateY(0deg) scale(1)', filter: 'brightness(1)' },
            ],
            {
              duration: 310,
              easing: 'cubic-bezier(.18,.7,.22,1)',
              fill: 'forwards',
            },
          );
        } catch {
          second = null;
        }
        const finish = () => {
          try {
            first.cancel();
            second?.cancel();
          } catch {
            // Already finished.
          }
          board.style.transformOrigin = '';
          board.style.transform = '';
          $('board-stage').classList.remove('is-slicing');
          S.ui.animating = false;
          resolve();
        };
        if (!second) finish();
        else second.finished.catch(() => {}).then(finish);
      });
  });
}

function creaseForMove(move) {
  if (!move || move.type !== 'slice') return null;
  try {
    const cells = creaseCells(move.fromPlane, move.toPlane);
    return { plane: move.toPlane, cells };
  } catch {
    return null;
  }
}

/* ---------------------------------- AI ----------------------------------- */

function stopAiWorkerRequest() {
  S.ai.requestId += 1;
  clearTimeout(S.ai.timer);
  S.ai.timer = null;
  S.ai.thinking = false;
}

function ensureAiWorker() {
  if (S.ai.worker) return S.ai.worker;
  if (S.ai.workerBroken) return null;
  try {
    const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', handleAiWorkerMessage);
    worker.addEventListener('error', () => {
      S.ai.workerBroken = true;
      if (S.ai.worker) {
        S.ai.worker.terminate();
        S.ai.worker = null;
      }
      // If a request was pending, retry in the main thread.
      if (S.ai.thinking && S.mode === 'ai' && S.game && S.game.phase === 'playing') {
        const requestId = S.ai.requestId;
        S.ai.thinking = false;
        scheduleAiMove(20, { forceFallback: true, requestId });
      }
    });
    S.ai.worker = worker;
    return worker;
  } catch {
    S.ai.workerBroken = true;
    return null;
  }
}

function handleAiWorkerMessage(event) {
  const { id, action, error } = event.data || {};
  if (id !== S.ai.requestId || S.mode !== 'ai' || !S.ai.thinking) return;
  if (error) {
    S.ai.thinking = false;
    runAiFallback();
    return;
  }
  finishAiSelection(action);
}

function finishAiSelection(action) {
  if (S.mode !== 'ai' || !S.game) return;
  const elapsed = Date.now() - (S.ai.startedAt || Date.now());
  const delay = Math.max(0, 390 - elapsed);
  clearTimeout(S.ai.timer);
  S.ai.timer = setTimeout(async () => {
    if (S.mode !== 'ai' || !S.game || S.game.phase !== 'playing') return;
    if (S.game.turn === S.myColor) return;
    S.ai.thinking = false;
    if (!action) {
      const legal = S.game.getLegalActions();
      action = legal[0] ? toEngineAction(legal[0]) : null;
    }
    if (!action) return;
    await executeLocalAction(action, 'ai');
  }, delay);
}

function toEngineAction(action) {
  if (!action) return null;
  if (action.type === 'place') return { type: 'place', row: action.row, col: action.col };
  return { type: 'slice', row: action.row, col: action.col, direction: action.direction };
}

function scheduleAiMove(delay = 420, { forceFallback = false, requestId: forcedId = null } = {}) {
  if (S.mode !== 'ai' || !S.game || S.game.phase !== 'playing') return;
  if (S.game.turn === S.myColor) return;
  stopAiWorkerRequest();
  const requestId = forcedId ?? S.ai.requestId;
  S.ai.requestId = requestId;
  S.ai.thinking = true;
  S.ui.busy = true;
  S.ai.startedAt = Date.now();
  S.ai.pendingSnapshot = S.game.snapshot();
  renderStatusAndDock();
  updateHeaderContext();

  const start = () => {
    if (S.mode !== 'ai' || !S.game || S.game.phase !== 'playing' || S.game.turn === S.myColor) return;
    if (S.ai.requestId !== requestId) return;
    const worker = forceFallback ? null : ensureAiWorker();
    if (worker) {
      try {
        worker.postMessage({
          id: requestId,
          snapshot: S.ai.pendingSnapshot,
          difficulty: S.aiLevel,
          timeLimit: AI_LEVELS[S.aiLevel].timeLimit,
        });
      } catch {
        S.ai.workerBroken = true;
        runAiFallback(requestId);
      }
    } else {
      runAiFallback(requestId);
    }
  };

  clearTimeout(S.ai.timer);
  if (delay > 0) {
    S.ai.timer = setTimeout(start, delay);
  } else {
    start();
  }
}

async function runAiFallback(requestId = S.ai.requestId) {
  if (S.mode !== 'ai' || !S.game || S.game.phase !== 'playing') return;
  S.ai.thinking = true;
  renderStatusAndDock();
  try {
    const { chooseAction } = await import('./ai.js');
    if (S.ai.requestId !== requestId || S.mode !== 'ai' || !S.game) return;
    const snapshot = S.game.snapshot();
    await sleep(30);
    const action = chooseAction(snapshot, {
      difficulty: S.aiLevel,
      timeLimit: AI_LEVELS[S.aiLevel].timeLimit,
    });
    if (S.ai.requestId !== requestId) return;
    finishAiSelection(action);
  } catch {
    S.ai.thinking = false;
    S.ui.busy = false;
    toast('AI 思考失败，已自动选择一步。', 'error');
    const legal = S.game.getLegalActions();
    if (legal.length) await executeLocalAction(toEngineAction(legal[0]), 'ai');
  }
}

function resetAiForLeave() {
  stopAiWorkerRequest();
  S.ai.pendingSnapshot = null;
}

/* -------------------------------------------------------------------------- */
/* Online room / SSE                                                          */
/* -------------------------------------------------------------------------- */

function setRoomUrl(code) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.history.replaceState({}, '', url);
  } catch {
    // file:// or restricted history — ignore.
  }
}

function clearRoomUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
  } catch {
    // Ignore.
  }
}

function inviteLink(code = S.online.code) {
  if (!code) return '';
  try {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    return url.toString();
  } catch {
    return `${window.location.origin}${window.location.pathname}?room=${code}`;
  }
}

async function copyInvite(code = S.online.code) {
  const link = inviteLink(code);
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制。', 'info');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = link;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      toast('邀请链接已复制。', 'info');
    } catch {
      toast(`邀请链接：${link}`, 'gold', 6000);
    } finally {
      textarea.remove();
    }
  }
  const copyButton = $('copy-invite');
  if (copyButton) {
    const span = copyButton.querySelector('span');
    if (span) {
      const original = span.textContent;
      span.textContent = '已复制';
      setTimeout(() => {
        span.textContent = original;
      }, 1400);
    }
  }
}

function openRoomStream() {
  closeRoomStreamOnly();
  if (!S.online.code || !S.online.token) return;
  if (!('EventSource' in window)) {
    S.online.pollTimer = setInterval(() => resyncOnline(), 2500);
    return;
  }
  const url = `/api/rooms/${encodeURIComponent(S.online.code)}/stream?token=${encodeURIComponent(S.online.token)}`;
  const source = new EventSource(url);
  S.online.stream = source;
  S.online.streamDown = false;
  source.addEventListener('open', () => {
    S.online.streamDown = false;
    updateConnectionUI();
  });
  source.addEventListener('state', (event) => {
    S.online.streamDown = false;
    try {
      const state = JSON.parse(event.data);
      receiveOnlineState(state);
    } catch {
      // A truncated event is harmless; the next state resend is full.
    }
  });
  source.addEventListener('error', () => {
    if (S.online.stream !== source) return;
    S.online.streamDown = true;
    updateConnectionUI();
    scheduleResync();
  });
}

function closeRoomStreamOnly() {
  if (S.online.stream) {
    try {
      S.online.stream.close();
    } catch {
      // Ignore.
    }
    S.online.stream = null;
  }
  clearInterval(S.online.pollTimer);
  S.online.pollTimer = null;
  clearTimeout(S.online.reconnectTimer);
  S.online.reconnectTimer = null;
  clearTimeout(S.online.resyncTimer);
  S.online.resyncTimer = null;
}

function closeOnlineStream({ clearToken = true, clearUrl = true, silent = false } = {}) {
  closeRoomStreamOnly();
  if (clearToken && S.online.code) store.remove(seatKey(S.online.code));
  if (clearUrl) clearRoomUrl();
  S.online.code = null;
  S.online.token = null;
  S.online.seat = null;
  S.online.state = null;
  S.online.queue = [];
  S.online.processing = false;
  S.online.lastQueuedSeq = -1;
  S.online.lastSeq = 0;
  S.online.actionPending = false;
  S.online.streamDown = false;
  S.online.lastOpponentConnected = null;
  S.online.lastPhase = null;
  S.online.noticeKey = null;
  S.online.rematchPending = false;
  S.online.leaving = false;
  if (!silent) updateConnectionUI();
}

function scheduleResync() {
  clearTimeout(S.online.resyncTimer);
  S.online.resyncTimer = setTimeout(() => {
    resyncOnline();
  }, 1600);
}

async function resyncOnline() {
  if (!S.online.code || !S.online.token) return;
  const code = S.online.code;
  const token = S.online.token;
  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`,
      { timeout: 8000 },
    );
    if (S.online.code !== code) return;
    receiveOnlineState(data.state);
  } catch (error) {
    if (S.online.code !== code) return;
    if (error.status === 404 || error.status === 403) {
      handleLostRoom(error.message);
    } else {
      scheduleResync();
    }
  }
}

function receiveOnlineState(state) {
  if (!state || !S.online.code || state.code !== S.online.code) return;
  if (!Number.isFinite(state.seq)) state.seq = 0;
  if (state.seq <= S.online.lastQueuedSeq) {
    return;
  }
  S.online.lastQueuedSeq = state.seq;
  S.online.queue.push(state);
  processOnlineQueue();
}

async function processOnlineQueue() {
  if (S.online.processing) return;
  S.online.processing = true;
  try {
    while (S.online.queue.length) {
      const state = S.online.queue.shift();
      try {
        await applyOnlineState(state);
      } catch (error) {
        console.error(error);
        toast('同步对局时出现异常，正在重新连接…', 'error');
        scheduleResync();
      }
    }
  } finally {
    S.online.processing = false;
    S.online.actionPending = false;
    S.ui.busy = false;
    if (S.game) {
      renderPlayers();
      renderStatusAndDock();
      updateConnectionUI();
      // Do not rebuild the board while a stone-drop animation is running.
      // Presence-only updates can otherwise leave the board classes a beat
      // behind, so repair them only when nothing is animating.
      const hasDroppingStone = Boolean($('board-cells')?.querySelector('.stone-enter'));
      if (!S.ui.animating && !hasDroppingStone) renderBoard();
    }
  }
}

async function applyOnlineState(state) {
  if (!state || state.code !== S.online.code) return;
  const previous = S.online.state;
  const previousPhase = previous?.phase ?? null;
  const previousRound = previous?.round ?? 0;
  S.online.state = state;
  S.online.lastSeq = state.seq;
  S.myColor = state.you?.color ?? S.myColor;
  const nextRound = state.round;

  maybeConnectionToasts(previous, state);

  if (state.phase === 'lobby') {
    S.round = nextRound;
    S.online.actionPending = false;
    S.ui.busy = false;
    updateHeaderContext();
    renderLobby(state);
    setScreen('lobby');
    updateConnectionUI();
    return;
  }

  if (state.phase === 'abandoned') {
    S.round = nextRound;
    S.online.actionPending = false;
    S.ui.busy = false;
    S.ui.sliceMode = false;
    S.ui.selectedPivot = null;
    S.ui.hoverDirection = null;
    clearTimeout(S.ui.resultTimer);
    S.ui.resultTimer = null;
    if (state.game) {
      try {
        const next = Game.fromSnapshot(state.game);
        S.game = next;
      } catch {
        // Keep the old board if a snapshot is malformed.
      }
    }
    if (S.screen !== 'game' && state.game) {
      setScreen('game');
      renderAll();
    } else {
      renderBoard();
      renderPlayers();
      renderStatusAndDock();
    }
    updateConnectionUI();
    updateHeaderContext();
    showAbandonedNotice(state);
    return;
  }

  if (!state.game) {
    S.online.actionPending = false;
    return;
  }

  let nextGame;
  try {
    nextGame = Game.fromSnapshot(state.game);
  } catch (error) {
    toast('对局数据读取失败。', 'error');
    return;
  }

  const prevGame = S.game;
  const newRound =
    state.round !== previousRound ||
    !prevGame ||
    S.screen !== 'game';

  if (newRound) {
    S.round = nextRound;
    S.game = nextGame;
    S.ui.sliceMode = false;
    S.ui.selectedPivot = null;
    S.ui.hoverDirection = null;
    S.ui.busy = false;
    S.ui.animating = false;
    S.ui.crease = null;
    S.ui.lastAnimatedMove = 0;
    S.ui.logLength = 0;
    S.ui.focusRow = 4;
    S.ui.focusCol = 4;
    S.ui.boardPlane = null;
    clearTimeout(S.ui.resultTimer);
    S.ui.resultTimer = null;
    S.ui.resultRoundKey = null;
    S.ui.resultOpen = false;
    S.online.actionPending = false;
    S.ui.busy = false;
    closeModals({ restoreFocus: false });
    clearToasts();
    if (state.phase === 'playing') {
      // A fresh rematch or the first game.
      const rematch = previousRound > 0 && state.round > previousRound;
      if (rematch) toast(`第 ${state.round} 局 · 先后手已交换`, 'gold');
      else announce('对局开始。');
    }
    setScreen('game');
    renderAll();
    if (state.phase === 'finished') {
      showOnlineResultSoon(500);
    }
    S.online.lastPhase = state.phase;
    updateHeaderContext();
    updateConnectionUI();
    return;
  }

  const prevMoveNumber = prevGame.moveNumber;
  const lastMove = state.game.lastMove;
  if (nextGame.moveNumber === prevMoveNumber + 1 && lastMove) {
    S.online.actionPending = false;
    // Any applied move ends the local cut-selection flow. In particular, an
    // online slice changes the plane; keeping the old pivot would make the
    // sheet reappear on a completely different board.
    S.ui.sliceMode = false;
    S.ui.selectedPivot = null;
    S.ui.hoverDirection = null;
    document.body.classList.remove('is-choosing-cut');
    if (lastMove.type === 'slice') {
      await playSliceTransition(prevGame, nextGame, lastMove);
      S.ui.busy = false;
      renderAll();
    } else {
      S.game = nextGame;
      S.ui.busy = false;
      renderAll({ animateLast: true });
      Sound.stone();
      announce(
        `${lastMove.color === S.myColor ? '你' : '对手'}在 ${lastMove.x},${lastMove.y},${lastMove.z} 落子。`,
      );
    }
  } else if (nextGame.moveNumber !== prevMoveNumber) {
    S.game = nextGame;
    S.online.actionPending = false;
    S.ui.busy = false;
    S.ui.sliceMode = false;
    S.ui.selectedPivot = null;
    S.ui.hoverDirection = null;
    document.body.classList.remove('is-choosing-cut');
    renderAll();
  } else {
    S.game = nextGame;
    renderPlayers();
    renderStatusAndDock();
    updateConnectionUI();
  }

  S.round = nextRound;
  S.online.lastPhase = state.phase;
  if (state.phase === 'finished') {
    S.ui.resultOpen = S.ui.resultOpen && S.ui.resultRoundKey === `${S.online.code}:${state.round}`;
    if (previousPhase !== 'finished') {
      const won = state.game?.winner === S.myColor;
      setTimeout(() => {
        if (S.mode !== 'online') return;
        if (state.game?.winner === EMPTY) return;
        if (won) Sound.win();
        else Sound.lose();
      }, 320);
    }
    showOnlineResultSoon(620);
    updateOnlineRematchUi();
  } else {
    renderStatusAndDock();
    updateHeaderContext();
  }
  updateConnectionUI();
}

function maybeConnectionToasts(previous, next) {
  if (!previous || !next) return;
  if (previous.phase !== 'playing' || next.phase !== 'playing') return;
  const before = previous.opponent?.connected;
  const after = next.opponent?.connected;
  if (before === true && after === false) {
    toast('对手暂时离线，正在等待重连…', 'gold', 3200);
  } else if (before === false && after === true) {
    toast('对手已重新连接。', 'info', 2000);
  }
}

function showOnlineResultSoon(delay = 600) {
  if (!S.online.state || S.online.state.phase !== 'finished') return;
  const key = `${S.online.code}:${S.online.state.round}`;
  if (S.ui.resultRoundKey === key) {
    updateOnlineRematchUi();
    return;
  }
  clearTimeout(S.ui.resultTimer);
  S.ui.resultTimer = setTimeout(() => {
    if (S.screen !== 'game' || S.online.state?.phase !== 'finished') return;
    if (S.ui.resultRoundKey === key) {
      updateOnlineRematchUi();
      return;
    }
    showResultModal();
  }, delay);
}

function handleLostRoom(message) {
  closeOnlineStream({ clearToken: true, clearUrl: true });
  cleanupLocalGame();
  S.mode = null;
  S.game = null;
  S.round = 0;
  clearToasts();
  setScreen('home');
  hideLoading();
  openNotice({
    kicker: 'ROOM EXPIRED',
    title: '这间房子已经关闭',
    text: message || '房间可能已过期，或服务器重新启动过。返回首页可以创建新的房间。',
    primaryLabel: '返回首页',
    onPrimary: () => closeModals(),
    icon: '×',
  });
}

async function sendOnlineAction(action) {
  if (S.mode !== 'online' || !S.online.code) return;
  if (!currentActionAllowed()) return;
  S.online.actionPending = true;
  S.ui.busy = true;
  renderStatusAndDock();
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(S.online.code)}/action`, {
      method: 'POST',
      body: { token: S.online.token, action },
    });
    receiveOnlineState(data.state);
    if (data.state?.seq <= S.online.lastSeq) {
      S.online.actionPending = false;
      S.ui.busy = false;
      renderStatusAndDock();
    }
  } catch (error) {
    S.online.actionPending = false;
    S.ui.busy = false;
    toast(error.message || '行动没有发送成功。', 'error');
    Sound.error();
    renderStatusAndDock();
    if (error.code === 'NOT_YOUR_TURN' || error.code === 'NOT_PLAYING' || error.code === 'GAME_OVER') {
      resyncOnline();
    }
  }
}

async function requestOnlineRematch() {
  if (S.mode !== 'online' || !S.online.code || S.online.rematchPending) return;
  if (S.online.state?.you?.rematch) return;
  S.online.rematchPending = true;
  updateOnlineRematchUi();
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(S.online.code)}/rematch`, {
      method: 'POST',
      body: { token: S.online.token },
    });
    receiveOnlineState(data.state);
    toast('已请求再来一局，等待对手。', 'info');
  } catch (error) {
    toast(error.message || '无法发送再来一局请求。', 'error');
  } finally {
    S.online.rematchPending = false;
    updateOnlineRematchUi();
  }
}

async function leaveOnline({ goHome = true } = {}) {
  if (S.online.leaving) return;
  S.online.leaving = true;
  const code = S.online.code;
  const token = S.online.token;
  if (code && token) {
    try {
      await api(`/api/rooms/${encodeURIComponent(code)}/leave`, {
        method: 'POST',
        body: { token },
        timeout: 5000,
      });
    } catch {
      // Leaving locally is more important than the acknowledgement.
    }
  }
  closeOnlineStream({ clearToken: true, clearUrl: true });
  S.online.lastPhase = null;
  if (goHome) {
    S.mode = null;
    S.game = null;
    S.round = 0;
    cleanupLocalGame();
    closeModals({ restoreFocus: false });
    clearToasts();
    setScreen('home');
    updateHeaderContext();
    hideLoading();
  }
}

/* -------------------------------------------------------------------------- */
/* Lobby                                                                      */
/* -------------------------------------------------------------------------- */

function renderLobby(state) {
  S.mode = 'online';
  safeText($('lobby-code'), state.code || S.online.code || '------');
  const you = state.you || state.players?.find((player) => player.seat === state.you?.seat);
  safeText($('lobby-you-name'), you?.name || '你');
  const opponent = state.opponent || state.players?.find((player) => player.seat !== state.you?.seat);
  const opponentName = $('lobby-opponent-name');
  const opponentNote = $('lobby-opponent-note');
  const opponentSeat = $('lobby-opponent');
  if (opponent) {
    safeText(opponentName, opponent.name);
    safeText(opponentNote, '已就位');
    opponentSeat?.classList.add('is-filled');
    opponentSeat?.classList.remove('is-waiting');
  } else {
    safeText(opponentName, '等待加入');
    safeText(opponentNote, '分享链接或房间号');
    opponentSeat?.classList.remove('is-filled');
    opponentSeat?.classList.add('is-waiting');
  }
  const status = $('lobby-status');
  if (status) {
    const dot = status.querySelector('.status-dot');
    status.replaceChildren();
    if (dot) status.append(dot);
    else {
      const created = document.createElement('span');
      created.className = 'status-dot';
      status.append(created);
    }
    status.append(document.createTextNode(opponent ? '挑战者已就位' : '等待挑战者'));
  }
  updateHeaderContext();
}

/* -------------------------------------------------------------------------- */
/* Result / notice / confirm                                                  */
/* -------------------------------------------------------------------------- */

function slicesByColor(color) {
  return S.game?.moves?.filter((move) => move.type === 'slice' && move.color === color).length ?? 0;
}

function directionLabel(direction) {
  if (!direction) return '—';
  const [dx, dy, dz] = direction;
  if (dx && !dy && !dz) return '沿 X 横线';
  if (!dx && dy && !dz) return '沿 Y 横线';
  if (!dx && !dy && dz) return '沿 Z 纵深';
  if (dx && dy && !dz) return '面内斜线';
  if (dx && !dy && dz) return '跨面斜线';
  if (!dx && dy && dz) return '跨面斜线';
  return '空间斜线';
}

function showResultModal() {
  if (!S.game || !S.game.over) return;
  const key =
    S.mode === 'online'
      ? `${S.online.code}:${S.round}`
      : `ai:${S.ai.gameId}`;
  if (S.ui.resultOpen && S.ui.resultRoundKey === key) {
    updateOnlineRematchUi();
    return;
  }
  S.ui.resultRoundKey = key;
  S.ui.resultOpen = true;
  closeModals({ restoreFocus: false });
  clearToasts();
  S.ui.resultOpen = true;
  openModal('result-modal');
  S.ui.resultOpen = true;

  const game = S.game;
  const winner = game.winner;
  const draw = game.phase === 'draw';
  const won = winner === S.myColor;
  const winnerPlayer =
    winner === BLACK
      ? playerForSide(playerColorForSide('you') === BLACK ? 'you' : 'opponent')
      : playerForSide(playerColorForSide('you') === WHITE ? 'you' : 'opponent');
  const kicker = draw
    ? 'DRAW / NO MOVES'
    : won
      ? `${winner === BLACK ? 'BLACK' : 'WHITE'} / FIVE`
      : 'DEFEAT / FIVE';
  safeText($('result-kicker'), kicker);
  safeText($('result-title'), draw ? '和棋' : won ? '你赢了' : '惜败');
  const offPlaneWins = draw
    ? 0
    : (game.winLine || []).filter((index) => !game.displayOf(index)).length;
  safeText(
    $('result-sub'),
    draw
      ? '棋盘上没有合法行动了。三维棋盘封死了这一局。'
      : `${winnerPlayer?.name || '对手'}以${colorName(winner)}棋连成五子。${
          offPlaneWins > 0
            ? `其中 ${offPlaneWins} 枚棋子留在其它切面。`
            : ''
        }`,
  );

  const coords = $('result-coordinates');
  coords.replaceChildren();
  for (const index of game.winLine || []) {
    const c = coordOf(index);
    const chip = document.createElement('span');
    chip.className = 'coord-chip';
    chip.textContent = `X${c.x} · Y${c.y} · Z${c.z}`;
    coords.append(chip);
  }

  const stats = $('result-stats');
  stats.replaceChildren();
  const addStat = (label, value) => {
    const block = document.createElement('div');
    block.className = 'result-stat';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = label;
    const keyValue = document.createElement('strong');
    keyValue.textContent = value;
    block.append(keyLabel, keyValue);
    stats.append(block);
  };
  addStat('总手数', String(game.moveNumber));
  addStat('你的切面', String(slicesByColor(S.myColor)));
  addStat('五连方向', draw ? '—' : directionLabel(game.winDirection));

  $('rematch-note').hidden = true;
  $('rematch-note').textContent = '';
  $('rematch-btn').disabled = false;
  $('rematch-btn').hidden = false;
  $('inspect-btn').hidden = false;
  $('result-home').textContent = S.mode === 'online' ? '离开房间' : '返回首页';
  $('rematch-btn').querySelector('span').textContent =
    S.mode === 'online' ? '再来一局' : '再下一局';
  updateOnlineRematchUi();

  requestAnimationFrame(() => {
    drawResultCube($('result-canvas'), {
      line: game.winLine,
      color: game.winner || BLACK,
      plane: game.plane,
    });
  });
}

function updateOnlineRematchUi() {
  if (S.mode !== 'online' || !S.online.state) return;
  const you = S.online.state.you;
  const opponent = S.online.state.opponent;
  if (!you) return;
  const rematchButton = $('rematch-btn');
  const note = $('rematch-note');
  if (!rematchButton) return;
  if (you.rematch) {
    rematchButton.disabled = true;
    rematchButton.querySelector('span').textContent = '等待对手…';
    note.hidden = false;
    note.textContent = opponent?.rematch ? '双方都同意了，正在开局…' : '已发送请求，等待对手同意…';
  } else if (opponent?.rematch) {
    rematchButton.disabled = false;
    rematchButton.querySelector('span').textContent = '接受再来一局';
    note.hidden = false;
    note.textContent = '对手想再来一局。';
  } else {
    rematchButton.disabled = Boolean(S.online.rematchPending);
    rematchButton.querySelector('span').textContent = '再来一局';
    note.hidden = true;
    note.textContent = '';
  }
}

function openNotice({
  kicker = 'ROOM NOTICE',
  title,
  text,
  primaryLabel = '返回首页',
  secondaryLabel = null,
  onPrimary = null,
  onSecondary = null,
  icon = '!',
}) {
  closeModals({ restoreFocus: false });
  safeText($('notice-kicker'), kicker);
  safeText($('notice-title'), title);
  safeText($('notice-text'), text);
  safeText($('notice-primary'), primaryLabel);
  safeText($('notice-icon'), icon);
  const secondary = $('notice-secondary');
  secondary.hidden = !secondaryLabel;
  if (secondaryLabel) safeText(secondary, secondaryLabel);
  $('notice-primary').onclick = () => {
    if (onPrimary) onPrimary();
  };
  secondary.onclick = () => {
    if (onSecondary) onSecondary();
    else closeModals();
  };
  openModal('notice-modal');
}

function showAbandonedNotice(state) {
  const key = `${S.online.code}:${state.round}:abandoned`;
  if (S.online.noticeKey === key) return;
  if (S.ui.resultOpen) closeModals({ restoreFocus: false });
  clearToasts();
  S.online.noticeKey = key;
  const opponent = playerForSide('opponent');
  openNotice({
    kicker: 'PLAYER LEFT',
    icon: '—',
    title: '对手已离开',
    text: `${opponent.name || '对手'}离开了房间，这局棋无法继续。你可以复盘棋盘，或返回首页开始新的对局。`,
    primaryLabel: '返回首页',
    secondaryLabel: '留在棋盘',
    onPrimary: async () => {
      await leaveOnline({ goHome: true });
    },
    onSecondary: () => {
      closeModals({ restoreFocus: false });
      updateConnectionUI();
      renderBoard();
      renderStatusAndDock();
    },
  });
}

function openConfirm({ title, text, confirmLabel = '确认离开', onConfirm }) {
  safeText($('confirm-title'), title);
  safeText($('confirm-text'), text);
  safeText($('confirm-leave'), confirmLabel);
  S.ui.confirmAction = onConfirm;
  openModal('confirm-modal');
}

async function confirmLeave() {
  const action = S.ui.confirmAction;
  S.ui.confirmAction = null;
  closeModals({ restoreFocus: false });
  if (action) await action();
}

/* -------------------------------------------------------------------------- */
/* Home actions                                                               */
/* -------------------------------------------------------------------------- */

function resetHomeState() {
  cleanupLocalGame();
  S.mode = null;
  S.game = null;
  S.round = 0;
  S.myColor = BLACK;
  S.ui.resultRoundKey = null;
  S.ui.resultOpen = false;
  S.ui.crease = null;
  S.ui.logLength = 0;
  S.ui.boardPlane = null;
  closeModals({ restoreFocus: false });
  closeOnlineStream({ clearToken: true, clearUrl: true, silent: true });
  clearToasts();
  setScreen('home');
  hideLoading();
}

function showInvitation(code) {
  if (!code) return;
  S.ui.invitationRoom = code;
  $('join-code').value = code;
  const note = $('invite-note');
  note.hidden = false;
  safeText($('invite-note-text'), `收到空间邀请 · 房间 ${code}`);
  $('join-card').classList.add('has-invitation');
}

function applyStoredIdentity() {
  const name = normalizeName(store.get(NAME_KEY, ''));
  if (name) {
    $('create-name').value = name;
    $('join-name').value = name;
  }
  const difficulty = store.get(DIFFICULTY_KEY, 'normal');
  if (AI_LEVELS[difficulty]) S.aiLevel = difficulty;
  for (const button of $$('.difficulty-btn')) {
    const active = button.dataset.level === S.aiLevel;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  }
  $('sound-icon').querySelector('use').setAttribute(
    'href',
    S.soundOn ? '#i-sound-on' : '#i-sound-off',
  );
  $('sound-btn').setAttribute('aria-pressed', String(S.soundOn));
  $('sound-btn').setAttribute('aria-label', S.soundOn ? '关闭音效' : '开启音效');
}

async function createOnlineRoom() {
  const button = $('create-room');
  const name = normalizeName($('create-name').value);
  setFormError('create-error', '');
  setBusyButton(button, true);
  try {
    const data = await api('/api/rooms', { method: 'POST', body: { name } });
    if (name) store.set(NAME_KEY, name);
    S.mode = 'online';
    S.online.code = data.code;
    S.online.token = data.token;
    S.online.seat = data.seat;
    S.online.queue = [];
    S.online.processing = false;
    S.online.lastQueuedSeq = 0;
    S.online.lastSeq = 0;
    S.online.streamDown = false;
    S.online.noticeKey = null;
    S.round = data.state.round ?? 0;
    store.set(seatKey(data.code), data.token);
    setRoomUrl(data.code);
    receiveOnlineState(data.state);
    openRoomStream();
    if (data.state.phase === 'lobby') {
      renderLobby(data.state);
      setScreen('lobby');
    }
  } catch (error) {
    setFormError('create-error', error.message);
    toast(error.message, 'error');
    Sound.error();
  } finally {
    setBusyButton(button, false);
  }
}

async function joinOnlineRoom() {
  const button = $('join-room');
  let code = normalizeCode($('join-code').value);
  $('join-code').value = code;
  const name = normalizeName($('join-name').value);
  setFormError('join-error', '');
  if (code.length !== 6) {
    setFormError('join-error', '请输入 6 位房间号。');
    $('join-code').focus();
    return;
  }
  setBusyButton(button, true);
  try {
    const storedSeat = store.get(seatKey(code), '');
    if (storedSeat) {
      // The player already has a seat: reconnect rather than joining twice.
      const data = await api(`/api/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(storedSeat)}`);
      S.mode = 'online';
      S.online.code = data.code;
      S.online.token = storedSeat;
      S.online.seat = data.seat;
      S.online.queue = [];
      S.online.lastQueuedSeq = 0;
      S.online.lastSeq = 0;
      if (name) store.set(NAME_KEY, name);
      setRoomUrl(code);
      receiveOnlineState(data.state);
      openRoomStream();
      return;
    }
    const data = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: { name },
    });
    if (name) store.set(NAME_KEY, name);
    S.mode = 'online';
    S.online.code = data.code;
    S.online.token = data.token;
    S.online.seat = data.seat;
    S.online.queue = [];
    S.online.processing = false;
    S.online.lastQueuedSeq = 0;
    S.online.lastSeq = 0;
    S.online.streamDown = false;
    S.online.noticeKey = null;
    S.round = data.state.round ?? 0;
    store.set(seatKey(data.code), data.token);
    setRoomUrl(code);
    receiveOnlineState(data.state);
    openRoomStream();
  } catch (error) {
    setFormError('join-error', error.message);
    toast(error.message, 'error');
    Sound.error();
    if (error.status === 409 && error.code === 'MATCH_STARTED') {
      const token = store.get(seatKey(code), '');
      if (token) {
        S.mode = 'online';
        S.online.code = code;
        S.online.token = token;
        S.online.queue = [];
        S.online.processing = false;
        S.online.lastQueuedSeq = 0;
        S.online.lastSeq = 0;
        S.online.streamDown = false;
        S.online.noticeKey = null;
        setRoomUrl(code);
        openRoomStream();
        resyncOnline();
      }
    }
    if (error.status === 403 || error.status === 404) {
      store.remove(seatKey(code));
    }
  } finally {
    setBusyButton(button, false);
  }
}

async function reconnectFromStorage(code) {
  const token = store.get(seatKey(code), '');
  if (!token) return false;
  showLoading('正在回到你的座位…');
  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`,
    );
    S.mode = 'online';
    S.online.code = data.code;
    S.online.token = token;
    S.online.seat = data.seat;
    S.online.queue = [];
    S.online.processing = false;
    S.online.lastQueuedSeq = 0;
    S.online.lastSeq = 0;
    S.online.streamDown = false;
    S.online.noticeKey = null;
    setRoomUrl(code);
    receiveOnlineState(data.state);
    openRoomStream();
    hideLoading();
    return true;
  } catch (error) {
    if (error.status === 403 || error.status === 404) store.remove(seatKey(code));
    hideLoading();
    showInvitation(code);
    setFormError('join-error', error.message || '无法回到这个房间。');
    return false;
  }
}

function requestLeaveConfirmation() {
  if (S.screen === 'home') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (isModalOpen()) return;
  const isLobby = S.screen === 'lobby';
  openConfirm({
    title: isLobby ? '取消这间房？' : '离开这局棋？',
    text: isLobby
      ? '房间会被关闭，邀请链接将失效。你可以随时创建新的房间。'
      : '对手会收到你已离开的提示，当前棋局不会保存。',
    confirmLabel: isLobby ? '取消房间' : '确认离开',
    onConfirm: async () => {
      if (S.mode === 'online') await leaveOnline({ goHome: true });
      else resetHomeState();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                               */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $('brand-home').addEventListener('click', () => {
    if (S.screen === 'home') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      requestLeaveConfirmation();
    }
  });
  $('rules-btn').addEventListener('click', () => openRules());
  $('sound-btn').addEventListener('click', toggleSound);
  $('leave-btn').addEventListener('click', requestLeaveConfirmation);
  $('context-copy').addEventListener('click', () => copyInvite());
  $('hero-scroll').addEventListener('click', () => {
    $('play-modes').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  for (const button of $$('.difficulty-btn')) {
    button.addEventListener('click', () => {
      const level = button.dataset.level;
      if (!AI_LEVELS[level]) return;
      S.aiLevel = level;
      store.set(DIFFICULTY_KEY, level);
      for (const item of $$('.difficulty-btn')) {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-checked', String(active));
      }
      Sound.click();
    });
  }

  $('start-ai').addEventListener('click', () => {
    Sound.ensure();
    Sound.click();
    S.aiLevel = AI_LEVELS[S.aiLevel] ? S.aiLevel : 'normal';
    startAiGame();
  });
  $('create-room').addEventListener('click', () => {
    Sound.ensure();
    createOnlineRoom();
  });
  $('join-room').addEventListener('click', () => {
    Sound.ensure();
    joinOnlineRoom();
  });
  $('join-code').addEventListener('input', () => {
    $('join-code').value = normalizeCode($('join-code').value);
    setFormError('join-error', '');
  });
  $('join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinOnlineRoom();
    }
  });
  $('join-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinOnlineRoom();
    }
  });
  for (const id of ['create-name', 'join-name']) {
    $(id).addEventListener('input', () => {
      setFormError(id === 'create-name' ? 'create-error' : 'join-error', '');
    });
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (id === 'create-name') createOnlineRoom();
        else joinOnlineRoom();
      }
    });
  }

  $('copy-code').addEventListener('click', () => copyInvite());
  $('copy-invite').addEventListener('click', () => copyInvite());
  $('lobby-rules').addEventListener('click', () => openRules());
  $('lobby-leave').addEventListener('click', requestLeaveConfirmation);

  $('board-cells').addEventListener('click', onBoardClick);
  $('board-cells').addEventListener('focusin', (event) => {
    const cell = event.target.closest?.('.cell');
    if (!cell) return;
    S.ui.focusRow = Number(cell.dataset.row);
    S.ui.focusCol = Number(cell.dataset.col);
    for (const item of $$('.cell', $('board-cells'))) item.tabIndex = item === cell ? 0 : -1;
  });
  $('board-cells').addEventListener('keydown', onBoardKeyDown);

  $('cut-button').addEventListener('click', () => {
    Sound.ensure();
    handleCutButton();
  });
  $('slice-cancel').addEventListener('click', () => {
    clearSliceMode();
    announce('已退出切面模式。');
  });
  $('dir-h').addEventListener('click', () => chooseDirection('h'));
  $('dir-v').addEventListener('click', () => chooseDirection('v'));
  $('dir-h').addEventListener('pointerenter', () => {
    S.ui.hoverDirection = 'h';
    if (S.ui.selectedPivot) drawCutPreview(S.ui.selectedPivot);
    $('dir-h').classList.add('is-hover');
    $('dir-v').classList.remove('is-hover');
  });
  $('dir-v').addEventListener('pointerenter', () => {
    S.ui.hoverDirection = 'v';
    if (S.ui.selectedPivot) drawCutPreview(S.ui.selectedPivot);
    $('dir-v').classList.add('is-hover');
    $('dir-h').classList.remove('is-hover');
  });
  for (const id of ['dir-h', 'dir-v']) {
    $(id).addEventListener('pointerleave', () => {
      S.ui.hoverDirection = null;
      if (S.ui.selectedPivot) drawCutPreview(S.ui.selectedPivot);
      $('dir-h').classList.remove('is-hover');
      $('dir-v').classList.remove('is-hover');
    });
  }

  $('rules-close').addEventListener('click', () => closeModals());
  $('rules-done').addEventListener('click', () => closeModals());
  $('modal-backdrop').addEventListener('click', () => {
    if (S.ui.modal === 'rules-modal') closeModals();
    if (S.ui.modal === 'result-modal') closeResultView();
  });
  $('modal-layer').addEventListener('keydown', onModalKeyDown);

  $('rematch-btn').addEventListener('click', onRematch);
  $('inspect-btn').addEventListener('click', closeResultView);
  $('result-home').addEventListener('click', async () => {
    if (S.mode === 'online') await leaveOnline({ goHome: true });
    else resetHomeState();
  });
  $('confirm-leave').addEventListener('click', confirmLeave);
  $('confirm-cancel').addEventListener('click', () => {
    S.ui.confirmAction = null;
    closeModals();
  });

  window.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('resize', debounce(() => {
    if (S.screen === 'game') renderSpace();
    if (S.ui.resultOpen && S.game) {
      drawResultCube($('result-canvas'), {
        line: S.game.winLine,
        color: S.game.winner || BLACK,
        plane: S.game.plane,
      });
    }
  }, 180));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.mode === 'online') resyncOnline();
  });
  window.addEventListener('online', () => {
    if (S.mode === 'online') resyncOnline();
  });
}

function toggleSound() {
  S.soundOn = !S.soundOn;
  store.set(SOUND_KEY, S.soundOn ? 'on' : 'off');
  $('sound-icon').querySelector('use').setAttribute(
    'href',
    S.soundOn ? '#i-sound-on' : '#i-sound-off',
  );
  $('sound-btn').setAttribute('aria-pressed', String(S.soundOn));
  $('sound-btn').setAttribute('aria-label', S.soundOn ? '关闭音效' : '开启音效');
  if (S.soundOn) Sound.select();
  toast(S.soundOn ? '音效已开启。' : '音效已关闭。', 'info', 1600);
}

function openRules() {
  Sound.ensure();
  openModal('rules-modal');
}

function onBoardClick(event) {
  const cell = event.target.closest?.('.cell');
  if (!cell) return;
  if (!S.game || S.game.phase !== 'playing') return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (S.ui.sliceMode) {
    choosePivot(row, col);
    return;
  }
  if (!currentActionAllowed()) return;
  const index = S.game.indexAt(row, col);
  if (S.game.cells[index] !== EMPTY) return;
  Sound.ensure();
  if (S.mode === 'ai') {
    executeLocalAction({ type: 'place', row, col }, 'human');
  } else if (S.mode === 'online') {
    sendOnlineAction({ type: 'place', row, col });
  }
}

function onBoardKeyDown(event) {
  const cell = event.target.closest?.('.cell');
  if (!cell) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  let nextRow = row;
  let nextCol = col;
  if (event.key === 'ArrowUp') nextRow = clamp(row - 1, 0, 8);
  else if (event.key === 'ArrowDown') nextRow = clamp(row + 1, 0, 8);
  else if (event.key === 'ArrowLeft') nextCol = clamp(col - 1, 0, 8);
  else if (event.key === 'ArrowRight') nextCol = clamp(col + 1, 0, 8);
  else if (event.key === 'Home') nextCol = 0;
  else if (event.key === 'End') nextCol = 8;
  else return;
  event.preventDefault();
  S.ui.focusRow = nextRow;
  S.ui.focusCol = nextCol;
  const target = $$('.cell', $('board-cells'))[nextRow * 9 + nextCol];
  target?.focus({ preventScroll: true });
}

function onModalKeyDown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    if (S.ui.modal === 'rules-modal') closeModals();
    else if (S.ui.modal === 'result-modal') closeResultView();
    else if (S.ui.modal === 'confirm-modal') {
      S.ui.confirmAction = null;
      closeModals();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const modal = $(S.ui.modal);
  if (!modal) return;
  const focusable = getFocusable(modal);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function onGlobalKeyDown(event) {
  if (event.key === 'Escape' && !isModalOpen()) {
    if (S.ui.sliceMode) {
      if (S.ui.selectedPivot) {
        S.ui.selectedPivot = null;
        S.ui.hoverDirection = null;
        renderBoard();
        renderStatusAndDock();
      } else {
        clearSliceMode();
      }
      event.preventDefault();
    }
  }
  if (
    !isModalOpen() &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.toLowerCase() === 's' &&
    S.screen === 'game' &&
    currentActionAllowed()
  ) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    if (S.ui.sliceMode) clearSliceMode();
    else enterSliceMode();
  }
}

function onRematch() {
  if (!S.game?.over) return;
  if (S.mode === 'online') {
    requestOnlineRematch();
    return;
  }
  const swap = S.myColor === BLACK;
  closeModals({ restoreFocus: false });
  startAiGame({ swapSides: swap });
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

function init() {
  buildBoardScaffold();
  buildCells();
  buildLayerScaffold();
  applyStoredIdentity();
  bindEvents();

  let invitation = '';
  try {
    const params = new URLSearchParams(window.location.search);
    invitation = normalizeCode(params.get('room') || '');
  } catch {
    invitation = '';
  }

  if (invitation) {
    showInvitation(invitation);
    const token = store.get(seatKey(invitation), '');
    if (token) {
      reconnectFromStorage(invitation).then((restored) => {
        if (!restored) {
          setScreen('home');
        }
      });
    } else {
      setScreen('home');
      setTimeout(() => {
        const joinCard = $('join-card');
        joinCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  } else {
    setScreen('home');
  }

  // Warm the AI worker only when a game actually needs it; the home screen
  // should stay light.
  const initialName = normalizeName(store.get(NAME_KEY, ''));
  if (initialName) {
    $('create-name').value = initialName;
    $('join-name').value = initialName;
  }
  setFormError('create-error', '');
  setFormError('join-error', '');
  updateHeaderContext();
}

init();
