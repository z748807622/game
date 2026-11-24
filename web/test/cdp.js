// cdp.js — Chrome DevTools Protocol 测试辅助：启动 headless Chrome、开页面、求值、截图。
//
// 跨平台找 Chrome（macOS / Windows / Linux），Node 18 也能跑（WebSocket 由 ws-polyfill 提供）。
'use strict';

require('./ws-polyfill.js');

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const file of list) {
    try {
      if (fs.existsSync(file)) return file;
    } catch (e) { /* 路径不存在 */ }
  }
  return list[0];
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (process.env.UI_DEBUG) console.error('[cdp]', String(ev.data).slice(0, 120));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.text + ' ' + ((d.exception && d.exception.description) || ''));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (process.env.UI_DEBUG) console.error('[cdp>]', method, sessionId || '');
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function connectCDP(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/version');
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cdp websocket failed'));
  });
  ws.binaryType = 'arraybuffer';
  return new CDP(ws);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) { /* 已经退出 */ }
}

// 启动 headless Chrome，返回 { cdp, port, close() }。
async function launch(opts = {}) {
  const chromePath = opts.chrome || findChrome();
  const port = opts.port || 9400 + Math.floor(Math.random() * 400);
  const outDir = opts.outDir || path.join(__dirname, '..', '..', '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const profileDir = opts.profileDir || path.join(os.tmpdir(), 'relay-cdp-' + process.pid + '-' + port);

  const child = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900'
  ], { stdio: 'ignore' });

  let exited = null;
  child.on('exit', (code) => { exited = code; });

  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
    if (exited !== null) throw new Error('chrome exited early with code ' + exited + ' (' + chromePath + ')');
    try {
      cdp = await connectCDP(port);
    } catch (e) {
      await sleep(200);
    }
  }
  if (!cdp) throw new Error('chrome devtools not reachable on port ' + port);

  const close = () => {
    try { cdp.ws.close(); } catch (e) {}
    killTree(child);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  };

  return { cdp, port, chromePath, close };
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  // 新标签页可能还停在 about:blank，等目标页真正渲染出内容再操作。
  await waitFor(
    cdp,
    sessionId,
    "document.readyState === 'complete' && !!document.body && document.body.children.length > 0",
    'page ready',
    15000
  );
  return sessionId;
}

async function evalIn(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const detail = (d.exception && (d.exception.description || d.exception.value)) || '';
    throw new Error(d.text + (detail ? ': ' + String(detail).split('\n')[0] : ''));
  }
  return r.result.value;
}

async function waitFor(cdp, sessionId, expr, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      if (await evalIn(cdp, sessionId, expr)) return;
    } catch (e) {
      lastErr = e; // 页面还在导航时 evaluate 可能失败，继续等
    }
    await sleep(50);
  }
  throw new Error('timeout: ' + label + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

// 模拟手机 / 桌面视口。
async function setViewport(cdp, sessionId, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: !!mobile
  }, sessionId);
}

async function screenshot(cdp, sessionId, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

module.exports = {
  launch,
  newPage,
  evalIn,
  waitFor,
  setViewport,
  screenshot,
  findChrome,
  sleep
};
