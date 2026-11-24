// 猜数字内核单测：纯逻辑，不需要服务器。
//   node web/test/bulls-core.test.js
const assert = require('assert');
const B = require('../bulls-core.js');

let passed = 0;
function it(name, fn) {
  fn();
  passed++;
  console.log('ok ' + name);
}

// ---------------------------------------------------------------- 输入校验

it('check 接受 1000–9999', () => {
  assert.strictEqual(B.check('1000').ok, true);
  assert.strictEqual(B.check('9999').ok, true);
  assert.strictEqual(B.check(' 1234 ').value, '1234');
  assert.strictEqual(B.check(1234).value, '1234');
});

it('check 拒绝首位 0 / 长度不对 / 非数字', () => {
  assert.strictEqual(B.check('0123').code, 'leading-zero');
  assert.strictEqual(B.check('123').code, 'format');
  assert.strictEqual(B.check('12345').code, 'format');
  assert.strictEqual(B.check('12a4').code, 'format');
  assert.strictEqual(B.check('').code, 'format');
  assert.strictEqual(B.check(null).code, 'format');
  assert.strictEqual(B.check(undefined).code, 'format');
});

// ---------------------------------------------------------------- 判定

it('hits 只数「数字和位置同时正确」的位数', () => {
  assert.strictEqual(B.hits('1357', '1234'), 1);
  assert.strictEqual(B.hits('1234', '1234'), 4);
  assert.strictEqual(B.hits('1357', '2468'), 0);
  assert.strictEqual(B.hits('1357', '1357'), 4);
});

it('hits 对重复数字按位置比较，不做去重', () => {
  assert.strictEqual(B.hits('1122', '1212'), 2); // 第 1、4 位对上
  assert.strictEqual(B.hits('1111', '1112'), 3);
  assert.strictEqual(B.hits('1000', '0001'), 2);
});

// ---------------------------------------------------------------- 状态机

// 已开局状态。turn 是谁先猜：1 = 自己先猜，2 = 对手先猜。
function started(turn) {
  let s = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  s = B.applySecret(s, { t: 'secret', from: 1, round: 1 }).state;
  s = B.applySecret(s, { t: 'secret', from: 2, round: 1 }).state;
  s = B.applyStart(s, { t: 'start', round: 1, turn: turn || 1 }).state;
  return s;
}

it('新对局从第 1 局 setup 开始', () => {
  const s = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.phase, B.PHASE.SETUP);
  assert.deepStrictEqual(s.ready, {});
  assert.strictEqual(B.isHost(s), true);
});

it('双方都就绪才能开局', () => {
  let s = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  s = B.applySecret(s, { t: 'secret', from: 2, round: 1 }).state;
  assert.strictEqual(B.bothReady(s), false);
  assert.strictEqual(B.applyStart(s, { t: 'start', round: 1, turn: 1 }).reason, 'not-ready');

  s = B.applySecret(s, { t: 'secret', from: 1, round: 1 }).state;
  assert.strictEqual(B.bothReady(s), true);
  const r = B.applyStart(s, { t: 'start', round: 1, turn: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.phase, B.PHASE.PLAYING);
  assert.strictEqual(r.state.turn, 1);
  assert.strictEqual(B.canGuess(r.state), true);
});

it('错过局号的 secret / start 被丢弃', () => {
  let s = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  assert.strictEqual(B.applySecret(s, { t: 'secret', from: 2, round: 2 }).reason, 'stale-round');
  s = B.applySecret(s, { t: 'secret', from: 2, round: 1 }).state;
  s = B.applySecret(s, { t: 'secret', from: 1, round: 1 }).state;
  assert.strictEqual(B.applyStart(s, { t: 'start', round: 2, turn: 1 }).reason, 'stale-round');
});

it('判定结果换手，历史按猜方记录', () => {
  let s = started(2); // 对手先猜，自己是裁判
  s = B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 2, win: false, next: 1 }).state;
  assert.strictEqual(s.history.length, 1);
  assert.deepStrictEqual(s.history[0], { slot: 2, guess: '1234', hits: 2, win: false });
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(B.guessCount(s, 2), 1);
  assert.strictEqual(B.guessCount(s, 1), 0);
});

it('不是当前回合的判定被拒绝', () => {
  const s = started(); // 轮到 1 猜，2 还没轮到
  const r = B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 2, win: false, next: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'out-of-turn');
});

it('hits=4 判胜并锁死后续判定', () => {
  let s = started(2);
  s = B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 2, win: false, next: 1 }).state;
  s = B.applyJudge(s, { t: 'judge', round: 1, by: 2, guess: '4321', hits: 4, win: true, winner: 1 }).state;
  assert.strictEqual(s.phase, B.PHASE.OVER);
  assert.strictEqual(s.winner, 1);
  assert.strictEqual(s.turn, 0);
  assert.strictEqual(s.history[1].win, true);
  assert.strictEqual(B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1111', hits: 0, win: false }).reason, 'not-playing');
});

it('hits 与 win 不一致的判定被拒绝', () => {
  const s = started(2);
  assert.strictEqual(
    B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 2, win: true, winner: 2 }).reason,
    'inconsistent-win'
  );
  assert.strictEqual(
    B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 5, win: false }).reason,
    'bad-hits'
  );
  assert.strictEqual(
    B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '0123', hits: 0, win: false }).reason,
    'bad-guess'
  );
});

it('再来一局清空上一局并进入下一局 setup', () => {
  let s = started(2);
  s = B.applyJudge(s, { t: 'judge', round: 1, by: 1, guess: '1234', hits: 4, win: true, winner: 2 }).state;
  const r = B.applyRematch(s, { t: 'rematch', round: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.round, 2);
  assert.strictEqual(r.state.phase, B.PHASE.SETUP);
  assert.deepStrictEqual(r.state.history, []);
  assert.deepStrictEqual(r.state.ready, {});
  assert.strictEqual(r.state.winner, 0);
  assert.strictEqual(B.applyRematch(r.state, { t: 'rematch', round: 2 }).reason, 'not-over');
});

it('状态迁移不修改入参', () => {
  const base = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  const before = JSON.stringify(base);
  B.applySecret(base, { t: 'secret', from: 2, round: 1 });
  assert.strictEqual(JSON.stringify(base), before);
});

it('对手离开后回到等待状态', () => {
  let s = started();
  s = B.bindPlayers(s, { selfSlot: 1, otherSlot: 0, hostSlot: 1 });
  assert.strictEqual(s.phase, B.PHASE.SETUP);
  assert.deepStrictEqual(s.ready, {});
  assert.strictEqual(B.bothReady(s), false);
});

// ---------------------------------------------------------------- 快照

it('snapshot / restore 往返一致且不含暗号', () => {
  const s = started();
  const snap = B.snapshot(s);
  assert.strictEqual(snap.secret, undefined);
  assert.strictEqual(JSON.stringify(snap).includes('secret'), false);

  const r = B.restore(B.newGame({ selfSlot: 2, otherSlot: 1, hostSlot: 1 }), snap);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.round, s.round);
  assert.strictEqual(r.state.phase, s.phase);
  assert.strictEqual(r.state.turn, s.turn);
  assert.deepStrictEqual(r.state.ready, s.ready);
});

it('restore 拒绝非法快照', () => {
  const s = B.newGame({ selfSlot: 1, otherSlot: 2, hostSlot: 1 });
  assert.strictEqual(B.restore(s, null).reason, 'bad-snapshot');
  assert.strictEqual(B.restore(s, { phase: 'nope', round: 1 }).reason, 'bad-phase');
  assert.strictEqual(B.restore(s, { phase: 'setup', round: 0 }).reason, 'bad-round');
  assert.strictEqual(
    B.restore(s, { phase: 'playing', round: 1, history: [{ guess: '0123', hits: 1 }] }).reason,
    'bad-history'
  );
});

console.log('\nbulls-core: ' + passed + ' passed');
