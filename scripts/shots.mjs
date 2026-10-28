/**
 * Generate the preview images used by the README.
 *
 *   npm start
 *   npm run shots
 */

import {
  launchBrowser,
  preparePage,
  navigate,
  evaluate,
  screenshot,
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

const browser = await launchBrowser({
  port: Number(process.env.CDP_PORT) || 9371,
  profile: `tmp/cdp-shots-${Date.now()}`,
});
const messages = collectConsole(browser.cdp);
let host = null;
try {
  const { cdp } = browser;
  await preparePage(cdp, { width: 1440, height: 1000, mobile: false });
  await navigate(cdp, `${base}/`, { settle: 1200 });
  await screenshot(cdp, 'shots/home-desktop.png');

  await evaluate(cdp, "document.querySelector('#start-ai').click(); true");
  await sleep(700);
  await evaluate(cdp, "document.querySelector('.cell[data-row=\"4\"][data-col=\"4\"]').click(); true");
  await sleep(1100);
  await screenshot(cdp, 'shots/game-desktop.png');

  await evaluate(cdp, "document.querySelector('#cut-button').click(); true");
  await sleep(150);
  await evaluate(cdp, "document.querySelector('.cell[data-row=\"4\"][data-col=\"4\"]').click(); true");
  await sleep(300);
  await screenshot(cdp, 'shots/slice-choose-desktop.png');

  // A quick online win for the result card.
  host = await api('/api/rooms', { method: 'POST', body: { name: '青禾' } });
  const guest = await api(`/api/rooms/${host.code}/join`, {
    method: 'POST',
    body: { name: '南星' },
  });
  for (const [token, row, col] of [
    [host.token, 0, 0], [guest.token, 0, 8],
    [host.token, 0, 1], [guest.token, 1, 8],
    [host.token, 0, 2], [guest.token, 2, 8],
    [host.token, 0, 3], [guest.token, 3, 8],
    [host.token, 0, 4],
  ]) {
    await api(`/api/rooms/${host.code}/action`, {
      method: 'POST',
      body: { token, action: { type: 'place', row, col } },
    });
  }
  await navigate(cdp, `${base}/`, { settle: 250 });
  await evaluate(
    cdp,
    `localStorage.setItem('fiveslice:seat:${host.code}', ${JSON.stringify(host.token)}); true`,
  );
  await navigate(cdp, `${base}/?room=${host.code}`, { settle: 1300 });
  await waitFor(cdp, "!document.querySelector('#result-modal').hidden", 8000);
  await sleep(350);
  await screenshot(cdp, 'shots/result-desktop.png');

  // Mobile previews.
  await preparePage(cdp, { width: 390, height: 844, mobile: true });
  await navigate(cdp, `${base}/`, { settle: 1000 });
  await screenshot(cdp, 'shots/home-mobile.png');
  await evaluate(cdp, "document.querySelector('#start-ai').click(); true");
  await sleep(700);
  await screenshot(cdp, 'shots/game-mobile.png');

  const errors = messages.filter((entry) => entry.type === 'exception');
  if (errors.length) {
    console.error('Browser exceptions while generating shots:', errors);
    process.exitCode = 1;
  } else {
    console.log('SHOTS — home, game, slicer and result previews written to shots/.');
  }
} finally {
  await browser.close();
  if (host?.code) {
    try {
      await api(`/api/rooms/${host.code}/leave`, {
        method: 'POST',
        body: { token: host.token },
      });
    } catch {
      // Cleanup only.
    }
  }
}
