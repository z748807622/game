// 打飞机页面 UI 冒烟：Chrome headless + 手机/桌面双视口。
// 依赖：本机 Chrome；服务器已启动（make ui-plane 会自动 build + 起服务）。
//   RELAY_URL=http://127.0.0.1:18080 node web/test/plane-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, newPage, evalIn, waitFor, setViewport, screenshot, sleep } = require('./cdp.js');

const BASE = process.env.RELAY_URL || 'http://127.0.0.1:18080';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', '..', '.tmp');
const PAGE = BASE + '/plane.html';

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function front(cdp, sid) {
  await cdp.send('Page.bringToFront', {}, sid);
  await sleep(120);
}

async function debug(cdp, sid, expr) {
  return evalIn(cdp, sid, 'window.__planeDebug.' + expr);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ outDir: OUT_DIR });
  const cdp = browser.cdp;

  try {
    // ---- 两个页面：p1 桌面/房主，p2 手机/队友
    const p1 = await newPage(cdp, PAGE);
    const p2 = await newPage(cdp, PAGE);
    await setViewport(cdp, p1, DESKTOP.width, DESKTOP.height, false);
    await setViewport(cdp, p2, MOBILE.width, MOBILE.height, true);

    const boot = (nick, token) => `(() => {
      document.getElementById('nickname').value = ${JSON.stringify(nick)};
      document.getElementById('token').value = ${JSON.stringify(token)};
      return true;
    })()`;
    await evalIn(cdp, p1, boot('阿伟', 'alice'));
    await evalIn(cdp, p2, boot('小美', 'bob'));

    // ---- 建房 / 加入
    await evalIn(cdp, p1, "document.getElementById('btnCreate').click(), true");
    await waitFor(cdp, p1, "document.getElementById('statusText').textContent.startsWith('房间')", 'p1 建房');
    const code = await evalIn(cdp, p1, "document.getElementById('roomCode').textContent");
    assert(/^[A-Z2-9]{4}$/.test(code), '房间码格式不对: ' + code);
    console.log('ok 建房', code);

    await evalIn(cdp, p2, `(() => {
      document.getElementById('code').value = ${JSON.stringify(code)};
      document.getElementById('btnJoin').click();
      return true;
    })()`);
    await waitFor(cdp, p2, "document.getElementById('statusText').textContent.startsWith('房间')", 'p2 加入');
    await waitFor(cdp, p1, "document.querySelectorAll('#members li').length === 2", 'p1 看到 2 人');
    await waitFor(cdp, p2, "document.querySelectorAll('#members li').length === 2", 'p2 看到 2 人');
    console.log('ok 双端进房');

    // ---- 按钮尺寸
    const startH = await evalIn(cdp, p1, "document.getElementById('btnStart').getBoundingClientRect().height");
    assert(startH >= 44, '开始按钮高度不足 44px: ' + startH);

    // ---- 房主开局（headless 下要激活主机标签页，rAF 才会跑模拟）
    await front(cdp, p1);
    await evalIn(cdp, p1, "document.getElementById('btnStart').click(), true");
    await waitFor(cdp, p1, "window.__planeDebug && window.__planeDebug.phase() === 'playing'", 'p1 开局');
    await waitFor(cdp, p2, "window.__planeDebug && window.__planeDebug.phase() === 'playing'", 'p2 开局');
    await waitFor(cdp, p2, "window.__planeDebug.selfPos() !== null", 'p2 有预测位置');
    await waitFor(cdp, p2, "window.__planeDebug.snapshotCount() >= 5", 'p2 收到 5 帧快照');
    console.log('ok 开局，快照到达');

    // ---- PC：鼠标只是目标点，飞机速度受限
    const hostBefore = await debug(cdp, p1, 'selfPos()');
    assert(hostBefore, 'p1 应有位置');
    await evalIn(cdp, p1, `(() => {
      const c = document.getElementById('game');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointermove', {
        clientX: r.left + r.width * 0.75,
        clientY: r.top + r.height * 0.25,
        bubbles: true, pointerType: 'mouse'
      }));
      return true;
    })()`);
    await sleep(50);
    const hostEarly = await debug(cdp, p1, 'selfPos()');
    const earlyDist = Math.hypot(hostEarly.x - hostBefore.x, hostEarly.y - hostBefore.y);
    assert(earlyDist < 30, '鼠标刚移动时飞机不应瞬移: ' + earlyDist);
    await sleep(400);
    const hostLater = await debug(cdp, p1, 'selfPos()');
    const moved = Math.hypot(hostLater.x - hostBefore.x, hostLater.y - hostBefore.y);
    const toAim = Math.hypot(hostLater.x - 360, hostLater.y - 180);
    assert(moved > 40, 'p1 应该朝目标移动: ' + moved);
    assert(moved < 300 * 0.5 + 60, 'p1 移动不应超过速度上限: ' + moved);
    assert(toAim > 30, 'p1 不应在 0.45s 内瞬移到目标点');
    console.log('ok PC 跟随：450ms 移动 ' + Math.round(moved) + 'px，未瞬移');

    // ---- 移动端：点按目标点，飞机追过去并停住
    // 切到手机页，让它的 rAF 跑本地预测（此时主机模拟会暂停，只影响快照）。
    await front(cdp, p2);
    const tap = await evalIn(cdp, p2, `(() => {
      const d = window.__planeDebug;
      const c = document.getElementById('game');
      const r = c.getBoundingClientRect();
      const p = d.selfPos();
      const wx = Math.max(16, Math.min(464, p.x - 40));
      const wy = Math.max(16, Math.min(680, p.y - 40));
      const cx = r.left + wx / 480 * r.width;
      const cy = r.top + wy / 720 * r.height;
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: cx, clientY: cy, bubbles: true,
        pointerType: 'touch', pointerId: 7, isPrimary: true, buttons: 1
      }));
      c.dispatchEvent(new PointerEvent('pointerup', {
        clientX: cx, clientY: cy, bubbles: true,
        pointerType: 'touch', pointerId: 7, isPrimary: true
      }));
      return { wx, wy, sx: p.x, sy: p.y };
    })()`);
    await sleep(50);
    const touchEarly = await debug(cdp, p2, 'selfPos()');
    const touchEarlyDist = Math.hypot(touchEarly.x - tap.sx, touchEarly.y - tap.sy);
    assert(touchEarlyDist < 25, '点按后不应瞬移: ' + touchEarlyDist);
    await sleep(700);
    const touchLater = await debug(cdp, p2, 'selfPos()');
    const remain = Math.hypot(touchLater.x - tap.wx, touchLater.y - tap.wy);
    assert(remain < 25, '飞机应到达点按目标并停住，剩余 ' + remain.toFixed(1) + 'px');
    console.log('ok 移动端点按：到达目标并停住');

    // ---- 切回主机，等快照恢复后再看 HUD / 网络状态
    await front(cdp, p1);
    await sleep(500);
    const hud = await evalIn(cdp, p2, `(() => ({
      score: document.getElementById('hudScore').textContent,
      wave: document.getElementById('hudWave').textContent,
      age: window.__planeDebug.snapshotAge(),
      phase: window.__planeDebug.phase()
    }))()`);
    assert(/^\d+$/.test(hud.score), 'HUD 分数应为数字: ' + hud.score);
    assert(hud.wave.indexOf('波') >= 0, 'HUD 应显示波次: ' + hud.wave);
    assert(hud.age >= 0 && hud.age < 700, '快照年龄应正常: ' + hud.age);
    assert(hud.phase === 'playing', '应仍在游戏中');

    // ---- 手机视口：无横向溢出 + 截图
    const overflow = await evalIn(cdp, p2, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assert(overflow <= 1, '手机视口横向溢出 ' + overflow + 'px');
    await front(cdp, p2);
    await sleep(300);
    await screenshot(cdp, p2, path.join(OUT_DIR, 'plane-mobile.png'));
    await front(cdp, p1);
    await sleep(300);
    await screenshot(cdp, p1, path.join(OUT_DIR, 'plane-desktop.png'));
    console.log('ok 截图与布局');

    if (cdp.exceptions.length) {
      throw new Error('页面异常: ' + JSON.stringify(cdp.exceptions));
    }
    if (cdp.consoleErrors.length) {
      throw new Error('控制台报错: ' + JSON.stringify(cdp.consoleErrors));
    }
    console.log('\nplane ui passed');
  } finally {
    browser.close();
  }
})().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
