// 打飞机二进制 payload 单测：不依赖服务器/DOM。
//   node web/test/plane-net.test.js
'use strict';

const assert = require('assert');
const N = require('../plane-net.js');

let passed = 0;
function it(name, fn) {
  fn();
  passed++;
  console.log('ok ' + name);
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function fixture() {
  return {
    tick: 1234,
    phase: 'playing',
    win: false,
    wave: 3,
    score: 5678,
    players: [
      { slot: 1, x: 100.25, y: 600.5, hp: 2, lives: 3, state: 0, connected: true }
    ],
    enemies: [
      { id: 7, kind: 2, x: 200.75, y: 120.25, hp: 4, boss: false }
    ],
    ebullets: [
      { x: 50.5, y: 100.25, vx: 2, vy: -3, kind: 1 }
    ],
    pbullets: [
      { x: 100.25, y: 300, vx: 0, vy: -22, owner: 1, kind: 0 }
    ]
  };
}

function bigWorld() {
  const w = {
    tick: 1, phase: 'playing', win: false, wave: 15, score: 0,
    players: [], enemies: [], ebullets: [], pbullets: []
  };
  for (let i = 0; i < 4; i++) {
    w.players.push({ slot: i + 1, x: 100 + i * 10, y: 600, hp: 3, lives: 3, state: 0, connected: true });
  }
  for (let i = 0; i < 24; i++) {
    w.enemies.push({ id: i + 1, kind: 0, x: 40 + i * 15, y: 100, hp: 1, boss: false });
  }
  for (let i = 0; i < 160; i++) {
    w.ebullets.push({ x: 20 + (i % 100), y: 50 + Math.floor(i / 100) * 10, vx: 1, vy: 1, kind: 0 });
  }
  for (let i = 0; i < 64; i++) {
    w.pbullets.push({ x: 20 + i, y: 400, vx: 0, vy: -22, owner: 1, kind: 0 });
  }
  return w;
}

// ---------------------------------------------------------------- INPUT

it('INPUT 往返：目标点定点 1/4px', () => {
  const b = N.encodeInput({ x: 100.25, y: 600.5, flags: 0 });
  assert.strictEqual(b.length, 8);
  assert.strictEqual(hex(b), '5001019101620900');
  const d = N.decode(b);
  assert.deepStrictEqual(d, { type: 1, x: 100.25, y: 600.5, flags: 0 });
});

it('INPUT 未知 flags 原样返回、坐标钳到 u16', () => {
  const d = N.decode(N.encodeInput({ x: 1e9, y: -5, flags: 0xaa }));
  assert.strictEqual(d.flags, 0xaa);
  assert.strictEqual(d.x, 65535 / 4);
  assert.strictEqual(d.y, 0);
});

// ---------------------------------------------------------------- START

it('START 往返：seed/mode/maxWave/玩家颜色', () => {
  const b = N.encodeStart({
    seed: 99, mode: 0, maxWave: 15,
    players: [{ slot: 1, color: 0 }, { slot: 2, color: 1 }]
  });
  assert.strictEqual(b.length, 16);
  assert.strictEqual(hex(b), '50010363000000000f02010000020001');
  const d = N.decode(b);
  assert.deepStrictEqual(d, {
    type: 3, seed: 99, mode: 0, maxWave: 15,
    players: [{ slot: 1, color: 0 }, { slot: 2, color: 1 }]
  });
});

it('START 满 4 人 22B', () => {
  const players = [1, 2, 3, 4].map((s, i) => ({ slot: s, color: i }));
  const b = N.encodeStart({ seed: 1, players: players });
  assert.strictEqual(b.length, 22);
  assert.strictEqual(N.decode(b).players.length, 4);
});

// ---------------------------------------------------------------- SNAP

it('SNAP 往返：全字段 + 黄金字节', () => {
  const b = N.encodeSnapshot(fixture());
  assert.strictEqual(b.length, 57);
  assert.strictEqual(hex(b),
    '500102d2040000010003002e160000000000000101009101620902030003010700022303e101040001ca00910102fd01019101b00400ea0100');

  const d = N.decode(b);
  assert.strictEqual(d.type, 2);
  assert.strictEqual(d.tick, 1234);
  assert.strictEqual(d.phase, 'playing');
  assert.strictEqual(d.win, false);
  assert.strictEqual(d.wave, 3);
  assert.strictEqual(d.score, 5678);
  assert.strictEqual(d.bossHp, 0);
  assert.strictEqual(d.players.length, 1);
  assert.deepStrictEqual(d.players[0], {
    slot: 1, x: 100.25, y: 600.5, hp: 2, lives: 3, state: 0,
    flags: 3, online: true, firing: true
  });
  assert.strictEqual(d.enemies[0].id, 7);
  assert.strictEqual(d.enemies[0].x, 200.75);
  assert.strictEqual(d.ebullets[0].vx, 2);
  assert.strictEqual(d.ebullets[0].vy, -3);
  assert.strictEqual(d.pbullets[0].owner, 1);
  assert.strictEqual(d.pbullets[0].vy, -22);
});

it('SNAP 最大尺寸 1911B', () => {
  assert.strictEqual(N.encodeSnapshot(bigWorld()).length, 1911);
});

it('SNAP 编码按上限截断', () => {
  const w = bigWorld();
  w.players.push({ slot: 5, x: 1, y: 1, hp: 1, lives: 1, state: 0, connected: true });
  w.enemies.push({ id: 99, kind: 0, x: 1, y: 1, hp: 1 });
  w.ebullets.push({ x: 1, y: 1, vx: 1, vy: 1, kind: 0 });
  w.pbullets.push({ x: 1, y: 1, vx: 0, vy: -1, owner: 1, kind: 0 });
  const d = N.decode(N.encodeSnapshot(w));
  assert.strictEqual(d.players.length, 4);
  assert.strictEqual(d.enemies.length, 24);
  assert.strictEqual(d.ebullets.length, 160);
  assert.strictEqual(d.pbullets.length, 64);
});

it('SNAP Boss 血量/标记', () => {
  const w = fixture();
  w.enemies = [{ id: 3, kind: 3, x: 240, y: 120, hp: 88, maxHp: 120, boss: true }];
  const d = N.decode(N.encodeSnapshot(w));
  assert.strictEqual(d.bossHp, 88);
  assert.strictEqual(d.bossMaxHp, 120);
  assert.strictEqual(d.enemies[0].boss, true);
});

it('SNAP 胜负 flags 可解码', () => {
  const w = fixture();
  w.phase = 'over';
  w.win = true;
  const d = N.decode(N.encodeSnapshot(w));
  assert.strictEqual(d.phase, 'over');
  assert.strictEqual(d.win, true);
});

// ---------------------------------------------------------------- 错误处理

it('未知 magic / ver / type 返回 null', () => {
  const b = N.encodeSnapshot(fixture());
  const m = b.slice();
  m[0] = 0x51;
  assert.strictEqual(N.decode(m), null);
  const v = b.slice();
  v[1] = 2;
  assert.strictEqual(N.decode(v), null);
  const t = b.slice();
  t[2] = 99;
  assert.strictEqual(N.decode(t), null);
});

it('缺头/截断抛 RangeError', () => {
  assert.throws(() => N.decode(new Uint8Array([0x50])), RangeError);
  const b = N.encodeSnapshot(fixture());
  assert.throws(() => N.decode(b.slice(0, b.length - 3)), RangeError);
  assert.throws(() => N.decode(b.slice(0, 25)), RangeError);
});

it('接受 ArrayBuffer 和 Uint8Array', () => {
  const b = N.encodeSnapshot(fixture());
  assert.strictEqual(N.decode(b.buffer).tick, 1234);
  assert.strictEqual(N.decode(b).tick, 1234);
});

console.log('\n' + passed + ' passed');
