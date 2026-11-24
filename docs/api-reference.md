# 客户端接口参考（协议 v2）

面向实现客户端的人。字节级布局见 [协议 v2](protocol-v2.md)，本文只讲「发什么、收什么、什么时候发」。

- 接入地址：`wss://<host>/ws`（本地 `ws://localhost:8080/ws`）
- 传输：WebSocket **binary frame**，一帧一条消息，单帧 ≤ 64KB
- 所有多字节整数：**小端序**
- `payload`：业务数据，服务器不解析，格式自定（推荐 protobuf，demo 用 JSON）

## 1. 会话建立

新会话：

```
C→S  HELLO{proto=1, flags=0, token}
S→C  READY{sid}                     ← 16 字节会话 id，客户端保存
```

断线恢复：

```
C→S  HELLO{proto=1, flags=RESUME, token, sid, lastSeq}
S→C  RECONNECTED{code, slot, host, seq, members, missed}
     [补发 RELAY × missed]
```

- **READY 只在新会话出现**；重连成功时首帧直接是 `RECONNECTED`。客户端据此判断是「新建会话」还是「回到原房间」。
- `token` 放首帧而不是 URL：浏览器和小程序都无法在 WS 握手时加自定义 header，放 query 会进访问日志。
- 生产环境 token 应为后端签发的 HMAC/JWT；当前服务端是开发桩（任意非空字符串通过）。
- 恢复失败（房间已销毁 / 超宽限期 / 被踢）→ `ERROR{ROOM_NOT_FOUND}` 后连接被关闭（4004），客户端应回大厅。

## 2. 消息参考

### 客户端 → 服务端

| op | 名称 | 字段 | 说明 |
|----|------|------|------|
| 0x01 | HELLO | `proto u8, flags u8, token len16, [sid len8, lastSeq u32]` | 必须首帧；`flags bit0=RESUME` |
| 0x02 | CREATE | `meta len16, pwd len8` | 建房，创建者为房主（slot=1） |
| 0x03 | JOIN | `code len8, pwd len8, meta len16` | 只加入**已存在**房间 |
| 0x04 | LEAVE | 空 | 离开房间，连接保留，可再 join |
| 0x05 | RELAY | `targetCount u8, targets u16[], payload...` | `targetCount=0` 表示除自己外所有人 |
| 0x06 | LOCK | `v u8` | 仅房主；锁定后拒绝新加入 |
| 0x07 | KICK | `slot u16` | 仅房主 |
| 0x08 | PING | `ts u64` | 客户端主动探活，服务端回 PONG |

`meta` 是不透明字节（建议 UTF-8 JSON：`{"name":"阿伟"}`），服务端原样存、原样广播给同房玩家。

### 服务端 → 客户端

| op | 名称 | 字段 | 说明 |
|----|------|------|------|
| 0x81 | READY | `proto u8, flags u8, sid len8` | 新会话建立 |
| 0x82 | CREATED | `code, slot, host, seq, members[]` | 建房成功 |
| 0x83 | JOINED | 同上 | 加入成功 |
| 0x84 | RECONNECTED | 同上 + `missed u16` | 重连成功，随后补发 `missed` 帧 |
| 0x85 | PEER_JOIN | `slot u16, meta len16` | 有新人加入 |
| 0x86 | PEER_LEAVE | `slot u16, reason u8` | `0=主动离开 1=超时 2=被踢` |
| 0x87 | PEER_REJOIN | `slot u16` | 断线的人回来了 |
| 0x8F | PEER_OFFLINE | `slot u16` | 断线但仍在宽限期（**不是离开**） |
| 0x88 | HOST | `slot u16` | 房主变更 |
| 0x89 | RELAY | `from u16, seq u32, payload...` | 转发消息 |
| 0x8A | RESYNC | `seq u32, reason u8` | 补发窗口不足，需要游戏层全量同步 |
| 0x8B | KICKED | 空 | 被踢，随后连接关闭（4002） |
| 0x8C | ERROR | `code u16, msg len16` | 业务错误，连接通常保留 |
| 0x8D | PONG | `ts u64` | 回 PING |
| 0x8E | PING | `ts u64` | 服务端心跳，收到必须回 PONG |

`members[]` 每项：`slot u16, flags u8(bit0=online), meta len16`。

房间状态帧的字段顺序统一为：`code len8, slot u16, host u16, seq u32, memberCount u16, members...`。

## 3. 房间语义

- **创建**：`CREATE` → 服务端生成 4 位房间码（字母表 `A-Z` 去掉 `I/O` 加 `2-9`），`CREATED` 里带回。
- **加入**：`JOIN{code}`。码不存在 → `ROOM_NOT_FOUND`，**不会顺手建房**（防止错码建出幽灵房）。
- **密码**：建房时设置，加入时校验；服务端只在内存比较，不落盘。
- **锁定**：房主 `LOCK{1}` 后新加入返回 `ROOM_LOCKED`；`LOCK{0}` 解锁。
- **踢人**：房主 `KICK{slot}`，被踢者先收到 `KICKED` 再断开（4002），且**不能用原 sid 恢复**。
- **房主转移**：房主主动离开 → 立即转给最小 slot 的在线成员；房主断线 → 宽限期内保留身份，超时才转。
- **断线**：连接断开后成员变 `offline`，向其他人广播 `PEER_OFFLINE`，**不广播 PEER_LEAVE**；宽限期（默认 60s）内回来 → `PEER_REJOIN`，超时 → `PEER_LEAVE{reason=1}`。
- **空房**：所有人离线且宽限期到期 → 房间销毁，房间码回收。

## 4. 转发语义

```
RELAY{targets=[2,5], payload}   → 只有 2、5 号位收到 RELAY{from=你, seq, payload}
RELAY{targets=[],   payload}    → 除自己外所有人
RELAY{targets=[1],  payload}    → 自己也能收到回显（房主做权威逻辑时有用）
```

- `from` 由服务端填写，客户端提交的任何发送者字段都会被忽略。
- `targets` 里出现非本房间成员 → 整条拒绝 `BAD_TARGET`，不会部分投递。
- 重复 target 会被去重。
- 单个 payload 建议 ≤ 60KB；不要靠中继层分片。
- **不要**在 payload 里再套一层中继消息（隧道会让 seq 语义失效）。

## 5. 序号与重连契约

房间内每条 `RELAY` 带单调 `seq`（从 1 开始，房间级，不是连接级）。

客户端必须做四件事：

1. **记录 `lastSeq`**：`JOINED`/`RECONNECTED` 给出基线 `seq`，之后每收到一条 `RELAY` 更新。
2. **检测空洞**：`seq != lastSeq+1` 且不在补发阶段 → 说明状态不可信，主动断开重连（带 `lastSeq`），让服务端补发。
3. **重连**：指数退避 0.5s→8s，带 `sid` + `lastSeq`；`ROOM_NOT_FOUND` 不重试。
4. **处理 RESYNC**：补发窗口（默认 64KB）不足时服务端回 `RESYNC` 而不是补发，此时游戏层必须向房主请求一次全量快照。

`RECONNECTED.missed` 是紧接着要补发的帧数；补发帧的 `seq` 会小于 `RECONNECTED.seq`，**不属于空洞**，客户端不要触发重连。

## 6. JS 客户端（`web/relay.js`）

浏览器直接 `<script src="relay.js">` 后使用 `window.Relay`；Node 里 `require('./web/relay.js')`。

```js
const c = new Relay.RelayClient({
  url: 'ws://localhost:8080/ws',
  token: 'dev-token',
  autoReconnect: true        // 默认 true
});

c.on('created', (room) => console.log('房间码', room.code));  // room: {code, slot, host, seq, members}
c.on('relay',   (msg)  => console.log(msg.from, msg.seq, msg.payload));
c.on('serverError', (e) => console.error(e.name, e.msg));

await c.connect();                 // 新会话：等 READY；重连：等 RECONNECTED
c.create('', { name: '阿伟' });    // 建房（密码, meta）
c.join('K7QF', '', { name: '阿伟' });
c.relay({ t: 'chat', text: 'hi' });        // 广播
c.relay({ t: 'deal', cards: [3, 7] }, [2]); // 定向
c.lock(true);
c.kick(3);
c.leave();
c.close();
```

方法：`connect / create / join / relay / relayBytes / leave / lock / kick / close`，属性：`sid / code / slot / host / seq / joined / members / lastSeq`。

事件：

| 事件 | 参数 | 时机 |
|------|------|------|
| `ready` | `{sid}` | 新会话建立 |
| `created` / `joined` | 房间状态 | 建房/加入成功 |
| `reconnected` / `resumed` | 房间状态（含 `missed`） | 重连成功 |
| `relay` | `{from, seq, payload}` | 收到转发 |
| `peerJoin` / `peerLeave` / `peerOffline` / `peerRejoin` | 对应字段 | 成员变化 |
| `host` | `{slot}` | 房主变更 |
| `resync` | `{seq, reason}` | 需要全量同步 |
| `gap` | `{expected, got}` | 序号空洞 |
| `reconnecting` | `{attempt, delay}` | 开始重连 |
| `serverError` | `{code, name, msg}` | 业务错误 |
| `kicked` / `stopped` | — | 被踢 / 彻底停止 |
| `tx` / `frame` | `{op, name, size}` | 出/入帧（调试用） |

## 7. 错误码

| 码 | 名称 | 含义 | 客户端处理 |
|----|------|------|-----------|
| 0x01 | UNAUTHORIZED | token 无效 | 刷新 token 重连 |
| 0x02 | BAD_FRAME | 帧格式错误 | 客户端 bug |
| 0x03 | ALREADY_JOINED | 已在房间 | 提示 |
| 0x04 | NOT_JOINED | 未加入就 relay/lock | 提示 |
| 0x05 | ROOM_NOT_FOUND | 房间不存在/已销毁 | 回大厅 |
| 0x06 | ROOM_FULL | 满 16 人 | 提示 |
| 0x07 | ROOM_LOCKED | 已锁定 | 提示 |
| 0x08 | BAD_PASSWORD | 密码错 | 提示 |
| 0x09 | BAD_TARGET | 目标不是本房成员 | 修 bug |
| 0x0A | NOT_HOST | 非房主执行 lock/kick | 提示 |
| 0x0B | RATE_LIMITED | 超频 | 退避 |
| 0x0C | SERVER_FULL | 房间数达上限 | 提示 |
| 0x0D | FRAME_TOO_LARGE | 单帧 > 64KB | 拆包 |
| 0x0E | BAD_VERSION | 协议版本不符 | 升级客户端 |
| 0x0F | INTERNAL | 服务端内部错误 | 重试 |

关闭码：`1000` 正常、`1009` 帧过大、`1013` 慢消费者、`4001` 鉴权失败、`4002` 被踢、`4004` 会话失效、`4005` 服务端退出、`4006` 限流。

## 8. 限制与默认值

| 项 | 默认 |
|----|------|
| 单房人数 | 16 |
| 单帧 | 64KB |
| meta | ≤ 512B |
| 密码 | ≤ 32B |
| token | ≤ 1024B |
| 心跳 | 服务端 20s 一次，60s 无入站断开 |
| 宽限期 | 60s |
| 重放缓冲 | 64KB/房 |
| 发送队列 | 256KB/连接，超了断开（1013） |
| 入站限流 | 200 帧/秒/连接 |
| 建房限流 | 10 次/分钟/IP |

这些都能在启动参数里调，见 [README](../README.md#配置)。

## 9. 部署注意

1. 反代必须放行 `Upgrade` / `Connection` 头，否则 WS 握手失败。
2. 反代空闲超时必须 **大于** 心跳间隔（Nginx 默认 60s，心跳 20s，勉强够；建议调到 120s）。
3. 小程序要求 `wss://` + 域名白名单，不能带自定义 header——这正是 token 走首帧的原因。
4. 服务端不设 CORS：demo 与 `/ws` 同源；如果客户端独立部署，浏览器 WS 不受 CORS 限制，但 HTTP 资源需要自己处理。

## 10. 版本兼容

- `HELLO.proto` 协商版本，当前只支持 1。
- 未知 op **忽略**（记日志），不要断开——这样服务端加新事件不会弄死旧客户端。
- 未知 `rsv` 位视为不兼容，必须断开，绝不猜测。
