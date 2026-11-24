package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"relay/internal/protocol"
)

type testClient struct {
	t *testing.T
	c *websocket.Conn
}

func dial(t *testing.T, base string) *testClient {
	t.Helper()
	u := "ws" + strings.TrimPrefix(base, "http") + "/ws"
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return &testClient{t: t, c: c}
}

func (c *testClient) send(f []byte) {
	c.t.Helper()
	_ = c.c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := c.c.WriteMessage(websocket.BinaryMessage, f); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) read() protocol.Frame {
	c.t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, data, err := c.c.ReadMessage()
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		c.t.Fatalf("expected binary, got %d", mt)
	}
	f, err := protocol.ParseFrame(data)
	if err != nil {
		c.t.Fatalf("parse frame: %v", err)
	}
	return f
}

// waitOp 跳过心跳等无关帧，直到拿到指定 op。
func (c *testClient) waitOp(op protocol.Op) protocol.Frame {
	c.t.Helper()
	for i := 0; i < 32; i++ {
		f := c.read()
		if f.Op == op {
			return f
		}
	}
	c.t.Fatalf("op %s not found", op)
	return protocol.Frame{}
}

// hello 建立新会话，返回服务端下发的 sid。
func (c *testClient) hello(token string) []byte {
	c.t.Helper()
	w := protocol.NewWriter(protocol.OpHello)
	w.U8(1)
	w.U8(0)
	w.Len16([]byte(token))
	c.send(w.Frame())
	f := c.waitOp(protocol.OpReady)
	r := protocol.NewReader(f.Body)
	r.U8()
	r.U8()
	sidOut := r.Bytes8()
	if r.Err() != nil {
		c.t.Fatalf("decode ready: %v", r.Err())
	}
	return sidOut
}

// resume 尝试恢复旧会话；成功时首帧是 RECONNECTED，不会再有 READY。
func (c *testClient) resume(sid []byte, lastSeq uint32, token string) {
	c.t.Helper()
	w := protocol.NewWriter(protocol.OpHello)
	w.U8(1)
	w.U8(1)
	w.Len16([]byte(token))
	w.Len8(sid)
	w.U32(lastSeq)
	c.send(w.Frame())
}

func decodeState(t *testing.T, f protocol.Frame) (code string, slot, host uint16, seq uint32, members []protocol.Member) {
	t.Helper()
	r := protocol.NewReader(f.Body)
	code = string(r.Bytes8())
	slot = r.U16()
	host = r.U16()
	seq = r.U32()
	n := int(r.U16())
	for i := 0; i < n; i++ {
		m := protocol.Member{Slot: r.U16()}
		m.Online = r.U8()&1 != 0
		m.Meta = r.Bytes16()
		members = append(members, m)
	}
	if r.Err() != nil {
		t.Fatalf("decode state: %v", r.Err())
	}
	return
}

func TestEndToEndCreateJoinRelayReconnect(t *testing.T) {
	srv := New(Config{GraceTimeout: 2 * time.Second, RingBytes: 64 << 10, RateLimit: 0}, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	a := dial(t, ts.URL)
	a.hello("alice")

	w := protocol.NewWriter(protocol.OpCreate)
	w.Len16([]byte("alice"))
	w.Len8(nil)
	a.send(w.Frame())
	created := a.waitOp(protocol.OpCreated)
	code, slot, _, _, _ := decodeState(t, created)
	if slot != 1 || len(code) != 4 {
		t.Fatalf("created: slot=%d code=%q", slot, code)
	}

	b := dial(t, ts.URL)
	sb := b.hello("bob")
	w = protocol.NewWriter(protocol.OpJoin)
	w.Len8([]byte(code))
	w.Len8(nil)
	w.Len16([]byte("bob"))
	b.send(w.Frame())
	joined := b.waitOp(protocol.OpJoined)
	_, bslot, _, _, members := decodeState(t, joined)
	if bslot != 2 || len(members) != 2 {
		t.Fatalf("joined: slot=%d members=%d", bslot, len(members))
	}
	a.waitOp(protocol.OpPeerJoin)

	// b 广播 → a 收到
	w = protocol.NewWriter(protocol.OpRelay)
	w.U8(0)
	w.Raw([]byte("hello"))
	b.send(w.Frame())
	relay := a.waitOp(protocol.OpRelayS2C)
	r := protocol.NewReader(relay.Body)
	from, seq := r.U16(), r.U32()
	payload := string(r.Rest())
	if from != 2 || seq != 1 || payload != "hello" {
		t.Fatalf("relay from=%d seq=%d payload=%q", from, seq, payload)
	}

	// b 断线（不发 LEAVE），a 继续发，b 用 sid 重连并收到补发
	_ = b.c.Close()
	time.Sleep(100 * time.Millisecond)
	w = protocol.NewWriter(protocol.OpRelay)
	w.U8(0)
	w.Raw([]byte("while-offline"))
	a.send(w.Frame())
	time.Sleep(100 * time.Millisecond)

	b2 := dial(t, ts.URL)
	b2.resume(sb, 1, "bob")
	reconnected := b2.waitOp(protocol.OpReconnected)
	_, rslot, _, rseq, _ := decodeState(t, reconnected)
	if rslot != 2 || rseq < 2 {
		t.Fatalf("reconnected: slot=%d seq=%d", rslot, rseq)
	}
	replay := b2.waitOp(protocol.OpRelayS2C)
	r = protocol.NewReader(replay.Body)
	r.U16()
	rseq = r.U32()
	if got := string(r.Rest()); rseq != 2 || got != "while-offline" {
		t.Fatalf("replay seq=%d payload=%q", rseq, got)
	}
}

func TestRejectHelloWithoutToken(t *testing.T) {
	srv := New(Config{}, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	c := dial(t, ts.URL)
	w := protocol.NewWriter(protocol.OpHello)
	w.U8(1)
	w.U8(0)
	w.Len16([]byte(""))
	c.send(w.Frame())

	for {
		f := c.read()
		if f.Op == protocol.OpError {
			r := protocol.NewReader(f.Body)
			if code := protocol.ErrCode(r.U16()); code != protocol.ErrBadFrame {
				t.Fatalf("error code = %v", code)
			}
			return
		}
		if f.Op == protocol.OpReady {
			t.Fatal("should not accept empty token")
		}
	}
}
