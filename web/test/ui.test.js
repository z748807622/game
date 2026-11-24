// 浏览器端 UI 冒烟测试：用 Chrome DevTools Protocol 驱动真实页面。
// 依赖：本机 Chrome；服务器已启动。
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   RELAY_URL=http://127.0.0.1:18080 node web/test/ui.test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.RELAY_URL || 'http://127.0.0.1:18080';
const PORT = 9400 + Math.floor(Math.random() * 400);
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', '..', '.tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (process.env.UI_DEBUG) console.error('[cdp]', String(ev.data).slice(0, 120));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails.text + ' ' +
          (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || ''));
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

async function connectCDP() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.binaryType = 'arraybuffer';
  return new CDP(ws);
}

async function newPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  return sessionId;
}

async function evalIn(cdp, sessionId, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(cdp, sessionId, expr, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalIn(cdp, sessionId, expr)) return;
    await sleep(50);
  }
  throw new Error('timeout: ' + label);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = path.join(OUT_DIR, 'chrome-profile-' + process.pid);
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1440,900'
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch (e) {} };
  process.on('exit', cleanup);

  try {
    if (process.env.UI_DEBUG) console.error('[ui] chrome pid', chrome.pid);
    let cdp = null;
    for (let i = 0; i < 60 && !cdp; i++) {
      try {
        cdp = await connectCDP();
      } catch (e) {
        if (chrome.exitCode !== null) throw new Error('chrome exited: ' + chrome.exitCode);
        await sleep(200);
      }
    }
    if (!cdp) throw new Error('chrome devtools not reachable');
    if (process.env.UI_DEBUG) console.error('[ui] cdp connected');

    const p1 = await newPage(cdp);
    if (process.env.UI_DEBUG) console.error('[ui] page1', p1);
    const p2 = await newPage(cdp);
    if (process.env.UI_DEBUG) console.error('[ui] page2', p2);

    const boot = (nick, token) => `(() => {
      document.getElementById('nickname').value = ${JSON.stringify(nick)};
      document.getElementById('token').value = ${JSON.stringify(token)};
      document.getElementById('btnConnect').click();
      return true;
    })()`;

    await evalIn(cdp, p1, boot('阿伟', 'alice'));
    await evalIn(cdp, p2, boot('小美', 'bob'));
    await waitFor(cdp, p1, "document.getElementById('statusText').textContent === '已连接'", 'p1 connected');
    await waitFor(cdp, p2, "document.getElementById('statusText').textContent === '已连接'", 'p2 connected');

    await evalIn(cdp, p1, "document.getElementById('btnCreate').click(), true");
    await waitFor(cdp, p1, "document.getElementById('statusText').textContent.startsWith('房间')", 'room created');
    const code = await evalIn(cdp, p1, "document.getElementById('code').value");
    if (!/^[A-Z2-9]{4}$/.test(code)) throw new Error('bad room code: ' + code);

    await evalIn(cdp, p2, `(() => {
      document.getElementById('code').value = ${JSON.stringify(code)};
      document.getElementById('btnJoin').click();
      return true;
    })()`);
    await waitFor(cdp, p2, "document.getElementById('statusText').textContent.startsWith('房间')", 'p2 joined');
    await waitFor(cdp, p1, "document.querySelectorAll('#members li').length === 2", 'member list sync');

    const say = (text) => `(() => {
      const el = document.getElementById('input');
      el.value = ${JSON.stringify(text)};
      document.getElementById('btnSend').click();
      return true;
    })()`;
    await evalIn(cdp, p1, say('开始吧，我先出牌'));
    await waitFor(cdp, p2, "document.getElementById('messages').textContent.includes('开始吧')", 'p2 got message');
    await evalIn(cdp, p2, say('收到，等我三秒'));
    await waitFor(cdp, p1, "document.getElementById('messages').textContent.includes('收到')", 'p1 got reply');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, p1);
    fs.writeFileSync(path.join(OUT_DIR, 'demo.png'), Buffer.from(shot.data, 'base64'));

    if (cdp.exceptions.length) {
      throw new Error('page exceptions: ' + cdp.exceptions.join(' | '));
    }
    console.log('ui ok: 连接 / 建房 / 加入 / 双端消息同步，截图 .tmp/demo.png');
    process.exitCode = 0;
    cdp.ws.close();
    cleanup();
  } finally {
    cleanup();
  }
})().catch((err) => {
  console.error('ui failed:', err.message);
  process.exitCode = 1;
});
