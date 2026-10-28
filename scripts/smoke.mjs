/**
 * Browser smoke test. Start the server first:
 *
 *   npm start
 *   npm run smoke
 *
 * It exercises the shipped assets, the local AI turn loop, an online win and
 * the result card. Server rules are covered separately by `npm test`.
 */

import assert from 'node:assert/strict';
import {
  launchBrowser,
  preparePage,
  navigate,
  evaluate,
  collectConsole,
  sleep,
} from './cdp.mjs';

const base = (process.env.BASE_URL || 'http://127.0.0.1:4175').replace(/\/$/, '');

async function api(path, options = {}) {
  const response = await fetch(base + path, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(cdp, expression, timeout = 7000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(150);
  }
  return false;
}

let health;
try {
  health = await fetch(`${base}/api/health`).then((response) => response.json());
} catch {
  console.error(`无法连接 ${base}。请先在项目目录运行 npm start，再运行 npm run smoke。`);
  process.exit(1);
}
assert.equal(health.ok, true);
assert.equal(health.service, 'five-slice');

const stamp = Date.now();
const browser = await launchBrowser({
  port: Number(process.env.CDP_PORT) || 9370,
  profile: `tmp/cdp-smoke-${stamp}`,
});
const consoleMessages = collectConsole(browser.cdp);
let host = null;
let guest = null;
try {
  const { cdp } = browser;
  await preparePage(cdp, { width: 1440, height: 1000, mobile: false });
  await navigate(cdp, `${base}/`, { settle: 1100 });

  assert.equal(await evaluate(cdp, 'document.body.dataset.screen'), 'home');
  assert.equal(await evaluate(cdp, "document.querySelectorAll('.cell').length"), 81);
  assert.equal(await evaluate(cdp, "document.querySelectorAll('.layer').length"), 9);

  // Local AI: human center, hard AI reply.
  await evaluate(cdp, "document.querySelector('.difficulty-btn[data-level=\"normal\"]').click(); true");
  await evaluate(cdp, "document.querySelector('#start-ai').click(); true");
  await sleep(500);
  await evaluate(cdp, "document.querySelector('.cell[data-row=\"4\"][data-col=\"4\"]').click(); true");
  assert.equal(
    await waitFor(cdp, "document.querySelectorAll('.stone').length >= 2", 8000),
    true,
  );
  assert.match(
    await evaluate(cdp, "document.querySelector('#status-text').textContent"),
    /轮到你/,
  );
  assert.equal(await evaluate(cdp, "document.querySelectorAll('.cell.is-playable').length"), 79);

  // A real browser cut: open the sheet, pick the human stone, flip into X=4.
  await evaluate(cdp, "document.querySelector('#cut-button').click(); true");
  await sleep(120);
  await evaluate(cdp, "document.querySelector('.cell[data-row=\"4\"][data-col=\"4\"]').click(); true");
  assert.equal(
    await evaluate(cdp, "!document.querySelector('#slice-chooser').hidden"),
    true,
  );
  await evaluate(cdp, "document.querySelector('#dir-v').click(); true");
  assert.equal(
    await waitFor(cdp, "document.querySelector('#plane-label').textContent === 'X = 4'", 7000),
    true,
  );
  assert.match(await evaluate(cdp, "document.querySelector('#move-log').innerText"), /纵向切/);
  await sleep(400);

  // Online: a full in-plane win created through the authoritative API.
  host = await api('/api/rooms', { method: 'POST', body: { name: '青禾' } });
  guest = await api(`/api/rooms/${host.code}/join`, {
    method: 'POST',
    body: { name: '南星' },
  });
  const winningSequence = [
    [host.token, 0, 0], [guest.token, 0, 8],
    [host.token, 0, 1], [guest.token, 1, 8],
    [host.token, 0, 2], [guest.token, 2, 8],
    [host.token, 0, 3], [guest.token, 3, 8],
    [host.token, 0, 4],
  ];
  for (const [token, row, col] of winningSequence) {
    await api(`/api/rooms/${host.code}/action`, {
      method: 'POST',
      body: { token, action: { type: 'place', row, col } },
    });
  }

  await navigate(cdp, `${base}/`, { settle: 300 });
  await evaluate(
    cdp,
    `localStorage.setItem('fiveslice:seat:${host.code}', ${JSON.stringify(host.token)}); true`,
  );
  await navigate(cdp, `${base}/?room=${host.code}`, { settle: 1300 });

  assert.equal(
    await waitFor(cdp, "!document.querySelector('#result-modal').hidden", 8000),
    true,
  );
  assert.equal(await evaluate(cdp, "document.querySelector('#result-title').textContent"), '你赢了');
  assert.equal(await evaluate(cdp, "document.querySelectorAll('#result-coordinates .coord-chip').length"), 5);
  assert.equal(await evaluate(cdp, "document.querySelectorAll('.cell.is-win').length"), 5);
  assert.equal(await evaluate(cdp, "document.querySelector('#plane-label').textContent"), 'Z = 4');

  await evaluate(cdp, "document.querySelector('#inspect-btn').click(); true");
  await sleep(300);
  assert.equal(await evaluate(cdp, "document.querySelector('#modal-layer').hidden"), true);
  assert.equal(await evaluate(cdp, "document.querySelector('#cut-label').textContent"), '查看结果');
  assert.equal(
    await evaluate(cdp, "document.querySelector('#board-hint').textContent.includes('五连完成')"),
    true,
  );

  const errors = consoleMessages.filter(
    (entry) =>
      entry.type === 'exception' ||
      (entry.type === 'log-error' && !entry.text.includes('favicon')),
  );
  assert.deepEqual(errors, []);
  console.log('SMOKE PASS — AI turn, browser cut, online win, result card and inspect view.');
} finally {
  await browser.close();
  if (host?.code) {
    try {
      await api(`/api/rooms/${host.code}/leave`, {
        method: 'POST',
        body: { token: host.token },
      });
    } catch {
      // The room may already be gone; this is only cleanup.
    }
  }
}
