/**
 * Minimal Chrome DevTools Protocol driver used by the visual checks.
 * Zero runtime dependencies; Node 20+ provides global WebSocket.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome/Edge binary found for visual checks.');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchBrowser(options = {}) {
  const port = options.port ?? 9333;
  const profile = path.resolve(options.profile ?? 'tmp/cdp-profile');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let pageWs = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        pageWs = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // Not ready yet.
    }
    await sleep(100);
  }
  if (!pageWs) {
    child.kill();
    throw new Error('Could not attach to browser page.');
  }

  const cdp = await connectCdp(pageWs);
  return {
    child,
    cdp,
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch {
        // Browser may already be gone.
      }
      cdp.close();
      await sleep(200);
      if (!child.killed) child.kill();
    },
  };
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const listeners = new Map();

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    const group = listeners.get(message.method);
    if (group) for (const handler of group) handler(message.params);
  });

  function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function on(method, handler) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method)?.delete(handler);
  }

  return {
    send,
    on,
    close: () => socket.close(),
  };
}

export async function preparePage(cdp, options = {}) {
  const width = options.width ?? 390;
  const height = options.height ?? 844;
  const mobile = options.mobile ?? width < 800;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
    screenOrientation: { angle: 0, type: 'portraitPrimary' },
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: mobile,
    maxTouchPoints: mobile ? 5 : 1,
  });
  if (mobile) {
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
      platform: 'Android',
    });
  }
  return { width, height };
}

export async function navigate(cdp, url, options = {}) {
  const loaded = new Promise((resolve) => {
    const off = cdp.on('Page.loadEventFired', () => {
      off();
      resolve();
    });
    setTimeout(() => {
      off();
      resolve();
    }, options.timeout ?? 5000);
  });
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(options.settle ?? 500);
}

export async function evaluate(cdp, expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: options.awaitPromise ?? true,
    returnByValue: options.returnByValue ?? true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Runtime evaluation failed',
    );
  }
  return result.result?.value;
}

export async function screenshot(cdp, filePath, options = {}) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: options.fullPage ?? false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

export async function tap(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await sleep(80);
}

export function collectConsole(cdp) {
  const messages = [];
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || [])
      .map((arg) => arg.value ?? arg.description ?? '')
      .join(' ');
    messages.push({ type: params.type, text });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    messages.push({
      type: 'exception',
      text:
        params.exceptionDetails?.exception?.description ||
        params.exceptionDetails?.text ||
        'exception',
    });
  });
  cdp.on('Log.entryAdded', (params) => {
    if (params.entry?.level === 'error') {
      messages.push({ type: 'log-error', text: params.entry.text });
    }
  });
  return messages;
}
