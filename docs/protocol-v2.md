# 中继协议 v2（二进制线格式）

> 传输：WebSocket **binary frame**（`wss`），每帧 = 一个 8 字节固定头 + 变长体。
> 所有多字节整数 **小端序**。单帧上限 64KB。
> 业务负载（payload）对服务端完全不透明，服务端只读信封，绝不解析其内部。

## 1. 效率来自三层，别混在一起优化

| 层 | 谁决定 | 单条「出牌」消息的开销 | 能不能优化 |
|----|--------|----------------------|-----------|
| 传输层 TCP/TLS/WS 分帧 | 协议栈 | TCP 20 + IP 20 + TLS 记录 5 + WS 帧头 2~6 ≈ 50B | 基本不能（`permessage-deflate` 关掉，见 §7） |
| **中继信封**（服务端要解析） | 我们 | **8B 固定头 + 6B 路由字段** | 手写二进制，服务端 O(1) 跳过 |
| 业务负载（服务端不碰） | 游戏 | protobuf 12B vs JSON 35B | 最大的一块，收益 3~5 倍 |

结论：**信封用手写固定头，负载用 protobuf**。

信封不做 protobuf 的原因：protobuf 要拿到字段就得整体反序列化（分配 + 解析 + 每字段 1B tag），而固定头可以让服务端「读到长度就知道去哪，读到 op 就知道干什么，其余整块切走」。热路径上这决定了每帧是 **0 次分配**还是 **3~5 次分配**。

## 2. 帧结构

```
偏移  长度  字段      说明
0     4    len u32   后续字节数（不含自身）。len+4 = 整帧字节数，且 ≤ 64KB
4     1    ver u8    协议版本，当前 1
5     1    op  u8    见 §3
6     1    flags u8  当前必须为 0（保留：将来标可靠/批量）
7     1    rsv  u8    必须为 0（不认识的扩展位 → 直接关连接，避免静默错解）
8     ...  body
```

`len` 与 op 无关，永远先校验：`4+len` 必须与读到的字节数一致，否则断开。这样任何畸形帧都会在进入业务逻辑前被拒绝。

## 3. 操作码

| 值 | 名称 | 方向 | 值 | 名称 | 方向 |
|----|------|------|---|------|------|
| 0x01 | HELLO | C→S | 0x81 | READY | S→C |
| 0x02 | CREATE | C→S | 0x82 | CREATED | S→C |
| 0x03 | JOIN | C→S | 0x83 | JOINED | S→C |
| 0x04 | LEAVE | C→S | 0x84 | RECONNECTED | S→C |
| 0x05 | RELAY | C→S | 0x85 | PEER_JOIN | S→C |
| 0x06 | LOCK | C→S | 0x86 | PEER_LEAVE | S→C |
| 0x07 | KICK | C→S | 0x87 | PEER_REJOIN | S→C |
| 0x08 | PING | C→S | 0x88 | HOST | S→C |
| 0x09 | PONG | C→S | 0x89 | RELAY | S→C |
| | | | 0x8A | RESYNC | S→C |
| | | | 0x8B | KICKED | S→C |
| | | | 0x8C | ERROR | S→C |
| | | | 0x8F | PEER_OFFLINE | S→C |
| | | | 0x8D | PONG | S→C |
| | | | 0x8E | PING | S→C |

规则：

- **未知 op**：记日志后忽略（向前兼容），不断开
- **`ver` 不等于 1**：回 `BAD_VERSION` 后断开
- **`rsv` 非 0**：断开
- 位移类 op（RELAY/PEER_*）不携带房间码——房间归属由连接状态决定，客户端无从伪造

## 4. 消息体布局

### HELLO 0x01

```
u8   proto    = 1
u8   flags    bit0 = RESUME（重连）
u16  tokenLen ≤ 1024
byte token[tokenLen]
u8   sidLen   = 16 if RESUME else 0
byte sid[sidLen]
u32  lastSeq  仅 RESUME 时有
```

服务端用 `TokenVerifier` 接口校验 token（生产 HMAC/JWT，开发可放行）。**token 走首帧而不是 URL**：浏览器和小程序都无法在握手时加自定义 header，而放 query 会进访问日志。

### READY 0x81

```
u8   proto
u8   flags   bit0 = RESUMED（当前恒为 0）
u8   sidLen  = 16
byte sid[16]     ← 128 位随机，会话 id
```

**只在新会话时下发**。`HELLO` 带 `RESUME` 且恢复成功时，首帧直接是 `RECONNECTED`，不再有 `READY`——客户端据此区分「新建会话」与「恢复会话」：先收到 `READY` 说明是全新会话，先收到 `RECONNECTED` 说明已回到原房间。

### CREATE 0x02

```
u16  metaLen ≤ 512
byte meta[metaLen]    ← 不透明（昵称/头像/等级），服务端原样存、原样回传
u8   pwdLen ≤ 32
byte pwd[pwdLen]
```

### CREATED 0x82 / JOINED 0x83 / RECONNECTED 0x84（同一结构，0x84 末尾多 2 字节）

```
u8   codeLen = 4
byte code[4]          ← 房间码，大写字母表去掉 0/O/1/I
u16  slot
u16  hostSlot
u32  seq              ← 房间当前最新 seq
u16  memberCount
重复 memberCount 次：
  u16  slot
  u8   mflags    bit0 = ONLINE
  u16  metaLen
  byte meta[metaLen]
```

`RECONNECTED` 追加：

```
u16  missed    ← 即将补发的帧数，仅用于客户端日志/进度提示
```

`join` 只加入已存在房间，不建房（否则输错码就在服务端生成幽灵房）；建房走 `CREATE`。

### RELAY 0x05（C→S，热路径）

```
u8   targetCount   0 = 除自己外全体；1..16
u16  targets[targetCount]
byte payload[...]  ← 剩余全部字节，不透明
```

- 私密投递（发牌、狼人身份）就是 `targetCount=1`
- `targets` 含自己的 slot → 会收到回显（房主做权威逻辑时用）
- 任一 target 不是本房间成员 → 整条拒绝 `BAD_TARGET`

### RELAY 0x89（S→C）

```
u16  from
u32  seq
byte payload[...]
```

服务端组装一次，扇出时所有目标**共享同一个只读切片**。

### 其余控制消息

| op | 体 |
|----|----|
| LEAVE 0x04 | 空 |
| LOCK 0x06 | `u8 v` |
| KICK 0x07 | `u16 slot` |
| PING 0x08 / PONG 0x09 | `u64 t`（毫秒时间戳） |
| PEER_JOIN 0x85 | `u16 slot, u16 metaLen, meta[...]` |
| PEER_LEAVE 0x86 | `u16 slot, u8 reason` |
| PEER_REJOIN 0x87 | `u16 slot` |
| PEER_OFFLINE 0x8F | `u16 slot`（宽限期内断线；不要与 PEER_LEAVE 混淆） |
| HOST 0x88 | `u16 slot` |
| RESYNC 0x8A | `u32 seq, u8 reason` |
| KICKED 0x8B | 空 |
| ERROR 0x8C | `u16 code, u16 msgLen, msg[...]`（UTF-8，仅调试用） |
| PONG 0x8D / PING 0x8E | `u64 t` |

枚举：

- `reason`(PEER_LEAVE)：`0`=LEFT，`1`=TIMEOUT，`2`=KICKED
- `PEER_OFFLINE`：仅表示连接断了、仍在宽限期；恢复用 `PEER_REJOIN`，超时才 `PEER_LEAVE{reason:TIMEOUT}`
- `reason`(RESYNC)：`0`=GAP（补发窗口不足），`1`=ROOM_RESET

## 5. 错误码

| 码 | 名称 | 客户端处理 |
|----|------|-----------|
| 0x01 | UNAUTHORIZED | 刷 token 重连 |
| 0x02 | BAD_FRAME | 断开（客户端 bug） |
| 0x03 | ALREADY_JOINED | 提示 |
| 0x04 | NOT_JOINED | 提示 |
| 0x05 | ROOM_NOT_FOUND | 回大厅 |
| 0x06 | ROOM_FULL | 提示 |
| 0x07 | ROOM_LOCKED | 提示 |
| 0x08 | BAD_PASSWORD | 提示 |
| 0x09 | BAD_TARGET | 修 bug |
| 0x0A | NOT_HOST | 提示 |
| 0x0B | RATE_LIMITED | 退避 |
| 0x0C | SERVER_FULL | 提示 |
| 0x0D | FRAME_TOO_LARGE | 拆包 |
| 0x0E | BAD_VERSION | 升级客户端 |
| 0x0F | INTERNAL | 重试 |

关闭码：`1000` 正常、`1009` 帧过大、`1013` 发送队列溢出、`4001` 鉴权失败、`4002` 被踢、`4004` 宽限期超时会话作废、`4005` 服务端退出。

## 6. 服务端解析路径（性能关键）

```
读 4B len ─▶ 校验 8 ≤ len ≤ 65535 ─▶ 读 len-4 字节 ─▶ 校验 ver/flags/rsv
   │
   ├─ op == RELAY：body[0] 取 targetCount，body[1:1+2n] 取 slots，
   │               payload = body[1+2n:]（零拷贝切片）
   │               → seq++ → 组装 8+2+4+len(payload) → 扇出
   │
   └─ 控制消息：按 §4 顺序读定长字段 + 长度前缀块，整体 ≤ 100 字节
```

每帧分配次数：**1 次**（组装输出缓冲）。JSON 方案同样一帧要 4~8 次（`ReadMessage` 缓冲 + envelope 反序列化 + 字符串/切片 + 输出拼接）。

推荐实现细节：

- 读缓冲固定 64KB + 65536，复用；`gorilla/websocket` 用 `NextReader` + `io.ReadFull`
- 输出缓冲不复用（共享切片 + 池化会引入生命周期 bug，2w msg/s 下 GC 完全扛得住）
- 控制消息解析禁止 `binary.Read`（反射开销）；直接 `binary.LittleEndian.Uint16(buf[i:])`

## 7. 传输层设置

- **`permessage-deflate` 关闭**：CPU 成本换不来收益，还引入压缩上下文和延迟抖动；要省带宽就让业务负载自己压缩（大快照用 zstd，别对小包做）
- WS 帧头最小 2B（≤125B 负载）、最大 14B（>64KB 不用）；单帧控制在 16KB 内，避免 TCP 队头阻塞放大
- `wss` 的 TLS 记录开销 5B/条，由连接复用摊薄（每条 WS 连接只握手一次）
- 服务端不做 UTF-8 校验（binary frame 天然免掉，JSON 文本帧反而每次都校验）
- 反代/网关必须显式放行 `Upgrade`/`Connection`，且空闲超时 > 心跳间隔（§9）

参考体积（一次「出牌」，16 人房广播）：

| 方案 | 单帧字节 | 15 个目标的总线上字节 |
|------|---------|---------------------|
| JSON 信封 + JSON 负载 | ~85 | ~1.3KB |
| **固定头 + protobuf** | **~26** | **~390B** |

## 8. 业务负载（payload）建议

服务端不解析，所以这是**游戏层**的自由；但既然是同一条链路，建议统一：

- **protobuf**：卡牌/桌游/派对游戏首选，跨语言（TS 用 `protobufjs`/`bufbuild`，Unity 用 `protobuf-net`/`Google.Protobuf`），比 JSON 小 3~5 倍且无解析分配
- 底层帧层协议（本文件）不要用 protobuf 描述：它的 tag/varint 是为「可演进 schema」设计的，不是为「8 字节定长路由头」设计的
- 负载上限 60KB，超了在业务层自己分片；不要靠中继层分片
- 禁止在 `payload` 里再套一层中继消息（别做成隧道），会让 seq/重放语义失效

## 9. 客户端行为约定（SDK 必做）

1. **心跳**：服务端每 20s 发 `PING`，客户端回 `PONG`；客户端 **45s 未收到任何帧** 即判定半开连接，主动 close 重连（移动网络切基站时 TCP 半开极常见）
2. **重连**：指数退避 0.5s→8s + 抖动；带 `sid` + 本地 `lastSeq`；`ROOM_NOT_FOUND` 不重试，回大厅
3. **seq 单调**：`RELAY.seq` 必须严格大于上一条（`JOINED`/`RECONNECTED` 会重置基线）；出现空洞 → 主动重连请求补发
4. **`RESYNC`**：进「等快照」态，向房主请求全量，期间丢弃过期帧
5. **发送**：二进制 `ArrayBuffer`，不要每帧 `new DataView` 反复创建（复用一块发送缓冲）

## 10. 典型时序

```
A: HELLO ─▶ READY{sid}
A: CREATE ─▶ CREATED{code:"K7QF", slot:1, seq:0}
B: HELLO ─▶ READY{sid}
B: JOIN{code:"K7QF"} ─▶ JOINED{slot:2, seq:0, members:[1,2]}
   A ◀ PEER_JOIN{slot:2}
B: RELAY{to:[1], payload} ─▶ seq=1 ─▶ A: RELAY{seq:1, from:2, payload}
A: RELAY{payload}         ─▶ seq=2 ─▶ B: RELAY{seq:2, from:1, payload}
B 断网（服务端 60s 后发现，标记 offline，向其他人广播 PEER_OFFLINE；不广播 PEER_LEAVE）
B: HELLO{RESUME, sid, lastSeq:2} ─▶ RECONNECTED{slot:2, seq:5, missed:3}（无 READY）
   ◀ 补发 seq=3,4,5 中命中 B 的帧
   A ◀ PEER_REJOIN{slot:2}
```

## 11. 演进

- `flags` 位留给「批量帧」：一条 WS 消息里塞 N 个完整帧，把 syscall 摊薄（帧率高的游戏才需要）
- `rsv` 位用于将来不兼容扩展；不认识就断开，绝不猜测
- 协议版本升级走 `HELLO.proto` 协商，服务端可同时支持 1 和 2 一段时间
- 新增 op 是安全变更：旧客户端忽略未知 op 即可
