# 前后端分离部署指南

本项目默认把前端页面内嵌进 Go 二进制（`go:embed`），`go run ./cmd/server` 即可访问。
生产上也可以把前端交给 nginx、后端只跑 `/ws`，两种形态共存，互不影响。

## 1. 两种拓扑

**拓扑 A：同域反代（推荐，前端零配置）**

```
浏览器 ──https──▶ nginx ──┬── /            静态文件（dist/web）
                          └── /ws  ──────▶ Go relay 127.0.0.1:8080
```

nginx 同时托管静态页并反代 WebSocket。页面按同源规则连接 `wss://<当前域名>/ws`。

**拓扑 B：前后端不同域/不同端口**

```
浏览器 ──https──▶ nginx（前端）── 静态文件
       └──wss────▶ 后端域名 /ws（另有一套 TLS + 反代直连 Go）
```

前端在 `web/config.js` 里写明后端地址；后端只要能收到 `Upgrade` 即可。
浏览器 WebSocket 不受 CORS 限制，`CheckOrigin` 当前放行所有来源。

## 2. 构建产物

```bash
make build        # 后端：bin/relay
make web-dist     # 前端：dist/web
```

等价命令（任意平台，不依赖 `rm`/`cp`/`mkdir`）：

```bash
go build -o bin/relay ./cmd/server
go run ./cmd/devtool webdist
```

`dist/web` 只包含下列 11 个文件（不含 `embed.go` / `test/`）：

```
index.html  relay.html  bulls.html  plane.html
relay.js  config.js  bulls-core.js  bulls.js  plane-core.js  plane-net.js  plane.js
```

文件清单直接来自 `web/embed.go` 的 `go:embed` 列表，新增前端文件只需改那一处。

交叉编译 Linux 后端：

```bash
GOOS=linux GOARCH=amd64 go build -o bin/relay ./cmd/server
```

## 3. 拓扑 A：nginx 同域反代

### 3.1 启动后端

后端只监听本机，静态页面关闭，并信任本机 nginx 传来的真实 IP：

```bash
./bin/relay \
  -addr 127.0.0.1:8080 \
  -serve-web=false \
  -trusted-proxies 127.0.0.1/32 \
  -log info
```

| 参数 | 作用 |
|------|------|
| `-serve-web=false` | 不提供内置页面，只保留 `/ws`、`/healthz` |
| `-trusted-proxies` | 可信反代网段；只有直连方命中列表才采信 `X-Real-IP` / `X-Forwarded-For` |
| `-static-dir` | 可选：改用磁盘目录提供页面（本地联调时替代内嵌页，不能与 `-serve-web=false` 同用） |

启动日志出现 `static=disabled` 表示静态页已关闭：

```
level=INFO msg="relay server listening" addr=127.0.0.1:8080 ws=/ws static=disabled
```

### 3.2 配置 nginx

把 `dist/web` 放到 `/var/www/game`，参考 [`deploy/nginx.conf`](../deploy/nginx.conf)：

```nginx
upstream relay_backend {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 80;
    server_name game.example.com;
    root /var/www/game;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location = /config.js {
        add_header Cache-Control "no-store";
    }

    location = /ws {
        proxy_pass http://relay_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        proxy_buffering off;
    }

    location = /healthz {
        proxy_pass http://relay_backend;
        access_log off;
    }
}
```

改完执行 `nginx -t && nginx -s reload`。

要点：

- **必须** `proxy_http_version 1.1` + `Upgrade` / `Connection` 透传，否则 WS 握手 400/426。
- 空闲超时必须**大于**服务端心跳间隔（默认 20s），样例用 120s。
- `config.js` 加 `no-store`，运维改后端地址后立即生效。
- HTTPS 只需在该 server 上加证书与 `listen 443 ssl`；页面自动用 `wss://`，无需改前端。

### 3.3 验证

```bash
curl -s http://127.0.0.1:8080/healthz          # {"ok":true,"rooms":0}
curl -i http://127.0.0.1:8080/                 # -serve-web=false 时 404
curl -sI https://game.example.com/config.js     # Cache-Control: no-store
```

浏览器打开 `https://game.example.com/`、`/bulls.html`、`/plane.html`：
建房后后端日志里的 `remote` 应是真实客户端 IP，而不是 `127.0.0.1`。

## 4. 拓扑 B：前后端分域

1. 前端 `config.js` 填后端地址：

```js
window.RELAY_CONFIG = {
  wsUrl: 'wss://api.example.com/ws'
};
```

也支持相对路径（`/relay/ws`）和 `http(s)://` 写法，`relay.js` 会自动归一化成 `ws(s)://`。

2. 后端域名同样用 nginx（或任意支持 WS 的网关）反代到 Go，配置与 3.2 的 `/ws` 一致，
   并按反代所在网段设置 `-trusted-proxies`。

3. 注意混合内容：HTTPS 页面不能连 `ws://`，必须 `wss://`；后端证书由它的
   nginx/网关终止，Go 本身只监听内网明文 HTTP。

4. 临时调试可以用 `?ws=` 覆盖，不修改文件：

```
https://game.example.com/plane.html?ws=wss%3A%2F%2Fapi.example.com%2Fws
```

## 5. WS 地址解析规则

`relay.js` 的 `wsURL()` 按以下顺序取值（前者覆盖后者）：

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | `new RelayClient({ url })` 显式传入 | 测试/e2e 用 |
| 2 | 页面 query `?ws=` | `?ws=wss%3A%2F%2Fapi.example.com%2Fws` |
| 3 | `window.RELAY_CONFIG.wsUrl` | `web/config.js` |
| 4 | 同源推导 | `wss://<当前域名>/ws` |
| 5 | 无 `location`（Node / `file:`） | `ws://127.0.0.1:8080/ws` |

推荐生产环境用拓扑 A 并保持 `config.js` 为空；只有分域时才填第 3 项。

## 6. 进程管理（systemd 示例）

```ini
[Unit]
Description=room relay server
After=network.target

[Service]
User=game
WorkingDirectory=/opt/game
ExecStart=/opt/game/bin/relay -addr 127.0.0.1:8080 -serve-web=false -trusted-proxies 127.0.0.1/32 -log info
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`SIGTERM` 会触发优雅退出：关闭所有连接（4005）并停止 HTTP 服务。

## 7. 排错

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 页面能打开，一直“连接中”/超时 | `/ws` 没反代或 Upgrade 头没透传 | 检查 `location = /ws`、`proxy_http_version 1.1`、两个 `Upgrade`/`Connection` 头 |
| 连上后约 60s 断开 | 反代空闲超时小于心跳 | `proxy_read_timeout` 调到 120s（必须 > 20s） |
| HTTPS 页面报混合内容/连不上 | 配了 `ws://` 或直连后端明文 | 改用 `wss://`，或走同域反代 |
| 改了 `config.js` 不生效 | 浏览器缓存 | 确认 `no-store`，强刷；`?ws=` 可临时绕过 |
| 所有用户共用一个 IP、建房被限流 | 后端只看到 nginx 的 `127.0.0.1` | 配 `-trusted-proxies` 并把 nginx 的真实 IP 头补上 |
| 握手 400/426 | nginx 未放行 `Upgrade` | 同第一条 |
| 连接被关 4001 | token 为空（`DevVerifier` 要求非空） | 页面填写 token；生产应替换为真实鉴权 |
| 子路径部署后连不上 | 页面同源推导出 `/ws`，但反代挂在 `/game/ws` | 在 `config.js` 写完整 `wsUrl`，或反代保持根路径 `/ws` |
| `-serve-web=false` 后打开首页 404 | 预期行为 | 静态页由 nginx 提供 |

## 8. 和内置页面模式的关系

- 默认（不带参数）行为不变：内嵌页面 + `/ws` + `/healthz` 同端口，适合开发和测试。
- `-static-dir` 让 Go 从磁盘目录提供页面，适合不想用 nginx 的临时联调。
- 相关设计、协议与容量说明见 [README](../README.md)、[协议 v2](protocol-v2.md)、[客户端接口](api-reference.md)。
