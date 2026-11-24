// relay.js — 中继协议 v2 的浏览器/Node 客户端。
// 与 internal/protocol 的 Go 实现逐字节对应，黄金向量见 internal/protocol/testdata/vectors.json。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Relay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OP = {
    HELLO: 0x01,
    CREATE: 0x02,
    JOIN: 0x03,
    LEAVE: 0x04,
    RELAY: 0x05,
    LOCK: 0x06,
    KICK: 0x07,
    PING: 0x08,
    PONG: 0x09,
    READY: 0x81,
    CREATED: 0x82,
    JOINED: 0x83,
    RECONNECTED: 0x84,
    PEER_JOIN: 0x85,
    PEER_LEAVE: 0x86,
    PEER_REJOIN: 0x87,
    HOST: 0x88,
    RELAY_S2C: 0x89,
    RESYNC: 0x8A,
    KICKED: 0x8B,
    PEER_OFFLINE: 0x8F,
    ERROR: 0x8C,
    PONG_S2C: 0x8D,
    PING_S2C: 0x8E
  };

  var OP_NAME = {};
  for (var k in OP) OP_NAME[OP[k]] = k;

  var ERR = {
    UNAUTHORIZED: 0x01,
    BAD_FRAME: 0x02,
    ALREADY_JOINED: 0x03,
    NOT_JOINED: 0x04,
    ROOM_NOT_FOUND: 0x05,
    ROOM_FULL: 0x06,
    ROOM_LOCKED: 0x07,
    BAD_PASSWORD: 0x08,
    BAD_TARGET: 0x09,
    NOT_HOST: 0x0a,
    RATE_LIMITED: 0x0b,
    SERVER_FULL: 0x0c,
    FRAME_TOO_LARGE: 0x0d,
    BAD_VERSION: 0x0e,
    INTERNAL: 0x0f
  };

  var ERR_NAME = {};
  for (var e in ERR) ERR_NAME[ERR[e]] = e;

  var VERSION = 1;
  var HEADER = 8;

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function utf8(str) {
    return enc.encode(str == null ? '' : String(str));
  }

  function fromUtf8(bytes) {
    return dec.decode(bytes);
  }

  // ------------------------------------------------------------ 写

  function Buf() {
    this.b = new Uint8Array(128);
    this.n = HEADER;
  }

  Buf.prototype.ensure = function (k) {
    if (this.n + k <= this.b.length) return;
    var cap = this.b.length * 2;
    while (cap < this.n + k) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  };

  Buf.prototype.u8 = function (v) {
    this.ensure(1);
    this.b[this.n++] = v & 0xff;
    return this;
  };

  Buf.prototype.u16 = function (v) {
    this.ensure(2);
    this.b[this.n++] = v & 0xff;
    this.b[this.n++] = (v >> 8) & 0xff;
    return this;
  };

  Buf.prototype.u32 = function (v) {
    this.ensure(4);
    this.b[this.n++] = v & 0xff;
    this.b[this.n++] = (v >>> 8) & 0xff;
    this.b[this.n++] = (v >>> 16) & 0xff;
    this.b[this.n++] = (v >>> 24) & 0xff;
    return this;
  };

  // v 是 < 2^53 的 Number（时间戳足够）
  Buf.prototype.u64 = function (v) {
    this.ensure(8);
    for (var i = 0; i < 8; i++) {
      this.b[this.n++] = v % 256;
      v = Math.floor(v / 256);
    }
    return this;
  };

  Buf.prototype.bytes = function (arr) {
    if (!arr || !arr.length) return this;
    this.ensure(arr.length);
    this.b.set(arr, this.n);
    this.n += arr.length;
    return this;
  };

  Buf.prototype.len8 = function (arr) {
    var n = arr ? arr.length : 0;
    this.u8(n);
    return this.bytes(arr);
  };

  Buf.prototype.len16 = function (arr) {
    var n = arr ? arr.length : 0;
    this.u16(n);
    return this.bytes(arr);
  };

  Buf.prototype.frame = function (op) {
    var out = this.b.subarray(0, this.n);
    out[0] = (this.n - 4) & 0xff;
    out[1] = ((this.n - 4) >>> 8) & 0xff;
    out[2] = ((this.n - 4) >>> 16) & 0xff;
    out[3] = ((this.n - 4) >>> 24) & 0xff;
    out[4] = VERSION;
    out[5] = op;
    out[6] = 0;
    out[7] = 0;
    return out;
  };

  // ------------------------------------------------------------ 读

  function Reader(buf) {
    this.b = buf;
    this.d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.i = 0;
  }

  Reader.prototype.u8 = function () {
    var v = this.d.getUint8(this.i);
    this.i += 1;
    return v;
  };

  Reader.prototype.u16 = function () {
    var v = this.d.getUint16(this.i, true);
    this.i += 2;
    return v;
  };

  Reader.prototype.u32 = function () {
    var v = this.d.getUint32(this.i, true);
    this.i += 4;
    return v;
  };

  Reader.prototype.u64 = function () {
    var lo = this.d.getUint32(this.i, true);
    var hi = this.d.getUint32(this.i + 4, true);
    this.i += 8;
    return hi * 4294967296 + lo;
  };

  Reader.prototype.bytes = function (n) {
    var v = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return v;
  };

  Reader.prototype.bytes8 = function () {
    return this.bytes(this.u8());
  };

  Reader.prototype.bytes16 = function () {
    return this.bytes(this.u16());
  };

  Reader.prototype.rest = function () {
    var v = this.b.subarray(this.i);
    this.i = this.b.length;
    return v;
  };

  // ------------------------------------------------------------ 编码

  function encodeHello(token, sid, lastSeq) {
    var resume = !!(sid && sid.length === 16);
    var w = new Buf().u8(VERSION).u8(resume ? 1 : 0).len16(utf8(token));
    if (resume) w.len8(sid).u32(lastSeq || 0);
    return w.frame(OP.HELLO);
  }

  function encodeCreate(metaBytes, pwd) {
    return new Buf().len16(metaBytes || new Uint8Array(0)).len8(utf8(pwd)).frame(OP.CREATE);
  }

  function encodeJoin(code, pwd, metaBytes) {
    return new Buf()
      .len8(utf8(String(code).toUpperCase()))
      .len8(utf8(pwd))
      .len16(metaBytes || new Uint8Array(0))
      .frame(OP.JOIN);
  }

  function encodeLeave() {
    return new Buf().frame(OP.LEAVE);
  }

  function encodeRelay(targets, payloadBytes) {
    var list = targets || [];
    var w = new Buf().u8(list.length);
    for (var i = 0; i < list.length; i++) w.u16(list[i]);
    return w.bytes(payloadBytes).frame(OP.RELAY);
  }

  function encodeLock(v) {
    return new Buf().u8(v ? 1 : 0).frame(OP.LOCK);
  }

  function encodeKick(slot) {
    return new Buf().u16(slot).frame(OP.KICK);
  }

  function encodePing(ts) {
    return new Buf().u64(ts).frame(OP.PING);
  }

  function encodePong(ts) {
    return new Buf().u64(ts).frame(OP.PONG);
  }

  function parseFrame(arrayBuffer) {
    var b = new Uint8Array(arrayBuffer);
    if (b.length < HEADER) throw new Error('short frame');
    var d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var len = d.getUint32(0, true);
    if (len + 4 !== b.length) throw new Error('bad length');
    if (b[4] !== VERSION) throw new Error('bad version ' + b[4]);
    if (b[6] !== 0 || b[7] !== 0) throw new Error('bad flags');
    return { op: b[5], body: b.subarray(HEADER) };
  }

  // ------------------------------------------------------------ 解码

  function decodeReady(r) {
    return { proto: r.u8(), resumed: (r.u8() & 1) !== 0, sid: r.bytes8() };
  }

  function decodeRoomState(r, withMissed) {
    var code = fromUtf8(r.bytes8());
    var slot = r.u16();
    var host = r.u16();
    var seq = r.u32();
    var n = r.u16();
    var members = [];
    for (var i = 0; i < n; i++) {
      var m = { slot: r.u16(), online: (r.u8() & 1) !== 0, meta: r.bytes16() };
      members.push(m);
    }
    var out = { code: code, slot: slot, host: host, seq: seq, members: members };
    if (withMissed) out.missed = r.u16();
    return out;
  }

  function decodeRelay(r) {
    return { from: r.u16(), seq: r.u32(), payload: r.rest() };
  }

  function decodePeerJoin(r) {
    return { slot: r.u16(), meta: r.bytes16() };
  }

  function decodeError(r) {
    var code = r.u16();
    return { code: code, name: ERR_NAME[code] || 'UNKNOWN', msg: fromUtf8(r.bytes16()) };
  }

  // ------------------------------------------------------------ 客户端

  function RelayClient(opts) {
    opts = opts || {};
    this.url = opts.url;
    this.token = opts.token || 'dev';
    this.autoReconnect = opts.autoReconnect !== false;
    this.handlers = {};
    this.ws = null;
    this.sid = null;
    this.slot = 0;
    this.code = null;
    this.host = 0;
    this.seq = 0;
    this.joined = false;
    this.members = [];
    this.lastSeq = 0;
    this.replayRemaining = 0;
    this.retry = 0;
    this.closedByUser = false;
    this.settle = null;
    this.lastPingAt = 0;
  }

  RelayClient.prototype.on = function (ev, fn) {
    (this.handlers[ev] || (this.handlers[ev] = [])).push(fn);
    return this;
  };

  RelayClient.prototype.emit = function (ev, data) {
    var list = this.handlers[ev];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](data);
      } catch (err) {
        console.error('handler error', ev, err);
      }
    }
  };

  RelayClient.prototype.connect = function () {
    var self = this;
    this.closedByUser = false;
    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = new WebSocket(self.url);
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      self.ws = ws;
      var timer = setTimeout(function () {
        if (self.settle) {
          self.settle = null;
          reject(new Error('connect timeout'));
          try {
            ws.close();
          } catch (e) {}
        }
      }, 8000);
      self.settle = { resolve: resolve, reject: reject, timer: timer };

      ws.onopen = function () {
        var resumeSid = self.joined ? self.sid : null;
        self.send(encodeHello(self.token, resumeSid, self.lastSeq));
      };
      ws.onmessage = function (ev) {
        try {
          self.onFrame(ev.data);
        } catch (err) {
          self.emit('error', { error: err });
        }
      };
      ws.onclose = function (ev) {
        self.onClose(ev);
      };
      ws.onerror = function () {
        // 详细原因由 onclose 处理
      };
    });
  };

  RelayClient.prototype.onClose = function (ev) {
    var self = this;
    this.emit('close', { code: ev.code, reason: ev.reason });
    if (this.settle) {
      clearTimeout(this.settle.timer);
      this.settle.reject(new Error('connection closed: ' + ev.code));
      this.settle = null;
    }
    var fatal = ev.code === 4001 || ev.code === 4002 || ev.code === 4004 || ev.code === 4005;
    if (fatal) {
      this.joined = false;
    }
    if (this.closedByUser || !this.autoReconnect || !this.joined || fatal) {
      this.emit('stopped', { code: ev.code });
      return;
    }
    var delay = Math.min(8000, 500 * Math.pow(2, this.retry)) * (0.7 + Math.random() * 0.6);
    this.retry++;
    this.emit('reconnecting', { attempt: this.retry, delay: Math.round(delay), code: ev.code });
    setTimeout(function () {
      if (self.closedByUser) return;
      self.connect().catch(function () {});
    }, delay);
  };

  RelayClient.prototype.send = function (frame) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(frame);
    this.emit('tx', { op: frame[5], name: OP_NAME[frame[5]] || 'UNKNOWN', size: frame.byteLength });
    return true;
  };

  RelayClient.prototype.applyState = function (m, kind) {
    this.code = m.code;
    this.slot = m.slot;
    this.host = m.host;
    this.seq = m.seq;
    this.members = m.members;
    this.joined = true;
    this.lastSeq = m.seq;
    this.retry = 0;
    this.emit(kind, m);
  };

  RelayClient.prototype.onFrame = function (data) {
    var f = parseFrame(data);
    var r = new Reader(f.body);
    var self = this;
    this.emit('frame', { op: f.op, name: OP_NAME[f.op] || 'UNKNOWN', size: data.byteLength });

    switch (f.op) {
      case OP.READY: {
        var ready = decodeReady(r);
        this.sid = ready.sid;
        this.emit('ready', ready);
        if (this.settle) {
          clearTimeout(this.settle.timer);
          this.settle.resolve(ready);
          this.settle = null;
        }
        break;
      }
      case OP.CREATED:
      case OP.JOINED:
        this.applyState(decodeRoomState(r), f.op === OP.CREATED ? 'created' : 'joined');
        break;
      case OP.RECONNECTED: {
        var re = decodeRoomState(r, true);
        this.replayRemaining = re.missed;
        this.emit('reconnected', re);
        this.applyState(re, 'resumed');
        if (this.settle) {
          clearTimeout(this.settle.timer);
          this.settle.resolve(re);
          this.settle = null;
        }
        break;
      }
      case OP.PEER_JOIN: {
        var pj = decodePeerJoin(r);
        this.upsertMember(pj.slot, pj.online !== false, pj.meta);
        this.emit('peerJoin', pj);
        break;
      }
      case OP.PEER_LEAVE: {
        var slot = r.u16();
        var reason = r.u8();
        this.members = this.members.filter(function (m) {
          return m.slot !== slot;
        });
        this.emit('peerLeave', { slot: slot, reason: reason });
        break;
      }
      case OP.PEER_OFFLINE: {
        var oslot = r.u16();
        this.members.forEach(function (m) {
          if (m.slot === oslot) m.online = false;
        });
        this.emit('peerOffline', { slot: oslot });
        break;
      }
      case OP.PEER_REJOIN: {
        var rslot = r.u16();
        this.members.forEach(function (m) {
          if (m.slot === rslot) m.online = true;
        });
        this.emit('peerRejoin', { slot: rslot });
        break;
      }
      case OP.HOST: {
        this.host = r.u16();
        this.emit('host', { slot: this.host });
        break;
      }
      case OP.RELAY_S2C: {
        var msg = decodeRelay(r);
        if (this.replayRemaining > 0) {
          this.replayRemaining--;
        } else if (this.lastSeq !== 0 && msg.seq !== this.lastSeq + 1) {
          this.emit('gap', { expected: this.lastSeq + 1, got: msg.seq });
          this.forceReconnect();
          return;
        }
        if (msg.seq > this.lastSeq) this.lastSeq = msg.seq;
        this.emit('relay', msg);
        break;
      }
      case OP.RESYNC: {
        this.emit('resync', { seq: r.u32(), reason: r.u8() });
        break;
      }
      case OP.KICKED:
        this.emit('kicked', {});
        break;
      case OP.ERROR: {
        var err = decodeError(r);
        this.emit('serverError', err);
        break;
      }
      case OP.PING_S2C: {
        var ts = r.u64();
        this.lastPingAt = Date.now();
        this.send(encodePong(ts));
        break;
      }
      case OP.PONG_S2C:
        r.u64();
        break;
      default:
        this.emit('unknownOp', { op: f.op });
    }
  };

  RelayClient.prototype.upsertMember = function (slot, online, meta) {
    for (var i = 0; i < this.members.length; i++) {
      if (this.members[i].slot === slot) {
        this.members[i].online = online;
        if (meta) this.members[i].meta = meta;
        return;
      }
    }
    this.members.push({ slot: slot, online: online, meta: meta });
    this.members.sort(function (a, b) {
      return a.slot - b.slot;
    });
  };

  RelayClient.prototype.forceReconnect = function () {
    this.emit('reconnecting', { attempt: this.retry, delay: 0, code: 0 });
    if (this.ws) this.ws.close(4000, 'gap');
  };

  RelayClient.prototype.create = function (pwd, metaObj) {
    return this.send(encodeCreate(utf8(JSON.stringify(metaObj || {})), pwd));
  };

  RelayClient.prototype.join = function (code, pwd, metaObj) {
    return this.send(encodeJoin(code, pwd, utf8(JSON.stringify(metaObj || {}))));
  };

  RelayClient.prototype.relay = function (payloadObj, targets) {
    var bytes = payloadObj instanceof Uint8Array ? payloadObj : utf8(JSON.stringify(payloadObj));
    return this.send(encodeRelay(targets, bytes));
  };

  RelayClient.prototype.relayBytes = function (bytes, targets) {
    return this.send(encodeRelay(targets, bytes));
  };

  RelayClient.prototype.leave = function () {
    this.send(encodeLeave());
    this.joined = false;
    this.members = [];
    this.slot = 0;
    this.code = null;
  };

  RelayClient.prototype.lock = function (v) {
    return this.send(encodeLock(v));
  };

  RelayClient.prototype.kick = function (slot) {
    return this.send(encodeKick(slot));
  };

  RelayClient.prototype.close = function () {
    this.closedByUser = true;
    if (this.ws) this.ws.close(1000, 'bye');
  };

  return {
    OP: OP,
    OP_NAME: OP_NAME,
    ERR: ERR,
    ERR_NAME: ERR_NAME,
    RelayClient: RelayClient,
    Reader: Reader,
    Buf: Buf,
    encodeHello: encodeHello,
    encodeCreate: encodeCreate,
    encodeJoin: encodeJoin,
    encodeLeave: encodeLeave,
    encodeRelay: encodeRelay,
    encodeLock: encodeLock,
    encodeKick: encodeKick,
    encodePing: encodePing,
    encodePong: encodePong,
    parseFrame: parseFrame,
    decodeReady: decodeReady,
    decodeRoomState: decodeRoomState,
    decodeRelay: decodeRelay,
    decodePeerJoin: decodePeerJoin,
    decodeError: decodeError,
    utf8: utf8,
    fromUtf8: fromUtf8
  };
});
