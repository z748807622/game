GO ?= go
BIN := bin/relay
ADDR ?= 127.0.0.1:18080

.PHONY: build run test test-race test-js e2e ui e2e-game ui-game e2e-plane ui-plane ui-split web-dist clean

build:
	$(GO) build -o $(BIN) ./cmd/server

# 前端静态产物：直接作为 nginx root（不含 embed.go / test/）。
# 用 Go 工具导出，Windows/macOS/Linux 都不依赖 rm/cp/mkdir。
web-dist:
	$(GO) run ./cmd/devtool webdist

run:
	$(GO) run ./cmd/server

test:
	$(GO) test ./...

test-race:
	$(GO) test -race ./...

test-js:
	node web/test/codec.test.js
	node web/test/ws-url.test.js
	node web/test/bulls-core.test.js
	node web/test/plane-core.test.js
	node web/test/plane-net.test.js

e2e: build
	RELAY_URL=ws://$(ADDR)/ws ./scripts/with-server.sh node web/test/e2e.test.js

e2e-game: build
	RELAY_URL=ws://$(ADDR)/ws ./scripts/with-server.sh node web/test/bulls-e2e.test.js

ui: build
	./scripts/with-server.sh node web/test/ui.test.js

ui-game: build
	./scripts/with-server.sh node web/test/bulls-ui.test.js

e2e-plane: build
	RELAY_URL=ws://$(ADDR)/ws ./scripts/with-server.sh node web/test/plane-e2e.test.js

ui-plane: build
	./scripts/with-server.sh node web/test/plane-ui.test.js

# 前后端分离：后端 -serve-web=false + 纯静态前端 + ?ws=
ui-split: build
	RELAY_ARGS="-serve-web=false -trusted-proxies 127.0.0.1/32" RELAY_URL=ws://$(ADDR)/ws \
		./scripts/with-server.sh node web/test/split-ui.test.js

clean:
	$(GO) run ./cmd/devtool clean
