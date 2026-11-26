// plane-net.js — 打飞机游戏的二进制 payload 编解码。
//
// 服务端完全不解析这些字节；这里只约定主机/队友之间 INPUT / START / SNAP 的布局。
// 小端、定长、无压缩；游戏 payload 首字节 magic=0x50，用来和别的 payload 区分。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./plane-core.js'));
  } else {
    root.PlaneNet = factory(root.PlaneCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var C = Core ? Core.C : {
    POS_SCALE: 4,
    MAX_PLAYERS: 4,
    MAX_ENEMIES: 24,
    MAX_EBULLETS: 160,
    MAX_PBULLETS: 64
  };

  var MAGIC = 0x50; // 'P'
  var VER = 1;
  var TYPE = { INPUT: 1, SNAP: 2, START: 3 };
  var PHASES = ['lobby', 'playing', 'over'];

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function toView(bytes) {
    if (bytes instanceof ArrayBuffer) return new DataView(bytes);
    if (bytes && bytes.buffer) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new TypeError('payload must be ArrayBuffer or Uint8Array');
  }

  function need(view, off, n) {
    if (off + n > view.byteLength) throw new RangeError('truncated payload');
  }

  function readU8(v, o) { need(v, o, 1); return v.getUint8(o); }
  function readU16(v, o) { need(v, o, 2); return v.getUint16(o, true); }
  function readU32(v, o) { need(v, o, 4); return v.getUint32(o, true); }
  function readI8(v, o) { need(v, o, 1); return v.getInt8(o); }

  function writeU8(v, o, x) { v.setUint8(o, x & 0xff); }
  function writeU16(v, o, x) { v.setUint16(o, x & 0xffff, true); }
  function writeU32(v, o, x) { v.setUint32(o, x >>> 0, true); }
  function writeI8(v, o, x) { v.setInt8(o, clamp(Math.round(x), -128, 127)); }

  function posToFixed(px) {
    return clamp(Math.round(px * C.POS_SCALE), 0, 0xffff);
  }

  function fixedToPos(fx) {
    return fx / C.POS_SCALE;
  }

  function phaseCode(phase) {
    var i = PHASES.indexOf(phase);
    return i < 0 ? 0 : i;
  }

  // ------------------------------------------------------------ INPUT

  function encodeInput(o) {
    o = o || {};
    var buf = new ArrayBuffer(8);
    var v = new DataView(buf);
    writeU8(v, 0, MAGIC);
    writeU8(v, 1, VER);
    writeU8(v, 2, TYPE.INPUT);
    writeU16(v, 3, posToFixed(o.x || 0));
    writeU16(v, 5, posToFixed(o.y || 0));
    writeU8(v, 7, o.flags || 0);
    return new Uint8Array(buf);
  }

  // ------------------------------------------------------------ START

  function encodeStart(o) {
    o = o || {};
    var players = (o.players || []).slice(0, C.MAX_PLAYERS);
    var buf = new ArrayBuffer(10 + players.length * 3);
    var v = new DataView(buf);
    var off = 0;
    writeU8(v, off++, MAGIC);
    writeU8(v, off++, VER);
    writeU8(v, off++, TYPE.START);
    writeU32(v, off, (o.seed >>> 0) || 1); off += 4;
    writeU8(v, off++, o.mode || 0);
    writeU8(v, off++, clamp(o.maxWave || 15, 1, 255));
    writeU8(v, off++, players.length);
    for (var i = 0; i < players.length; i++) {
      writeU16(v, off, players[i].slot); off += 2;
      writeU8(v, off++, players[i].color || 0);
    }
    return new Uint8Array(buf);
  }

  // ------------------------------------------------------------ SNAP

  function encodeSnapshot(w) {
    var players = w.players.slice(0, C.MAX_PLAYERS);
    var enemies = w.enemies.slice(0, C.MAX_ENEMIES);
    var ebullets = w.ebullets.slice(0, C.MAX_EBULLETS);
    var pbullets = w.pbullets.slice(0, C.MAX_PBULLETS);
    var boss = Core && Core.bossOf ? Core.bossOf(w) : null;

    var size = 20 + players.length * 10 + 1 + enemies.length * 9 + 1 +
      ebullets.length * 7 + 1 + pbullets.length * 8;
    var buf = new ArrayBuffer(size);
    var v = new DataView(buf);
    var off = 0;

    writeU8(v, off++, MAGIC);
    writeU8(v, off++, VER);
    writeU8(v, off++, TYPE.SNAP);
    writeU32(v, off, w.tick >>> 0); off += 4;
    writeU8(v, off++, phaseCode(w.phase));
    writeU8(v, off++, w.win ? 1 : 0);
    writeU16(v, off, clamp(w.wave || 0, 0, 0xffff)); off += 2;
    writeU32(v, off, Math.max(0, w.score || 0)); off += 4;
    writeU16(v, off, boss ? clamp(boss.hp, 0, 0xffff) : 0); off += 2;
    writeU16(v, off, boss ? clamp(boss.maxHp, 0, 0xffff) : 0); off += 2;

    writeU8(v, off++, players.length);
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      writeU16(v, off, p.slot); off += 2;
      writeU16(v, off, posToFixed(p.x)); off += 2;
      writeU16(v, off, posToFixed(p.y)); off += 2;
      writeU8(v, off++, clamp(p.hp, 0, 255));
      writeU8(v, off++, clamp(p.lives, 0, 255));
      writeU8(v, off++, p.state & 0xff);
      var pf = (p.connected ? 1 : 0) | ((p.state === 0 || p.state === 1) && p.connected ? 2 : 0);
      writeU8(v, off++, pf);
    }

    writeU8(v, off++, enemies.length);
    for (i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      writeU16(v, off, e.id & 0xffff); off += 2;
      writeU8(v, off++, e.kind & 0xff);
      writeU16(v, off, posToFixed(e.x)); off += 2;
      writeU16(v, off, posToFixed(e.y)); off += 2;
      writeU8(v, off++, clamp(e.hp, 0, 255));
      writeU8(v, off++, e.kind === 3 ? 1 : 0);
    }

    writeU8(v, off++, ebullets.length);
    for (i = 0; i < ebullets.length; i++) {
      var eb = ebullets[i];
      writeU16(v, off, posToFixed(eb.x)); off += 2;
      writeU16(v, off, posToFixed(eb.y)); off += 2;
      writeI8(v, off++, eb.vx);
      writeI8(v, off++, eb.vy);
      writeU8(v, off++, eb.kind & 0xff);
    }

    writeU8(v, off++, pbullets.length);
    for (i = 0; i < pbullets.length; i++) {
      var pb = pbullets[i];
      writeU16(v, off, posToFixed(pb.x)); off += 2;
      writeU16(v, off, posToFixed(pb.y)); off += 2;
      writeI8(v, off++, pb.vx);
      writeI8(v, off++, pb.vy);
      writeU8(v, off++, clamp(pb.owner, 0, 255));
      writeU8(v, off++, pb.kind & 0xff);
    }

    return new Uint8Array(buf);
  }

  // ------------------------------------------------------------ DECODE

  function decode(bytes) {
    var v = toView(bytes);
    if (v.byteLength < 3) throw new RangeError('truncated payload');
    if (v.getUint8(0) !== MAGIC) return null;
    if (v.getUint8(1) !== VER) return null;
    var type = v.getUint8(2);
    if (type === TYPE.INPUT) return decodeInput(v);
    if (type === TYPE.START) return decodeStart(v);
    if (type === TYPE.SNAP) return decodeSnapshot(v);
    return null;
  }

  function decodeInput(v) {
    return {
      type: TYPE.INPUT,
      x: fixedToPos(readU16(v, 3)),
      y: fixedToPos(readU16(v, 5)),
      flags: readU8(v, 7)
    };
  }

  function decodeStart(v) {
    var off = 3;
    var seed = readU32(v, off); off += 4;
    var mode = readU8(v, off++);
    var maxWave = readU8(v, off++);
    var n = readU8(v, off++);
    if (n > C.MAX_PLAYERS) throw new RangeError('too many players');
    need(v, off, n * 3);
    var players = [];
    for (var i = 0; i < n; i++) {
      players.push({ slot: readU16(v, off), color: readU8(v, off + 2) });
      off += 3;
    }
    return { type: TYPE.START, seed: seed, mode: mode, maxWave: maxWave, players: players };
  }

  function decodeSnapshot(v) {
    var off = 3;
    var tick = readU32(v, off); off += 4;
    var phase = PHASES[readU8(v, off++)] || 'lobby';
    var flags = readU8(v, off++);
    var wave = readU16(v, off); off += 2;
    var score = readU32(v, off); off += 4;
    var bossHp = readU16(v, off); off += 2;
    var bossMaxHp = readU16(v, off); off += 2;

    var playerCount = readU8(v, off++);
    if (playerCount > C.MAX_PLAYERS) throw new RangeError('too many players');
    need(v, off, playerCount * 10);
    var players = [];
    for (var i = 0; i < playerCount; i++) {
      var p = {
        slot: readU16(v, off),
        x: fixedToPos(readU16(v, off + 2)),
        y: fixedToPos(readU16(v, off + 4)),
        hp: readU8(v, off + 6),
        lives: readU8(v, off + 7),
        state: readU8(v, off + 8),
        flags: readU8(v, off + 9)
      };
      p.online = !!(p.flags & 1);
      p.firing = !!(p.flags & 2);
      players.push(p);
      off += 10;
    }

    var enemyCount = readU8(v, off++);
    if (enemyCount > C.MAX_ENEMIES) throw new RangeError('too many enemies');
    need(v, off, enemyCount * 9);
    var enemies = [];
    for (i = 0; i < enemyCount; i++) {
      enemies.push({
        id: readU16(v, off),
        kind: readU8(v, off + 2),
        x: fixedToPos(readU16(v, off + 3)),
        y: fixedToPos(readU16(v, off + 5)),
        hp: readU8(v, off + 7),
        flags: readU8(v, off + 8),
        boss: !!(readU8(v, off + 8) & 1)
      });
      off += 9;
    }

    var ebulletCount = readU8(v, off++);
    if (ebulletCount > C.MAX_EBULLETS) throw new RangeError('too many enemy bullets');
    need(v, off, ebulletCount * 7);
    var ebullets = [];
    for (i = 0; i < ebulletCount; i++) {
      ebullets.push({
        x: fixedToPos(readU16(v, off)),
        y: fixedToPos(readU16(v, off + 2)),
        vx: readI8(v, off + 4),
        vy: readI8(v, off + 5),
        kind: readU8(v, off + 6)
      });
      off += 7;
    }

    var pbulletCount = readU8(v, off++);
    if (pbulletCount > C.MAX_PBULLETS) throw new RangeError('too many player bullets');
    need(v, off, pbulletCount * 8);
    var pbullets = [];
    for (i = 0; i < pbulletCount; i++) {
      pbullets.push({
        x: fixedToPos(readU16(v, off)),
        y: fixedToPos(readU16(v, off + 2)),
        vx: readI8(v, off + 4),
        vy: readI8(v, off + 5),
        owner: readU8(v, off + 6),
        kind: readU8(v, off + 7)
      });
      off += 8;
    }

    return {
      type: TYPE.SNAP,
      tick: tick,
      phase: phase,
      flags: flags,
      win: !!(flags & 1),
      wave: wave,
      score: score,
      bossHp: bossHp,
      bossMaxHp: bossMaxHp,
      players: players,
      enemies: enemies,
      ebullets: ebullets,
      pbullets: pbullets
    };
  }

  return {
    MAGIC: MAGIC,
    VER: VER,
    TYPE: TYPE,
    PHASES: PHASES,
    encodeInput: encodeInput,
    encodeStart: encodeStart,
    encodeSnapshot: encodeSnapshot,
    decode: decode,
    posToFixed: posToFixed,
    fixedToPos: fixedToPos
  };
});
