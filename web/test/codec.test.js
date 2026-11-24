// 黄金向量测试：与 Go 侧 internal/protocol 使用同一份 vectors.json。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = require('../relay.js');

const vectorsPath = path.join(__dirname, '..', '..', 'internal', 'protocol', 'testdata', 'vectors.json');
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

const sid16 = Uint8Array.from({ length: 16 }, (_, i) => i);

const encoders = {
  ping_c2s: () => R.encodePing(0x0011223344556677),
  pong_c2s: () => R.encodePong(0x0011223344556688),
  hello: () => R.encodeHello('ab', null, 0),
  hello_resume: () => R.encodeHello('t', sid16, 0x1234),
  relay_c2s: () => R.encodeRelay([2, 5], R.utf8('x')),
  create: () => R.encodeCreate(R.utf8('m1'), 'pw'),
  join: () => R.encodeJoin('K7QF', '', R.utf8('bob')),
  leave: () => R.encodeLeave(),
  lock: () => R.encodeLock(true),
  kick: () => R.encodeKick(3)
};

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

let checked = 0;
for (const v of vectors) {
  if (encoders[v.name]) {
    const got = hex(encoders[v.name]());
    assert.strictEqual(got, v.hex, `encode ${v.name}`);
    checked++;
  }
}

// 解码：用 golden 字节反解，验证字段
function frameOf(hexStr) {
  return R.parseFrame(Uint8Array.from(Buffer.from(hexStr, 'hex')));
}

{
  const f = frameOf(vectors.find((v) => v.name === 'ready').hex);
  const m = decodeWith(f.body, R.decodeReady);
  assert.strictEqual(m.proto, 1);
  assert.strictEqual(m.resumed, false);
  assert.deepStrictEqual(Array.from(m.sid), Array.from(sid16));
}
{
  const f = frameOf(vectors.find((v) => v.name === 'joined').hex);
  const m = decodeWith(f.body, R.decodeRoomState);
  assert.strictEqual(m.code, 'K7QF');
  assert.strictEqual(m.slot, 2);
  assert.strictEqual(m.host, 1);
  assert.strictEqual(m.seq, 16);
  assert.strictEqual(m.members.length, 2);
  assert.strictEqual(R.fromUtf8(m.members[0].meta), 'm1');
  assert.strictEqual(m.members[0].online, true);
}
{
  const f = frameOf(vectors.find((v) => v.name === 'relay_s2c').hex);
  const m = decodeWith(f.body, R.decodeRelay);
  assert.strictEqual(m.from, 2);
  assert.strictEqual(m.seq, 1);
  assert.strictEqual(R.fromUtf8(m.payload), 'hi');
}
{
  const f = frameOf(vectors.find((v) => v.name === 'error').hex);
  const m = decodeWith(f.body, R.decodeError);
  assert.strictEqual(m.code, R.ERR.ROOM_NOT_FOUND);
  assert.strictEqual(m.msg, 'nf');
}
{
  const f = frameOf(vectors.find((v) => v.name === 'hello_resume').hex);
  assert.strictEqual(f.op, R.OP.HELLO);
}

// 内部小工具：relay.js 没导出 Reader，用 DataView 手工按字段读不现实，
// 这里复用 decode 函数签名（Reader 实例由 parseFrame 的 body 构造）。
function decodeWith(body, fn) {
  const { Reader } = R;
  assert.ok(Reader, 'relay.js 需要导出 Reader 供测试使用');
  return fn(new Reader(body));
}

console.log(`codec ok: ${checked} 个编码向量 + 5 个解码断言`);
