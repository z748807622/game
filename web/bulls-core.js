// bulls-core.js — 「猜数字」双人对局内核。
//
// 纯函数 + 纯状态机，不碰 DOM、不碰 WebSocket：浏览器里挂 window.Bulls，
// Node 里 require 直接用。中继服务器不解析 payload，所以全部规则都在这里，
// 由暗号持有者担任「裁判」，只把判定结果广播出去。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bulls = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 暗号与猜测都是 4 位数字；暗号首位不能为 0（1000–9999，数字可重复）。
  var NUMBER = /^[0-9]{4}$/;
  var SECRET = /^[1-9][0-9]{3}$/;

  var PHASE = { SETUP: 'setup', PLAYING: 'playing', OVER: 'over' };

  var MAX_HITS = 4;

  function text(v) {
    return v == null ? '' : String(v).trim();
  }

  function slotOf(v) {
    var n = Number(v);
    return n > 0 && n <= 0xffff ? n : 0;
  }

  function clone(state) {
    return {
      selfSlot: state.selfSlot,
      otherSlot: state.otherSlot,
      hostSlot: state.hostSlot,
      round: state.round,
      phase: state.phase,
      turn: state.turn,
      history: state.history.map(function (h) {
        return { slot: h.slot, guess: h.guess, hits: h.hits, win: h.win };
      }),
      winner: state.winner,
      ready: Object.assign({}, state.ready)
    };
  }

  function ok(state) {
    return { ok: true, state: state };
  }

  function reject(reason, msg) {
    return { ok: false, reason: reason, msg: msg || '' };
  }

  // ------------------------------------------------------------ 输入校验

  // 校验一个 4 位数字串（暗号和猜测共用）。返回 {ok,value} 或 {ok:false,code,msg}。
  function check(v) {
    var s = text(v);
    if (!NUMBER.test(s)) {
      return { ok: false, code: 'format', msg: '要 4 位数字（0–9）' };
    }
    if (!SECRET.test(s)) {
      return { ok: false, code: 'leading-zero', msg: '首位不能是 0' };
    }
    return { ok: true, value: s };
  }

  // 数字和位置同时对上的位数，0–4。重复数字按位置逐个比较，不做去重。
  function hits(secret, guess) {
    var a = text(secret);
    var b = text(guess);
    var n = Math.min(a.length, b.length, MAX_HITS);
    var c = 0;
    for (var i = 0; i < n; i++) {
      if (a.charAt(i) === b.charAt(i)) c++;
    }
    return c;
  }

  // ------------------------------------------------------------ 状态

  // 新对局。局号从 1 开始，phase=setup（等双方设暗号）。
  function newGame(opts) {
    opts = opts || {};
    return {
      selfSlot: slotOf(opts.selfSlot),
      otherSlot: slotOf(opts.otherSlot),
      hostSlot: slotOf(opts.hostSlot),
      round: 1,
      phase: PHASE.SETUP,
      turn: 0,
      history: [],
      winner: 0,
      ready: {}
    };
  }

  // 成员变化后重新绑定身份（进房、对手进出、房主转移都调用它）。
  function bindPlayers(state, slots) {
    slots = slots || {};
    var next = clone(state);
    next.selfSlot = slotOf(slots.selfSlot) || next.selfSlot;
    next.otherSlot = slotOf(slots.otherSlot);
    next.hostSlot = slotOf(slots.hostSlot) || next.hostSlot;
    if (next.otherSlot === 0) {
      // 对手走了：清掉就绪标记，回到等待状态。
      next.phase = PHASE.SETUP;
      next.turn = 0;
      next.ready = {};
    }
    return next;
  }

  function isHost(state) {
    return state.selfSlot !== 0 && state.selfSlot === state.hostSlot;
  }

  function bothReady(state) {
    return !!(
      state.selfSlot && state.otherSlot &&
      state.ready[state.selfSlot] && state.ready[state.otherSlot]
    );
  }

  function canGuess(state) {
    return state.phase === PHASE.PLAYING && state.turn === state.selfSlot && state.selfSlot !== 0;
  }

  function isMyTurn(state) {
    return state.turn === state.selfSlot;
  }

  function guessCount(state, slot) {
    var n = 0;
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].slot === slot) n++;
    }
    return n;
  }

  // ------------------------------------------------------------ 状态迁移

  // 对手宣布「暗号已设好」。只接受当前局，且只在 setup 阶段。
  function applySecret(state, msg) {
    if (!msg || msg.t !== 'secret') return reject('bad-message');
    if (state.phase !== PHASE.SETUP) return reject('not-setup');
    var from = slotOf(msg.from);
    var round = Number(msg.round);
    if (!from || (from !== state.selfSlot && from !== state.otherSlot)) {
      return reject('bad-slot');
    }
    if (round !== state.round) return reject('stale-round');
    var next = clone(state);
    next.ready[from] = true;
    return ok(next);
  }

  // 房主开局：phase → playing，定先手。双方都就绪才认。
  function applyStart(state, msg) {
    if (!msg || msg.t !== 'start') return reject('bad-message');
    var round = Number(msg.round);
    if (round !== state.round) return reject('stale-round');
    if (state.phase === PHASE.PLAYING) return reject('already-playing');
    if (!bothReady(state)) return reject('not-ready');
    var turn = slotOf(msg.turn);
    if (!turn || (turn !== state.selfSlot && turn !== state.otherSlot)) {
      return reject('bad-turn');
    }
    var next = clone(state);
    next.phase = PHASE.PLAYING;
    next.turn = turn;
    next.history = [];
    next.winner = 0;
    return ok(next);
  }

  // 裁判（暗号持有者）广播的判定。双方都只认这一条消息，历史因此始终一致。
  function applyJudge(state, msg) {
    if (!msg || msg.t !== 'judge') return reject('bad-message');
    if (state.phase !== PHASE.PLAYING) return reject('not-playing');
    if (Number(msg.round) !== state.round) return reject('stale-round');

    var by = slotOf(msg.by);
    if (!by || (by !== state.selfSlot && by !== state.otherSlot)) return reject('bad-judge');

    var guess = check(msg.guess);
    if (!guess.ok) return reject('bad-guess', guess.msg);

    var h = Number(msg.hits);
    if (!(h >= 0 && h <= MAX_HITS)) return reject('bad-hits');

    var win = h === MAX_HITS;
    if (!!msg.win !== win) return reject('inconsistent-win', 'hits 与 win 不一致');

    var guesser = by === state.selfSlot ? state.otherSlot : state.selfSlot;
    if (!guesser) return reject('bad-judge');
    if (state.turn && state.turn !== guesser) return reject('out-of-turn');

    if (win) {
      if (Number(msg.winner) !== guesser) return reject('bad-winner');
    } else if (msg.next != null && Number(msg.next) !== by) {
      return reject('bad-next');
    }

    var next = clone(state);
    next.history = state.history.concat([{ slot: guesser, guess: guess.value, hits: h, win: win }]);
    if (win) {
      next.phase = PHASE.OVER;
      next.winner = guesser;
      next.turn = 0;
    } else {
      next.turn = by; // 换手：猜完轮到出题的人去猜
    }
    return ok(next);
  }

  // 房主发起下一局：phase → setup，局号 +1，清空上一局。
  function applyRematch(state, msg) {
    if (!msg || msg.t !== 'rematch') return reject('bad-message');
    var round = Number(msg.round);
    if (state.phase !== PHASE.OVER) return reject('not-over');
    if (round !== state.round + 1) return reject('stale-round');
    var next = clone(state);
    next.round = round;
    next.phase = PHASE.SETUP;
    next.turn = 0;
    next.history = [];
    next.winner = 0;
    next.ready = {};
    return ok(next);
  }

  // ------------------------------------------------------------ 重连同步

  // 快照不含暗号：暗号永远只在各自内存里。
  function snapshot(state) {
    return {
      round: state.round,
      phase: state.phase,
      turn: state.turn,
      history: state.history.map(function (h) {
        return { slot: h.slot, guess: h.guess, hits: h.hits, win: h.win };
      }),
      winner: state.winner,
      ready: Object.assign({}, state.ready)
    };
  }

  // 收到对手快照后恢复。字段非法就整条拒绝，绝不半信半疑地合并。
  function restore(state, snap) {
    if (!snap || typeof snap !== 'object') return reject('bad-snapshot');
    var phase = snap.phase;
    if (phase !== PHASE.SETUP && phase !== PHASE.PLAYING && phase !== PHASE.OVER) {
      return reject('bad-phase');
    }
    var round = Number(snap.round);
    if (!(round >= 1)) return reject('bad-round');

    var history = [];
    if (Array.isArray(snap.history)) {
      for (var i = 0; i < snap.history.length; i++) {
        var item = snap.history[i] || {};
        var g = check(item.guess);
        var n = Number(item.hits);
        if (!g.ok || !(n >= 0 && n <= MAX_HITS)) return reject('bad-history');
        history.push({
          slot: slotOf(item.slot),
          guess: g.value,
          hits: n,
          win: n === MAX_HITS
        });
      }
    }

    var ready = {};
    if (snap.ready && typeof snap.ready === 'object') {
      if (snap.ready[state.selfSlot]) ready[state.selfSlot] = true;
      if (snap.ready[state.otherSlot]) ready[state.otherSlot] = true;
    }

    var next = clone(state);
    next.round = round;
    next.phase = phase;
    next.turn = slotOf(snap.turn);
    next.history = history;
    next.winner = phase === PHASE.OVER ? slotOf(snap.winner) : 0;
    next.ready = ready;
    return ok(next);
  }

  return {
    PHASE: PHASE,
    MAX_HITS: MAX_HITS,
    check: check,
    hits: hits,
    newGame: newGame,
    clone: clone,
    bindPlayers: bindPlayers,
    bothReady: bothReady,
    canGuess: canGuess,
    isMyTurn: isMyTurn,
    isHost: isHost,
    guessCount: guessCount,
    applySecret: applySecret,
    applyStart: applyStart,
    applyJudge: applyJudge,
    applyRematch: applyRematch,
    snapshot: snapshot,
    restore: restore,
    slotOf: slotOf
  };
});
