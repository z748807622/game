// 猜数字端到端测试：真服务器 + 两个 RelayClient，完整走一遍协议和状态机。
//   node web/test/bulls-e2e.test.js
// 环境变量：RELAY_URL（默认 ws://127.0.0.1:18080/ws）
'use strict';

require('./ws-polyfill.js'); // Node 18 没有全局 WebSocket
const assert = require('assert');
const R = require('../relay.js');
const B = require('../bulls-core.js');

const URL = process.env.RELAY_URL || 'ws://127.0.0.1:18080/ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(c, ev, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting ' + ev)), timeoutMs);
    c.on(ev, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function waitFor(fn, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error('timeout: ' + label);
}

// Peer 是页面控制器的协议层：收消息 → 状态机 → 必要时判定。
class Peer {
  constructor(name) {
    this.name = name;
    this.secret = '';
    this.payloads = [];
    this.game = B.newGame({});
    this.client = new R.RelayClient({ url: URL, token: name });
    this.client.on('relay', (m) => this.onRelay(m));
  }

  async connect() {
    await this.client.connect();
  }

  bind(state) {
    const others = state.members.filter((m) => m.slot !== state.slot).map((m) => m.slot);
    this.game = B.bindPlayers(this.game, {
      selfSlot: state.slot,
      otherSlot: others[0] || 0,
      hostSlot: state.host
    });
  }

  async create() {
    const p = once(this.client, 'created');
    this.client.create('', { name: this.name });
    const state = await p;
    this.bind(state);
    return state;
  }

  async join(code) {
    const p = once(this.client, 'joined');
    this.client.join(code, '', { name: this.name });
    const state = await p;
    this.bind(state);
    return state;
  }

  send(msg) {
    // 房间 seq 是全局的：目标里带上自己，双方都收到每一帧，seq 才连续。
    const targets = [this.client.slot, this.game.otherSlot].filter((s) => s > 0);
    this.client.relay(msg, targets);
  }

  setSecret(secret) {
    this.secret = secret;
    const msg = { t: 'secret', round: this.game.round };
    this.send(msg);
    const r = B.applySecret(this.game, { t: 'secret', from: this.client.slot, round: this.game.round });
    assert.ok(r.ok, 'applySecret 失败: ' + r.reason);
    this.game = r.state;
  }

  start() {
    const turn = this.game.round % 2 === 1 ? this.game.hostSlot : this.game.otherSlot;
    const msg = { t: 'start', round: this.game.round, turn };
    this.send(msg);
    const r = B.applyStart(this.game, msg);
    assert.ok(r.ok, 'applyStart 失败: ' + r.reason);
    this.game = r.state;
  }

  rematch() {
    const msg = { t: 'rematch', round: this.game.round + 1 };
    this.send(msg);
    const r = B.applyRematch(this.game, msg);
    assert.ok(r.ok, 'applyRematch 失败: ' + r.reason);
    this.game = r.state;
  }

  guess(n) {
    this.send({ t: 'guess', round: this.game.round, n });
  }

  onRelay(m) {
    const msg = JSON.parse(R.fromUtf8(m.payload));
    this.payloads.push(msg);
    if (m.from === this.client.slot) return; // 自己的回显，本地已应用
    msg.from = m.from;
    switch (msg.t) {
      case 'secret': {
        const r = B.applySecret(this.game, msg);
        if (r.ok) this.game = r.state;
        break;
      }
      case 'start': {
        const r = B.applyStart(this.game, msg);
        if (r.ok) this.game = r.state;
        break;
      }
      case 'guess':
        this.judge(m.from, msg);
        break;
      case 'judge': {
        const r = B.applyJudge(this.game, msg);
        if (r.ok) this.game = r.state;
        break;
      }
      case 'rematch': {
        const r = B.applyRematch(this.game, msg);
        if (r.ok) this.game = r.state;
        break;
      }
      case 'sync_req':
        this.send({ t: 'sync', state: B.snapshot(this.game) });
        break;
      case 'sync': {
        const r = B.restore(this.game, msg.state);
        if (r.ok) this.game = r.state;
        break;
      }
      default:
        break;
    }
  }

  // 我是裁判：本地判定，结果广播给双方（自己也按同一条消息迁移）。
  judge(from, msg) {
    if (!this.secret) return;
    if (this.game.phase !== B.PHASE.PLAYING) return;
    if (Number(msg.round) !== this.game.round || from !== this.game.turn) return;
    const h = B.hits(this.secret, msg.n);
    const win = h === B.MAX_HITS;
    const judgeMsg = {
      t: 'judge',
      round: this.game.round,
      by: this.client.slot,
      guess: msg.n,
      hits: h,
      win,
      winner: win ? from : 0,
      next: win ? 0 : this.client.slot
    };
    this.send(judgeMsg);
    const r = B.applyJudge(this.game, judgeMsg);
    assert.ok(r.ok, 'applyJudge 失败: ' + r.reason);
    this.game = r.state;
  }
}

async function playTurn(guesser, judge, n) {
  const before = guesser.game.history.length;
  guesser.guess(n);
  await waitFor(
    () => judge.game.history.length === before + 1 && guesser.game.history.length === before + 1,
    '双方都收到判定 (猜 ' + n + ')'
  );
  assert.deepStrictEqual(guesser.game.history, judge.game.history, '双方历史必须一致');
  assert.strictEqual(guesser.game.turn, judge.game.turn, '双方回合必须一致');
}

(async () => {
  const a = new Peer('alice');
  const b = new Peer('bob');
  await a.connect();
  await b.connect();
  console.log('ok 两个客户端已连接');

  const room = await a.create();
  assert.strictEqual(room.slot, 1);
  const joined = await b.join(room.code);
  assert.strictEqual(joined.slot, 2);
  console.log('ok 建房 / 加入', room.code);

  // 两个人各自看到对方，绑定角色
  a.game = B.bindPlayers(a.game, { selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  b.game = B.bindPlayers(b.game, { selfSlot: 2, otherSlot: 1, hostSlot: 1 });

  // 秘密数字绝对不能进 payload
  a.setSecret('1234');
  b.setSecret('5678');
  await waitFor(() => a.game.ready[2] && b.game.ready[1], '双方就绪');
  const secretMsgs = a.payloads.concat(b.payloads).filter((p) => p.t === 'secret');
  assert.ok(secretMsgs.length >= 2, '应当收到 secret 通知');
  for (const p of secretMsgs) {
    assert.strictEqual(p.secret, undefined, 'secret 消息不能带暗号');
    assert.strictEqual(p.reveal, undefined, 'secret 消息不能带暗号');
  }
  console.log('ok 暗号只留在本地，payload 只广播「已就绪」');

  a.start();
  await waitFor(() => a.game.phase === B.PHASE.PLAYING && b.game.phase === B.PHASE.PLAYING, '开局');
  assert.strictEqual(a.game.turn, 1, '第 1 局房主先猜');

  await playTurn(a, b, '1111'); // bob 的 5678 对 1111 → 0
  assert.strictEqual(b.game.history[0].hits, 0);
  await playTurn(b, a, '1200'); // alice 的 1234 对 1200 → 2
  assert.strictEqual(a.game.history[1].hits, 2);
  console.log('ok 轮流判定与换手正常，hits=' + a.game.history[1].hits);

  // 越权：此刻轮到 alice，bob 抢猜不该被采纳
  b.guess('9999');
  await sleep(200);
  assert.strictEqual(a.game.history.length, 2, '越权猜测不应被采纳');
  assert.strictEqual(b.game.history.length, 2, '越权猜测不应产生判定');
  console.log('ok 非本回合猜测被丢弃');

  // alice 猜中 bob 的 5678
  await playTurn(a, b, '5678');
  assert.strictEqual(a.game.phase, B.PHASE.OVER);
  assert.strictEqual(a.game.winner, 1);
  assert.strictEqual(b.game.winner, 1);
  assert.strictEqual(a.game.history[a.game.history.length - 1].hits, 4);
  console.log('ok 第 1 局：alice 猜中，双方一致判胜');

  // 再来一局：先手交替给 bob，bob 猜中 alice 的暗号
  a.rematch();
  await waitFor(() => b.game.round === 2 && b.game.phase === B.PHASE.SETUP, 'bob 进入第 2 局');
  a.setSecret('1234');
  b.setSecret('5678');
  await waitFor(() => a.game.ready[2] && b.game.ready[1], '第 2 局双方就绪');
  a.start(); // 第 2 局先手是 bob
  await waitFor(() => b.game.phase === B.PHASE.PLAYING, 'bob 收到开局');
  assert.strictEqual(b.game.turn, 2, '第 2 局应当由 bob 先猜');
  await playTurn(b, a, '1234');
  assert.strictEqual(a.game.phase, B.PHASE.OVER);
  assert.strictEqual(a.game.winner, 2);
  assert.strictEqual(b.game.winner, 2);
  console.log('ok 第 2 局：先手交替，bob 猜中');

  // RESYNC 语义：bob 要快照，alice 回全量状态
  b.send({ t: 'sync_req' });
  await waitFor(() => b.game.phase === B.PHASE.OVER && b.game.round === 2, '快照恢复');
  assert.deepStrictEqual(B.snapshot(a.game), B.snapshot(b.game), '快照应一致');
  console.log('ok sync_req / sync 快照一致');

  // 满 2 人锁定后，第三人被拒
  a.client.lock(true);
  const c = new R.RelayClient({ url: URL, token: 'carol' });
  await c.connect();
  const errP = once(c, 'serverError');
  c.join(room.code, '', { name: 'carol' });
  const err = await errP;
  assert.strictEqual(err.name, 'ROOM_LOCKED');
  c.close();
  console.log('ok 第三人加入被 ROOM_LOCKED 拒绝');

  a.client.close();
  b.client.close();
  await sleep(50);
  console.log('\nbulls-e2e: all passed');
  process.exit(0);
})().catch((err) => {
  console.error('bulls-e2e failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
