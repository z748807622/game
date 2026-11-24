# 房间消息中继服务器（Go）— 设计 v1.1

> v0.1 → v1.0 的依据：已确认四条产品约束（≤16 人、WebSocket/H5、客户端自建房间码、可配置重连宽限期）。
> v1.0 → v1.1：确认走二进制信封（D5 反转），线格式见 [协议 v2](protocol-v2.md)。

## 1. 定位与边界

**一个有房间概念的、与游戏业务无关的消息中继服务器**：维护「谁在哪个房间」，按目标转发消息，payload 不解析。

不做：游戏逻辑、状态计算、匹配、反作弊、持久化。

**权威性缺失是架构层面的固有属性**：服务器看不懂 payload，就无法校验任何业务行为。适用休闲桌游、派对游戏、你画我猜、狼人杀、语音房；不适用强对抗 FPS/MOBA。若要留后路，唯一做法是允许客户端把「房主权威」的思路做进游戏逻辑，服务器只转发——这也是本设计隐含支持的模型。

## 2. 决策记录

| # | 决策 | 依据 | 影响 |
|---|------|------|------|
| D1 | 单房 ≤16 人，派对/桌游 | 已确认 | 广播成本可忽略（16×20×15=4800 msg/s/房），**不做 AOI/分组**；容量目标改为「房间数优先」 |
| D2 | 传输只用 WebSocket | 已确认（H5/小程序） | 只实现 WS 传输；TCP/KCP 仅留接口，不写实现 |
| D3 | 客户端自建房间，凭房间码加入 | 已确认 | `create` 显式建房并返回 4 位房间码；`join` 只加入已存在房间（防止错码建出幽灵房） |
| D4 | 断线宽限期可配置，默认 60s | 已确认 | 成员有 online/offline 两态；房主离线在宽限期内不转移；最后一人离线且超时才销毁房间 |
| D5 | **二进制信封**：8 字节固定头 + 变长体，payload 不透明 | 传输效率优先；固定头让服务端 O(1) 跳过，每帧 0~1 次分配（JSON 需 4~8 次）；线上体积约为 JSON 的 1/3 | 服务端只读头与路由字段；业务负载建议 protobuf，见 [协议 v2](protocol-v2.md) |
| D6 | 增加**房间级 seq + 环形重放缓冲** | 桌游/卡牌类不能丢「出牌」这条消息；TCP 只保证链路内有序，重连后必丢 | 每条转发消息带单调 seq；重连时客户端带 `lastSeq`，服务端从环形缓冲补发；窗口不足则回 `resync_required` 由游戏层用房主快照恢复 |
| D7 | 单节点、单进程，内存态 | 规模不需要分布式 | `Transport`/`RoomRegistry` 抽象保留，P3 再拆 Gateway + RoomService |

## 3. 架构

```
              ┌───────────────┐
  Client A ───┤ Transport/WS  │  每连接：readLoop + writeLoop
  Client B ───┤  (upgrade)    │
  Client C ───┤               │
              └───────┬───────┘
                      │ 只解析 8B 固定头 + 路由字段；payload 不解析
              ┌───────▼───────┐
              │  Room Actor   │  每房间 1 goroutine，无锁串行
              │  成员表 / seq  │  持有环形重放缓冲
              │  inbox chan   │
              └──┬────┬────┬──┘
                 │    │    │   同一份 []byte 扇出（只读共享，不可复用）
              ┌──▼┐ ┌─▼─┐ ┌▼──┐
              │ W │ │ W │ │ W │  writeLoop：背压的唯一发生点
              └───┘ └───┘ └───┘
```

扇出时**只组装一次字节**（`8B 头 + from u16 + seq u32 + payload`），所有目标共享同一个只读切片。每条消息一次分配、交给 GC；在派对游戏量级完全可接受，换来零锁、零解析、零拷贝广播。若将来上高频，再引入引用计数或按目标数决定是否拷贝。

## 4. 房间模型

### 4.1 状态机

```
Creating ──▶ Open ──(房主 lock)──▶ Locked
                │                    │
                └────(全员离线)──────┴──▶ Draining ──(宽限期满)──▶ Closed
```

- **创建**：`create` → 生成 4 位房间码（字母表去掉 `0/O/1/I`，碰撞重试）→ 创建者为房主（slot=1）
- **加入**：校验房间码存在、未锁、未满（16）、密码；分配 slot（uint16 单调递增、房间内不复用，避免 ABA）
- **加入成功**：回 `joined`（含 slot、成员快照、当前 seq）；向其他成员广播 `peer_join`
- **离开**：广播 `peer_leave`（reason: left/timeout/kicked）
- **房主离开**：优先移交给**在线**的最小 slot；无人在线则保持房主身份到宽限期结束，仍不回来再转移或销毁
- **踢人**：仅房主可踢；被踢者收到 `kicked` 后连接关闭，**不可用同一会话重连**
- **空房**：所有成员离线且宽限期到期 → 销毁、回收房间码
- **房间码回收**：房间销毁后码回到可用池（进程内使用原子计数 + map 即可，无需预分配池）

### 4.2 重连

- 握手成功后服务端下发 `sid`（16B 随机）+ 连接绑定
- 断线 → 成员标记 offline（**不广播 peer_leave**），启动该成员的宽限计时
- 重连：客户端带 `sessionId` + `lastSeq` → 校验（房间还在、slot 仍在、未超宽限）→ 重绑槽位 → 回 `reconnected`（成员快照 + 当前 seq）→ 从环形缓冲补发 `seq > lastSeq` 的转发帧 → 广播 `peer_rejoin`
- 超宽限：广播 `peer_leave{reason:"timeout"}`，slot 释放（但**不复用**，直到房间销毁）

## 5. 数据通路与性能

单条消息的完整路径（WebSocket binary frame）：

1. `readLoop`：`NextReader` → 读 4B 长度 → 读剩余字节 → 校验 `ver`/`flags`/`rsv`
2. 房间 actor inbox（容量 1024）
3. actor 内：校验目标 slot → `seq++` → 组装 `8B 头 + from u16 + seq u32 + payload` → 推入各目标 `sendCh`
4. `writeLoop`：`WriteMessage(BinaryMessage)`（带写超时）

关键约束：

- **payload 零成本**：`payload = body[1+2n:]` 只是一个切片，不复制、不反序列化；组装时整块 memcpy 一次
- **每帧分配 1 次**（输出缓冲），读缓冲复用；控制消息解析用 `binary.LittleEndian.Uint16(buf[i:])` 直接取，**禁用 `binary.Read`**（反射，一帧能多出几百 ns 和几次分配）
- **输出缓冲不复用**：共享切片 + 池化会引入生命周期 bug，派对游戏量级不值当
- **热路径不取锁**：房间状态只由 actor 协程写；连接上 `room/slot` 字段只在 actor 内读写（readLoop 通过 channel 提交事件，不直接读）
- 目标校验：`targets` 必须是当前房间**在线或离线**成员，否则整条消息拒绝（`BAD_TARGET`），防止跨房注入

## 6. 背压与故障处理

| 位置 | 策略 |
|------|------|
| 连接 sendCh 满（默认 256KB 字节配额） | 关闭该连接（close code 1013），进入宽限期；不阻塞房间 |
| 房间 inbox 满（1024） | 说明异常（用户态阻塞），记错误日志 + 指标，**丢弃当前事件并断开来源连接** |
| 单帧 > 64KB | 直接断开（1009） |
| 写超时（10s） | 断开 |
| 心跳：服务端 20s 发 `ping`，60s 无任何入站 | 断开 |
| 读空闲 90s | 断开 |
| 限流 | 每连接令牌桶（30 msg/s 突发 60）；每 IP 建房 10 次/分钟、加入尝试 60 次/分钟 |
| 房间数上限 | 默认 10000，超过拒绝建房（`server_full`） |

为什么「慢客户端直接断」而不是丢消息：派对游戏的转发帧大多是业务关键帧，静默丢弃会让客户端状态永久错乱；断开 + 宽限期 + seq 补发是一条可以被客户端理解、可以恢复的路径。

## 7. 容量与指标

目标（单节点 4C8G，派对游戏负载）：3000 房间 / 2w 连接 / 转发 2w msg/s / P99 进程内延迟 < 2ms。

内存估算：连接 ~64KB（含 2 个 WS 缓冲 + 队列）+ 房间 ~8KB + 重放缓冲 ≤64KB/房。3000 房满载约 3000×72KB≈216MB，加上连接内存约 1.3GB。

指标：
`room_active`、`conn_active`、`msg_in_total`、`msg_out_total`、`bytes_in/out`、`send_queue_bytes`(直方图)、`drop_total{reason}`、`replay_served_total`、`resync_total`、`room_create_total`、`join_fail_total{code}`、`goroutines`、`gc_pause`。

## 8. 目录结构

```
cmd/server/main.go
internal/config          默认值 + env/YAML 覆盖
internal/protocol        envelope 解析、错误码、输出组装
internal/transport/ws    Listener + Conn 适配（未来 tcp 同接口）
internal/session         readLoop / writeLoop / 背压 / 心跳
internal/room            actor、成员表、seq、环形缓冲、宽限期
internal/registry        分片 map: code→*Room、sessionId→slot 索引
internal/server          组装、限流、优雅退出
internal/metrics         prometheus
```

依赖仅 `gorilla/websocket` + `prometheus/client_golang`（HTTP 服务用标准库）。

## 9. 实施计划

| 里程碑 | 内容 | 估时 |
|--------|------|------|
| M1 可跑骨架 | 配置、WS upgrade、二进制信封编解码、room actor、create/join/relay/leave、单测 | 3~4 天 |
| M2 可用 | 房间码、密码、lock/kick、心跳、宽限期重连、seq + 重放、限流 | 3 天 |
| M3 可上线 | 指标、日志、优雅退出、压测脚本、故障注入、TS 客户端 SDK | 3 天 |

## 10. 风险与未决

1. **小程序/浏览器连接约束**：wss 必须走 443、域名白名单、不能自定义 header → 鉴权 token 只能放 URL query 或首帧（首帧更安全，也避免日志泄露）。首帧方案已定，见协议文档。
2. **LB/反代空闲超时**：Nginx 默认 60s，必须大于 ping 间隔（20s）；k8s ingress 同理。
3. **反代不支持 WS 升级**：需显式配置 `Upgrade`/`Connection` 透传。
4. **单机内存态**：进程崩溃 = 所有房间消失。派对游戏可接受（重开一局），但要在产品上明确告知。
5. **待确认**：是否接受无权威（可作弊）；部署形态与 TLS 终止位置；是否需要观战/房间列表。
6. **客户端 SDK 成本**：二进制信封意味着 TS/Unity/C# 各要手写一份 ~300 行 codec（约 1 天/语言）。若客户端只有 TS，成本可接受；若同时要 Unity + 小程序 + 原生，建议用同一份 schema 代码生成，别手抄。
