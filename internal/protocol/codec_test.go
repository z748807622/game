package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type vector struct {
	Name string `json:"name"`
	Op   int    `json:"op"`
	Hex  string `json:"hex"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return vs
}

func sid16() []byte {
	b := make([]byte, 16)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

func TestGoldenVectors(t *testing.T) {
	encoders := map[string]func() []byte{
		"ping_s2c": func() []byte { return EncodePing(0x0011223344556677) },
		"pong_s2c": func() []byte { return EncodePong(0x0011223344556688) },
		"relay_s2c": func() []byte {
			return EncodeRelayS2C(2, 1, []byte("hi"))
		},
		"hello": func() []byte {
			w := NewWriter(OpHello)
			w.U8(1)
			w.U8(0)
			w.Len16([]byte("ab"))
			return w.Frame()
		},
		"hello_resume": func() []byte {
			w := NewWriter(OpHello)
			w.U8(1)
			w.U8(1)
			w.Len16([]byte("t"))
			w.Len8(sid16())
			w.U32(0x1234)
			return w.Frame()
		},
		"relay_c2s": func() []byte {
			w := NewWriter(OpRelay)
			w.U8(2)
			w.U16(2)
			w.U16(5)
			w.Raw([]byte("x"))
			return w.Frame()
		},
		"joined": func() []byte {
			return EncodeJoined("K7QF", 2, 1, 0x10, []Member{
				{Slot: 1, Online: true, Meta: []byte("m1")},
				{Slot: 2, Online: true, Meta: nil},
			})
		},
		"error": func() []byte { return EncodeError(ErrRoomNotFound, "nf") },
		"ready": func() []byte { return EncodeReady(sid16(), false) },
	}

	vs := loadVectors(t)
	if len(vs) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vs {
		enc, ok := encoders[v.Name]
		if !ok {
			continue
		}
		got := enc()
		if want := mustDecodeHex(t, v.Hex); string(got) != string(want) {
			t.Errorf("%s:\n got %s\nwant %s", v.Name, hex.EncodeToString(got), v.Hex)
		}
		f, err := ParseFrame(got)
		if err != nil {
			t.Fatalf("%s: ParseFrame: %v", v.Name, err)
		}
		if int(f.Op) != v.Op {
			t.Errorf("%s: op = %d, want %d", v.Name, f.Op, v.Op)
		}
		if len(f.Body) == 0 {
			t.Errorf("%s: empty body", v.Name)
		}
	}
}

func TestDecodeHelloResume(t *testing.T) {
	w := NewWriter(OpHello)
	w.U8(1)
	w.U8(1)
	w.Len16([]byte("tok"))
	w.Len8(sid16())
	w.U32(0xDEADBEEF)
	f, err := ParseFrame(w.Frame())
	if err != nil {
		t.Fatal(err)
	}
	h, err := DecodeHello(f)
	if err != nil {
		t.Fatal(err)
	}
	if !h.Resume() || len(h.SID) != 16 || h.LastSeq != 0xDEADBEEF || string(h.Token) != "tok" {
		t.Fatalf("unexpected hello: %+v", h)
	}
}

func TestParseFrameRejects(t *testing.T) {
	good := EncodePing(1)
	cases := map[string]func([]byte) []byte{
		"short": func(b []byte) []byte { return b[:5] },
		"len_mismatch": func(b []byte) []byte {
			c := append([]byte(nil), b...)
			c[0]++
			return c
		},
		"bad_version": func(b []byte) []byte {
			c := append([]byte(nil), b...)
			c[4] = 9
			return c
		},
		"bad_flags": func(b []byte) []byte {
			c := append([]byte(nil), b...)
			c[6] = 1
			return c
		},
		"bad_rsv": func(b []byte) []byte {
			c := append([]byte(nil), b...)
			c[7] = 1
			return c
		},
	}
	for name, mutate := range cases {
		if _, err := ParseFrame(mutate(good)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := ParseFrame(good); err != nil {
		t.Errorf("good frame rejected: %v", err)
	}
}

func TestDecodeJoinRejectsBadCode(t *testing.T) {
	w := NewWriter(OpJoin)
	w.Len8([]byte("K7Q")) // 只有 3 位
	w.Len8(nil)
	w.Len16(nil)
	f, _ := ParseFrame(w.Frame())
	if _, err := DecodeJoin(f); err == nil {
		t.Fatal("expected error for bad code")
	}
}

func TestDecodeRelayTargets(t *testing.T) {
	w := NewWriter(OpRelay)
	w.U8(2)
	w.U16(3)
	w.U16(7)
	w.Raw([]byte("payload"))
	f, _ := ParseFrame(w.Frame())
	r, err := DecodeRelay(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Targets) != 2 || r.Targets[0] != 3 || r.Targets[1] != 7 || string(r.Payload) != "payload" {
		t.Fatalf("unexpected relay: %+v", r)
	}
}

func mustDecodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// TestClientVectors 验证 C→S 方向的字节布局（这些帧由客户端编码、服务端解码）。
func TestClientVectors(t *testing.T) {
	byName := map[string]string{}
	for _, v := range loadVectors(t) {
		byName[v.Name] = v.Hex
	}
	frameOf := func(name string) Frame {
		t.Helper()
		f, err := ParseFrame(mustDecodeHex(t, byName[name]))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return f
	}

	c, err := DecodeCreate(frameOf("create"))
	if err != nil || string(c.Meta) != "m1" || string(c.Pwd) != "pw" {
		t.Fatalf("create = %+v, err %v", c, err)
	}
	j, err := DecodeJoin(frameOf("join"))
	if err != nil || j.Code != "K7QF" || len(j.Pwd) != 0 || string(j.Meta) != "bob" {
		t.Fatalf("join = %+v, err %v", j, err)
	}
	if f := frameOf("leave"); len(f.Body) != 0 {
		t.Fatalf("leave body = %d", len(f.Body))
	}
	if v, err := DecodeLock(frameOf("lock")); err != nil || !v {
		t.Fatalf("lock = %v, err %v", v, err)
	}
	if slot, err := DecodeKick(frameOf("kick")); err != nil || slot != 3 {
		t.Fatalf("kick = %d, err %v", slot, err)
	}
	if f := frameOf("ping_c2s"); len(f.Body) != 8 {
		t.Fatalf("ping body = %d", len(f.Body))
	}
	if f := frameOf("pong_c2s"); len(f.Body) != 8 {
		t.Fatalf("pong body = %d", len(f.Body))
	}
}
