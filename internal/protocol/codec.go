package protocol

import (
	"encoding/binary"
	"errors"
)

var (
	ErrShort   = errors.New("protocol: short")
	ErrLength  = errors.New("protocol: bad length")
	ErrVersion = errors.New("protocol: bad version")
	ErrFlags   = errors.New("protocol: bad flags")
	ErrBody    = errors.New("protocol: malformed body")
)

const (
	maxMeta  = 512
	maxPwd   = 32
	maxToken = 1024
)

// Frame 是解析后的一帧。Body 指向原始读缓冲，生命周期由调用方保证。
type Frame struct {
	Op    Op
	Flags uint8
	Body  []byte
}

// ParseFrame 只做头部校验，不解析 body。
func ParseFrame(b []byte) (Frame, error) {
	if len(b) < HeaderLen {
		return Frame{}, ErrShort
	}
	n := int(binary.LittleEndian.Uint32(b[0:4]))
	if n < 4 {
		return Frame{}, ErrLength
	}
	if len(b) > MaxFrame {
		return Frame{}, ErrLength
	}
	if n+4 != len(b) {
		return Frame{}, ErrLength
	}
	if b[4] != Version {
		return Frame{}, ErrVersion
	}
	if b[6] != 0 {
		return Frame{}, ErrFlags
	}
	if b[7] != 0 {
		return Frame{}, ErrFlags
	}
	return Frame{Op: Op(b[5]), Flags: b[6], Body: b[HeaderLen:]}, nil
}

// ---------------------------------------------------------------- writer

// Writer 顺序拼接 body，Frame 时回填长度。
type Writer struct {
	b  []byte
	op Op
}

func NewWriter(op Op) *Writer {
	return &Writer{b: make([]byte, HeaderLen, 128), op: op}
}

func (w *Writer) U8(v uint8) { w.b = append(w.b, v) }

func (w *Writer) U16(v uint16) {
	w.b = append(w.b, byte(v), byte(v>>8))
}

func (w *Writer) U32(v uint32) {
	w.b = append(w.b, byte(v), byte(v>>8), byte(v>>16), byte(v>>24))
}

func (w *Writer) U64(v uint64) {
	w.b = append(w.b,
		byte(v), byte(v>>8), byte(v>>16), byte(v>>24),
		byte(v>>32), byte(v>>40), byte(v>>48), byte(v>>56))
}

func (w *Writer) Raw(p []byte) { w.b = append(w.b, p...) }

// Len8 写入 u8 长度前缀 + 内容。
func (w *Writer) Len8(p []byte) {
	if len(p) > 0xFF {
		p = p[:0xFF]
	}
	w.U8(uint8(len(p)))
	w.Raw(p)
}

// Len16 写入 u16 长度前缀 + 内容。
func (w *Writer) Len16(p []byte) {
	if len(p) > 0xFFFF {
		p = p[:0xFFFF]
	}
	w.U16(uint16(len(p)))
	w.Raw(p)
}

// Frame 回填头部并返回完整帧。
func (w *Writer) Frame() []byte {
	binary.LittleEndian.PutUint32(w.b[0:4], uint32(len(w.b)-4))
	w.b[4] = Version
	w.b[5] = byte(w.op)
	w.b[6] = 0
	w.b[7] = 0
	return w.b
}

// ---------------------------------------------------------------- reader

// Reader 顺序读取 body，首个错误后所有读取返回零值。
type Reader struct {
	b   []byte
	i   int
	err error
}

func NewReader(b []byte) *Reader { return &Reader{b: b} }

func (r *Reader) fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

func (r *Reader) U8() uint8 {
	if r.err != nil {
		return 0
	}
	if r.i+1 > len(r.b) {
		r.fail(ErrBody)
		return 0
	}
	v := r.b[r.i]
	r.i++
	return v
}

func (r *Reader) U16() uint16 {
	if r.err != nil {
		return 0
	}
	if r.i+2 > len(r.b) {
		r.fail(ErrBody)
		return 0
	}
	v := binary.LittleEndian.Uint16(r.b[r.i:])
	r.i += 2
	return v
}

func (r *Reader) U32() uint32 {
	if r.err != nil {
		return 0
	}
	if r.i+4 > len(r.b) {
		r.fail(ErrBody)
		return 0
	}
	v := binary.LittleEndian.Uint32(r.b[r.i:])
	r.i += 4
	return v
}

func (r *Reader) U64() uint64 {
	if r.err != nil {
		return 0
	}
	if r.i+8 > len(r.b) {
		r.fail(ErrBody)
		return 0
	}
	v := binary.LittleEndian.Uint64(r.b[r.i:])
	r.i += 8
	return v
}

func (r *Reader) Bytes(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.i+n > len(r.b) {
		r.fail(ErrBody)
		return nil
	}
	v := r.b[r.i : r.i+n]
	r.i += n
	return v
}

func (r *Reader) Bytes8() []byte { return r.Bytes(int(r.U8())) }

func (r *Reader) Bytes16() []byte { return r.Bytes(int(r.U16())) }

func (r *Reader) Rest() []byte {
	if r.err != nil {
		return nil
	}
	v := r.b[r.i:]
	r.i = len(r.b)
	return v
}

func (r *Reader) Err() error { return r.err }

func (r *Reader) done() bool { return r.err == nil && r.i == len(r.b) }

// ---------------------------------------------------------------- 解码

type Hello struct {
	Proto   uint8
	Flags   uint8
	Token   []byte
	SID     []byte
	LastSeq uint32
}

func (h Hello) Resume() bool { return h.Flags&1 != 0 }

func DecodeHello(f Frame) (Hello, error) {
	r := NewReader(f.Body)
	h := Hello{Proto: r.U8(), Flags: r.U8()}
	h.Token = r.Bytes16()
	if h.Flags&1 != 0 {
		h.SID = r.Bytes8()
		h.LastSeq = r.U32()
	}
	if err := r.Err(); err != nil {
		return Hello{}, err
	}
	if !r.done() {
		return Hello{}, ErrBody
	}
	if h.Proto != Version {
		return Hello{}, ErrVersion
	}
	if h.Flags&^uint8(1) != 0 {
		return Hello{}, ErrBody
	}
	if len(h.Token) == 0 || len(h.Token) > maxToken {
		return Hello{}, ErrBody
	}
	if h.Resume() && len(h.SID) != 16 {
		return Hello{}, ErrBody
	}
	return h, nil
}

type Create struct {
	Meta []byte
	Pwd  []byte
}

func DecodeCreate(f Frame) (Create, error) {
	r := NewReader(f.Body)
	c := Create{Meta: r.Bytes16(), Pwd: r.Bytes8()}
	if err := r.Err(); err != nil {
		return Create{}, err
	}
	if !r.done() {
		return Create{}, ErrBody
	}
	if len(c.Meta) > maxMeta || len(c.Pwd) > maxPwd {
		return Create{}, ErrBody
	}
	return c, nil
}

type Join struct {
	Code string
	Pwd  []byte
	Meta []byte
}

func DecodeJoin(f Frame) (Join, error) {
	r := NewReader(f.Body)
	j := Join{
		Code: string(r.Bytes8()),
		Pwd:  r.Bytes8(),
		Meta: r.Bytes16(),
	}
	if err := r.Err(); err != nil {
		return Join{}, err
	}
	if !r.done() {
		return Join{}, ErrBody
	}
	if !ValidCode(j.Code) || len(j.Meta) > maxMeta || len(j.Pwd) > maxPwd {
		return Join{}, ErrBody
	}
	return j, nil
}

type Relay struct {
	Targets []uint16
	Payload []byte
}

func DecodeRelay(f Frame) (Relay, error) {
	r := NewReader(f.Body)
	n := int(r.U8())
	if n > MaxTargets {
		return Relay{}, ErrBody
	}
	var targets []uint16
	if n > 0 {
		targets = make([]uint16, n)
		for i := 0; i < n; i++ {
			targets[i] = r.U16()
		}
	}
	payload := r.Rest()
	if err := r.Err(); err != nil {
		return Relay{}, err
	}
	return Relay{Targets: targets, Payload: payload}, nil
}

func DecodeLock(f Frame) (bool, error) {
	r := NewReader(f.Body)
	v := r.U8() != 0
	if err := r.Err(); err != nil {
		return false, err
	}
	if !r.done() {
		return false, ErrBody
	}
	return v, nil
}

func DecodeKick(f Frame) (uint16, error) {
	r := NewReader(f.Body)
	slot := r.U16()
	if err := r.Err(); err != nil {
		return 0, err
	}
	if !r.done() {
		return 0, ErrBody
	}
	return slot, nil
}

// ---------------------------------------------------------------- 编码

// EncodeReady 下发会话 id 与协议版本。
func EncodeReady(sid []byte, resumed bool) []byte {
	w := NewWriter(OpReady)
	w.U8(Version)
	var flags uint8
	if resumed {
		flags |= 1
	}
	w.U8(flags)
	w.Len8(sid)
	return w.Frame()
}

func encodeRoomState(op Op, code string, slot, host uint16, seq uint32, members []Member, missed int) []byte {
	w := NewWriter(op)
	w.Len8([]byte(code))
	w.U16(slot)
	w.U16(host)
	w.U32(seq)
	w.U16(uint16(len(members)))
	for _, m := range members {
		w.U16(m.Slot)
		var f uint8
		if m.Online {
			f = 1
		}
		w.U8(f)
		w.Len16(m.Meta)
	}
	if missed >= 0 {
		w.U16(uint16(missed))
	}
	return w.Frame()
}

// EncodeCreated / EncodeJoined 共用布局。
func EncodeCreated(code string, slot, host uint16, seq uint32, members []Member) []byte {
	return encodeRoomState(OpCreated, code, slot, host, seq, members, -1)
}

func EncodeJoined(code string, slot, host uint16, seq uint32, members []Member) []byte {
	return encodeRoomState(OpJoined, code, slot, host, seq, members, -1)
}

func EncodeReconnected(code string, slot, host uint16, seq uint32, members []Member, missed uint16) []byte {
	return encodeRoomState(OpReconnected, code, slot, host, seq, members, int(missed))
}

func EncodePeerJoin(slot uint16, meta []byte) []byte {
	w := NewWriter(OpPeerJoin)
	w.U16(slot)
	w.Len16(meta)
	return w.Frame()
}

func EncodePeerLeave(slot uint16, reason uint8) []byte {
	w := NewWriter(OpPeerLeave)
	w.U16(slot)
	w.U8(reason)
	return w.Frame()
}

func EncodePeerOffline(slot uint16) []byte {
	w := NewWriter(OpPeerOffline)
	w.U16(slot)
	return w.Frame()
}

func EncodePeerRejoin(slot uint16) []byte {
	w := NewWriter(OpPeerRejoin)
	w.U16(slot)
	return w.Frame()
}

func EncodeHost(slot uint16) []byte {
	w := NewWriter(OpHost)
	w.U16(slot)
	return w.Frame()
}

// EncodeRelayS2C 是热路径，手工布局避免 Writer 开销：一次分配、一次拷贝。
func EncodeRelayS2C(from uint16, seq uint32, payload []byte) []byte {
	b := make([]byte, HeaderLen+6+len(payload))
	binary.LittleEndian.PutUint32(b[0:4], uint32(len(b)-4))
	b[4] = Version
	b[5] = byte(OpRelayS2C)
	binary.LittleEndian.PutUint16(b[8:10], from)
	binary.LittleEndian.PutUint32(b[10:14], seq)
	copy(b[14:], payload)
	return b
}

func EncodeResync(seq uint32, reason uint8) []byte {
	w := NewWriter(OpResync)
	w.U32(seq)
	w.U8(reason)
	return w.Frame()
}

func EncodeKicked() []byte {
	return NewWriter(OpKicked).Frame()
}

func EncodeError(code ErrCode, msg string) []byte {
	if len(msg) > 512 {
		msg = msg[:512]
	}
	w := NewWriter(OpError)
	w.U16(uint16(code))
	w.Len16([]byte(msg))
	return w.Frame()
}

func EncodePing(ts uint64) []byte {
	w := NewWriter(OpPingS2C)
	w.U64(ts)
	return w.Frame()
}

func EncodePong(ts uint64) []byte {
	w := NewWriter(OpPongS2C)
	w.U64(ts)
	return w.Frame()
}
