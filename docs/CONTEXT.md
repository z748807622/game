# 上下文摘要（2026-11-24）

> 这份文件是项目当前状态的压缩版，用于替代此前逐轮讨论的细节。后续继续开发时先读它。

## 1. 项目

**通用房间消息中继服务器**：Go + WebSocket，只维护「谁在哪个房间」并转发消息，**不解析业务 payload**。
定位 ≤16 人派对/桌游/卡牌/狼人杀；游戏逻辑在客户端或房主，服务器只搬字节。

明确接受的产品边界：
- **无权威 → 可作弊**（不解析消息就无法校验）。涉及虚拟货币/付费则不适用。
- **单机内存态**：进程重启房间全丢。
- 仅 WebSocket；TCP/KCP/QUIC 只留了接口。

## 2. 关键决策

| 决策 | 结论 |
|------|------|
| 传输 | WebSocket binary frame；token 走首帧（浏览器/小程序无法加 header） |
| 编码 | 8 字节固定头 + 变长体，小端；payload 不透明（推荐 protobuf，demo 用 JSON） |
| 房间归属 | 一条连接 = 一个房间成员；转发帧不带 roomId，客户端无法伪造 |
| 寻址 | slot（u16，房内单调递增、不复用），不暴露玩家 uid |
| 并发 | 每房间一个 goroutine（actor）+ inbox；每连接读/写协程 + 256KB 字节配额队列；慢客户端直接断（1013） |
| 可靠性 | 房间级 seq + 64KB 环形重放；重连带 sid+lastSeq 补发；窗口不足回 RESYNC 由游戏层全量同步 |
| 断线 | 宽限期 60s（可配）；期内只广播 PEER_OFFLINE，不广播 PEER_LEAVE；恢复广播 PEER_REJOIN |
| 房间 | 4 位房间码（字母表去掉 0/O/1/I）；CREATE 显式建房，JOIN 只加入已存在房间（防幽灵房）；创建者为房主；lock/kick/房主转移 |
| 会话 | READY 只在新会话下发；重连成功首帧直接是 RECONNECTED |
| 部署 | 单节点；RoomRegistry/Transport 留了拆分接口，暂不做 Gateway/RoomService |
| 打飞机示例 | 主机权威 + 30Hz 模拟 + 15Hz 全量快照 + 30Hz 目标点；实时局带宽/写次数远高于桌游，容量单独压测 |

## 3. 已交付

```
cmd/server/main.go            启动、参数、信号、优雅退出
internal/protocol/            二进制编解码、op/错误码、黄金向量
internal/protocol/testdata/vectors.json   Go 与 JS 共用的字节级黄金向量
internal/room/                房间 actor：成员、seq、环形重放、宽限期、房主
internal/session/             连接封装：发送队列、背压、关闭语义
internal/registry/            房间码索引、sid → (房间, slot)
internal/server/              WS 接入、DevVerifier 鉴权、分发、限流
web/index.html                内嵌 demo（连接/建房/加入/私聊/成员/协议帧日志）
web/relay.js                  浏览器+Node 通用协议库（RelayClient）
web/bulls.html / bulls.js / bulls-core.js   猜数字双人示例（移动端优先 UI + 纯状态机）
web/plane.html / plane.js / plane-core.js / plane-net.js   打飞机 2–4 人合作示例（主机权威 + 二进制快照）
web/test/{codec,e2e,ui}.test.js   向量对账、真进程 e2e、Chrome 真机 UI
web/test/{bulls-core,bulls-e2e,bulls-ui}.test.js  猜数字内核 / 双客户端 e2e / 手机+桌面 UI
web/test/{plane-core,plane-net,plane-e2e,plane-ui}.test.js  打飞机内核 / 编解码 / 主机+队友 e2e / 手机+桌面 UI
web/test/{cdp.js,ws-polyfill.js}  跨平台 CDP 辅助、Node 18 用的极简 WebSocket
docs/bulls-game.md            猜数字玩法、payload 约定、seq 回显与重同步说明
docs/plane-game.md            打飞机玩法、控制模型、字节布局、带宽与容量说明
docs/room-relay-design.md     设计 v1.1（架构、容量、实施计划）
docs/protocol-v2.md           二进制线格式规范
docs/api-reference.md         客户端接口参考
docs/demo.png                 UI 截图
Makefile / scripts/           构建与测试编排
```

## 4. 运行与验证

```bash
go run ./cmd/server        # 或 make run；打开 http://localhost:8080
```

| 命令 | 覆盖 |
|------|------|
| `make test` | 协议黄金字节、房间 actor、WS 端到端 |
| `make test-race` | 同上 + race detector |
| `make test-js` | JS 编解码对同一份 vectors.json；含猜数字 / 打飞机内核与编解码 |
| `make e2e` | 真进程 + 两个 Node 客户端：建房/广播/定向/断线补发/踢人 |
| `make ui` | Chrome headless 驱动真实页面，产出 .tmp/demo.png |
| `make e2e-plane` | 真进程 + 主机/三名队友：目标点同步、快照频率、重连、RESYNC |
| `make ui-plane` | Chrome headless：手机 + 桌面双视口，鼠标/触摸操作，产出 .tmp/plane-*.png |

全部通过；`go vet`、`gofmt` 干净。开发时多用 `GOCACHE=$PWD/.gocache` 规避沙箱对 `~/Library/Caches` 的写入限制。

## 5. 协议速查

- 帧：`len u32 | ver u8 | op u8 | flags u8 | rsv u8 | body`，整帧 ≤ 64KB
- C→S：HELLO 01 / CREATE 02 / JOIN 03 / LEAVE 04 / RELAY 05 / LOCK 06 / KICK 07 / PING 08 / PONG 09
- S→C：READY 81 / CREATED 82 / JOINED 83 / RECONNECTED 84 / PEER_JOIN 85 / PEER_LEAVE 86 / PEER_REJOIN 87 / HOST 88 / RELAY 89 / RESYNC 8A / KICKED 8B / ERROR 8C / PONG 8D / PING 8E / PEER_OFFLINE 8F
- 默认值：16 人/房、64KB 帧、512B meta、32B 密码、20s 心跳、60s 宽限、64KB 重放、200 帧/s/连接、10 房/分/IP
- 错误码 0x01–0x0F（含 INTERNAL 0x0F）；关闭码 4001 鉴权 / 4002 被踢 / 4004 会话失效 / 4005 服务端退出 / 4006 限流

## 6. 环境

- Go **1.27.4** darwin/arm64；`go.mod` 已声明 `go 1.27`（协作方需 ≥1.27）
- 已删除旧版 cgo/`netgo` workaround；race 测试直接 `go test -race ./...`
- 本机: macOS 27.0.1；沙箱内无 sudo、`$HOME` 不可写
- 用户侧收尾（可选）：`sudo rm -rf /usr/local/go-1.21.1.bak`、`rm /tmp/go1.27.4.darwin-arm64.tar.gz`

## 7. 下一步（建议顺序）

1. **压测**：写 Go loadgen，实测「3000 房 / 2w 连接 / 2w msg/s」目标，校准容量数字；打飞机实时局另按 200–500 房压测
2. **可观测**：Prometheus 指标（连接数、房间数、队列水位、丢弃、重放/重同步次数）
3. **真实鉴权**：替换 `DevVerifier` 为 HMAC/JWT 校验
4. **产品项**：观战、房间列表、匹配可插拔
5. **上线件**：反代 Upgrade 透传、idle timeout > 20s、部署清单
6. 远期：TCP 传输、多节点 Gateway + RoomService

## 8. 容易踩的坑

- 改了 `web/` 下的资源必须重新 `go build`（`go:embed` 在编译期烘焙）
- 二进制协议任何改动，Go 与 JS 两份实现要同时过 `vectors.json`
- 别把 payload 再包一层中继消息（隧道会破坏 seq/重放语义）
- 实时游戏所有消息要广播给全房（含自己/离线成员），否则 seq 跳号会让客户端误重连
- u32 tick 用无符号差值比较（可能 > 2^31）；START/重连时重置基线
- 房间码不存在时不自动建房，否则手滑输入会在服务端造出幽灵房
