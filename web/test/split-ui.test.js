// split-ui.test.js — 前后端分离冒烟：后端 -serve-web=false，前端由独立静态服务器托管。
//
// 运行（后端需带 -serve-web=false 启动）：
//   RELAY_URL=ws://127.0.0.1:18080/ws node web/test/split-ui.test.js
// 依赖：本机 Chrome。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch, newPage, evalIn, waitFor } = require('./cdp.js');

const WS = process.env.RELAY_URL || 'ws://127.0.0.1:18080/ws';
const WEB = path.join(__dirname, '..');
const BACKEND = WS.replace(/^ws/, 'http').replace(/\/ws$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function checkBackendSeparated() {
  const home = await fetch(BACKEND + '/');
  assert(home.status === 404, '后端应关闭静态页（-serve-web=false），实际 GET / = ' + home.status);
  const health = await fetch(BACKEND + '/healthz');
  assert(health.status === 200, '后端 /healthz 应 200，实际 ' + health.status);
  const body = await health.text();
  assert(body.includes('"ok":true'), 'healthz 响应异常: ' + body);
  console.log('ok 后端未提供静态页 / healthz 正常');
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const rel = pathname === '/' ? '/index.html' : pathname;
        const file = path.normalize(path.join(WEB, rel));
        if (file !== WEB && !file.startsWith(WEB + path.sep)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch (e) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  await checkBackendSeparated();

  const staticServer = await startStaticServer();
  const base = 'http://127.0.0.1:' + staticServer.address().port;
  const page = base + '/bulls.html?ws=' + encodeURIComponent(WS);
  let browser = null;

  try {
    browser = await launch({});
    const cdp = browser.cdp;
    const p = await newPage(cdp, page);
    await evalIn(cdp, p, "document.getElementById('nickname').value = '分离部署'; true");

    const used = await evalIn(cdp, p, 'window.Relay.wsURL()');
    assert(used === WS, '页面解析出的 WS 地址不对: ' + used);
    console.log('ok 页面使用显式 WS 地址', used);

    await evalIn(cdp, p, "document.getElementById('btnCreate').click(), true");
    await waitFor(cdp, p, "document.getElementById('statusText').textContent.startsWith('房间')", '分离部署建房');
    const code = await evalIn(cdp, p, "document.getElementById('roomCode').textContent");
    assert(/^[A-Z2-9]{4}$/.test(code), '房间码格式不对: ' + code);
    console.log('ok 分离部署建房', code);

    if (cdp.exceptions.length) throw new Error('page exceptions: ' + cdp.exceptions.join(' | '));
    console.log('split-ui ok: 静态前端 + 独立后端 + 显式 WS 地址');
  } finally {
    if (browser) browser.close();
    await new Promise((resolve) => staticServer.close(resolve));
  }
})().catch((err) => {
  console.error('split-ui failed:', err.message);
  process.exitCode = 1;
});
