// 猜数字页面 UI 测试：手机视口 + 桌面视口，两个页面打完整一局。
// 依赖：本机 Chrome；服务器已启动。
//   RELAY_URL=http://127.0.0.1:18080 node web/test/bulls-ui.test.js
const fs = require('fs');
const path = require('path');
const { launch, newPage, evalIn, waitFor, setViewport, screenshot } = require('./cdp.js');

const BASE = process.env.RELAY_URL || 'http://127.0.0.1:18080';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', '..', '.tmp');
const PAGE = BASE + '/bulls.html';

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function dump(cdp, pages) {
  for (const [name, sid] of Object.entries(pages)) {
    try {
      const info = await evalIn(cdp, sid, `(() => {
        const t = (id) => { const el = document.getElementById(id); return el ? (el.textContent || '').trim() : '(no el)'; };
        return {
          status: t('statusText'),
          band: t('turnBand'),
          guessHint: t('guessHint'),
          secretHint: t('secretHint'),
          mine: t('historyMine'),
          theirs: t('historyTheirs'),
          over: t('resultBand'),
          playHidden: document.getElementById('playBox').classList.contains('hidden'),
          setupHidden: document.getElementById('setupBox').classList.contains('hidden'),
          guessDisabled: document.getElementById('guessInput').disabled,
          guessValue: document.getElementById('guessInput').value
        };
      })()`);
      console.error('DEBUG ' + name, JSON.stringify(info));
    } catch (e) {
      console.error('DEBUG ' + name + ' unreadable', e.message);
    }
  }
  console.error('DEBUG exceptions', cdp.exceptions);
  console.error('DEBUG consoleErrors', cdp.consoleErrors);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ outDir: OUT_DIR });
  const cdp = browser.cdp;
  const pages = {};

  try {
    const p1 = await newPage(cdp, PAGE);
    const p2 = await newPage(cdp, PAGE);
    pages.p1 = p1;
    pages.p2 = p2;
    await setViewport(cdp, p1, MOBILE.width, MOBILE.height, true);
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
    console.log('ok 加入房间');

    // ---- 设暗号
    await waitFor(cdp, p1, "!document.getElementById('setupBox').classList.contains('hidden')", 'p1 进入设暗号');
    await waitFor(cdp, p2, "!document.getElementById('setupBox').classList.contains('hidden')", 'p2 进入设暗号');

    const secretBtnHeight = await evalIn(cdp, p1, "document.getElementById('btnSecret').getBoundingClientRect().height");
    assert(secretBtnHeight >= 44, '锁定暗号按钮高度不足 44px: ' + secretBtnHeight);

    const setSecret = (n) => `(() => {
      document.getElementById('secretInput').value = ${JSON.stringify(n)};
      document.getElementById('btnSecret').click();
      return true;
    })()`;
    await evalIn(cdp, p1, setSecret('1234'));
    await evalIn(cdp, p2, setSecret('5678'));
    console.log('ok 双方锁定暗号');

    // ---- 开局：房主先猜
    await waitFor(cdp, p1, "!document.getElementById('playBox').classList.contains('hidden')", 'p1 开局');
    await waitFor(cdp, p2, "!document.getElementById('playBox').classList.contains('hidden')", 'p2 开局');
    const band1 = await evalIn(cdp, p1, "document.getElementById('turnBand').textContent");
    const band2 = await evalIn(cdp, p2, "document.getElementById('turnBand').textContent");
    assert(band1.indexOf('轮到你猜') === 0, 'p1 应当先猜，实际: ' + band1);
    assert(band2.indexOf('等对手猜') === 0, 'p2 应当等待，实际: ' + band2);
    console.log('ok 开局，房主先猜');

    const guess = (n) => `(() => {
      const el = document.getElementById('guessInput');
      el.value = ${JSON.stringify(n)};
      document.getElementById('btnGuess').click();
      return true;
    })()`;

    const guessBtnHeight = await evalIn(cdp, p1, "document.getElementById('btnGuess').getBoundingClientRect().height");
    assert(guessBtnHeight >= 44, '猜按钮高度不足 44px: ' + guessBtnHeight);

    // 第 1 猜：1234 vs 5678 → 1 个
    await evalIn(cdp, p1, guess('5670'));
    await waitFor(cdp, p1, "document.getElementById('historyMine').textContent.includes('5670')", 'p1 看到自己的猜测');
    await waitFor(cdp, p2, "document.getElementById('historyTheirs').textContent.includes('5670')", 'p2 收到猜测');
    await waitFor(cdp, p1, "document.getElementById('historyMine').textContent.includes('3 个')", 'p1 看到 3 个');
    console.log('ok 第 1 猜：5670 → 3 个');

    // 第 2 猜：bob 猜 1200 对 1234 → 2 个
    await evalIn(cdp, p2, guess('1200'));
    await waitFor(cdp, p2, "document.getElementById('historyMine').textContent.includes('1200')", 'p2 看到自己的猜测');
    await waitFor(cdp, p1, "document.getElementById('historyTheirs').textContent.includes('1200')", 'p1 收到猜测');
    await waitFor(cdp, p2, "document.getElementById('historyMine').textContent.includes('2 个')", 'p2 看到 2 个');
    console.log('ok 第 2 猜：1200 → 2 个');

    // 手机视口截图 + 横向溢出检查
    let overflow = await evalIn(cdp, p1, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assert(overflow <= 1, '手机视口横向溢出 ' + overflow + 'px');
    await screenshot(cdp, p1, path.join(OUT_DIR, 'bulls-mobile.png'));

    // 第 3 猜：alice 猜中 5678
    await evalIn(cdp, p1, guess('5678'));
    await waitFor(cdp, p1, "document.getElementById('resultBand').textContent.indexOf('你赢了') === 0", 'p1 判胜');
    await waitFor(cdp, p2, "document.getElementById('resultBand').textContent.indexOf('对手先猜中') === 0", 'p2 判负');

    const reveal1 = await evalIn(cdp, p1, "document.getElementById('revealLine').textContent");
    const reveal2 = await evalIn(cdp, p2, "document.getElementById('revealLine').textContent");
    assert(reveal1.includes('1234') && reveal1.includes('5678'), 'p1 结算未亮出双方暗号: ' + reveal1);
    assert(reveal2.includes('1234') && reveal2.includes('5678'), 'p2 结算未亮出双方暗号: ' + reveal2);
    console.log('ok 胜负判定与暗号揭晓一致');

    const rematchHeight = await evalIn(cdp, p1, "document.getElementById('btnRematch').getBoundingClientRect().height");
    assert(rematchHeight >= 44, '再来一局按钮高度不足 44px: ' + rematchHeight);

    // 桌面视口截图 + 溢出检查
    await setViewport(cdp, p1, DESKTOP.width, DESKTOP.height, false);
    await setViewport(cdp, p2, DESKTOP.width, DESKTOP.height, false);
    await waitFor(cdp, p1, 'window.innerWidth > 1000', '桌面视口生效');
    overflow = await evalIn(cdp, p1, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assert(overflow <= 1, '桌面视口横向溢出 ' + overflow + 'px');
    await screenshot(cdp, p1, path.join(OUT_DIR, 'bulls-desktop.png'));

    // 再来一局
    await evalIn(cdp, p1, "document.getElementById('btnRematch').click(), true");
    await waitFor(cdp, p1, "document.getElementById('roundTag').textContent === '第 2 局'", 'p1 进入第 2 局');
    await waitFor(cdp, p2, "document.getElementById('roundTag').textContent === '第 2 局'", 'p2 进入第 2 局');
    await waitFor(cdp, p1, "!document.getElementById('setupBox').classList.contains('hidden')", 'p1 重新设暗号');
    const canRetype = await evalIn(cdp, p2, "!document.getElementById('secretInput').disabled");
    assert(canRetype, '第 2 局暗号输入框应当重新可用');
    console.log('ok 再来一局：双方回到设暗号');

    if (cdp.exceptions.length) throw new Error('页面异常: ' + cdp.exceptions.join(' | '));
    if (cdp.consoleErrors.length) throw new Error('console.error: ' + cdp.consoleErrors.join(' | '));

    console.log('bulls-ui ok: 手机 + 桌面双视口，完整对局，截图 .tmp/bulls-mobile.png / .tmp/bulls-desktop.png');
  } catch (err) {
    await dump(cdp, pages);
    throw err;
  } finally {
    browser.close();
  }
})().catch((err) => {
  console.error('bulls-ui failed:', err.message);
  process.exitCode = 1;
});
