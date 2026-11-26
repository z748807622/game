// ws-url.test.js — 前端 WS 地址解析：优先级、同源推导、归一化、兜底。
// 运行：node web/test/ws-url.test.js
'use strict';

const assert = require('assert');
const R = require('../relay.js');

function withPage(loc, cfg, fn) {
  const hadLoc = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const hadCfg = Object.prototype.hasOwnProperty.call(globalThis, 'RELAY_CONFIG');
  const oldLoc = globalThis.location;
  const oldCfg = globalThis.RELAY_CONFIG;
  try {
    if (loc === undefined) delete globalThis.location;
    else globalThis.location = loc;
    if (cfg === undefined) delete globalThis.RELAY_CONFIG;
    else globalThis.RELAY_CONFIG = cfg;
    fn();
  } finally {
    if (hadLoc) globalThis.location = oldLoc;
    else delete globalThis.location;
    if (hadCfg) globalThis.RELAY_CONFIG = oldCfg;
    else delete globalThis.RELAY_CONFIG;
  }
}

let passed = 0;
function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, label + ': got ' + actual + ', want ' + expected);
  passed++;
}

// 同源推导
withPage({ protocol: 'https:', host: 'game.example.com', search: '' }, undefined, () => {
  eq(R.wsURL(), 'wss://game.example.com/ws', 'https 同源');
  eq(new R.RelayClient({}).url, 'wss://game.example.com/ws', 'RelayClient 默认地址');
});
withPage({ protocol: 'http:', host: 'game.example.com:8080', search: '' }, undefined, () => {
  eq(R.wsURL(), 'ws://game.example.com:8080/ws', 'http 同源');
});

// ?ws= 覆盖 config.js
withPage(
  { protocol: 'https:', host: 'game.example.com', search: '?ws=' + encodeURIComponent('ws://127.0.0.1:18080/ws') },
  { wsUrl: 'wss://api.example.com/ws' },
  () => {
    eq(R.wsURL(), 'ws://127.0.0.1:18080/ws', '?ws= 覆盖 config');
  }
);

// 显式参数 > config > 同源
withPage({ protocol: 'https:', host: 'game.example.com', search: '' }, { wsUrl: 'wss://api.example.com/ws' }, () => {
  eq(R.wsURL(), 'wss://api.example.com/ws', 'config 覆盖同源');
  eq(R.wsURL('ws://explicit:9000/ws'), 'ws://explicit:9000/ws', '显式参数优先');
});

// 归一化
withPage({ protocol: 'https:', host: 'game.example.com', search: '' }, { wsUrl: '/relay/ws' }, () => {
  eq(R.wsURL(), 'wss://game.example.com/relay/ws', '相对路径补全');
});
withPage({ protocol: 'http:', host: 'game.example.com', search: '' }, { wsUrl: 'https://api.example.com/ws' }, () => {
  eq(R.wsURL(), 'wss://api.example.com/ws', 'https 配置归一化');
});
withPage({ protocol: 'https:', host: 'game.example.com', search: '' }, { wsUrl: 'http://api.example.com/ws' }, () => {
  eq(R.wsURL(), 'ws://api.example.com/ws', 'http 配置归一化');
});

// 空 config 走同源
withPage({ protocol: 'https:', host: 'game.example.com', search: '' }, { wsUrl: '' }, () => {
  eq(R.wsURL(), 'wss://game.example.com/ws', '空 config 走同源');
});

// file: 与 Node（无 location）兜底
withPage({ protocol: 'file:', host: '', search: '' }, undefined, () => {
  eq(R.wsURL(), 'ws://127.0.0.1:8080/ws', 'file: 兜底');
});
withPage(undefined, undefined, () => {
  eq(R.wsURL(), 'ws://127.0.0.1:8080/ws', '无 location 兜底');
});

console.log('ws-url ok: ' + passed + ' assertions');
