// ws-polyfill.js — 极简 WebSocket 客户端，只为让测试在 Node 18（没有全局 WebSocket）上跑起来。
//
// 支持：ws://、text/binary 帧、分片、ping/pong、close 握手。不支持 wss、代理、扩展。
// 用法：require('./ws-polyfill.js') 后 globalThis.WebSocket 就有值了。
'use strict';

const http = require('http');
const crypto = require('crypto');

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class MiniWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = CONNECTING;
    this.binaryType = 'arraybuffer';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._listeners = Object.create(null);
    this._buf = Buffer.alloc(0);
    this._fragOpcode = 0;
    this._frag = [];
    this._socket = null;
    this._closed = false;

    let u;
    try {
      u = new URL(this.url);
    } catch (e) {
      throw new Error('bad websocket url: ' + this.url);
    }
    if (u.protocol !== 'ws:') {
      throw new Error('ws-polyfill 只支持 ws://，收到 ' + u.protocol);
    }

    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port) || 80,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    });

    const fail = (err) => {
      if (this._closed) return;
      const e = err instanceof Error ? err : new Error(String(err));
      this._emit('error', { error: e, message: e.message });
      this._finish(1006, e.message);
    };

    req.on('upgrade', (res, socket, head) => {
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        return fail(new Error('bad Sec-WebSocket-Accept'));
      }
      this._socket = socket;
      this.readyState = OPEN;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        this._buf = Buffer.concat([this._buf, chunk]);
        this._parse();
      });
      socket.on('error', fail);
      socket.on('close', () => this._finish(1000, ''));
      if (head && head.length) {
        this._buf = Buffer.concat([this._buf, head]);
        this._parse();
      }
      if (this.readyState === OPEN) this._emit('open', {});
    });

    req.on('response', (res) => {
      res.resume();
      fail(new Error('handshake failed: HTTP ' + res.statusCode));
    });
    req.on('error', fail);
    req.end();
  }

  // ---------------------------------------------------------------- 事件

  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  _emit(type, ev) {
    ev.type = type;
    ev.target = this;
    const handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler(ev); } catch (e) { console.error('ws handler error', e); }
    }
    const list = this._listeners[type];
    if (list) {
      for (const fn of list.slice()) {
        try { fn(ev); } catch (e) { console.error('ws listener error', e); }
      }
    }
  }

  _finish(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = CLOSED;
    if (this._socket) {
      try { this._socket.destroy(); } catch (e) { /* 已关闭 */ }
    }
    this._emit('close', { code: code || 1000, reason: reason || '', wasClean: code !== 1006 });
  }

  // ---------------------------------------------------------------- 发送

  send(data) {
    if (this.readyState !== OPEN || !this._socket) {
      throw new Error('websocket is not open');
    }
    if (typeof data === 'string') {
      this._frame(0x1, Buffer.from(data, 'utf8'));
    } else if (data instanceof ArrayBuffer) {
      this._frame(0x2, Buffer.from(new Uint8Array(data)));
    } else if (ArrayBuffer.isView(data)) {
      this._frame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } else {
      throw new Error('unsupported websocket payload: ' + typeof data);
    }
  }

  close(code, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    const body = Buffer.alloc(2);
    body.writeUInt16BE((code || 1000) & 0xffff, 0);
    const tail = reason ? Buffer.from(String(reason), 'utf8') : Buffer.alloc(0);
    try {
      this._frame(0x8, Buffer.concat([body, tail]));
    } catch (e) { /* 连接已坏，直接关 */ }
    if (this._socket) {
      const socket = this._socket;
      setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 50);
    } else {
      this._finish(code || 1000, reason || '');
    }
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  // ---------------------------------------------------------------- 接收

  _parse() {
    for (;;) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this._buf.length < off + 4) return;
        maskKey = this._buf.subarray(off, off + 4);
        off += 4;
      }
      if (this._buf.length < off + len) return;
      let payload = this._buf.subarray(off, off + len);
      this._buf = this._buf.subarray(off + len);
      if (maskKey) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= maskKey[i & 3];
        payload = copy;
      }
      this._onFrame(fin, opcode, payload);
      if (this.readyState === CLOSED) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0:
        if (!this._fragOpcode) return;
        this._frag.push(payload);
        if (fin) {
          const body = Buffer.concat(this._frag);
          const op = this._fragOpcode;
          this._frag = [];
          this._fragOpcode = 0;
          this._deliver(op, body);
        }
        return;
      case 0x1:
      case 0x2:
        if (!fin) {
          this._fragOpcode = opcode;
          this._frag = [payload];
          return;
        }
        this._deliver(opcode, payload);
        return;
      case 0x8: {
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        try { this._frame(0x8, payload.subarray(0, 2)); } catch (e) { /* 对端可能已走 */ }
        this._finish(code, reason);
        return;
      }
      case 0x9:
        try { this._frame(0xa, payload); } catch (e) { /* 忽略 */ }
        return;
      case 0xa:
        return;
      default:
        return;
    }
  }

  _deliver(opcode, body) {
    if (opcode === 0x1) {
      this._emit('message', { data: body.toString('utf8') });
      return;
    }
    if (this.binaryType === 'arraybuffer') {
      this._emit('message', {
        data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      });
    } else {
      this._emit('message', { data: body });
    }
  }
}

MiniWebSocket.CONNECTING = CONNECTING;
MiniWebSocket.OPEN = OPEN;
MiniWebSocket.CLOSING = CLOSING;
MiniWebSocket.CLOSED = CLOSED;

function install() {
  if (typeof globalThis.WebSocket !== 'function') {
    globalThis.WebSocket = MiniWebSocket;
  }
  return MiniWebSocket;
}

module.exports = install();
module.exports.MiniWebSocket = MiniWebSocket;
