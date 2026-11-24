GO ?= go
BIN := bin/relay
ADDR ?= 127.0.0.1:18080

.PHONY: build run test test-race test-js e2e ui clean

build:
	$(GO) build -o $(BIN) ./cmd/server

run:
	$(GO) run ./cmd/server

test:
	$(GO) test ./...

test-race:
	$(GO) test -race ./...

test-js:
	node web/test/codec.test.js

e2e: build
	RELAY_URL=ws://$(ADDR)/ws ./scripts/with-server.sh node web/test/e2e.test.js

ui: build
	./scripts/with-server.sh node web/test/ui.test.js

clean:
	rm -rf bin .tmp
