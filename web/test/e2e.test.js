// 端到端测试：需要先启动服务器。
//   RELAY_URL=ws://127.0.0.1:18080/ws node web/test/e2e.test.js
'use strict';

require('./ws-polyfill.js'); // Node 18 没有全局 WebSocket

const assert = require('assert');
const R = require('../relay.js');

const url = process.env.RELAY_URL || 'ws://127.0.0.1:18080/ws';

function once(c, ev, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting ' + ev)), timeoutMs);
    c.on(ev, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function payloadText(bytes) {
  const raw = R.fromUtf8(bytes);
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.text === 'string') return obj.text;
  } catch (e) {}
  return raw;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('condition not met in ' + timeoutMs + 'ms');
}

(async () => {
  const a = new R.RelayClient({ url, token: 'alice' });
  const relaysA = [];
  a.on('relay', (m) => relaysA.push(payloadText(m.payload)));

  await a.connect();
  console.log('ok 连接 A');

  const createdP = once(a, 'created');
  a.create('', { name: 'alice' });
  const created = await createdP;
  assert.match(created.code, /^[A-Z2-9]{4}$/);
  assert.strictEqual(created.slot, 1);
  console.log('ok 建房', created.code);

  const b = new R.RelayClient({ url, token: 'bob' });
  const relaysB = [];
  b.on('relay', (m) => relaysB.push(payloadText(m.payload)));
  await b.connect();
  console.log('ok 连接 B');

  const peerJoinP = once(a, 'peerJoin');
  const joinedP = once(b, 'joined');
  b.join(created.code, '', { name: 'bob' });
  const joined = await joinedP;
  assert.strictEqual(joined.slot, 2);
  assert.strictEqual(joined.members.length, 2);
  const pj = await peerJoinP;
  assert.strictEqual(pj.slot, 2);
  console.log('ok 加入房间，成员快照正确');

  const relayP = once(a, 'relay');
  b.relay({ t: 'chat', text: 'hello' });
  const got = await relayP;
  assert.strictEqual(got.from, 2);
  assert.strictEqual(got.seq, 1);
  console.log('ok 广播转发 seq=1');

  const privP = once(b, 'relay');
  a.relay({ t: 'chat', text: 'secret' }, [2]);
  const priv = await privP;
  assert.strictEqual(priv.from, 1);
  assert.strictEqual(priv.seq, 2);
  console.log('ok 定向转发 seq=2');

  // 模拟断线：客户端主动断开，随后自动带 sid+lastSeq 重连
  const resumedP = once(a, 'resumed', 10000);
  a.ws.close();
  await sleep(300);
  b.relay({ t: 'chat', text: 'while-offline' });
  const resumed = await resumedP;
  assert.strictEqual(resumed.code, created.code);
  assert.strictEqual(resumed.slot, 1);
  console.log('ok 自动重连，missed =', resumed.missed);

  await waitFor(() => relaysA.includes('while-offline'));
  console.log('ok 断线期间的消息被补发');

  const kickedP = once(b, 'kicked');
  a.kick(2);
  await kickedP;
  console.log('ok 房主踢人');

  a.close();
  b.close();
  console.log('e2e all passed');
  process.exit(0);
})().catch((err) => {
  console.error('e2e failed:', err.message);
  process.exit(1);
});
