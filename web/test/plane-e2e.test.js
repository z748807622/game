// 打飞机端到端测试：真服务器 + 一个 Node 主机 + 三个队友。
//   RELAY_URL=ws://127.0.0.1:18080/ws node web/test/plane-e2e.test.js
'use strict';

require('./ws-polyfill.js');

const assert = require('assert');
const R = require('../relay.js');
const C = require('../plane-core.js');
const N = require('../plane-net.js');

const URL = process.env.RELAY_URL || 'ws://127.0.0.1:18080/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(c, ev, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting ' + ev)), timeoutMs);
    c.on(ev, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function waitFor(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error('timeout: ' + label);
}

function slotsOf(client) {
  const out = [];
  for (const m of client.members) out.push(m.slot);
  if (!out.length && client.slot) out.push(client.slot);
  return out;
}

function playerOf(w, slot) {
  return C.findPlayer(w, slot);
}

// ---------------------------------------------------------------- 主机

class Host {
  constructor(name) {
    this.name = name;
    this.client = new R.RelayClient({ url: URL, token: name, autoReconnect: true });
    this.world = null;
    this.timer = null;
    this.aim = { x: 240, y: 600 };
    this.lastSnap = -1;
    this.snaps = 0;
    this.lastSnap = null;
    this.gaps = 0;
    this.client.on('gap', () => this.gaps++);
    this.client.on('relay', (m) => this.onRelay(m));
  }

  async connect() {
    await this.client.connect();
  }

  async create() {
    const p = once(this.client, 'created');
    this.client.create('', { name: this.name });
    await p;
  }

  online() {
    return this.client.members
      .filter((m) => m.online)
      .sort((a, b) => a.slot - b.slot);
  }

  start() {
    const players = this.online().slice(0, 4).map((m, i) => ({ slot: m.slot, color: i }));
    const seed = (Date.now() & 0xffff) + 7;
    this.config = { seed: seed, mode: 0, maxWave: C.C.MAX_WAVE, players: players };
    this.world = C.newWorld({
      seed: seed,
      players: players,
      maxWave: C.C.MAX_WAVE,
      tick0: Math.floor(Date.now() / C.C.TICK_MS)
    });
    const me = playerOf(this.world, this.client.slot);
    if (me) this.aim = { x: me.x, y: me.y };
    this.client.lock(true);
    this.send(N.encodeStart(this.config));
    this.snap();
    this.timer = setInterval(() => this.tick(), 33);
  }

  tick() {
    if (!this.world || this.world.phase !== C.PHASE.PLAYING) return;
    C.setAim(this.world, this.client.slot, this.aim.x, this.aim.y);
    C.step(this.world);
    if (this.world.tick % 2 === 0 && this.world.tick !== this.lastSnap) this.snap();
    if (this.world.phase !== C.PHASE.PLAYING) {
      this.snap();
      this.stop();
    }
  }

  snap() {
    if (!this.world) return;
    this.lastSnap = this.world.tick;
    this.snaps++;
    this.send(N.encodeSnapshot(this.world));
  }

  send(bytes) {
    this.client.relayBytes(bytes, slotsOf(this.client));
  }

  onRelay(m) {
    let msg;
    try { msg = N.decode(m.payload); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === N.TYPE.INPUT && this.world && m.from !== this.client.slot) {
      C.setAim(this.world, m.from, msg.x, msg.y);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  leave() {
    this.stop();
    if (this.client.joined) this.client.leave();
  }
}

// ---------------------------------------------------------------- 队友

class Peer {
  constructor(name, autoReconnect = true) {
    this.name = name;
    this.client = new R.RelayClient({ url: URL, token: name, autoReconnect: autoReconnect });
    this.aim = { x: 240, y: 600 };
    this.snaps = 0;
    this.gaps = 0;
    this.resyncs = 0;
    this.started = false;
    this.timer = null;
    this.client.on('gap', () => this.gaps++);
    this.client.on('resync', () => this.resyncs++);
    this.client.on('relay', (m) => this.onRelay(m));
  }

  async connect() {
    await this.client.connect();
  }

  async join(code) {
    const p = once(this.client, 'joined');
    this.client.join(code, '', { name: this.name });
    await p;
  }

  onRelay(m) {
    let msg;
    try { msg = N.decode(m.payload); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === N.TYPE.START) this.started = true;
    if (msg.type === N.TYPE.SNAP) {
      this.snaps++;
      this.lastSnap = msg;
    }
  }

  startInput() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.client.joined) return;
      this.client.relayBytes(N.encodeInput(this.aim), slotsOf(this.client));
    }, 33);
  }

  stopInput() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------- 测试

(async () => {
  const host = new Host('host');
  const p1 = new Peer('p1', true);
  const p2 = new Peer('p2', true);
  const p3 = new Peer('p3', false); // 手动控制重连，用来触发 RESYNC

  try {
    await host.connect();
    await host.create();
    console.log('ok 建房', host.client.code);

    for (const p of [p1, p2, p3]) {
      await p.connect();
      await p.join(host.client.code);
    }
    await waitFor(() => host.client.members.length === 4, '4 人进房');
    console.log('ok 三人加入');

    host.start();
    await waitFor(() => p1.started && p2.started && p3.started, 'START 到达所有队友');
    console.log('ok START 广播');

    // 让玩家不被打死，专心测同步
    for (const p of host.world.players) {
      p.invuln = 100000;
      p.state = 1;
    }

    p1.startInput();
    p2.startInput();
    p3.startInput();

    // ---- 快照频率
    await waitFor(() => p1.snaps >= 5, '收到快照');
    const n0 = p1.snaps;
    await sleep(1000);
    const rate = p1.snaps - n0;
    assert.ok(rate >= 8, '1 秒快照数应 ≥8，实际 ' + rate);
    console.log('ok 快照频率 ' + rate + '/s');

    // ---- 目标点同步：p1 把目标点甩到远处，主机看到玩家以速度上限移动
    const p1Slot = p1.client.slot;
    const before = { x: playerOf(host.world, p1Slot).x, y: playerOf(host.world, p1Slot).y };
    p1.aim = { x: 400, y: 200 };
    await sleep(700);
    const after = playerOf(host.world, p1Slot);
    assert.ok(after.x > before.x + 40, 'p1 应该向右移动');
    assert.ok(after.y < before.y - 40, 'p1 应该向上移动');
    const distToAim = Math.hypot(after.x - 400, after.y - 200);
    assert.ok(distToAim > 20, '700ms 内不应瞬移到目标点');
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    assert.ok(moved <= 300 * 0.7 + 40, '移动距离不应超过速度上限: ' + moved);
    console.log('ok 目标点同步，700ms 移动 ' + Math.round(moved) + 'px');

    // ---- 战斗：给主机面前放一个敌机，自动开火应拿到分
    const me = playerOf(host.world, host.client.slot);
    C.spawnEnemy(host.world, 0, me.x, me.y - 120);
    await waitFor(() => host.world.score > 0, '击杀得分', 2500);
    console.log('ok 战斗得分', host.world.score);

    // ---- 队友断线重连：补发窗口内应无缝恢复
    const resumed = once(p1.client, 'resumed', 6000);
    const snapsBeforeResume = p1.snaps;
    p1.client.ws.close(4000, 'drop');
    await resumed;
    await waitFor(() => p1.snaps > snapsBeforeResume, '重连后继续收到快照');
    console.log('ok 队友断线重连');

    // ---- 撑大快照并让 p3 离线 > 环形窗口，触发 RESYNC
    const w = host.world;
    w.enemies = [];
    w.toSpawn = 0;
    w.intermission = 9999;
    for (let i = 0; i < C.C.MAX_EBULLETS; i++) {
      C.addEBullet(w, 20 + (i % 90), 100 + Math.floor(i / 90) * 8, 0, 0, 0);
    }
    for (let i = 0; i < C.C.MAX_PBULLETS; i++) {
      w.pbullets.push({ x: 20 + (i % 60), y: 300 + Math.floor(i / 60) * 10, vx: 0, vy: 0, owner: host.client.slot, kind: 0 });
    }
    await sleep(300);
    const snapBytes = N.encodeSnapshot(w).length;
    assert.ok(snapBytes > 1600, '快照应接近上限，实际 ' + snapBytes);
    console.log('ok 高压快照 ' + snapBytes + 'B');

    const snapsBeforeGap = p3.snaps;
    p3.client.ws.close(4000, 'drop');
    await sleep(4000);
    const resync = once(p3.client, 'resync', 8000);
    await p3.client.connect();
    const resyncEv = await resync;
    assert.ok(resyncEv, '应收到 RESYNC');
    await waitFor(() => p3.snaps > snapsBeforeGap, 'RESYNC 后收到新快照');
    console.log('ok RESYNC 自愈，reason=' + resyncEv.reason);

    // ---- 结算：清空最后一波 → 主机发 over 快照，队友应看到 win
    host.world.wave = host.world.maxWave;
    host.world.enemies = [];
    host.world.toSpawn = 0;
    host.world.intermission = 0;
    await waitFor(() => p1.lastSnap && p1.lastSnap.phase === 'over', '收到结算快照', 3000);
    assert.strictEqual(p1.lastSnap.win, true);
    assert.strictEqual(host.world.phase, C.PHASE.OVER);
    console.log('ok 结算快照广播');

    // ---- 房主离开：其他人收到 HOST 转移
    const hostSlot = host.client.slot;
    const hostChange = once(p1.client, 'host', 6000);
    host.leave();
    const ev = await hostChange;
    assert.ok(ev.slot && ev.slot !== hostSlot, '房主应转移给其他成员');
    console.log('ok 房主转移给 #' + ev.slot);

    // ---- 全程 seq 不应出现空洞
    assert.strictEqual(p1.gaps, 0, 'p1 不应出现 seq 空洞');
    assert.strictEqual(p2.gaps, 0, 'p2 不应出现 seq 空洞');
    assert.strictEqual(p3.gaps, 0, 'p3 不应出现 seq 空洞');
    console.log('ok 全员 seq 连续');

    console.log('\nplane e2e passed');
    cleanup([host, p1, p2, p3]);
    process.exit(0);
  } catch (err) {
    console.error('FAIL', err && err.stack ? err.stack : err);
    cleanup([host, p1, p2, p3]);
    process.exit(1);
  }
})();

function cleanup(list) {
  for (const x of list) {
    try {
      if (x.stop) x.stop();
      if (x.stopInput) x.stopInput();
      if (x.client) x.client.close();
    } catch (e) { /* ignore */ }
  }
}
