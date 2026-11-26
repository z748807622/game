// plane-core.js — 2–4 人合作纵版射击的纯模拟。
//
// 纯函数 + 纯数据，不碰 DOM、不碰 WebSocket：浏览器里挂 window.PlaneCore，
// Node 里 require 直接用。中继服务器不解析 payload，所以主机权威的规则全在这里：
// 只有主机跑 step()，队友只发目标点、渲染快照。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlaneCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C = {
    TICK_HZ: 30,
    TICK_MS: 1000 / 30,
    SNAP_EVERY: 2,              // 每 2 tick 一帧快照 → 15Hz

    WORLD_W: 480,
    WORLD_H: 720,

    PLAYER_SPEED: 300,          // px/s，追目标点的最大速度
    PLAYER_HIT_R: 4,            // 判定半径（视觉尺寸大得多，方便擦弹）
    PLAYER_HP: 3,
    PLAYER_LIVES: 3,
    INVULN_TICKS: 90,           // 3s
    RESPAWN_TICKS: 90,          // 3s
    FIRE_INTERVAL: 6,           // 5 发/s
    BULLET_SPEED: 660,          // px/s，向上
    BULLET_R: 3,

    MAX_WAVE: 15,
    BOSS_EVERY: 5,
    INTERMISSION_TICKS: 60,     // 2s
    BOSS_HOVER_Y: 120,

    MAX_PLAYERS: 4,
    MAX_ENEMIES: 24,
    MAX_EBULLETS: 160,
    MAX_PBULLETS: 64,

    MARGIN_X: 16,
    MARGIN_TOP: 16,
    MARGIN_BOTTOM: 40,

    POS_SCALE: 4,               // 快照位置定点：1/4 px
    STARVE_MS: 600,
    INTERP_MS: 80,
    EXTRAP_MAX_MS: 150
  };

  var PHASE = { LOBBY: 'lobby', PLAYING: 'playing', OVER: 'over' };

  // kind: 0 小兵 / 1 蛇形 / 2 精英 / 3 Boss
  var KINDS = {
    0: { hp: 1, speed: 120, r: 12, score: 10 },
    1: { hp: 2, speed: 100, r: 12, score: 20 },
    2: { hp: 6, speed: 90, r: 16, score: 50 },
    3: { hp: 120, speed: 90, r: 40, score: 500 }
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function dist2(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return dx * dx + dy * dy;
  }

  // 固定种子 PRNG：主机侧所有随机都走它，保证测试/回放可复现。
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 目标点追踪：步长 ≤ maxSpeed*dt，不越界、不过冲、带 0.5px 死区。
  // 客户端预测和主机模拟共用这一个函数。
  function seek(pos, aim, maxSpeed, dt) {
    var dx = aim.x - pos.x;
    var dy = aim.y - pos.y;
    var d = Math.hypot(dx, dy);
    if (d <= 0.5) return { x: pos.x, y: pos.y };
    var step = Math.min(d, maxSpeed * dt);
    return {
      x: pos.x + (dx / d) * step,
      y: pos.y + (dy / d) * step
    };
  }

  function findPlayer(w, slot) {
    if (!w) return null;
    for (var i = 0; i < w.players.length; i++) {
      if (w.players[i].slot === slot) return w.players[i];
    }
    return null;
  }

  function bossOf(w) {
    if (!w) return null;
    for (var i = 0; i < w.enemies.length; i++) {
      if (w.enemies[i].kind === 3) return w.enemies[i];
    }
    return null;
  }

  function makePlayer(slot, color, index, total) {
    var x = C.WORLD_W * (index + 1) / (total + 1);
    var y = C.WORLD_H - 80;
    return {
      slot: slot,
      color: color == null ? index : color,
      x: x,
      y: y,
      aimX: x,
      aimY: y,
      hp: C.PLAYER_HP,
      lives: C.PLAYER_LIVES,
      state: 0,          // 0 存活 / 1 无敌 / 2 倒地 / 3 观战
      invuln: 0,
      respawn: 0,
      fireCd: 0,
      connected: true
    };
  }

  function newWorld(opts) {
    opts = opts || {};
    var list = (opts.players || []).slice(0, C.MAX_PLAYERS);
    var players = [];
    for (var i = 0; i < list.length; i++) {
      players.push(makePlayer(list[i].slot, list[i].color == null ? i : list[i].color, i, list.length));
    }
    var seed = (opts.seed >>> 0) || 1;
    var w = {
      seed: seed,
      rng: mulberry32(seed),
      tick: opts.tick0 >>> 0,
      phase: PHASE.PLAYING,
      wave: 1,
      score: 0,
      win: false,
      maxWave: opts.maxWave || C.MAX_WAVE,
      players: players,
      enemies: [],
      ebullets: [],
      pbullets: [],
      toSpawn: 0,
      spawnTimer: 0,
      spawnInterval: 0,
      intermission: 0,
      bossWave: false,
      nextEnemyId: 1,
      fx: []
    };
    if (players.length) startWave(w, 1);
    return w;
  }

  function startWave(w, n) {
    w.wave = n;
    w.bossWave = (n % C.BOSS_EVERY === 0);
    w.toSpawn = w.bossWave ? 1 : Math.min(C.MAX_ENEMIES, 6 + 2 * n);
    w.spawnTimer = 0;
    w.spawnInterval = w.bossWave ? 0 : Math.max(12, 26 - 2 * n);
    w.intermission = 0;
  }

  function pickKind(w) {
    var r = w.rng();
    if (w.wave >= 3) {
      if (r < 0.55) return 0;
      if (r < 0.85) return 1;
      return 2;
    }
    if (r < 0.65) return 0;
    if (r < 0.92) return 1;
    return 2;
  }

  function spawnEnemy(w, kind, x, y) {
    var meta = KINDS[kind] || KINDS[0];
    var hpMul = 1 + 0.08 * (w.wave - 1);
    var hp = Math.max(1, Math.round(meta.hp * hpMul));
    var ex = (x == null) ? (40 + w.rng() * (C.WORLD_W - 80)) : x;
    var ey = (y == null) ? -meta.r : y;
    var e = {
      id: w.nextEnemyId++,
      kind: kind,
      x: ex,
      y: ey,
      vx: 0,
      vy: meta.speed / C.TICK_HZ,
      hp: hp,
      maxHp: hp,
      r: meta.r,
      age: 0,
      originX: ex,
      fireCd: kind === 3 ? 90 : (kind === 2 ? 60 : 9999),
      score: meta.score,
      boss: kind === 3,
      entered: false,
      pattern: 0
    };
    if (kind === 3) {
      e.y = -60;
      e.vy = 3; // 入场 90px/s，到悬停高度后停下
    }
    w.enemies.push(e);
    return e;
  }

  function addEBullet(w, x, y, vx, vy, kind) {
    if (w.ebullets.length >= C.MAX_EBULLETS) w.ebullets.shift();
    w.ebullets.push({ x: x, y: y, vx: vx, vy: vy, kind: kind || 0 });
  }

  function nearestTarget(w, e) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < w.players.length; i++) {
      var p = w.players[i];
      if (!p.connected) continue;
      if (p.state !== 0 && p.state !== 1) continue;
      var d = dist2(p.x, p.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  function fireAimed(w, e, count, speed) {
    var p = nearestTarget(w, e);
    if (!p) return;
    var mul = 1 + 0.03 * (w.wave - 1);
    var base = Math.atan2(p.y - e.y, p.x - e.x);
    var spread = count > 1 ? 0.16 : 0;
    for (var i = 0; i < count; i++) {
      var a = base + (i - (count - 1) / 2) * spread;
      addEBullet(w, e.x, e.y, Math.cos(a) * speed * mul / C.TICK_HZ, Math.sin(a) * speed * mul / C.TICK_HZ, 1);
    }
  }

  function fireRing(w, e, count, speed) {
    var mul = 1 + 0.03 * (w.wave - 1);
    for (var i = 0; i < count; i++) {
      var a = (Math.PI * 2 * i) / count;
      addEBullet(w, e.x, e.y, Math.cos(a) * speed * mul / C.TICK_HZ, Math.sin(a) * speed * mul / C.TICK_HZ, 2);
    }
  }

  function spawnPBullet(w, p) {
    if (w.pbullets.length >= C.MAX_PBULLETS) w.pbullets.shift();
    w.pbullets.push({
      x: p.x,
      y: p.y - 18,
      vx: 0,
      vy: -C.BULLET_SPEED / C.TICK_HZ,
      owner: p.slot,
      kind: 0
    });
  }

  function damagePlayer(w, p) {
    if (!p.connected) return false;
    if (p.state !== 0 || p.invuln > 0) return false;
    p.hp--;
    w.fx.push({ type: 'hit', x: p.x, y: p.y, size: 18, slot: p.slot });
    if (p.hp > 0) {
      p.state = 1;
      p.invuln = C.INVULN_TICKS;
    } else {
      p.hp = 0;
      p.lives--;
      if (p.lives > 0) {
        p.state = 2;
        p.respawn = C.RESPAWN_TICKS;
      } else {
        p.state = 3;
        p.respawn = 0;
      }
      w.fx.push({ type: 'boom', x: p.x, y: p.y, size: 28, slot: p.slot });
    }
    return true;
  }

  function updatePlayers(w) {
    for (var i = 0; i < w.players.length; i++) {
      var p = w.players[i];
      if (!p.connected) continue;

      if (p.state === 2) {
        p.respawn--;
        if (p.respawn <= 0) {
          if (p.lives > 0) {
            p.hp = C.PLAYER_HP;
            p.state = 1;
            p.invuln = 60;
            p.respawn = 0;
            p.x = C.WORLD_W / 2;
            p.y = C.WORLD_H - 80;
            p.aimX = p.x;
            p.aimY = p.y;
          } else {
            p.state = 3;
          }
        }
        continue;
      }
      if (p.state === 3) continue;

      var np = seek(p, { x: p.aimX, y: p.aimY }, C.PLAYER_SPEED, 1 / C.TICK_HZ);
      p.x = clamp(np.x, C.MARGIN_X, C.WORLD_W - C.MARGIN_X);
      p.y = clamp(np.y, C.MARGIN_TOP, C.WORLD_H - C.MARGIN_BOTTOM);

      if (p.invuln > 0) {
        p.invuln--;
        p.state = p.invuln > 0 ? 1 : 0;
      } else {
        p.state = 0;
      }

      p.fireCd--;
      if (p.fireCd <= 0) {
        spawnPBullet(w, p);
        p.fireCd = C.FIRE_INTERVAL;
      }
    }
  }

  function updateSpawn(w) {
    if (w.intermission > 0) {
      w.intermission--;
      if (w.intermission <= 0 && w.phase === PHASE.PLAYING) {
        startWave(w, w.wave + 1);
      }
      return;
    }
    if (w.toSpawn <= 0) return;

    w.spawnTimer--;
    if (w.spawnTimer > 0) return;
    if (w.enemies.length >= C.MAX_ENEMIES) {
      w.spawnTimer = 6;
      return;
    }
    var kind = w.bossWave ? 3 : pickKind(w);
    spawnEnemy(w, kind);
    w.toSpawn--;
    w.spawnTimer = w.spawnInterval;
  }

  function updateEnemies(w) {
    for (var i = 0; i < w.enemies.length; i++) {
      var e = w.enemies[i];
      e.age++;

      if (e.kind === 0) {
        e.y += e.vy;
      } else if (e.kind === 1) {
        e.y += e.vy;
        e.x = e.originX + Math.sin(e.age * 0.08) * 60;
      } else if (e.kind === 2) {
        e.y += e.vy;
        e.x = e.originX + Math.sin(e.age * 0.05) * 40;
        if (e.y > 40 && e.y < C.WORLD_H * 0.75) {
          e.fireCd--;
          if (e.fireCd <= 0) {
            fireAimed(w, e, 1, 200);
            e.fireCd = 90;
          }
        }
      } else if (e.kind === 3) {
        if (!e.entered) {
          e.y += e.vy;
          if (e.y >= C.BOSS_HOVER_Y) {
            e.y = C.BOSS_HOVER_Y;
            e.entered = true;
            e.fireCd = 60;
          }
        } else {
          e.x = C.WORLD_W / 2 + Math.sin(e.age * 0.02) * 100;
          e.fireCd--;
          if (e.fireCd <= 0) {
            e.pattern++;
            if (e.pattern % 2 === 1) fireRing(w, e, 12, 150);
            else fireAimed(w, e, 3, 210);
            e.fireCd = 60;
          }
        }
      }
    }
  }

  function updateBullets(w) {
    var i;
    for (i = w.pbullets.length - 1; i >= 0; i--) {
      var pb = w.pbullets[i];
      pb.x += pb.vx;
      pb.y += pb.vy;
      if (pb.y < -40 || pb.y > C.WORLD_H + 40 || pb.x < -40 || pb.x > C.WORLD_W + 40) {
        w.pbullets.splice(i, 1);
      }
    }
    for (i = w.ebullets.length - 1; i >= 0; i--) {
      var eb = w.ebullets[i];
      eb.x += eb.vx;
      eb.y += eb.vy;
      if (eb.y < -40 || eb.y > C.WORLD_H + 40 || eb.x < -40 || eb.x > C.WORLD_W + 40) {
        w.ebullets.splice(i, 1);
      }
    }
  }

  function collide(w) {
    var i, j;

    // 我弹 → 敌机
    for (i = w.pbullets.length - 1; i >= 0; i--) {
      var pb = w.pbullets[i];
      var hit = false;
      for (j = w.enemies.length - 1; j >= 0; j--) {
        var e = w.enemies[j];
        var rr = e.r + C.BULLET_R;
        if (dist2(pb.x, pb.y, e.x, e.y) <= rr * rr) {
          w.pbullets.splice(i, 1);
          e.hp--;
          w.fx.push({ type: 'spark', x: pb.x, y: pb.y, size: 8 });
          if (e.hp <= 0) {
            w.score += e.score;
            w.enemies.splice(j, 1);
            w.fx.push({ type: 'boom', x: e.x, y: e.y, size: e.boss ? 52 : e.r });
          }
          hit = true;
          break;
        }
      }
      if (hit) continue;
    }

    // 敌弹 → 玩家（只有非无敌的存活玩家会吃伤害）
    for (i = w.ebullets.length - 1; i >= 0; i--) {
      var eb = w.ebullets[i];
      var rr2 = C.PLAYER_HIT_R + C.BULLET_R;
      for (j = 0; j < w.players.length; j++) {
        var p = w.players[j];
        if (dist2(eb.x, eb.y, p.x, p.y) <= rr2 * rr2) {
          if (damagePlayer(w, p)) {
            w.ebullets.splice(i, 1);
            break;
          }
        }
      }
    }

    // 敌机撞机
    for (i = 0; i < w.enemies.length; i++) {
      var en = w.enemies[i];
      for (j = 0; j < w.players.length; j++) {
        var pl = w.players[j];
        if ((pl.state !== 0 && pl.state !== 1) || !pl.connected) continue;
        var rr3 = C.PLAYER_HIT_R + en.r;
        if (dist2(pl.x, pl.y, en.x, en.y) <= rr3 * rr3) {
          damagePlayer(w, pl);
        }
      }
    }
  }

  function cleanup(w) {
    var i;
    for (i = w.enemies.length - 1; i >= 0; i--) {
      var e = w.enemies[i];
      if (e.kind !== 3 && (e.y > C.WORLD_H + 60 || e.x < -120 || e.x > C.WORLD_W + 120)) {
        w.enemies.splice(i, 1);
      }
    }
  }

  function checkWaveClear(w) {
    if (w.phase !== PHASE.PLAYING) return;
    if (w.toSpawn > 0 || w.enemies.length > 0 || w.intermission > 0) return;
    if (w.wave >= w.maxWave) {
      endRound(w, true);
      return;
    }
    w.intermission = C.INTERMISSION_TICKS;
  }

  function endRound(w, win) {
    if (w.phase !== PHASE.PLAYING) return;
    w.phase = PHASE.OVER;
    w.win = !!win;
  }

  function checkRoundEnd(w) {
    if (w.phase !== PHASE.PLAYING) return;
    if (w.players.length === 0) {
      endRound(w, false);
      return;
    }
    for (var i = 0; i < w.players.length; i++) {
      if (w.players[i].state !== 3) return;
    }
    endRound(w, false);
  }

  function step(w) {
    if (!w || w.phase !== PHASE.PLAYING) return w;
    w.fx.length = 0;
    updatePlayers(w);
    updateSpawn(w);
    updateEnemies(w);
    updateBullets(w);
    collide(w);
    cleanup(w);
    checkWaveClear(w);
    checkRoundEnd(w);
    w.tick++;
    return w;
  }

  function setAim(w, slot, x, y) {
    var p = findPlayer(w, slot);
    if (!p) return false;
    p.aimX = clamp(x, C.MARGIN_X, C.WORLD_W - C.MARGIN_X);
    p.aimY = clamp(y, C.MARGIN_TOP, C.WORLD_H - C.MARGIN_BOTTOM);
    return true;
  }

  function setConnected(w, slot, online) {
    var p = findPlayer(w, slot);
    if (!p) return;
    p.connected = !!online;
    if (online && (p.state === 0 || p.state === 1)) {
      p.invuln = Math.max(p.invuln, 60);
      p.state = 1;
    }
  }

  function removePlayer(w, slot) {
    for (var i = w.players.length - 1; i >= 0; i--) {
      if (w.players[i].slot === slot) w.players.splice(i, 1);
    }
  }

  // 测试/回放用的稳定哈希：只覆盖可观察状态。
  function hashWorld(w) {
    if (!w) return 0;
    var s = [w.tick, w.phase, w.wave, w.score, w.win ? 1 : 0].join('|');
    var i;
    for (i = 0; i < w.players.length; i++) {
      var p = w.players[i];
      s += ';p' + p.slot + ',' + Math.round(p.x * 100) + ',' + Math.round(p.y * 100) +
        ',' + p.hp + ',' + p.lives + ',' + p.state + ',' + (p.connected ? 1 : 0);
    }
    for (i = 0; i < w.enemies.length; i++) {
      var e = w.enemies[i];
      s += ';e' + e.id + ',' + e.kind + ',' + Math.round(e.x * 100) + ',' +
        Math.round(e.y * 100) + ',' + e.hp;
    }
    s += ';eb' + w.ebullets.length + ';pb' + w.pbullets.length;
    var h = 2166136261;
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  return {
    C: C,
    PHASE: PHASE,
    KINDS: KINDS,
    seek: seek,
    newWorld: newWorld,
    step: step,
    setAim: setAim,
    setConnected: setConnected,
    removePlayer: removePlayer,
    spawnEnemy: spawnEnemy,
    addEBullet: addEBullet,
    findPlayer: findPlayer,
    bossOf: bossOf,
    hashWorld: hashWorld,
    clamp: clamp
  };
});
