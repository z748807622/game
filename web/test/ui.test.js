// 浏览器端 UI 冒烟测试：用 Chrome DevTools Protocol 驱动真实页面。
// 依赖：本机 Chrome；服务器已启动。
//   CHROME="..." RELAY_URL=http://127.0.0.1:18080 node web/test/ui.test.js
const fs = require('fs');
const path = require('path');
const { launch, newPage, evalIn, waitFor, setViewport, screenshot } = require('./cdp.js');

const BASE = process.env.RELAY_URL || 'http://127.0.0.1:18080';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', '..', '.tmp');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ outDir: OUT_DIR });
  try {
    // 首页菜单：入口齐全，手机/桌面都不横向溢出
    const menu = await newPage(browser.cdp, BASE + '/');
    const links = await evalIn(browser.cdp, menu, "Array.from(document.querySelectorAll('.menu a')).map(a => a.getAttribute('href'))");
    if (links.join(',') !== 'relay.html,bulls.html,plane.html') {
      throw new Error('菜单入口不对: ' + links.join(','));
    }
    for (const [w, h, mobile] of [[390, 844, true], [1440, 900, false]]) {
      await setViewport(browser.cdp, menu, w, h, mobile);
      const overflow = await evalIn(browser.cdp, menu, 'document.documentElement.scrollWidth > document.documentElement.clientWidth');
      if (overflow) throw new Error('菜单在 ' + w + 'px 下横向溢出');
    }
    console.log('ok 菜单入口与响应式');

    const p1 = await newPage(browser.cdp, BASE + '/relay.html');
    const p2 = await newPage(browser.cdp, BASE + '/relay.html');

    const boot = (nick, token) => `(() => {
      document.getElementById('nickname').value = ${JSON.stringify(nick)};
      document.getElementById('token').value = ${JSON.stringify(token)};
      document.getElementById('btnConnect').click();
      return true;
    })()`;

    await evalIn(browser.cdp, p1, boot('阿伟', 'alice'));
    await evalIn(browser.cdp, p2, boot('小美', 'bob'));
    await waitFor(browser.cdp, p1, "document.getElementById('statusText').textContent === '已连接'", 'p1 connected');
    await waitFor(browser.cdp, p2, "document.getElementById('statusText').textContent === '已连接'", 'p2 connected');
    console.log('ok 两个页面已连接');

    await evalIn(browser.cdp, p1, "document.getElementById('btnCreate').click(), true");
    await waitFor(browser.cdp, p1, "document.getElementById('statusText').textContent.startsWith('房间')", 'room created');
    const code = await evalIn(browser.cdp, p1, "document.getElementById('code').value");
    if (!/^[A-Z2-9]{4}$/.test(code)) throw new Error('bad room code: ' + code);
    console.log('ok 建房', code);

    await evalIn(browser.cdp, p2, `(() => {
      document.getElementById('code').value = ${JSON.stringify(code)};
      document.getElementById('btnJoin').click();
      return true;
    })()`);
    await waitFor(browser.cdp, p2, "document.getElementById('statusText').textContent.startsWith('房间')", 'p2 joined');
    await waitFor(browser.cdp, p1, "document.querySelectorAll('#members li').length === 2", 'member list sync');
    console.log('ok 加入房间，成员列表同步');

    const say = (text) => `(() => {
      const el = document.getElementById('input');
      el.value = ${JSON.stringify(text)};
      document.getElementById('btnSend').click();
      return true;
    })()`;
    await evalIn(browser.cdp, p1, say('开始吧，我先出牌'));
    await waitFor(browser.cdp, p2, "document.getElementById('messages').textContent.includes('开始吧')", 'p2 got message');
    await evalIn(browser.cdp, p2, say('收到，等我三秒'));
    await waitFor(browser.cdp, p1, "document.getElementById('messages').textContent.includes('收到')", 'p1 got reply');
    console.log('ok 双端消息同步');

    await screenshot(browser.cdp, p1, path.join(OUT_DIR, 'demo.png'));

    if (browser.cdp.exceptions.length) {
      throw new Error('page exceptions: ' + browser.cdp.exceptions.join(' | '));
    }
    console.log('ui ok: 连接 / 建房 / 加入 / 双端消息同步，截图 .tmp/demo.png');
  } finally {
    browser.close();
  }
})().catch((err) => {
  console.error('ui failed:', err.message);
  process.exitCode = 1;
});
