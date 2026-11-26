// 打飞机纯逻辑单测：不需要服务器、不需要 DOM。
//   node web/test/plane-core.test.js
'use strict';

const assert = require('assert');
const C = require('../plane-core.js');

let passed = 0;
function it(name, fn) {
  fn();
  passed++;
  console.log('ok ' + name);
}

// 静默世界：停止刷怪，方便单独测某条规则。
function quiet(w) {
  w.toSpawn = 0;
  w.intermission = 9999;
  w.enemies = [];
  return w;
}

function one(opts) {
  return C.newWorld(Object.assign({
    seed: 1,
    players: [{ slot: 1, color: 0 }],
    maxWave: 15
  }, opts || {}));
}

// ---------------------------------------------------------------- 追踪

it('seek 单帧位移不超过 maxSpeed*dt', () => {
  const a = C.seek({ x: 0, y: 0 }, { x: 1000, y: 0 }, 300, 1 / 30);
  assert.ok(Math.abs(a.x - 10) < 1e-9);
  assert.strictEqual(a.y, 0);
});

it('seek 不越界、不过冲、带死区', () => {
  const b = C.seek({ x: 0, y: 0 }, { x: 5, y: 0 }, 300, 1);
  assert.strictEqual(b.x, 5);
  const c = C.seek({ x: 10, y: 10 }, { x: 10.2, y: 10.1 }, 300, 1);
  assert.strictEqual(c.x, 10);
  assert.strictEqual(c.y, 10);
});

it('seek 对角线速度仍是 maxSpeed', () => {
  const a = C.seek({ x: 0, y: 0 }, { x: 300, y: 400 }, 300, 0.1);
  const d = Math.hypot(a.x, a.y);
  assert.ok(Math.abs(d - 30) < 1e-6);
});

// ---------------------------------------------------------------- 世界

it('newWorld 按人数分散出生，初始相位 playing', () => {
  const w = C.newWorld({
    seed: 7,
    players: [{ slot: 1, color: 0 }, { slot: 2, color: 1 }]
  });
  assert.strictEqual(w.phase, C.PHASE.PLAYING);
  assert.strictEqual(w.wave, 1);
  assert.strictEqual(w.players.length, 2);
  assert.ok(w.players[0].x < w.players[1].x);
  assert.strictEqual(w.players[0].y, C.C.WORLD_H - 80);
});

it('setAim 会把目标点钳到可移动区域', () => {
  const w = one();
  C.setAim(w, 1, -1000, 9999);
  const p = w.players[0];
  assert.strictEqual(p.aimX, C.C.MARGIN_X);
  assert.strictEqual(p.aimY, C.C.WORLD_H - C.C.MARGIN_BOTTOM);
});

it('玩家以固定速度追目标点，不会瞬移', () => {
  const w = quiet(one());
  const p = w.players[0];
  const x0 = p.x;
  C.setAim(w, 1, p.x + 160, p.y);
  C.step(w);
  assert.ok(p.x - x0 <= 10 + 1e-6, '单 tick 位移不应超过 10px');
  assert.ok(p.x - x0 > 5);
  for (let i = 0; i < 20; i++) C.step(w);
  assert.ok(Math.abs(p.x - (x0 + 160)) < 0.001, '20 tick 内应到达目标');
});

// ---------------------------------------------------------------- 开火

it('自动开火按 FIRE_INTERVAL 生成子弹，速度向上', () => {
  const w = quiet(one());
  for (let i = 0; i < 30; i++) C.step(w);
  assert.ok(w.pbullets.length >= 4);
  assert.ok(w.pbullets.length <= C.C.MAX_PBULLETS);
  for (const b of w.pbullets) {
    assert.ok(b.vy < 0);
    assert.strictEqual(b.owner, 1);
  }
});

it('我弹超过上限时丢最旧的', () => {
  const w = quiet(one());
  for (let i = 0; i < C.C.MAX_PBULLETS; i++) {
    w.pbullets.push({ x: 10, y: 10, vx: 0, vy: 0, owner: 1, kind: 0 });
  }
  w.players[0].fireCd = 0;
  C.step(w);
  assert.ok(w.pbullets.length <= C.C.MAX_PBULLETS);
});

// ---------------------------------------------------------------- 碰撞

it('我弹命中敌机：加分并移除', () => {
  const w = quiet(one());
  const p = w.players[0];
  const e = C.spawnEnemy(w, 0, p.x, p.y - 100);
  w.pbullets.push({ x: e.x, y: e.y, vx: 0, vy: 0, owner: 1, kind: 0 });
  C.step(w);
  assert.ok(w.score >= 10);
  assert.ok(!w.enemies.some((x) => x.id === e.id));
});

it('敌弹命中玩家：扣血、进入无敌', () => {
  const w = quiet(one());
  const p = w.players[0];
  w.ebullets.push({ x: p.x, y: p.y, vx: 0, vy: 0, kind: 0 });
  C.step(w);
  assert.strictEqual(p.hp, 2);
  assert.strictEqual(p.state, 1);
  assert.ok(p.invuln > 0);

  w.ebullets.push({ x: p.x, y: p.y, vx: 0, vy: 0, kind: 0 });
  C.step(w);
  assert.strictEqual(p.hp, 2, '无敌期间不再扣血');
});

it('敌机撞机也会扣血', () => {
  const w = quiet(one());
  const p = w.players[0];
  C.spawnEnemy(w, 0, p.x, p.y);
  C.step(w);
  assert.strictEqual(p.hp, 2);
});

it('命耗尽后倒地 90 tick 再重生', () => {
  const w = quiet(one());
  const p = w.players[0];
  p.hp = 1;
  p.state = 0;
  p.invuln = 0;
  w.ebullets.push({ x: p.x, y: p.y, vx: 0, vy: 0, kind: 0 });
  C.step(w);
  assert.strictEqual(p.lives, 2);
  assert.strictEqual(p.state, 2);
  assert.ok(p.respawn > 0);

  for (let i = 0; i < C.C.RESPAWN_TICKS; i++) C.step(w);
  assert.strictEqual(p.hp, C.C.PLAYER_HP);
  assert.strictEqual(p.state, 1);
  assert.ok(p.invuln > 0);
});

it('最后一条命耗尽 → 观战 → 判负', () => {
  const w = quiet(one());
  const p = w.players[0];
  p.lives = 1;
  p.hp = 1;
  p.state = 0;
  p.invuln = 0;
  w.ebullets.push({ x: p.x, y: p.y, vx: 0, vy: 0, kind: 0 });
  C.step(w);
  assert.strictEqual(p.lives, 0);
  assert.strictEqual(p.state, 3);
  assert.strictEqual(w.phase, C.PHASE.OVER);
  assert.strictEqual(w.win, false);
});

// ---------------------------------------------------------------- 波次 / Boss

function nextWave(w) {
  w.toSpawn = 0;
  w.enemies = [];
  w.intermission = 1;
  C.step(w);
}

it('清波后进入下一波', () => {
  const w = quiet(one());
  w.wave = 1;
  w.toSpawn = 0;
  w.enemies = [];
  w.intermission = 0;
  C.step(w);
  assert.ok(w.intermission > 0);
  w.intermission = 1;
  C.step(w);
  assert.strictEqual(w.wave, 2);
});

it('第 5 波出 Boss', () => {
  const w = quiet(one());
  while (w.wave < 5) nextWave(w);
  C.step(w);
  assert.ok(w.enemies.some((e) => e.kind === 3));
  assert.ok(C.bossOf(w));
});

it('Boss 悬停后开火', () => {
  const w = quiet(one());
  while (w.wave < 5) nextWave(w);
  C.step(w);
  const boss = C.bossOf(w);
  boss.entered = true;
  boss.y = C.C.BOSS_HOVER_Y;
  boss.fireCd = 1;
  C.step(w);
  assert.ok(w.ebullets.length > 0);
});

it('第 15 波清空 → 通关', () => {
  const w = quiet(one());
  w.wave = w.maxWave;
  w.toSpawn = 0;
  w.enemies = [];
  w.intermission = 0;
  C.step(w);
  assert.strictEqual(w.phase, C.PHASE.OVER);
  assert.strictEqual(w.win, true);
});

// ---------------------------------------------------------------- 连接 / 确定性

it('断线玩家冻结、回来补无敌', () => {
  const w = quiet(one());
  const p = w.players[0];
  C.setConnected(w, 1, false);
  const x = p.x;
  C.setAim(w, 1, p.x + 100, p.y);
  for (let i = 0; i < 10; i++) C.step(w);
  assert.strictEqual(p.x, x, '离线期间不应移动');

  C.setConnected(w, 1, true);
  assert.strictEqual(p.state, 1);
  assert.ok(p.invuln >= 60);
});

it('removePlayer 移除成员', () => {
  const w = C.newWorld({
    seed: 1,
    players: [{ slot: 1, color: 0 }, { slot: 2, color: 1 }]
  });
  C.removePlayer(w, 2);
  assert.strictEqual(w.players.length, 1);
  assert.strictEqual(w.players[0].slot, 1);
});

it('同 seed 同输入跑 120 tick，世界哈希一致', () => {
  function run(seed) {
    const w = C.newWorld({
      seed: seed,
      players: [{ slot: 1, color: 0 }, { slot: 2, color: 1 }]
    });
    w.toSpawn = 0;
    w.intermission = 9999;
    C.spawnEnemy(w, 1);          // 随机 x，用 seed 驱动的 rng
    C.spawnEnemy(w, 2, 100, 60);
    C.setAim(w, 1, 200, 300);
    C.setAim(w, 2, 380, 420);
    for (let i = 0; i < 120; i++) C.step(w);
    return C.hashWorld(w);
  }
  assert.strictEqual(run(42), run(42));
  assert.notStrictEqual(run(42), run(43));
});

console.log('\n' + passed + ' passed');
