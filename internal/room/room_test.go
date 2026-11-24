package room

import (
	"sync"
	"testing"
	"time"

	"relay/internal/protocol"
)

type fakePeer struct {
	mu     sync.Mutex
	frames [][]byte
	closed int
}

func (p *fakePeer) Send(b []byte) bool {
	p.mu.Lock()
	p.frames = append(p.frames, b)
	p.mu.Unlock()
	return true
}

func (p *fakePeer) Close(code int, reason string) {
	p.mu.Lock()
	p.closed = code
	p.mu.Unlock()
}

func (p *fakePeer) of(op protocol.Op) [][]byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out [][]byte
	for _, f := range p.frames {
		if protocol.Op(f[5]) == op {
			out = append(out, f)
		}
	}
	return out
}

func (p *fakePeer) wait(t *testing.T, op protocol.Op, n int) [][]byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := p.of(op); len(got) >= n {
			return got
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d frames of %s, have %d", n, op, len(p.of(op)))
	return nil
}

func decodeRelay(t *testing.T, f []byte) (from uint16, seq uint32, payload string) {
	t.Helper()
	fr, err := protocol.ParseFrame(f)
	if err != nil {
		t.Fatalf("parse relay: %v", err)
	}
	r := protocol.NewReader(fr.Body)
	from = r.U16()
	seq = r.U32()
	payload = string(r.Rest())
	if r.Err() != nil {
		t.Fatalf("decode relay: %v", r.Err())
	}
	return
}

func testRoom(t *testing.T, cfg Config, hooks Hooks) *Room {
	t.Helper()
	if cfg.MaxMembers == 0 {
		cfg.MaxMembers = 16
	}
	if cfg.GraceTimeout == 0 {
		cfg.GraceTimeout = time.Second
	}
	if cfg.RingBytes == 0 {
		cfg.RingBytes = 64 << 10
	}
	return New("TEST", "", cfg, hooks)
}

func TestJoinBroadcastAndTargeted(t *testing.T) {
	r := testRoom(t, Config{}, Hooks{})
	defer r.Shutdown()

	a, b, c := &fakePeer{}, &fakePeer{}, &fakePeer{}
	var sidA, sidB, sidC [16]byte
	sidA[0], sidB[0], sidC[0] = 1, 2, 3

	if _, code := r.Join(a, sidA, []byte("A"), nil, true); code != protocol.ErrNone {
		t.Fatalf("join a: %v", code)
	}
	if got := a.wait(t, protocol.OpCreated, 1); len(got) != 1 {
		t.Fatalf("created frames = %d", len(got))
	}
	if _, code := r.Join(b, sidB, []byte("B"), nil, false); code != protocol.ErrNone {
		t.Fatalf("join b: %v", code)
	}
	if _, code := r.Join(c, sidC, []byte("C"), nil, false); code != protocol.ErrNone {
		t.Fatalf("join c: %v", code)
	}
	a.wait(t, protocol.OpPeerJoin, 2)

	if code := r.Relay(b, 2, nil, []byte("hello")); code != protocol.ErrNone {
		t.Fatalf("relay: %v", code)
	}
	got := a.wait(t, protocol.OpRelayS2C, 1)
	from, seq, payload := decodeRelay(t, got[0])
	if from != 2 || seq != 1 || payload != "hello" {
		t.Fatalf("relay = from %d seq %d payload %q", from, seq, payload)
	}
	if len(b.of(protocol.OpRelayS2C)) != 0 {
		t.Fatal("sender should not receive its own broadcast")
	}
	c.wait(t, protocol.OpRelayS2C, 1)

	// 定向：只发给 1 号
	if code := r.Relay(c, 3, []uint16{1}, []byte("secret")); code != protocol.ErrNone {
		t.Fatalf("relay targeted: %v", code)
	}
	got = a.wait(t, protocol.OpRelayS2C, 2)
	_, seq, payload = decodeRelay(t, got[1])
	if seq != 2 || payload != "secret" {
		t.Fatalf("targeted relay = seq %d payload %q", seq, payload)
	}
	if len(b.of(protocol.OpRelayS2C)) != 0 {
		t.Fatal("b should not receive c's targeted message")
	}
}

func TestTargetValidation(t *testing.T) {
	r := testRoom(t, Config{}, Hooks{})
	defer r.Shutdown()
	a, b := &fakePeer{}, &fakePeer{}
	var sa, sb [16]byte
	sa[0], sb[0] = 1, 2
	r.Join(a, sa, nil, nil, true)
	r.Join(b, sb, nil, nil, false)

	if code := r.Relay(a, 1, []uint16{99}, []byte("x")); code != protocol.ErrBadTarget {
		t.Fatalf("want BAD_TARGET, got %v", code)
	}
}

func TestHostTransferAndLeave(t *testing.T) {
	r := testRoom(t, Config{}, Hooks{})
	defer r.Shutdown()
	a, b := &fakePeer{}, &fakePeer{}
	var sa, sb [16]byte
	sa[0], sb[0] = 1, 2
	r.Join(a, sa, nil, nil, true)
	r.Join(b, sb, nil, nil, false)

	r.Leave(a, 1)
	b.wait(t, protocol.OpPeerLeave, 1)
	host := b.wait(t, protocol.OpHost, 1)
	if host[0][8] != 2 {
		t.Fatalf("host should transfer to slot 2, frame=%x", host[0])
	}

	// 房主转移后可以 lock
	if code := r.Lock(2, true); code != protocol.ErrNone {
		t.Fatalf("lock: %v", code)
	}
	c := &fakePeer{}
	var sc [16]byte
	sc[0] = 3
	if _, code := r.Join(c, sc, nil, nil, false); code != protocol.ErrRoomLocked {
		t.Fatalf("want ROOM_LOCKED, got %v", code)
	}
	if code := r.Lock(2, false); code != protocol.ErrNone {
		t.Fatalf("unlock: %v", code)
	}
	if _, code := r.Join(c, sc, nil, nil, false); code != protocol.ErrNone {
		t.Fatalf("join after unlock: %v", code)
	}
}

func TestReconnectReplay(t *testing.T) {
	r := testRoom(t, Config{GraceTimeout: 2 * time.Second}, Hooks{})
	defer r.Shutdown()
	a, b := &fakePeer{}, &fakePeer{}
	var sa, sb [16]byte
	sa[0], sb[0] = 1, 2
	r.Join(a, sa, nil, nil, true)
	r.Join(b, sb, nil, nil, false)

	// seq 1 在线时发出，b 能收到
	r.Relay(a, 1, nil, []byte("one"))
	b.wait(t, protocol.OpRelayS2C, 1)

	// b 断线：其他人收到 PEER_OFFLINE（不是 PEER_LEAVE）
	r.Drop(b, 2)
	a.wait(t, protocol.OpPeerOffline, 1)

	// 断线期间 a 继续发：seq 2/3 不会投递给 b，但要进重放缓冲
	r.Relay(a, 1, nil, []byte("two"))
	r.Relay(a, 1, nil, []byte("three"))

	b2 := &fakePeer{}
	slot, code := r.Resume(b2, sb, 1)
	if code != protocol.ErrNone || slot != 2 {
		t.Fatalf("resume: slot=%d code=%v", slot, code)
	}
	rec := b2.wait(t, protocol.OpReconnected, 1)
	if len(rec) != 1 {
		t.Fatal("expected one RECONNECTED")
	}
	relays := b2.wait(t, protocol.OpRelayS2C, 2)
	if from, seq, payload := decodeRelay(t, relays[0]); from != 1 || seq != 2 || payload != "two" {
		t.Fatalf("replay[0] = %d/%d/%q", from, seq, payload)
	}
	if _, seq, payload := decodeRelay(t, relays[1]); seq != 3 || payload != "three" {
		t.Fatalf("replay[1] = %d/%q", seq, payload)
	}
	a.wait(t, protocol.OpPeerRejoin, 1)
}

func TestReconnectGapSendsResync(t *testing.T) {
	r := testRoom(t, Config{GraceTimeout: 2 * time.Second, RingBytes: 60}, Hooks{})
	defer r.Shutdown()
	a, b := &fakePeer{}, &fakePeer{}
	var sa, sb [16]byte
	sa[0], sb[0] = 1, 2
	r.Join(a, sa, nil, nil, true)
	r.Join(b, sb, nil, nil, false)
	r.Drop(b, 2)
	for i := 0; i < 10; i++ {
		r.Relay(a, 1, nil, []byte("0123456789"))
	}
	b2 := &fakePeer{}
	if _, code := r.Resume(b2, sb, 0); code != protocol.ErrNone {
		t.Fatalf("resume: %v", code)
	}
	b2.wait(t, protocol.OpReconnected, 1)
	b2.wait(t, protocol.OpResync, 1)
	if n := len(b2.of(protocol.OpRelayS2C)); n != 0 {
		t.Fatalf("expected no replay when gap, got %d", n)
	}
}

func TestGraceTimeoutDestroy(t *testing.T) {
	destroyed := make(chan string, 1)
	r := testRoom(t, Config{GraceTimeout: 30 * time.Millisecond}, Hooks{
		Destroy: func(code string) { destroyed <- code },
	})
	a := &fakePeer{}
	var sa [16]byte
	sa[0] = 1
	r.Join(a, sa, nil, nil, true)
	r.Drop(a, 1)

	select {
	case code := <-destroyed:
		if code != "TEST" {
			t.Fatalf("destroyed code = %q", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("room not destroyed after grace timeout")
	}
	select {
	case <-r.Done():
	case <-time.After(time.Second):
		t.Fatal("done not closed")
	}
}

func TestKick(t *testing.T) {
	r := testRoom(t, Config{}, Hooks{})
	defer r.Shutdown()
	a, b := &fakePeer{}, &fakePeer{}
	var sa, sb [16]byte
	sa[0], sb[0] = 1, 2
	r.Join(a, sa, nil, nil, true)
	r.Join(b, sb, nil, nil, false)

	if code := r.Kick(2, 1); code != protocol.ErrNotHost {
		t.Fatalf("want NOT_HOST, got %v", code)
	}
	if code := r.Kick(1, 2); code != protocol.ErrNone {
		t.Fatalf("kick: %v", code)
	}
	b.wait(t, protocol.OpKicked, 1)
	if b.closed != 4002 {
		t.Fatalf("kicked peer close code = %d", b.closed)
	}
	// 被踢后不能再用原 sid 恢复
	if _, code := r.Resume(b, sb, 0); code != protocol.ErrRoomNotFound {
		t.Fatalf("resume kicked: want ROOM_NOT_FOUND, got %v", code)
	}
}

func TestFullRoom(t *testing.T) {
	r := testRoom(t, Config{MaxMembers: 2}, Hooks{})
	defer r.Shutdown()
	var sids [3][16]byte
	peers := [3]*fakePeer{{}, {}, {}}
	for i := 0; i < 2; i++ {
		sids[i][0] = byte(i + 1)
		if _, code := r.Join(peers[i], sids[i], nil, nil, i == 0); code != protocol.ErrNone {
			t.Fatalf("join %d: %v", i, code)
		}
	}
	sids[2][0] = 9
	if _, code := r.Join(peers[2], sids[2], nil, nil, false); code != protocol.ErrRoomFull {
		t.Fatalf("want ROOM_FULL, got %v", code)
	}
}
