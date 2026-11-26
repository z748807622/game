// plane.js — 「多人打飞机」页面控制器。
//
// 只做四件事：把 RelayClient 事件翻译成对局消息、主机跑 plane-core 的模拟、
// 队友做本地预测/插值渲染、把 UI 点亮。规则和二进制格式分别在
// plane-core.js / plane-net.js 里。
(function () {
  'use strict';

  var R = window.Relay;
  var C = window.PlaneCore;
  var N = window.PlaneNet;
  var CC = C.C;
  var W = CC.WORLD_W;
  var H = CC.WORLD_H;

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('game');
  var ctx = canvas.getContext('2d');

  var PALETTE = ['#4c8dff', '#ff5db1', '#34d17b', '#ffd166'];

  // ------------------------------------------------------------ 状态

  var client = null;
  var pendingConnect = null;
  var phase = 'lobby';            // lobby | playing | over
  var config = null;              // START：{seed, mode, maxWave, players:[{slot,color}]}
  var colorOf = {};
  var hostWorld = null;

  var snapshots = [];             // [{snap, arrived}]，最多 5 帧
  var snapTotal = 0;              // 收到的快照总数（调试/测试用）
  var latest = null;
  var lastAppliedTick = -1;
  var selfPos = null;             // 客户端本地预测位置
  var aim = { x: W / 2, y: H - 80 };
  var aimTouched = false;
  var activePointer = null;
  var lastSnapshotAt = 0;
  var syncing = false;
  var roundHostSlot = 0;
  var resumeTimer = 0;

  var raf = 0;
  var lastFrame = 0;
  var lastHudAt = 0;
  var hostAcc = 0;
  var hostLast = 0;
  var hostTimer = 0;
  var hostSteps = 0;
  var hostSnaps = 0;
  var relayFrames = 0;
  var snapFrames = 0;
  var startFrames = 0;
  var lastSnapTick = -1;

  var roomLocked = false;
  var overlayKind = '';
  var overlayAction = null;
  var toastTimer = 0;

  var stars = null;
  var particles = [];
  var flash = 0;
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var bgGrad = null;

  // ------------------------------------------------------------ 小工具

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function show(id, visible) {
    var el = $(id);
    if (el) el.classList.toggle('hidden', !visible);
  }

  function status(text, kind) {
    var t = $('statusText');
    if (t) t.textContent = text;
    var d = $('dot');
    if (d) d.className = 'dot' + (kind ? ' ' + kind : '');
  }

  function toast(text, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2400);
  }

  function isHost() {
    return !!(client && client.joined && client.host && client.slot && client.host === client.slot);
  }

  function joined() {
    return !!(client && client.joined);
  }

  function memberList() {
    return joined() ? client.members : [];
  }

  function onlineMembers() {
    var ms = memberList();
    var out = [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].online) out.push(ms[i]);
    }
    out.sort(function (a, b) { return a.slot - b.slot; });
    return out;
  }

  function allSlots() {
    var ms = memberList();
    var out = [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].slot) out.push(ms[i].slot);
    }
    if (!out.length && client && client.slot) out.push(client.slot);
    return out;
  }

  function nameOf(slot) {
    var ms = memberList();
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].slot !== slot) continue;
      try {
        var meta = JSON.parse(R.fromUtf8(ms[i].meta));
        if (meta && meta.name) return String(meta.name).slice(0, 12);
      } catch (e) { /* meta 不是 JSON */ }
      return '#' + slot;
    }
    return slot ? '#' + slot : '?';
  }

  function colorOfSlot(slot) {
    if (colorOf[slot] != null) return PALETTE[colorOf[slot] % PALETTE.length];
    return PALETTE[0];
  }

  function findSnapPlayer(snap, slot) {
    if (!snap || !snap.players) return null;
    for (var i = 0; i < snap.players.length; i++) {
      if (snap.players[i].slot === slot) return snap.players[i];
    }
    return null;
  }

  function meta() {
    return { name: ($('nickname').value || '').trim() || '玩家' };
  }

  function wsURL() {
    try {
      var q = new URLSearchParams(location.search).get('ws');
      if (q) return q;
    } catch (e) { /* 老浏览器 */ }
    if (location.protocol === 'file:') return 'ws://127.0.0.1:8080/ws';
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  // ------------------------------------------------------------ 连接

  function ensureClient() {
    if (client && client.ws && client.ws.readyState === 1) return Promise.resolve(client);
    if (!client) {
      client = new R.RelayClient({
        url: wsURL(),
        token: ($('token').value || '').trim() || 'dev-token',
        autoReconnect: true
      });
      wire(client);
    }
    if (!pendingConnect) {
      status('连接中…', 'warn');
      pendingConnect = client.connect().then(
        function () { pendingConnect = null; return client; },
        function (err) { pendingConnect = null; throw err; }
      );
    }
    return pendingConnect;
  }

  function wire(c) {
    c.on('ready', function (m) {
      if (client !== c) return;
      if (!m.resumed) status('已连接', 'ok');
    });
    c.on('created', function (m) {
      if (client !== c) return;
      enterRoom('fresh', '房间已创建：' + m.code);
    });
    c.on('joined', function (m) {
      if (client !== c) return;
      enterRoom('fresh', '已加入房间 ' + m.code);
    });
    c.on('reconnected', function (m) {
      if (client !== c) return;
      if (m.missed) toast('服务端补发了 ' + m.missed + ' 帧');
    });
    c.on('resumed', function (m) {
      if (client !== c) return;
      onResumed(m);
    });
    c.on('peerJoin', function (p) {
      if (client !== c) return;
      if (isHost() && phase === 'lobby' && memberList().length >= 4) lockRoom(true);
      if (isHost() && hostWorld && (phase === 'playing' || phase === 'over')) sendSnapshot();
      renderRoom();
      toast('#' + p.slot + ' ' + nameOf(p.slot) + ' 加入');
    });
    c.on('peerLeave', function (p) {
      if (client !== c) return;
      if (isHost() && hostWorld) C.removePlayer(hostWorld, p.slot);
      if (isHost() && phase === 'lobby' && memberList().length < 4) lockRoom(false);
      renderRoom();
      if (phase === 'playing') toast('#' + p.slot + ' 离开了房间', 'warn');
    });
    c.on('peerOffline', function (p) {
      if (client !== c) return;
      if (isHost() && hostWorld) C.setConnected(hostWorld, p.slot, false);
      renderRoom();
      if (phase === 'playing') toast('#' + p.slot + ' 断线，等待重连…', 'warn');
    });
    c.on('peerRejoin', function (p) {
      if (client !== c) return;
      if (isHost() && hostWorld) {
        C.setConnected(hostWorld, p.slot, true);
        // 队友刚回来：立刻补一帧当前全量状态，避免它在 over / 暂停时等不到下一帧。
        sendSnapshot();
      }
      renderRoom();
      if (phase === 'playing') toast('#' + p.slot + ' 回来了', 'ok');
    });
    c.on('host', function (h) {
      if (client !== c) return;
      var wasPlaying = phase === 'playing' || phase === 'over';
      roomLocked = false;
      if (wasPlaying) abortRound('房主已离开，本局结束');
      if (isHost() && client.joined) {
        roomLocked = false;
        c.lock(false);
      }
      renderRoom();
      if (!wasPlaying) toast('房主变更为 #' + h.slot);
    });
    c.on('relay', function (m) {
      if (client !== c) return;
      onRelay(m.from, m.payload);
    });
    c.on('resync', function () {
      if (client !== c) return;
      onResync();
    });
    c.on('reconnecting', function () {
      if (client !== c) return;
      status('重连中…', 'warn');
    });
    c.on('close', function (ev) {
      if (client !== c) return;
      if (!ev || ev.code !== 1000) status('连接断开', 'bad');
    });
    c.on('kicked', function () {
      if (client !== c) return;
      toast('你被房主移出了房间', 'bad');
    });
    c.on('serverError', function (e) {
      if (client !== c) return;
      if (e.name === 'BAD_TARGET') return; // 成员刚离开的竞态：丢一帧即可
      var map = {
        ROOM_NOT_FOUND: '房间不存在或已解散',
        ROOM_FULL: '房间已满',
        ROOM_LOCKED: '房间已锁定（满 4 人或对局中）',
        BAD_PASSWORD: '密码不对',
        NOT_HOST: '只有房主能做这个操作',
        RATE_LIMITED: '操作太频繁，稍等一下',
        ALREADY_JOINED: '你已经在房间里了',
        BAD_TARGET: '目标不在房间里',
        BAD_FRAME: '协议帧异常'
      };
      toast(map[e.name] || ('服务端错误：' + e.name), 'bad');
    });
    c.on('stopped', function () {
      if (client !== c) return;
      status('已断开', 'bad');
      leaveToLobby();
      toast('连接已断开，请重新进入房间', 'bad');
    });
  }

  // ------------------------------------------------------------ 房间

  function enterRoom(kind, text) {
    if (kind === 'fresh') resetClientRound();
    roundHostSlot = 0;
    document.body.classList.add('in-room');
    show('lobbyCard', false);
    show('roomWrap', true);
    status('房间 ' + (client.code || ''), 'ok');
    if (!raf) startLoop();
    renderRoom();
    if (text) toast(text, 'ok');
  }

  function resetClientRound() {
    stopHostTimer();
    phase = 'lobby';
    config = null;
    colorOf = {};
    hostWorld = null;
    snapshots = [];
    snapTotal = 0;
    latest = null;
    lastAppliedTick = -1;
    selfPos = null;
    aim = { x: W / 2, y: H - 80 };
    aimTouched = false;
    lastSnapshotAt = 0;
    syncing = false;
    roundHostSlot = 0;
    particles = [];
    flash = 0;
    clearTimeout(resumeTimer);
  }

  function leaveToLobby() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    client = null;
    pendingConnect = null;
    resetClientRound();
    roomLocked = false;
    document.body.classList.remove('in-room');
    show('roomWrap', false);
    show('lobbyCard', true);
    status('未连接', '');
    hideOverlay();
    if (stars == null) initStars();
  }

  function leaveRoom() {
    if (client) {
      try {
        if (client.joined) client.leave();
        client.close();
      } catch (e) { /* ignore */ }
    }
    leaveToLobby();
  }

  function lockRoom(v) {
    if (!isHost() || roomLocked === v) return;
    roomLocked = v;
    client.lock(v);
  }

  function renderRoom() {
    if (!joined()) return;
    $('roomCode').textContent = client.code || '----';
    var ms = memberList();
    $('memberCount').textContent = Math.min(ms.length, 4) + '/4';

    var ul = $('members');
    ul.textContent = '';
    var sorted = ms.slice().sort(function (a, b) { return a.slot - b.slot; });
    for (var i = 0; i < sorted.length; i++) {
      (function (m) {
        var li = document.createElement('li');
        li.className = 'member' + (m.slot === client.slot ? ' self' : '');
        var dot = document.createElement('i');
        dot.className = 'mdot' + (m.online ? '' : ' off');
        li.appendChild(dot);
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = '#' + m.slot + ' ' + nameOf(m.slot) +
          (m.slot === client.slot ? '（你）' : '');
        li.appendChild(name);
        if (m.slot === client.host) {
          var host = document.createElement('span');
          host.className = 'pill';
          host.textContent = '房主';
          li.appendChild(host);
        }
        if (!m.online) {
          var off = document.createElement('span');
          off.className = 'pill';
          off.textContent = '断线';
          li.appendChild(off);
        }
        ul.appendChild(li);
      })(sorted[i]);
    }

    var host = isHost();
    var canStart = host && phase === 'lobby' && onlineMembers().length > 0;
    show('btnStart', host && phase === 'lobby');
    $('btnStart').disabled = !canStart;

    if (phase === 'lobby') {
      $('roomHint').textContent = host
        ? '满 4 人自动锁房；点「开始游戏」进入对局。'
        : '等房主开始游戏。';
      showOverlay('waiting', '等待开始',
        host ? '点下方按钮开始，或等朋友加入。' : '等房主开始游戏…',
        host ? { label: '开始游戏', fn: startRoundHost } : null);
    } else if (phase === 'playing') {
      $('roomHint').textContent = '对局中：' + (host ? '你是主机' : '主机在算世界');
    } else {
      $('roomHint').textContent = '本局结束。';
    }
  }

  // ------------------------------------------------------------ 消息

  function broadcast(bytes) {
    if (!joined()) return false;
    var slots = allSlots();
    if (!slots.length) return false;
    return client.relayBytes(bytes, slots);
  }

  function onRelay(from, payload) {
    relayFrames++;
    var msg;
    try {
      msg = N.decode(payload);
    } catch (e) {
      return;
    }
    if (!msg) return;
    if (msg.type === N.TYPE.START) startFrames++;
    if (msg.type === N.TYPE.SNAP) snapFrames++;

    if (msg.type === N.TYPE.START) {
      if (from === client.slot) return;
      if (from !== client.host) return;
      applyStart(msg);
      return;
    }
    if (msg.type === N.TYPE.SNAP) {
      if (from === client.slot) return;
      if (from !== client.host) return;
      applySnapshot(msg);
      return;
    }
    if (msg.type === N.TYPE.INPUT) {
      if (!isHost() || !hostWorld || phase !== 'playing') return;
      if (from === client.slot) return;
      if (!C.findPlayer(hostWorld, from)) return;
      C.setAim(hostWorld, from, msg.x, msg.y);
    }
  }

  function applyStart(msg) {
    config = msg;
    colorOf = {};
    for (var i = 0; i < msg.players.length; i++) {
      colorOf[msg.players[i].slot] = msg.players[i].color;
    }
    phase = 'playing';
    snapshots = [];
    snapTotal = 0;
    latest = null;
    lastAppliedTick = -1;
    selfPos = null;
    aim = { x: W / 2, y: H - 80 };
    aimTouched = false;
    particles = [];
    flash = 0;
    syncing = false;
    roundHostSlot = client.host;
    lastSnapshotAt = Date.now();
    clearTimeout(resumeTimer);
    hideOverlay();
    show('roomWrap', true);
    renderRoom();
    toast('开局！', 'ok');
  }

  function applySnapshot(snap) {
    // u32 tick 比较：用无符号差值，避免 tick > 2^31 时被 |0 变成负数。
    if (lastAppliedTick >= 0) {
      var d = (snap.tick - lastAppliedTick) >>> 0;
      if (d === 0 || d >= 0x80000000) return;
    }
    lastAppliedTick = snap.tick;
    roundHostSlot = client.host;

    var prev = latest;
    latest = snap;
    lastSnapshotAt = Date.now();
    syncing = false;
    clearTimeout(resumeTimer);
    snapTotal++;
    snapshots.push({ snap: snap, arrived: lastSnapshotAt });
    if (snapshots.length > 5) snapshots.shift();

    // 漏掉 START 的观战者/晚加入者也能按槽位顺序分到颜色。
    if (!config) {
      colorOf = {};
      for (var ci = 0; ci < snap.players.length; ci++) colorOf[snap.players[ci].slot] = ci;
    }

    if (phase === 'lobby') {
      phase = 'playing';
      show('roomWrap', true);
      renderRoom();
    }
    if (snap.phase === 'over') {
      if (phase !== 'over') {
        phase = 'over';
        showOver(snap.win, snap.score, snap.wave);
        renderRoom();
      }
    } else if (phase === 'over' && snap.phase === 'playing') {
      // 理论上只有 START 能开新局；旧快照不把状态拉回去。
    } else if (overlayKind === 'sync' || overlayKind === 'paused' || overlayKind === 'waiting') {
      hideOverlay();
    }

    var me = findSnapPlayer(snap, client.slot);
    if (!me) {
      selfPos = null;
    } else {
      if ((me.state === 2 || me.state === 3) || !selfPos) {
        if (!selfPos && !aimTouched) aim = { x: me.x, y: me.y };
        selfPos = { x: me.x, y: me.y };
      } else {
        var err = Math.hypot(me.x - selfPos.x, me.y - selfPos.y);
        if (err > 96) {
          selfPos = { x: me.x, y: me.y };
        } else if (err > 24) {
          selfPos.x += (me.x - selfPos.x) * 0.5;
          selfPos.y += (me.y - selfPos.y) * 0.5;
        } else {
          selfPos.x += (me.x - selfPos.x) * 0.2;
          selfPos.y += (me.y - selfPos.y) * 0.2;
        }
      }
    }

    diffFx(prev, snap);
    updateHud(performance.now());
  }

  function onResumed() {
    clearTimeout(resumeTimer);
    if (isHost()) {
      if (hostWorld && phase === 'playing') {
        startHostTimer();
        status('房间 ' + client.code, 'ok');
        toast('已回到对局', 'ok');
        renderRoom();
        return;
      }
      resetClientRound();
      renderRoom();
      return;
    }

    // 队友：快照是全量状态，清掉旧缓冲、等下一帧即可。
    snapshots = [];
    latest = null;
    selfPos = null;
    lastAppliedTick = -1;
    lastSnapshotAt = 0;
    particles = [];
    flash = 0;
    status('房间 ' + client.code, 'ok');
    toast('已回到房间', 'ok');

    if (phase === 'lobby') {
      renderRoom();
      return;
    }
    if (roundHostSlot && client.host !== roundHostSlot) {
      phase = 'lobby';
      config = null;
      renderRoom();
      toast('房间状态已变化，等待房主开始', 'warn');
      return;
    }
    syncing = true;
    showOverlay('sync', '同步中…', '正在恢复对局，等下一帧快照');
    resumeTimer = setTimeout(function () {
      if (!syncing) return;
      syncing = false;
      showOverlay('paused', '等待主机…', '房主可能暂停了，或网络还没恢复');
    }, 1600);
  }

  function onResync() {
    if (!joined() || isHost()) return;
    snapshots = [];
    latest = null;
    syncing = true;
    showOverlay('sync', '重新同步…', '补发窗口不足，等下一帧全量快照');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () {
      if (!syncing) return;
      syncing = false;
      showOverlay('paused', '等待主机…', '网络不稳定，等主机继续');
    }, 1600);
  }

  // ------------------------------------------------------------ 主机

  function startRoundHost() {
    if (!isHost()) return toast('只有房主可以开始', 'warn');
    if (phase === 'playing') return;
    var members = onlineMembers();
    if (!members.length) return toast('没有可参战的玩家', 'bad');
    var players = [];
    for (var i = 0; i < members.length && i < CC.MAX_PLAYERS; i++) {
      players.push({ slot: members[i].slot, color: i });
    }

    var seed = (Math.random() * 0xffffffff) >>> 0;
    config = { seed: seed, mode: 0, maxWave: CC.MAX_WAVE, players: players };
    colorOf = {};
    for (i = 0; i < players.length; i++) colorOf[players[i].slot] = players[i].color;

    hostWorld = C.newWorld({
      seed: seed,
      players: players,
      maxWave: CC.MAX_WAVE,
      tick0: Math.floor(Date.now() / CC.TICK_MS)
    });

    phase = 'playing';
    snapshots = [];
    snapTotal = 0;
    latest = null;
    lastAppliedTick = -1;
    lastSnapTick = -1;
    selfPos = null;
    aimTouched = false;
    particles = [];
    flash = 0;
    syncing = false;
    roundHostSlot = client.slot;
    clearTimeout(resumeTimer);

    var me = C.findPlayer(hostWorld, client.slot);
    if (me) {
      selfPos = { x: me.x, y: me.y };
      aim = { x: me.x, y: me.y };
    }

    client.lock(true);
    roomLocked = true;
    broadcast(N.encodeStart(config));
    sendSnapshot();
    startHostTimer();
    lastSnapshotAt = Date.now();
    hideOverlay();
    renderRoom();
    updateHud(performance.now());
    toast('开局！', 'ok');
  }

  function sendSnapshot() {
    if (!hostWorld) return;
    lastSnapTick = hostWorld.tick;
    hostSnaps++;
    broadcast(N.encodeSnapshot(hostWorld));
  }

  function startHostTimer() {
    stopHostTimer();
    hostAcc = 0;
    hostLast = performance.now();
    hostTimer = setInterval(hostTick, 1000 / CC.TICK_HZ);
  }

  function stopHostTimer() {
    if (hostTimer) {
      clearInterval(hostTimer);
      hostTimer = 0;
    }
  }

  // 主机模拟用 setInterval 驱动：rAF 在后台/headless 里可能被挂起，
  // 但主机需要稳定出快照。document.hidden 时显式暂停。
  function hostTick() {
    if (!hostWorld || phase !== 'playing' || document.hidden) return;
    if (!client || !client.ws || client.ws.readyState !== 1) return; // 断线时暂停模拟
    var now = performance.now();
    if (!hostLast) hostLast = now;
    var dt = Math.min(now - hostLast, 100);
    hostLast = now;
    hostAcc += dt;

    var steps = 0;
    while (hostAcc >= CC.TICK_MS && steps < 3 && hostWorld.phase === C.PHASE.PLAYING) {
      if (client.slot) C.setAim(hostWorld, client.slot, aim.x, aim.y);
      C.step(hostWorld);
      hostSteps++;
      spawnFx(hostWorld.fx);
      hostAcc -= CC.TICK_MS;
      steps++;
    }
    if (steps >= 3) hostAcc = 0;

    if (hostWorld.phase === C.PHASE.OVER) {
      finishHostRound();
      return;
    }
    if (hostWorld.tick % CC.SNAP_EVERY === 0 && hostWorld.tick !== lastSnapTick) {
      sendSnapshot();
    }
  }

  function finishHostRound() {
    phase = 'over';
    sendSnapshot();
    if (isHost()) {
      roomLocked = false;
      client.lock(false);
    }
    stopHostTimer();
    hostAcc = 0;
    showOver(hostWorld.win, hostWorld.score, hostWorld.wave);
    renderRoom();
    updateHud(performance.now());
  }

  function abortRound(reason) {
    if (phase === 'lobby') return;
    stopHostTimer();
    phase = 'lobby';
    hostWorld = null;
    snapshots = [];
    snapTotal = 0;
    latest = null;
    selfPos = null;
    config = null;
    colorOf = {};
    lastAppliedTick = -1;
    lastSnapTick = -1;
    syncing = false;
    particles = [];
    flash = 0;
    clearTimeout(resumeTimer);
    if (isHost()) {
      roomLocked = false;
      if (client && client.joined) client.lock(false);
    }
    toast(reason, 'warn');
    renderRoom();
  }

  // ------------------------------------------------------------ 渲染输入

  function spawnFx(list) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var fx = list[i];
      if (fx.type === 'boom') {
        addBoom(fx.x, fx.y, fx.size > 40 ? 1.6 : 0.9);
        flash = Math.max(flash, fx.size > 40 ? 0.55 : 0.32);
      } else if (fx.type === 'hit') {
        addHit(fx.x, fx.y, 6, '#ff5d5d');
        if (fx.slot === client.slot) flash = Math.max(flash, 0.5);
      } else {
        addHit(fx.x, fx.y, 3, '#ffd166');
      }
    }
  }

  function addBoom(x, y, scale) {
    var n = Math.round(12 * scale);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 40 + Math.random() * 220 * scale;
      addParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        200 + Math.random() * 380, 2 + Math.random() * 4 * scale,
        Math.random() < 0.5 ? '#ffb347' : '#ff5d5d');
    }
  }

  function addHit(x, y, n, color) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 30 + Math.random() * 180;
      addParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        120 + Math.random() * 260, 1.5 + Math.random() * 2.5, color);
    }
  }

  function addParticle(x, y, vx, vy, life, size, color) {
    if (particles.length >= 240) particles.shift();
    particles.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, color: color });
  }

  function diffFx(prev, next) {
    if (!prev || !next) return;
    var ids = {};
    var i;
    for (i = 0; i < next.enemies.length; i++) ids[next.enemies[i].id] = 1;
    for (i = 0; i < prev.enemies.length; i++) {
      var e = prev.enemies[i];
      if (!ids[e.id] && e.y > -20 && e.y < H + 20) {
        addBoom(e.x, e.y, e.kind === 3 ? 1.6 : (e.kind === 2 ? 0.95 : 0.65));
      }
    }
    var pm = {};
    for (i = 0; i < prev.players.length; i++) pm[prev.players[i].slot] = prev.players[i];
    for (i = 0; i < next.players.length; i++) {
      var p = next.players[i];
      var old = pm[p.slot];
      if (!old) continue;
      if (old.hp > p.hp) {
        addHit(p.x, p.y, p.slot === client.slot ? 10 : 6, '#ff5d5d');
        if (p.slot === client.slot) flash = Math.max(flash, 0.5);
      }
    }
  }

  function setAimFromEvent(ev) {
    if (phase !== 'playing') return;
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    aim.x = clamp((ev.clientX - r.left) / r.width * W, CC.MARGIN_X, W - CC.MARGIN_X);
    aim.y = clamp((ev.clientY - r.top) / r.height * H, CC.MARGIN_TOP, H - CC.MARGIN_BOTTOM);
    aimTouched = true;
  }

  function predictSelf(dt) {
    if (!selfPos) return;
    var me = latest ? findSnapPlayer(latest, client.slot) : null;
    if (me && (me.state === 2 || me.state === 3)) {
      selfPos = { x: me.x, y: me.y };
      return;
    }
    var np = C.seek(selfPos, aim, CC.PLAYER_SPEED, dt / 1000);
    selfPos.x = clamp(np.x, CC.MARGIN_X, W - CC.MARGIN_X);
    selfPos.y = clamp(np.y, CC.MARGIN_TOP, H - CC.MARGIN_BOTTOM);
  }

  // ------------------------------------------------------------ 视图

  function hostView() {
    var w = hostWorld;
    var boss = C.bossOf(w);
    var view = {
      tick: w.tick,
      phase: w.phase,
      win: w.win,
      wave: w.wave,
      score: w.score,
      bossHp: boss ? boss.hp : 0,
      bossMaxHp: boss ? boss.maxHp : 0,
      players: [],
      enemies: [],
      ebullets: [],
      pbullets: []
    };
    var i;
    for (i = 0; i < w.players.length; i++) {
      var p = w.players[i];
      view.players.push({
        slot: p.slot, x: p.x, y: p.y, hp: p.hp, lives: p.lives,
        state: p.state, online: p.connected
      });
    }
    for (i = 0; i < w.enemies.length; i++) {
      var e = w.enemies[i];
      view.enemies.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, boss: e.boss });
    }
    for (i = 0; i < w.ebullets.length; i++) {
      var eb = w.ebullets[i];
      view.ebullets.push({ x: eb.x, y: eb.y, vx: eb.vx, vy: eb.vy, kind: eb.kind });
    }
    for (i = 0; i < w.pbullets.length; i++) {
      var pb = w.pbullets[i];
      view.pbullets.push({ x: pb.x, y: pb.y, vx: pb.vx, vy: pb.vy, owner: pb.owner, kind: pb.kind });
    }
    return view;
  }

  function clientView(now) {
    if (!latest) return null;
    if (snapshots.length < 2) {
      var v0 = fromSnap(latest, now);
      overrideSelf(v0);
      return v0;
    }

    var a = snapshots[0];
    var b = snapshots[snapshots.length - 1];
    var renderAt = now - CC.INTERP_MS;
    for (var i = 0; i < snapshots.length - 1; i++) {
      if (snapshots[i].arrived <= renderAt && snapshots[i + 1].arrived > renderAt) {
        a = snapshots[i];
        b = snapshots[i + 1];
        break;
      }
    }
    if (renderAt >= b.arrived) {
      a = snapshots[snapshots.length - 2];
      b = snapshots[snapshots.length - 1];
    }
    var span = b.arrived - a.arrived;
    var alpha = span > 0 ? clamp((renderAt - a.arrived) / span, 0, 1) : 1;

    var view = {
      tick: b.snap.tick,
      phase: b.snap.phase,
      win: b.snap.win,
      wave: b.snap.wave,
      score: b.snap.score,
      bossHp: b.snap.bossHp,
      bossMaxHp: b.snap.bossMaxHp,
      players: [],
      enemies: [],
      ebullets: [],
      pbullets: []
    };

    var am = {};
    for (i = 0; i < a.snap.players.length; i++) am[a.snap.players[i].slot] = a.snap.players[i];
    for (i = 0; i < b.snap.players.length; i++) {
      var p = b.snap.players[i];
      var q = am[p.slot];
      view.players.push({
        slot: p.slot,
        x: q ? lerp(q.x, p.x, alpha) : p.x,
        y: q ? lerp(q.y, p.y, alpha) : p.y,
        hp: p.hp, lives: p.lives, state: p.state, online: p.online
      });
    }

    var ae = {};
    for (i = 0; i < a.snap.enemies.length; i++) ae[a.snap.enemies[i].id] = a.snap.enemies[i];
    for (i = 0; i < b.snap.enemies.length; i++) {
      var e = b.snap.enemies[i];
      var ea = ae[e.id];
      view.enemies.push({
        id: e.id, kind: e.kind,
        x: ea ? lerp(ea.x, e.x, alpha) : e.x,
        y: ea ? lerp(ea.y, e.y, alpha) : e.y,
        hp: e.hp, boss: e.boss
      });
    }

    var age = clamp(renderAt - b.arrived, -CC.TICK_MS, CC.EXTRAP_MAX_MS);
    var tf = age / CC.TICK_MS;
    for (i = 0; i < b.snap.ebullets.length; i++) {
      var eb = b.snap.ebullets[i];
      view.ebullets.push({ x: eb.x + eb.vx * tf, y: eb.y + eb.vy * tf, vx: eb.vx, vy: eb.vy, kind: eb.kind });
    }
    for (i = 0; i < b.snap.pbullets.length; i++) {
      var pb = b.snap.pbullets[i];
      view.pbullets.push({
        x: pb.x + pb.vx * tf, y: pb.y + pb.vy * tf,
        vx: pb.vx, vy: pb.vy, owner: pb.owner, kind: pb.kind
      });
    }

    overrideSelf(view);
    return view;
  }

  function fromSnap(snap, now) {
    var age = clamp((now - CC.INTERP_MS) - lastSnapshotAt, -CC.TICK_MS, CC.EXTRAP_MAX_MS);
    var tf = age / CC.TICK_MS;
    var view = {
      tick: snap.tick, phase: snap.phase, win: snap.win, wave: snap.wave, score: snap.score,
      bossHp: snap.bossHp, bossMaxHp: snap.bossMaxHp,
      players: [], enemies: [], ebullets: [], pbullets: []
    };
    var i;
    for (i = 0; i < snap.players.length; i++) {
      var p = snap.players[i];
      view.players.push({
        slot: p.slot, x: p.x, y: p.y, hp: p.hp, lives: p.lives, state: p.state, online: p.online
      });
    }
    for (i = 0; i < snap.enemies.length; i++) {
      var e = snap.enemies[i];
      view.enemies.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, boss: e.boss });
    }
    for (i = 0; i < snap.ebullets.length; i++) {
      var eb = snap.ebullets[i];
      view.ebullets.push({ x: eb.x + eb.vx * tf, y: eb.y + eb.vy * tf, kind: eb.kind });
    }
    for (i = 0; i < snap.pbullets.length; i++) {
      var pb = snap.pbullets[i];
      view.pbullets.push({ x: pb.x + pb.vx * tf, y: pb.y + pb.vy * tf, owner: pb.owner, kind: pb.kind });
    }
    return view;
  }

  function overrideSelf(view) {
    if (!view || !selfPos || !client) return;
    for (var i = 0; i < view.players.length; i++) {
      var p = view.players[i];
      if (p.slot !== client.slot) continue;
      if (p.state === 0 || p.state === 1) {
        p.x = selfPos.x;
        p.y = selfPos.y;
      }
      return;
    }
  }

  // ------------------------------------------------------------ 绘制

  function initStars() {
    stars = [];
    for (var i = 0; i < 90; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: 0.3 + Math.random() * 0.7,
        s: 0.8 + Math.random() * 1.8
      });
    }
  }

  function ensureCanvas() {
    var want = Math.min(2, window.devicePixelRatio || 1);
    var pw = Math.round(W * want);
    var ph = Math.round(H * want);
    if (want !== dpr || canvas.width !== pw || canvas.height !== ph) {
      dpr = want;
      canvas.width = pw;
      canvas.height = ph;
      bgGrad = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!bgGrad) {
      bgGrad = ctx.createLinearGradient(0, 0, 0, H);
      bgGrad.addColorStop(0, '#0a1426');
      bgGrad.addColorStop(0.55, '#070c16');
      bgGrad.addColorStop(1, '#04060b');
    }
  }

  function drawStars(dt) {
    var i;
    for (i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.y += (18 + s.z * 70) * dt / 1000;
      if (s.y > H + 2) {
        s.y = -2;
        s.x = Math.random() * W;
      }
    }
    ctx.save();
    for (i = 0; i < stars.length; i++) {
      var st = stars[i];
      ctx.globalAlpha = 0.12 + st.z * 0.45;
      ctx.fillStyle = st.z > 0.75 ? '#9dc0ff' : '#6f8bb8';
      ctx.fillRect(st.x, st.y, st.s, st.s * 1.8);
    }
    ctx.restore();
  }

  function draw(now, dt) {
    ensureCanvas();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
    drawStars(dt);

    var view = null;
    if (hostWorld) view = hostView();
    else if (latest) view = clientView(now);
    if (view) drawView(view, now);

    drawParticles(dt);

    if (flash > 0.01) {
      ctx.save();
      ctx.globalAlpha = flash * 0.3;
      ctx.fillStyle = '#ff3b3b';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      flash = Math.max(0, flash - dt / 360);
    }
  }

  function drawView(view, now) {
    var i;
    for (i = 0; i < view.enemies.length; i++) drawEnemy(view.enemies[i], now);
    for (i = 0; i < view.ebullets.length; i++) drawEBullet(view.ebullets[i]);
    for (i = 0; i < view.pbullets.length; i++) drawPBullet(view.pbullets[i]);

    var selfSlot = client ? client.slot : 0;
    for (i = 0; i < view.players.length; i++) {
      if (view.players[i].slot !== selfSlot) drawPlayer(view.players[i], false, now);
    }
    for (i = 0; i < view.players.length; i++) {
      if (view.players[i].slot === selfSlot) drawPlayer(view.players[i], true, now);
    }
  }

  function drawPlayer(p, isSelf, now) {
    var color = colorOfSlot(p.slot);
    var blink = p.state === 1 ? (0.5 + 0.5 * Math.sin(now / 70)) : 1;
    var alpha = p.online === false ? 0.35 : blink;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = alpha;

    if (p.state === 2) {
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.2)';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (p.state === 3) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.shadowColor = color;
    ctx.shadowBlur = isSelf ? 16 : 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -17);
    ctx.lineTo(9, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-9, 9);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(3, 2);
    ctx.lineTo(-3, 2);
    ctx.closePath();
    ctx.fill();

    if (p.state === 1) {
      ctx.strokeStyle = 'rgba(157,192,255,.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.online === false) {
      ctx.strokeStyle = 'rgba(255,93,93,.6)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!isSelf) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#cfe0ff';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('#' + p.slot + ' ' + nameOf(p.slot), 0, -26);
    }
    ctx.restore();
  }

  function drawEnemy(e, now) {
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.kind === 3) {
      var pulse = 1 + 0.03 * Math.sin(now / 160);
      ctx.scale(pulse, pulse);
      ctx.shadowColor = '#ff5d5d';
      ctx.shadowBlur = 26;
      ctx.fillStyle = '#3a1722';
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ff8a8a';
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,209,102,.9)';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      for (var k = 0; k < 4; k++) {
        var a = now / 900 + k * Math.PI / 2;
        ctx.strokeStyle = 'rgba(255,107,107,.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 42, Math.sin(a) * 42);
        ctx.lineTo(Math.cos(a) * 54, Math.sin(a) * 54);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    if (e.kind === 0) {
      ctx.shadowColor = '#ff5d5d';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#e5484d';
      ctx.beginPath();
      ctx.moveTo(0, 13);
      ctx.lineTo(11, -9);
      ctx.lineTo(0, -4);
      ctx.lineTo(-11, -9);
      ctx.closePath();
      ctx.fill();
    } else if (e.kind === 1) {
      ctx.shadowColor = '#f5a623';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#f0a12a';
      ctx.beginPath();
      ctx.moveTo(0, 12);
      ctx.lineTo(11, 0);
      ctx.lineTo(0, -12);
      ctx.lineTo(-11, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.shadowColor = '#b06bff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#8b5cf6';
      ctx.beginPath();
      for (var j = 0; j < 6; j++) {
        var ang = Math.PI / 6 + j * Math.PI / 3;
        var px = Math.cos(ang) * 16;
        var py = Math.sin(ang) * 16;
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEBullet(b) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.shadowColor = b.kind === 2 ? '#ffb347' : '#ff7bd5';
    ctx.shadowBlur = 8;
    ctx.fillStyle = b.kind === 2 ? '#ffb347' : (b.kind === 1 ? '#ff9ad5' : '#ffd1f0');
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.kind === 2 ? 4.5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPBullet(b) {
    ctx.save();
    ctx.shadowColor = '#ffd166';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffe39a';
    ctx.fillRect(b.x - 1.5, b.y - 5, 3, 10);
    ctx.restore();
  }

  function drawParticles(dt) {
    var keep = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt / 1000;
      p.y += p.vy * dt / 1000;
      p.vx *= 0.98;
      p.vy *= 0.98;
      keep.push(p);
    }
    if (keep.length !== particles.length) particles = keep;
    ctx.save();
    for (i = 0; i < particles.length; i++) {
      var q = particles[i];
      ctx.globalAlpha = Math.max(0, q.life / q.max);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ HUD

  function updateHud(now) {
    var s = hostWorld || latest;
    if (!s) {
      $('hudScore').textContent = '0';
      $('hudWave').textContent = '第 1 波';
      $('hudLives').textContent = '—';
      $('hudLag').textContent = '--';
      $('hudLag').className = 'lag';
      show('bossWrap', false);
      return;
    }

    var bossHp = 0;
    var bossMax = 0;
    if (hostWorld) {
      var boss = C.bossOf(hostWorld);
      if (boss) { bossHp = boss.hp; bossMax = boss.maxHp; }
    } else {
      bossHp = latest.bossHp;
      bossMax = latest.bossMaxHp;
    }

    $('hudScore').textContent = String(s.score || 0);
    $('hudWave').textContent = '第 ' + (s.wave || 1) + ' 波';
    show('bossWrap', bossMax > 0);
    if (bossMax > 0) {
      $('bossBar').style.width = Math.max(0, Math.min(100, bossHp / bossMax * 100)) + '%';
    }

    var me = null;
    for (var i = 0; i < s.players.length; i++) {
      if (client && s.players[i].slot === client.slot) me = s.players[i];
    }
    if (me) {
      if (me.state === 2) $('hudLives').textContent = '重生中…';
      else if (me.state === 3) $('hudLives').textContent = '观战中';
      else $('hudLives').textContent = '♥'.repeat(Math.max(0, me.hp)) + ' · ' + me.lives + ' 命';
    } else {
      $('hudLives').textContent = '—';
    }

    if (hostWorld) {
      $('hudLag').textContent = 'HOST';
      $('hudLag').className = 'lag';
    } else {
      var age = lastSnapshotAt ? Math.max(0, Math.round(now - lastSnapshotAt)) : 0;
      $('hudLag').textContent = age + 'ms';
      $('hudLag').className = 'lag' + (age > 600 ? ' bad' : (age > 250 ? ' warn' : ''));
    }

    var ul = $('hudPlayers');
    ul.textContent = '';
    for (i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      var li = document.createElement('li');
      var offline = (p.online === false) || (p.connected === false);
      li.className = 'chip' +
        (p.slot === (client && client.slot) ? ' me' : '') +
        (offline ? ' off' : '');
      var dot = document.createElement('i');
      dot.style.background = colorOfSlot(p.slot);
      li.appendChild(dot);
      var name = document.createElement('span');
      name.textContent = nameOf(p.slot) + ' ' +
        (p.state === 2 ? '重生' : (p.state === 3 ? '观战' : p.hp + '♥'));
      li.appendChild(name);
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------ 覆盖层

  function showOverlay(kind, title, text, action) {
    overlayKind = kind;
    var el = $('overlay');
    el.classList.remove('hidden');
    $('overlayTitle').textContent = title;
    $('overlayText').textContent = text || '';
    var btn = $('overlayBtn');
    if (action) {
      btn.classList.remove('hidden');
      btn.textContent = action.label;
      overlayAction = action.fn;
    } else {
      btn.classList.add('hidden');
      overlayAction = null;
    }
  }

  function hideOverlay() {
    overlayKind = '';
    overlayAction = null;
    $('overlay').classList.add('hidden');
  }

  function showOver(win, score, wave) {
    showOverlay('over', win ? '通关！' : '全员阵亡',
      '分数 ' + score + ' · 第 ' + wave + ' 波',
      isHost() ? { label: '再来一局', fn: startRoundHost } : null);
  }

  function checkStarve(now) {
    if (phase !== 'playing' || isHost() || syncing) return;
    if (!latest) return;
    var age = now - lastSnapshotAt;
    if (age > CC.STARVE_MS) {
      if (overlayKind !== 'paused' && overlayKind !== 'over') {
        showOverlay('paused', '等待主机…', '网络抖动或房主暂停中');
      }
    } else if (overlayKind === 'paused') {
      hideOverlay();
    }
  }

  // ------------------------------------------------------------ 主循环

  function startLoop() {
    if (raf) return;
    lastFrame = 0;
    lastHudAt = 0;
    if (!stars) initStars();
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    if (!joined()) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    if (!lastFrame) lastFrame = now;
    var dt = Math.min(now - lastFrame, 100);
    lastFrame = now;

    if (!isHost() && phase === 'playing') {
      predictSelf(dt);
      checkStarve(now);
    }

    draw(now, dt);

    if (now - lastHudAt > 100) {
      lastHudAt = now;
      updateHud(now);
    }
  }

  // ------------------------------------------------------------ 事件绑定

  $('btnCreate').onclick = function () {
    ensureClient().then(function () {
      if (!joined()) client.create($('pwd').value || '', meta());
    }).catch(function (err) {
      status('未连接', 'bad');
      toast('连接失败：' + (err && err.message ? err.message : err), 'bad');
    });
  };

  $('btnJoin').onclick = function () {
    var code = ($('code').value || '').trim().toUpperCase();
    if (code.length !== 4) return toast('房间码是 4 位字母数字', 'bad');
    ensureClient().then(function () {
      if (!joined()) client.join(code, $('pwd').value || '', meta());
    }).catch(function (err) {
      status('未连接', 'bad');
      toast('连接失败：' + (err && err.message ? err.message : err), 'bad');
    });
  };

  $('btnCopy').onclick = function () {
    var code = (client && client.code) || '';
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(
        function () { toast('房间码已复制：' + code, 'ok'); },
        function () { toast('复制失败，请手动记下：' + code, 'bad'); }
      );
    } else {
      toast('房间码：' + code);
    }
  };

  $('btnLeave').onclick = function () { leaveRoom(); };
  $('btnStart').onclick = function () { startRoundHost(); };

  $('overlayBtn').addEventListener('click', function () {
    if (overlayAction) overlayAction();
  });

  canvas.addEventListener('pointermove', function (ev) {
    // 触摸只跟第一根手指；鼠标/笔始终跟随。
    if (ev.pointerType === 'touch' && ev.pointerId !== activePointer) return;
    setAimFromEvent(ev);
  });
  canvas.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'touch') {
      if (activePointer !== null && ev.pointerId !== activePointer) return;
      activePointer = ev.pointerId;
    }
    setAimFromEvent(ev);
    aimTouched = true;
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
    ev.preventDefault();
  });
  canvas.addEventListener('pointerup', function (ev) {
    if (ev.pointerType === 'touch' && ev.pointerId === activePointer) activePointer = null;
    if (canvas.releasePointerCapture) {
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
  });
  canvas.addEventListener('pointercancel', function (ev) {
    if (ev.pointerType === 'touch' && ev.pointerId === activePointer) activePointer = null;
  });
  canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  $('code').addEventListener('input', function (ev) {
    var el = ev.target;
    var clean = el.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
    if (clean !== el.value) el.value = clean;
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      hostAcc = 0;
      hostLast = performance.now();
      lastFrame = performance.now();
      if (isHost() && phase === 'playing' && hostWorld && !hostTimer) startHostTimer();
    }
  });

  window.addEventListener('beforeunload', function () {
    if (client) {
      try { client.close(); } catch (e) { /* ignore */ }
    }
  });

  // 30Hz 发目标点；主机不给自己发（本地直接 setAim）。
  setInterval(function () {
    if (!joined() || isHost() || phase !== 'playing') return;
    if (!latest) return;
    var me = findSnapPlayer(latest, client.slot);
    if (!me || me.state === 3) return;
    broadcast(N.encodeInput(aim));
  }, 33);

  // ------------------------------------------------------------ 调试钩子（只读）

  window.__planeDebug = {
    phase: function () { return phase; },
    isHost: isHost,
    selfPos: function () {
      if (isHost() && hostWorld) {
        var p = C.findPlayer(hostWorld, client ? client.slot : 0);
        return p ? { x: p.x, y: p.y } : null;
      }
      return selfPos ? { x: selfPos.x, y: selfPos.y } : null;
    },
    aim: function () { return { x: aim.x, y: aim.y }; },
    snapshotCount: function () { return snapTotal; },
    snapshotAge: function () { return lastSnapshotAt ? Date.now() - lastSnapshotAt : -1; },
    tick: function () { return hostWorld ? hostWorld.tick : (latest ? latest.tick : -1); },
    score: function () { return hostWorld ? hostWorld.score : (latest ? latest.score : 0); },
    wave: function () { return hostWorld ? hostWorld.wave : (latest ? latest.wave : 0); },
    players: function () { return config ? config.players.map(function (p) { return p.slot; }) : []; },
    locked: function () { return roomLocked; },
    info: function () {
      return {
        host: client ? client.host : 0,
        slot: client ? client.slot : 0,
        joined: joined(),
        phase: phase,
        snapTotal: snapTotal,
        tick: latest ? latest.tick : -1,
        players: latest ? latest.players.map(function (p) { return p.slot; }) : [],
        cfgPlayers: config ? config.players.map(function (p) { return p.slot; }) : [],
        snapAge: lastSnapshotAt ? Date.now() - lastSnapshotAt : -1,
        hidden: document.hidden,
        raf: !!raf,
        hostTick: hostWorld ? hostWorld.tick : -1,
        hostSteps: hostSteps,
        hostSnaps: hostSnaps,
        hostTimer: !!hostTimer,
        relayFrames: relayFrames,
        snapFrames: snapFrames,
        startFrames: startFrames,
        lastAppliedTick: lastAppliedTick,
        lastSnapTick: lastSnapTick,
        hostAcc: Math.round(hostAcc)
      };
    }
  };

  // ------------------------------------------------------------ 启动

  initStars();
  status('未连接', '');
})();
