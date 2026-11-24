// bulls.js — 「猜数字」页面控制器。
//
// 只做三件事：把 RelayClient 的事件翻译成对局消息、把 Bulls 状态机渲染成界面、
// 在断线/重连时做一次全量同步。业务判定全部在 bulls-core.js。
(function () {
  'use strict';

  var R = window.Relay;
  var B = window.Bulls;
  var $ = function (id) { return document.getElementById(id); };

  var client = null;
  var pendingConnect = null;
  var game = B.newGame({});
  var mySecret = '';        // 只存在本机，永不上传
  var opponentSecret = '';  // 胜负揭晓后才会有值
  var pending = false;      // 已发出猜测，等对手判定
  var lockedSecret = false; // 本轮暗号已锁定
  var peeking = false;      // 是否明文显示自己的暗号
  var revealedSent = false; // 结算后是否已公开自己的暗号
  var roomLocked = false;
  var startRecord = { round: 0, at: 0, count: 0 };
  var startTimer = 0;
  var toastTimer = 0;

  // ------------------------------------------------------------ 小工具

  function wsURL() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function status(text, kind) {
    $('statusText').textContent = text;
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
  }

  function toast(text, kind) {
    var el = $('toast');
    el.textContent = text;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function hint(el, text, kind) {
    el.textContent = text || '';
    el.className = 'hint' + (kind ? ' ' + kind : '');
  }

  function show(id, visible) {
    $(id).classList.toggle('hidden', !visible);
  }

  function memberList() {
    return client && client.joined ? client.members : [];
  }

  function slots() {
    var me = client && client.joined ? client.slot : 0;
    var other = 0;
    var list = memberList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].slot !== me) { other = list[i].slot; break; }
    }
    return {
      selfSlot: me,
      otherSlot: other,
      hostSlot: client && client.joined ? client.host : 0
    };
  }

  function memberOnline(slot) {
    if (!slot) return false;
    var list = memberList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].slot === slot) return !!list[i].online;
    }
    return false;
  }

  function nameOf(slot) {
    var list = memberList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].slot !== slot) continue;
      try {
        var meta = JSON.parse(R.fromUtf8(list[i].meta));
        if (meta && meta.name) return String(meta.name);
      } catch (e) { /* meta 不是 JSON 就用 slot 显示 */ }
      return '#' + slot;
    }
    return slot ? '#' + slot : '对手';
  }

  function syncPlayers() {
    game = B.bindPlayers(game, slots());
  }

  function send(obj, targets) {
    if (!client || !client.joined) return false;
    return client.relay(obj, targets || []);
  }

  // 房间 seq 是全局的，而 RELAY 只投给 targets。双人对局里如果只发给对手，
  // 发件人自己就收不到这一帧，双方各自看到的 seq 会跳号，RelayClient 会误判
  // 空洞（4000）并重连丢帧。所以所有消息都把「自己」也放进 targets：
  // 每个成员都收到全部帧，seq 连续；自己的回显在 onPayload 里按 from 忽略。
  function broadcast(obj) {
    var s = slots();
    var targets = [];
    if (s.selfSlot) targets.push(s.selfSlot);
    if (s.otherSlot) targets.push(s.otherSlot);
    return send(obj, targets);
  }

  function requestSync() {
    var s = slots();
    if (!s.otherSlot) return;
    broadcast({ t: 'sync_req' });
  }

  // ------------------------------------------------------------ 渲染

  function render() {
    var inRoom = !!(client && client.joined);
    document.body.classList.toggle('in-room', inRoom);
    show('cardLobby', !inRoom);
    show('cardPlay', inRoom);
    show('cardMembers', inRoom);
    renderMembers();
    if (!inRoom) return;

    var s = slots();
    var waiting = !s.otherSlot;
    var offline = !waiting && !memberOnline(s.otherSlot);

    $('roomCode').textContent = client.code || '----';
    $('bigCode').textContent = client.code || '----';
    $('roundTag').textContent = '第 ' + game.round + ' 局';
    $('oppName').textContent = waiting ? '等待加入…' : nameOf(s.otherSlot);
    $('oppDot').className = 'mdot' + (waiting || offline ? ' off' : '');
    $('oppReady').classList.toggle('hidden', !(s.otherSlot && game.ready[s.otherSlot]));

    show('waitBox', waiting);
    show('setupBox', !waiting && game.phase === B.PHASE.SETUP);
    show('playBox', !waiting && game.phase === B.PHASE.PLAYING);
    show('overBox', !waiting && game.phase === B.PHASE.OVER);

    renderSetup();
    renderPlay(offline);
    renderOver();
    renderHistory();

    if (!waiting && game.phase === B.PHASE.SETUP) maybeStart();
  }

  function renderMembers() {
    var ul = $('members');
    ul.textContent = '';
    var list = memberList();
    $('memberCount').textContent = String(list.length);
    for (var i = 0; i < list.length; i++) {
      (function (m) {
        var li = document.createElement('li');
        li.className = 'member' +
          (client && m.slot === client.slot ? ' self' : '') +
          (m.online ? '' : ' offline');
        var dot = document.createElement('i');
        dot.className = 'mdot' + (m.online ? '' : ' off');
        li.appendChild(dot);
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = '#' + m.slot + ' ' + nameOf(m.slot) +
          (client && m.slot === client.slot ? '（你）' : '');
        li.appendChild(name);
        if (client && m.slot === client.host) {
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
      })(list[i]);
    }
  }

  function renderSetup() {
    if (game.phase !== B.PHASE.SETUP) return;
    var s = slots();
    $('secretInput').disabled = lockedSecret;
    $('btnSecret').textContent = lockedSecret ? '换一个暗号' : '锁定暗号';
    if (!lockedSecret) {
      hint($('secretHint'), '4 位数字，可重复，首位不能是 0');
    } else if (!game.ready[s.otherSlot]) {
      hint($('secretHint'), '已锁定，等对手设好暗号…', 'ok');
    } else {
      hint($('secretHint'), '双方就绪，开局中…', 'ok');
    }
  }

  function renderPlay(offline) {
    if (game.phase !== B.PHASE.PLAYING) return;
    var mine = B.isMyTurn(game);
    var band = $('turnBand');
    if (offline) {
      band.className = 'band warn';
      band.textContent = '对手断线，等对手重连…';
    } else if (pending) {
      band.className = 'band muted';
      band.textContent = '已发出，等对手判定…';
    } else if (mine) {
      band.className = 'band';
      band.textContent = '轮到你猜 · 第 ' + (B.guessCount(game, game.selfSlot) + 1) + ' 次';
    } else {
      band.className = 'band muted';
      band.textContent = '等对手猜…';
    }

    $('mySecret').textContent = peeking ? (mySecret || '未设') : '••••';
    $('btnPeek').textContent = peeking ? '隐藏' : '显示';

    var can = !offline && !pending && B.canGuess(game);
    $('guessInput').disabled = !can;
    $('btnGuess').disabled = !can;
    hint($('guessHint'), can ? '' : (offline ? '对手回来后才能继续' : mine ? '等判定结果…' : '对手正在猜'));
  }

  function renderOver() {
    if (game.phase !== B.PHASE.OVER) return;
    var win = game.winner === game.selfSlot;
    var band = $('resultBand');
    band.className = 'band ' + (win ? 'win' : 'lose');
    band.textContent = win ? '你赢了！' : '对手先猜中了';

    var my = mySecret || '未记录';
    var other = opponentSecret || '未公开';
    $('revealLine').textContent = '你的暗号 ' + my + ' · 对手暗号 ' + other;

    var host = B.isHost(game);
    $('btnRematch').disabled = !host;
    $('btnRematch').textContent = host ? '再来一局' : '等房主开下一局';
    hint($('rematchHint'), host ? '双方重新设暗号，先手交替。' : '房主点了「再来一局」后会自动进入下一局。');
  }

  function renderHistory() {
    var mine = [];
    var theirs = [];
    for (var i = 0; i < game.history.length; i++) {
      var h = game.history[i];
      (h.slot === game.selfSlot ? mine : theirs).push(h);
    }
    fillHistory($('historyMine'), mine, '还没猜过');
    fillHistory($('historyTheirs'), theirs, '还没猜过');
  }

  function fillHistory(ul, list, emptyText) {
    ul.textContent = '';
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = emptyText;
      ul.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      var li = document.createElement('li');
      li.className = 'hit h' + h.hits + (h.win ? ' win' : '');
      var digits = document.createElement('b');
      digits.textContent = h.guess;
      var badge = document.createElement('span');
      badge.className = 'n';
      badge.textContent = h.win ? '4 个 · 命中' : h.hits + ' 个';
      li.appendChild(digits);
      li.appendChild(badge);
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------ 开局

  // 只有房主发起 start，且带重试：万一发送时连接正好断开，2 秒后再发一次。
  function maybeStart() {
    var s = slots();
    if (!s.otherSlot || !B.isHost(game) || !B.bothReady(game)) return;
    if (startRecord.round !== game.round) {
      startRecord = { round: game.round, at: 0, count: 0 };
    }
    if (startRecord.count >= 3) return;
    var wait = 2000 - (Date.now() - startRecord.at);
    if (startRecord.at && wait > 0) {
      if (!startTimer) {
        startTimer = setTimeout(function () {
          startTimer = 0;
          render();
        }, wait);
      }
      return;
    }

    var turn = game.round % 2 === 1
      ? s.hostSlot
      : (s.hostSlot === s.selfSlot ? s.otherSlot : s.selfSlot);
    var msg = { t: 'start', round: game.round, turn: turn };
    if (!broadcast(msg)) return;

    startRecord.at = Date.now();
    startRecord.count++;
    var r = B.applyStart(game, msg);
    if (r.ok) {
      pending = false;
      game = r.state;
      render();
      toast(B.isMyTurn(game) ? '开局，你先猜' : '开局，对手先猜', 'ok');
    }
  }

  function resetRound() {
    mySecret = '';
    opponentSecret = '';
    lockedSecret = false;
    pending = false;
    peeking = false;
    revealedSent = false;
    $('secretInput').value = '';
    $('secretInput').disabled = false;
    $('guessInput').value = '';
  }

  // 结算后双方各公开一次自己的暗号，这样两边都能看到完整答案。
  // 只在 phase=over 时发，暗号在此之前绝不出本机。
  function announceReveal() {
    if (revealedSent || game.phase !== B.PHASE.OVER || !mySecret) return;
    revealedSent = true;
    broadcast({ t: 'reveal', round: game.round, secret: mySecret });
  }

  function onRevealMsg(from, msg) {
    if (from !== slots().otherSlot) return;
    if (game.phase !== B.PHASE.OVER || Number(msg.round) !== game.round) return;
    var v = B.check(msg.secret);
    if (!v.ok) return;
    opponentSecret = v.value;
    render();
  }

  // ------------------------------------------------------------ 消息

  function onPayload(from, payload) {
    var msg;
    try {
      msg = JSON.parse(R.fromUtf8(payload));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    if (from === slots().selfSlot) return; // 自己的回显：本地已经应用过

    switch (msg.t) {
      case 'secret': onSecretMsg(from, msg); break;
      case 'start': onStartMsg(msg); break;
      case 'guess': onGuessMsg(from, msg); break;
      case 'judge': onJudgeMsg(msg); break;
      case 'rematch': onRematchMsg(msg); break;
      case 'sync_req': onSyncRequest(); break;
      case 'sync': onSyncMsg(msg); break;
      case 'reveal': onRevealMsg(from, msg); break;
      default: break;
    }
  }

  function onSecretMsg(from, msg) {
    msg.from = from;
    var r = B.applySecret(game, msg);
    if (!r.ok) return;
    game = r.state;
    toast(nameOf(from) + ' 的暗号已设好');
    render();
  }

  function onStartMsg(msg) {
    var r = B.applyStart(game, msg);
    if (!r.ok) {
      if (r.reason === 'not-ready' || r.reason === 'stale-round') requestSync();
      return;
    }
    pending = false;
    game = r.state;
    render();
    toast(B.isMyTurn(game) ? '开局，你先猜' : '开局，对手先猜', 'ok');
  }

  // 我是裁判：对手的猜测由我本地判定，结果广播给双方。
  function onGuessMsg(from, msg) {
    var s = slots();
    if (from !== s.otherSlot) return;
    if (!mySecret) {
      toast('你的暗号不在本机，本局无法判定', 'bad');
      return;
    }
    if (game.phase !== B.PHASE.PLAYING || Number(msg.round) !== game.round) return;
    if (from !== game.turn) {
      toast('还没轮到他猜', 'bad');
      return;
    }
    var v = B.check(msg.n);
    if (!v.ok) return;

    var h = B.hits(mySecret, v.value);
    var win = h === B.MAX_HITS;
    var judge = {
      t: 'judge',
      round: game.round,
      by: s.selfSlot,
      guess: v.value,
      hits: h,
      win: win,
      winner: win ? from : 0,
      next: win ? 0 : s.selfSlot
    };
    broadcast(judge);
    onJudgeMsg(judge);
  }

  function onJudgeMsg(msg) {
    var r = B.applyJudge(game, msg);
    if (!r.ok) {
      if (r.reason === 'stale-round' || r.reason === 'not-playing') requestSync();
      return;
    }
    game = r.state;
    pending = false;

    var last = game.history[game.history.length - 1];
    if (last && last.win && last.slot === game.selfSlot) {
      // 我猜中的就是对手的暗号；对手的暗号由对方在结算时主动公开。
      opponentSecret = last.guess;
    }
    render();
    if (game.phase === B.PHASE.OVER) {
      announceReveal();
      toast(game.winner === game.selfSlot ? '猜中了！' : '对手猜中了', game.winner === game.selfSlot ? 'ok' : 'bad');
    } else if (last) {
      toast('猜 ' + last.guess + ' → ' + last.hits + ' 个全对');
    }
  }

  function onRematchMsg(msg) {
    var r = B.applyRematch(game, msg);
    if (!r.ok) {
      if (r.reason === 'stale-round') requestSync();
      return;
    }
    resetRound();
    game = r.state;
    startRecord = { round: 0, at: 0, count: 0 };
    render();
    toast('第 ' + game.round + ' 局：重新设暗号', 'ok');
  }

  function onSyncRequest() {
    if (!slots().otherSlot) return;
    broadcast({ t: 'sync', state: B.snapshot(game) });
  }

  function onSyncMsg(msg) {
    var r = B.restore(game, msg.state);
    if (!r.ok) return;
    if (r.state.phase === B.PHASE.PLAYING && !mySecret) {
      toast('局面已同步，但你的暗号不在本机，请让房主开下一局', 'bad');
      return;
    }
    game = r.state;
    pending = false;
    render();
  }

  // ------------------------------------------------------------ 房间

  function lockRoom(value) {
    if (!client || !client.joined || !B.isHost(game)) return;
    if (roomLocked === value) return;
    roomLocked = value;
    client.lock(value);
  }

  function enterRoom(text) {
    syncPlayers();
    status('房间 ' + (client.code || ''), 'ok');
    if (text) toast(text, 'ok');
    render();
    if (B.isHost(game) && memberList().length >= 2) lockRoom(true);
  }

  function leaveToLobby() {
    client = null;
    pendingConnect = null;
    game = B.newGame({});
    resetRound();
    roomLocked = false;
    startRecord = { round: 0, at: 0, count: 0 };
    status('未连接', '');
    render();
  }

  function wire(c) {
    c.on('ready', function (m) {
      if (!m.resumed) status('已连接', 'ok');
    });
    c.on('created', function (m) { enterRoom('房间已创建：' + m.code); });
    c.on('joined', function (m) { enterRoom('已加入房间 ' + m.code); });
    c.on('resumed', function (m) {
      enterRoom('已回到房间 ' + m.code);
      requestSync();
    });
    c.on('reconnected', function (m) {
      if (m.missed) toast('服务端补发了 ' + m.missed + ' 帧');
    });
    c.on('peerJoin', function (p) {
      syncPlayers();
      toast('#' + p.slot + ' ' + nameOf(p.slot) + ' 加入');
      if (B.isHost(game) && memberList().length >= 2) lockRoom(true);
      render();
    });
    c.on('peerLeave', function (p) {
      syncPlayers();
      resetRound();
      startRecord = { round: 0, at: 0, count: 0 };
      if (B.isHost(game)) lockRoom(false);
      toast('#' + p.slot + ' 离开了房间');
      render();
    });
    c.on('peerOffline', function (p) {
      if (p.slot === slots().otherSlot) toast('对手断线，等待重连…', 'warn');
      render();
    });
    c.on('peerRejoin', function (p) {
      if (p.slot === slots().otherSlot) toast('对手回来了', 'ok');
      syncPlayers();
      render();
    });
    c.on('host', function (h) {
      syncPlayers();
      roomLocked = false;
      toast('房主变更为 #' + h.slot);
      if (B.isHost(game) && memberList().length >= 2) lockRoom(true);
      render();
    });
    c.on('relay', function (m) { onPayload(m.from, m.payload); });
    c.on('serverError', function (e) {
      var map = {
        ROOM_NOT_FOUND: '房间不存在或已解散',
        ROOM_FULL: '房间已满',
        ROOM_LOCKED: '房间已锁定（这一局已经满 2 人）',
        BAD_PASSWORD: '密码不对',
        NOT_HOST: '只有房主能做这个操作',
        RATE_LIMITED: '操作太频繁，稍等一下',
        ALREADY_JOINED: '你已经在房间里了',
        BAD_TARGET: '目标不在房间里',
        BAD_FRAME: '协议帧异常'
      };
      toast(map[e.name] || ('服务端错误：' + e.name), 'bad');
    });
    c.on('kicked', function () { toast('你被房主移出了房间', 'bad'); });
    c.on('resync', function () {
      toast('补发窗口不足，正在同步局面…', 'warn');
      requestSync();
    });
    c.on('gap', function () { /* RelayClient 会带 lastSeq 重连补齐 */ });
    c.on('reconnecting', function () { status('重连中…', 'warn'); });
    c.on('close', function () { status('连接关闭', 'bad'); });
    c.on('stopped', function () {
      status('已断开', 'bad');
      leaveToLobby();
      toast('连接已断开，请重新进入房间', 'bad');
    });
  }

  function ensureClient() {
    if (client && client.ws && client.ws.readyState === 1) return Promise.resolve(client);
    if (!client) {
      client = new R.RelayClient({
        url: wsURL(),
        token: ($('token').value || '').trim() || 'dev-token'
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

  function meta() {
    return { name: ($('nickname').value || '').trim() || '匿名' };
  }

  // ------------------------------------------------------------ 事件绑定

  $('btnCreate').onclick = function () {
    ensureClient().then(function () {
      client.create(($('pwd').value || ''), meta());
    }).catch(function (err) {
      status('未连接', 'bad');
      toast('连接失败：' + err.message, 'bad');
    });
  };

  $('btnJoin').onclick = function () {
    var code = ($('code').value || '').trim().toUpperCase();
    if (code.length !== 4) return toast('房间码是 4 位字母数字', 'bad');
    ensureClient().then(function () {
      client.join(code, ($('pwd').value || ''), meta());
    }).catch(function (err) {
      status('未连接', 'bad');
      toast('连接失败：' + err.message, 'bad');
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

  $('btnLeave').onclick = function () {
    if (!client || !client.joined) return leaveToLobby();
    client.leave();
    game = B.newGame({});
    resetRound();
    roomLocked = false;
    status('已连接', 'ok');
    toast('已离开房间');
    render();
  };

  $('btnSecret').onclick = function () {
    if (lockedSecret) {
      lockedSecret = false;
      $('secretInput').disabled = false;
      $('secretInput').focus();
      render();
      return;
    }
    var v = B.check($('secretInput').value);
    if (!v.ok) return hint($('secretHint'), v.msg, 'bad');
    mySecret = v.value;
    lockedSecret = true;
    broadcast({ t: 'secret', round: game.round });
    var r = B.applySecret(game, { t: 'secret', from: slots().selfSlot, round: game.round });
    if (r.ok) game = r.state;
    toast('暗号已锁定', 'ok');
    render();
  };

  $('btnPeek').onclick = function () {
    peeking = !peeking;
    render();
  };

  $('btnGuess').onclick = submitGuess;

  $('btnRematch').onclick = function () {
    if (!B.isHost(game)) return toast('等房主开下一局', 'warn');
    var msg = { t: 'rematch', round: game.round + 1 };
    if (!broadcast(msg)) return;
    var r = B.applyRematch(game, msg);
    if (!r.ok) return;
    resetRound();
    game = r.state;
    startRecord = { round: 0, at: 0, count: 0 };
    render();
    toast('第 ' + game.round + ' 局，重新设暗号', 'ok');
  };

  function submitGuess() {
    var s = slots();
    if (!s.otherSlot || pending || !B.canGuess(game)) return;
    var v = B.check($('guessInput').value);
    if (!v.ok) return hint($('guessHint'), v.msg, 'bad');
    if (!broadcast({ t: 'guess', round: game.round, n: v.value })) return;
    pending = true;
    $('guessInput').value = '';
    render();
  }

  $('guessInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      submitGuess();
    }
  });

  // 只允许数字：手机数字键盘 + 粘贴兜底。
  ['secretInput', 'guessInput'].forEach(function (id) {
    $(id).addEventListener('input', function (ev) {
      var el = ev.target;
      var clean = el.value.replace(/\D+/g, '').slice(0, 4);
      if (clean !== el.value) el.value = clean;
    });
  });

  $('code').addEventListener('input', function (ev) {
    var el = ev.target;
    var clean = el.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
    if (clean !== el.value) el.value = clean;
  });

  window.addEventListener('beforeunload', function () {
    if (client) client.close();
  });

  render();
  status('未连接', '');
})();
