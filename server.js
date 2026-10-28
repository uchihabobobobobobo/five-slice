/**
 * FIVE / SLICE — zero-dependency authoritative room server.
 *
 * REST + Server-Sent Events. The browser owns rendering and the local AI;
 * the server owns room membership and validates every move against the shared
 * 3D rules engine. State is small enough to resend in full after each action.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Game, RuleError, otherColor } from './public/js/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4175;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = Math.max(60_000, Number(process.env.ROOM_TTL_MS) || 4 * 60 * 60 * 1000);
const MAX_BODY = 64 * 1024;
const MAX_ROOMS = 300;
const MAX_NAME = 16;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.phase = 'lobby';
    this.players = [];
    this.game = null;
    this.blackSeat = 0;
    this.round = 0;
    this.seq = 0;
    this.streams = new Map();
    this.abandonedBy = null;
    this.startedAt = null;
    this.finishedAt = null;
  }

  get(id) {
    return this.players.find((player) => player.token === id) ?? null;
  }

  addPlayer(name, seatHint = null) {
    if (this.players.length >= 2) {
      throw new ApiError(409, 'ROOM_FULL', '这个房间已经坐满了。');
    }
    if (this.phase !== 'lobby') {
      throw new ApiError(409, 'MATCH_STARTED', '对局已经开始，请用原座位链接重连。');
    }
    const seat = seatHint ?? this.players.length;
    const player = {
      token: randomToken(),
      name: sanitizeName(name, seat === 0 ? '房主' : '挑战者'),
      seat,
      connected: false,
      rematch: false,
      left: false,
      joinedAt: Date.now(),
    };
    this.players.push(player);
    this.players.sort((a, b) => a.seat - b.seat);
    this.updatedAt = Date.now();
    this.seq += 1;
    if (this.players.length === 2) this.startGame();
    return player;
  }

  startGame() {
    if (this.players.length !== 2) return;
    this.round += 1;
    this.phase = 'playing';
    this.game = new Game();
    this.abandonedBy = null;
    this.finishedAt = null;
    this.startedAt = Date.now();
    for (const player of this.players) {
      player.rematch = false;
      player.left = false;
    }
    this.updatedAt = Date.now();
    this.seq += 1;
  }

  colorForSeat(seat) {
    return seat === this.blackSeat ? 1 : 2;
  }

  requirePlayer(token) {
    const player = this.get(token);
    if (!player) throw new ApiError(403, 'BAD_TOKEN', '座位凭证无效，请重新加入房间。');
    return player;
  }

  requirePlaying(player) {
    if (this.phase !== 'playing' || !this.game) {
      throw new ApiError(409, 'NOT_PLAYING', '当前不在对局中。');
    }
    if (this.game.phase !== 'playing') {
      throw new ApiError(409, 'GAME_OVER', '本局已经结束。');
    }
    if (player.left) {
      throw new ApiError(403, 'LEFT_ROOM', '你已经离开了这个房间。');
    }
  }

  action(token, action) {
    const player = this.requirePlayer(token);
    this.requirePlaying(player);
    if (this.game.turn !== this.colorForSeat(player.seat)) {
      throw new ApiError(409, 'NOT_YOUR_TURN', '现在还没有轮到你。');
    }
    if (!action || typeof action !== 'object') {
      throw new ApiError(400, 'BAD_ACTION', '行动格式不正确。');
    }
    const clean = {
      type: action.type,
      row: action.row,
      col: action.col,
      direction: action.direction,
    };
    try {
      this.game.applyAction(clean);
    } catch (error) {
      if (error instanceof RuleError) {
        throw new ApiError(400, error.code, error.message);
      }
      throw error;
    }
    this.updatedAt = Date.now();
    this.seq += 1;
    if (this.game.phase !== 'playing') {
      this.phase = 'finished';
      this.finishedAt = Date.now();
    }
    this.broadcast();
    return this.game.lastMove;
  }

  rematch(token) {
    const player = this.requirePlayer(token);
    if (this.phase !== 'finished' || !this.game) {
      throw new ApiError(409, 'NOT_FINISHED', '本局还没有结束。');
    }
    if (this.players.some((entry) => entry.left)) {
      throw new ApiError(409, 'PLAYER_LEFT', '对手已经离开，无法再来一局。');
    }
    player.rematch = true;
    this.updatedAt = Date.now();
    this.seq += 1;
    if (this.players.length === 2 && this.players.every((entry) => entry.rematch)) {
      this.blackSeat = 1 - this.blackSeat;
      this.startGame();
    }
    this.broadcast();
  }

  leave(token) {
    const player = this.requirePlayer(token);
    if (player.left) return;
    player.left = true;
    this.updatedAt = Date.now();
    this.seq += 1;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((entry) => entry !== player);
      if (this.players.length === 0) {
        this.manager.deleteRoom(this.code);
        return;
      }
    } else {
      this.phase = 'abandoned';
      this.abandonedBy = player.seat;
      this.finishedAt = Date.now();
    }
    this.broadcast();
  }

  addStream(token, response) {
    const player = this.requirePlayer(token);
    if (!this.streams.has(token)) this.streams.set(token, new Set());
    this.streams.get(token).add(response);
    if (!player.connected) {
      player.connected = true;
      this.updatedAt = Date.now();
      this.seq += 1;
    }
    this.send(response, this.stateFor(player.seat));
    this.broadcast();
  }

  removeStream(token, response) {
    const streams = this.streams.get(token);
    if (!streams) return;
    streams.delete(response);
    if (streams.size > 0) return;
    this.streams.delete(token);
    const player = this.get(token);
    if (player && !player.left) {
      player.connected = false;
      this.updatedAt = Date.now();
      this.seq += 1;
      this.broadcast();
    }
  }

  send(response, state) {
    try {
      response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    } catch {
      // The close handler removes stale streams.
    }
  }

  broadcast() {
    this.updatedAt = Date.now();
    for (const player of this.players) {
      const streams = this.streams.get(player.token);
      if (!streams || streams.size === 0) continue;
      const payload = this.stateFor(player.seat);
      for (const stream of streams) this.send(stream, payload);
    }
  }

  stateFor(seat) {
    const you = this.players.find((player) => player.seat === seat) ?? null;
    const opponent = this.players.find((player) => player.seat !== seat) ?? null;
    const publicPlayer = (player) =>
      player
        ? {
            seat: player.seat,
            name: player.name,
            color: this.colorForSeat(player.seat),
            connected: player.connected,
            rematch: player.rematch,
            left: player.left,
          }
        : null;
    return {
      ok: true,
      code: this.code,
      phase: this.phase,
      seq: this.seq,
      round: this.round,
      serverNow: Date.now(),
      blackSeat: this.blackSeat,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      players: this.players.map(publicPlayer),
      you: publicPlayer(you),
      opponent: publicPlayer(opponent),
      abandonedBy: this.abandonedBy,
      canRematch:
        this.phase === 'finished' &&
        this.players.length === 2 &&
        this.players.every((entry) => !entry.left),
      game: this.game ? this.game.snapshot() : null,
    };
  }

  close() {
    for (const streams of this.streams.values()) {
      for (const response of streams) {
        try {
          response.end();
        } catch {
          // Already closed.
        }
      }
    }
    this.streams.clear();
  }
}

class RoomManager {
  constructor(options = {}) {
    this.rooms = new Map();
    this.startedAt = Date.now();
    this.roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
    this.log = options.log ?? defaultLog;
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  createRoom(name) {
    if (this.rooms.size >= MAX_ROOMS) {
      throw new ApiError(503, 'SERVER_FULL', '当前房间太多，请稍后再试。');
    }
    let code = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      code = randomCode(6);
      if (!this.rooms.has(code)) break;
    }
    if (this.rooms.has(code)) {
      throw new ApiError(503, 'CODE_ERROR', '暂时无法分配房间号，请重试。');
    }
    const room = new Room(code, this);
    const player = room.addPlayer(name, 0);
    this.rooms.set(code, room);
    return { room, player };
  }

  getRoom(code) {
    const normalized = normalizeCode(code);
    const room = this.rooms.get(normalized);
    if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', '找不到这个房间，链接可能已失效。');
    return room;
  }

  joinRoom(code, name) {
    const room = this.getRoom(code);
    const player = room.addPlayer(name, 1);
    room.broadcast();
    return { room, player };
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.close();
    this.rooms.delete(code);
  }

  cleanup() {
    const current = Date.now();
    for (const [code, room] of this.rooms) {
      if (current - room.updatedAt > this.roomTtlMs) this.deleteRoom(code);
    }
  }

  dispose() {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
  }
}

function defaultLog(...args) {
  console.log('[five-slice]', ...args);
}

export function createGameServer(options = {}) {
  const manager = new RoomManager(options);
  const server = http.createServer((request, response) => {
    handleRequest(manager, request, response).catch((error) => {
      if (!(error instanceof ApiError)) manager.log('request error', error);
      if (!response.headersSent) {
        if (error instanceof ApiError) {
          sendJson(response, error.status, {
            ok: false,
            error: { code: error.code, message: error.message },
          });
        } else {
          sendJson(response, 500, {
            ok: false,
            error: { code: 'INTERNAL', message: '服务器内部错误。' },
          });
        }
      } else {
        try {
          response.end();
        } catch {
          // Already closed.
        }
      }
    });
  });
  server.on('close', () => manager.dispose());
  return { server, manager };
}

async function handleRequest(manager, request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new ApiError(400, 'BAD_PATH', '请求路径无效。');
  }

  if (pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      service: 'five-slice',
      uptime: Math.round((Date.now() - manager.startedAt) / 1000),
      rooms: manager.rooms.size,
    });
    return;
  }

  if (pathname === '/api/network' && request.method === 'GET') {
    const port = request.socket.localPort || PORT;
    sendJson(response, 200, { ok: true, urls: formatLanUrls(port) });
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(manager, request, response, pathname, url);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {
      ok: false,
      error: { code: 'METHOD', message: 'Method not allowed.' },
    });
    return;
  }
  await serveStatic(request, response, pathname);
}

async function handleApi(manager, request, response, pathname, url) {
  if (pathname === '/api/rooms' && request.method === 'POST') {
    const body = await readJson(request);
    const { room, player } = manager.createRoom(body.name);
    sendJson(response, 201, {
      ok: true,
      code: room.code,
      token: player.token,
      seat: player.seat,
      state: room.stateFor(player.seat),
    });
    return;
  }

  const match = pathname.match(
    /^\/api\/rooms\/([A-Za-z0-9]+)(?:\/(join|action|rematch|leave|stream))?$/,
  );
  if (!match) throw new ApiError(404, 'NOT_FOUND', 'API 路径不存在。');
  const code = normalizeCode(match[1]);
  const action = match[2] || 'state';
  const room = manager.getRoom(code);

  if (action === 'state' && request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const player = room.requirePlayer(token);
    sendJson(response, 200, {
      ok: true,
      code: room.code,
      token,
      seat: player.seat,
      state: room.stateFor(player.seat),
    });
    return;
  }

  if (action === 'stream' && request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    room.requirePlayer(token);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('retry: 1500\n\n');
    room.addStream(token, response);
    const ping = setInterval(() => {
      try {
        response.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        clearInterval(ping);
      }
    }, 15_000);
    ping.unref?.();
    response.on('close', () => {
      clearInterval(ping);
      room.removeStream(token, response);
    });
    return;
  }

  if (action === 'join' && request.method === 'POST') {
    const body = await readJson(request);
    const { player } = manager.joinRoom(code, body.name);
    sendJson(response, 201, {
      ok: true,
      code: room.code,
      token: player.token,
      seat: player.seat,
      state: room.stateFor(player.seat),
    });
    return;
  }

  const body = await readJson(request);
  const token = typeof body.token === 'string' ? body.token : '';
  const player = room.requirePlayer(token);

  if (action === 'action' && request.method === 'POST') {
    room.action(token, body.action);
    sendJson(response, 200, {
      ok: true,
      code: room.code,
      token,
      seat: player.seat,
      state: room.stateFor(player.seat),
    });
    return;
  }

  if (action === 'rematch' && request.method === 'POST') {
    room.rematch(token);
    sendJson(response, 200, {
      ok: true,
      code: room.code,
      token,
      seat: player.seat,
      state: room.stateFor(player.seat),
    });
    return;
  }

  if (action === 'leave' && request.method === 'POST') {
    room.leave(token);
    sendJson(response, 200, { ok: true });
    return;
  }

  throw new ApiError(405, 'METHOD', 'Method not allowed.');
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    throw new ApiError(403, 'FORBIDDEN', 'Forbidden path.');
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  }
  if (!stat.isFile()) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  if (request.method === 'HEAD') {
    response.writeHead(200, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(target).pipe(response);
}

async function readJson(request) {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD', 'POST required.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'TOO_LARGE', '请求体过大。');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'BAD_JSON', '请求体必须是合法 JSON。');
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
    .trim();
  const chars = [...stripped].slice(0, MAX_NAME);
  return chars.join('') || fallback;
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function randomCode(length) {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return output;
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function formatLanUrls(port) {
  const urls = [{ label: '本机', url: `http://localhost:${port}` }];
  let index = 0;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      index += 1;
      urls.push({
        label: `局域网 ${index}`,
        url: `http://${address.address}:${port}`,
      });
    }
  }
  return urls;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const { server, manager } = createGameServer();
  server.listen(PORT, HOST, () => {
    manager.log(`FIVE / SLICE listening on http://localhost:${PORT}`);
    for (const entry of formatLanUrls(PORT).slice(1)) {
      manager.log(`${entry.label}: ${entry.url}`);
    }
  });
  server.on('error', (error) => {
    console.error('[five-slice] server error', error);
    process.exitCode = 1;
  });
}
