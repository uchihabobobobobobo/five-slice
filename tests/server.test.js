import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../server.js';
import { planeId } from '../public/js/engine.js';

const { server } = createGameServer({ log: () => {} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
    }),
);

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function createRoom(name = '青禾') {
  const { status, json } = await api('/api/rooms', { method: 'POST', body: { name } });
  assert.equal(status, 201, JSON.stringify(json));
  return json;
}

async function joinRoom(code, name = '南星') {
  const { status, json } = await api(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: { name },
  });
  assert.equal(status, 201, JSON.stringify(json));
  return json;
}

async function move(code, token, action) {
  return api(`/api/rooms/${code}/action`, {
    method: 'POST',
    body: { token, action },
  });
}

test('health, room creation and join start a match', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const host = await createRoom();
  assert.match(host.code, /^[A-Z2-9]{6}$/);
  assert.equal(host.seat, 0);
  assert.equal(host.state.phase, 'lobby');
  assert.equal(host.state.game, null);
  assert.equal(host.state.you.color, 1);

  const guest = await joinRoom(host.code);
  assert.equal(guest.seat, 1);
  assert.equal(guest.state.phase, 'playing');
  assert.equal(guest.state.blackSeat, 0);
  assert.equal(guest.state.you.color, 2);
  assert.ok(guest.state.game);

  const full = await api(`/api/rooms/${host.code}/join`, {
    method: 'POST',
    body: { name: '第三人' },
  });
  assert.equal(full.status, 409);
  assert.equal(full.json.error.code, 'ROOM_FULL');

  const badToken = await api(`/api/rooms/${host.code}?token=nope`);
  assert.equal(badToken.status, 403);

  const notTurn = await move(host.code, guest.token, {
    type: 'place',
    row: 4,
    col: 4,
  });
  assert.equal(notTurn.status, 409);
  assert.equal(notTurn.json.error.code, 'NOT_YOUR_TURN');

  const first = await move(host.code, host.token, { type: 'place', row: 4, col: 4 });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.state.game.turn, 2);
  assert.equal(first.json.state.game.moveNumber, 1);
  assert.equal(first.json.state.game.lastMove.x, 4);
  assert.equal(first.json.state.game.lastMove.y, 4);
  assert.equal(first.json.state.game.lastMove.z, 4);
});

test('SSE sends the authoritative state and marks the player connected', async () => {
  const host = await createRoom('听雨');
  const guest = await joinRoom(host.code, '空山');
  const controller = new AbortController();
  try {
    const response = await fetch(
      `${base}/api/rooms/${host.code}/stream?token=${encodeURIComponent(host.token)}`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: state') && buffer.includes('\n\n')) break;
    }
    assert.match(buffer, /event: state/);
    const payloadLine = buffer
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(payloadLine);
    const state = JSON.parse(payloadLine.slice(6));
    assert.equal(state.code, host.code);
    assert.equal(state.you.seat, 0);
    assert.equal(state.opponent.seat, 1);
  } finally {
    controller.abort();
  }

  // The stream's close handler can take a tick to update presence.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const state = await api(`/api/rooms/${host.code}?token=${host.token}`);
  assert.equal(state.status, 200);
  assert.equal(state.json.state.you.connected, false);
});

test('a cut is validated, spends the pivot and changes the active plane', async () => {
  const host = await createRoom();
  const guest = await joinRoom(host.code);
  let result = await move(host.code, host.token, { type: 'place', row: 4, col: 4 });
  assert.equal(result.status, 200);
  result = await move(host.code, guest.token, { type: 'place', row: 0, col: 0 });
  assert.equal(result.status, 200);
  result = await move(host.code, host.token, {
    type: 'slice',
    row: 4,
    col: 4,
    direction: 'v',
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const game = result.json.state.game;
  assert.equal(game.plane, planeId('x', 4));
  assert.equal(game.turn, 2);
  assert.equal(game.moveNumber, 3);
  const pivot = game.lastMove;
  assert.equal(pivot.type, 'slice');
  assert.equal(pivot.toLabel, 'X = 4');
  assert.equal(game.used[pivot.pivot], '1');

  // The spent pivot is still black's stone and cannot be used again. Validate
  // the server rejects a bogus second cut by the wrong player and by the pivot.
  const wrong = await move(host.code, host.token, {
    type: 'slice',
    row: 4,
    col: 4,
    direction: 'h',
  });
  assert.equal(wrong.status, 409);

  const guestMove = await move(host.code, guest.token, { type: 'place', row: 0, col: 0 });
  assert.equal(guestMove.status, 200);
  const secondBlack = await move(host.code, host.token, {
    type: 'place',
    row: 0,
    col: 1,
  });
  assert.equal(secondBlack.status, 200);
});

test('five in a row finishes the game; both rematch requests swap colours', async () => {
  const host = await createRoom();
  const guest = await joinRoom(host.code);
  const sequence = [
    host, [0, 0], guest, [0, 8],
    host, [0, 1], guest, [1, 8],
    host, [0, 2], guest, [2, 8],
    host, [0, 3], guest, [3, 8],
    host, [0, 4],
  ];
  let lastState = null;
  for (let i = 0; i < sequence.length; i += 2) {
    const player = sequence[i];
    const [row, col] = sequence[i + 1];
    const result = await move(host.code, player.token, { type: 'place', row, col });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    lastState = result.json.state;
  }
  assert.equal(lastState.phase, 'finished');
  assert.equal(lastState.game.phase, 'won');
  assert.equal(lastState.game.winner, 1);
  assert.equal(lastState.game.winLine.length, 5);

  const afterWin = await move(host.code, guest.token, { type: 'place', row: 5, col: 5 });
  assert.equal(afterWin.status, 409);

  const hostRematch = await api(`/api/rooms/${host.code}/rematch`, {
    method: 'POST',
    body: { token: host.token },
  });
  assert.equal(hostRematch.status, 200);
  assert.equal(hostRematch.json.state.phase, 'finished');
  assert.equal(hostRematch.json.state.you.rematch, true);

  const guestRematch = await api(`/api/rooms/${host.code}/rematch`, {
    method: 'POST',
    body: { token: guest.token },
  });
  assert.equal(guestRematch.status, 200);
  const state = guestRematch.json.state;
  assert.equal(state.phase, 'playing');
  assert.equal(state.round, 2);
  assert.equal(state.blackSeat, 1);
  assert.equal(state.you.color, 1); // guest is now black
  assert.equal(state.opponent.color, 2);
  assert.equal(state.game.moveNumber, 0);
  assert.equal(state.game.phase, 'playing');

  const oldBlackTriesFirst = await move(host.code, host.token, {
    type: 'place',
    row: 4,
    col: 4,
  });
  assert.equal(oldBlackTriesFirst.status, 409);
  const newBlack = await move(host.code, guest.token, { type: 'place', row: 4, col: 4 });
  assert.equal(newBlack.status, 200);
});

test('leaving marks the room abandoned and blocks a rematch', async () => {
  const host = await createRoom();
  const guest = await joinRoom(host.code);
  await move(host.code, host.token, { type: 'place', row: 4, col: 4 });
  const left = await api(`/api/rooms/${host.code}/leave`, {
    method: 'POST',
    body: { token: guest.token },
  });
  assert.equal(left.status, 200);
  const state = await api(`/api/rooms/${host.code}?token=${host.token}`);
  assert.equal(state.status, 200);
  assert.equal(state.json.state.phase, 'abandoned');
  assert.equal(state.json.state.abandonedBy, 1);
  assert.equal(state.json.state.opponent.left, true);
  const rematch = await api(`/api/rooms/${host.code}/rematch`, {
    method: 'POST',
    body: { token: host.token },
  });
  assert.equal(rematch.status, 409);
});

test('invalid moves and names are rejected or sanitised gracefully', async () => {
  const host = await createRoom('   ');
  assert.equal(host.state.you.name, '房主');
  const guest = await joinRoom(host.code, '一二三四五六七八九十一二三四五六七八');
  assert.equal([...guest.state.you.name].length, 16);

  const outOfBounds = await move(host.code, host.token, { type: 'place', row: 9, col: 0 });
  assert.equal(outOfBounds.status, 400);
  const occupied = await move(host.code, host.token, { type: 'place', row: 4, col: 4 });
  assert.equal(occupied.status, 200);
  const bad = await move(host.code, guest.token, { type: 'place', row: 4, col: 4 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'OCCUPIED');
});
