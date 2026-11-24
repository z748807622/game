// Package room 实现房间 actor：成员表、序号、重放环形缓冲与宽限期。
//
// 所有可变状态只由 run() 所在协程访问，外部通过 inbox 投递事件，
// 因此房间内部不需要任何锁。
package room

import (
	"sort"
	"sync"
	"time"

	"relay/internal/protocol"
)

// Peer 是房间投递的目标。实现方保证 Send 不阻塞。
type Peer interface {
	Send(frame []byte) bool
	Close(code int, reason string)
}

type Config struct {
	MaxMembers   int
	GraceTimeout time.Duration
	RingBytes    int
	InboxSize    int
}

type Hooks struct {
	Bind    func(sid [16]byte, code string, slot uint16)
	Unbind  func(sid [16]byte)
	Destroy func(code string)
}

const opTimeout = 5 * time.Second

type member struct {
	slot   uint16
	sid    [16]byte
	meta   []byte
	peer   Peer
	online bool
	grace  *time.Timer
}

// Room 是一个房间。Code 在创建后不再变化。
type Room struct {
	Code     string
	password string
	cfg      Config
	hooks    Hooks

	inbox chan any
	done  chan struct{}
	once  sync.Once

	closed   bool
	host     uint16
	nextSlot uint32
	seq      uint32
	locked   bool
	members  map[uint16]*member
	ring     *ring
}

func New(code, password string, cfg Config, hooks Hooks) *Room {
	if cfg.MaxMembers <= 0 {
		cfg.MaxMembers = 16
	}
	if cfg.GraceTimeout <= 0 {
		cfg.GraceTimeout = 60 * time.Second
	}
	if cfg.RingBytes <= 0 {
		cfg.RingBytes = 64 << 10
	}
	if cfg.InboxSize <= 0 {
		cfg.InboxSize = 1024
	}
	r := &Room{
		Code:     code,
		password: password,
		cfg:      cfg,
		hooks:    hooks,
		inbox:    make(chan any, cfg.InboxSize),
		done:     make(chan struct{}),
		members:  make(map[uint16]*member, cfg.MaxMembers),
		ring:     &ring{budget: cfg.RingBytes},
	}
	go r.run()
	return r
}

// Done 在房间销毁后关闭。
func (r *Room) Done() <-chan struct{} { return r.done }

// ---------------------------------------------------------------- 事件

type joinReq struct {
	peer    Peer
	sid     [16]byte
	meta    []byte
	pwd     []byte
	created bool
	reply   chan joinResult
}

type joinResult struct {
	slot uint16
	code protocol.ErrCode
}

type resumeReq struct {
	peer    Peer
	sid     [16]byte
	lastSeq uint32
	reply   chan resumeResult
}

type resumeResult struct {
	slot uint16
	code protocol.ErrCode
}

type relayReq struct {
	peer    Peer
	slot    uint16
	targets []uint16
	payload []byte
	reply   chan protocol.ErrCode
}

type leaveReq struct {
	peer Peer
	slot uint16
}

type dropReq struct {
	peer Peer
	slot uint16
}

type graceExpired struct {
	slot uint16
	sid  [16]byte
}

type lockReq struct {
	by    uint16
	value bool
	reply chan protocol.ErrCode
}

type kickReq struct {
	by     uint16
	target uint16
	reply  chan protocol.ErrCode
}

type shutdownReq struct{}

// ---------------------------------------------------------------- 对外 API

func (r *Room) Join(p Peer, sid [16]byte, meta, pwd []byte, created bool) (uint16, protocol.ErrCode) {
	reply := make(chan joinResult, 1)
	if !r.post(joinReq{peer: p, sid: sid, meta: meta, pwd: pwd, created: created, reply: reply}) {
		return 0, protocol.ErrRoomNotFound
	}
	select {
	case res := <-reply:
		return res.slot, res.code
	case <-r.done:
		return 0, protocol.ErrRoomNotFound
	case <-time.After(opTimeout):
		return 0, protocol.ErrInternal
	}
}

func (r *Room) Resume(p Peer, sid [16]byte, lastSeq uint32) (uint16, protocol.ErrCode) {
	reply := make(chan resumeResult, 1)
	if !r.post(resumeReq{peer: p, sid: sid, lastSeq: lastSeq, reply: reply}) {
		return 0, protocol.ErrRoomNotFound
	}
	select {
	case res := <-reply:
		return res.slot, res.code
	case <-r.done:
		return 0, protocol.ErrRoomNotFound
	case <-time.After(opTimeout):
		return 0, protocol.ErrInternal
	}
}

func (r *Room) Relay(p Peer, slot uint16, targets []uint16, payload []byte) protocol.ErrCode {
	reply := make(chan protocol.ErrCode, 1)
	if !r.post(relayReq{peer: p, slot: slot, targets: targets, payload: payload, reply: reply}) {
		return protocol.ErrRoomNotFound
	}
	select {
	case code := <-reply:
		return code
	case <-r.done:
		return protocol.ErrRoomNotFound
	case <-time.After(opTimeout):
		return protocol.ErrInternal
	}
}

func (r *Room) Leave(p Peer, slot uint16) { r.post(leaveReq{peer: p, slot: slot}) }

func (r *Room) Drop(p Peer, slot uint16) { r.post(dropReq{peer: p, slot: slot}) }

func (r *Room) Lock(by uint16, value bool) protocol.ErrCode {
	reply := make(chan protocol.ErrCode, 1)
	if !r.post(lockReq{by: by, value: value, reply: reply}) {
		return protocol.ErrRoomNotFound
	}
	select {
	case code := <-reply:
		return code
	case <-r.done:
		return protocol.ErrRoomNotFound
	case <-time.After(opTimeout):
		return protocol.ErrInternal
	}
}

func (r *Room) Kick(by, target uint16) protocol.ErrCode {
	reply := make(chan protocol.ErrCode, 1)
	if !r.post(kickReq{by: by, target: target, reply: reply}) {
		return protocol.ErrRoomNotFound
	}
	select {
	case code := <-reply:
		return code
	case <-r.done:
		return protocol.ErrRoomNotFound
	case <-time.After(opTimeout):
		return protocol.ErrInternal
	}
}

// Shutdown 销毁房间（用于建好后加入失败、或进程退出）。
func (r *Room) Shutdown() { r.post(shutdownReq{}) }

// ---------------------------------------------------------------- actor

func (r *Room) post(ev any) bool {
	select {
	case <-r.done:
		return false
	default:
	}
	select {
	case r.inbox <- ev:
		return true
	case <-r.done:
		return false
	}
}

func (r *Room) run() {
	for {
		select {
		case <-r.done:
			return
		case ev := <-r.inbox:
			r.handle(ev)
		}
	}
}

func (r *Room) handle(ev any) {
	switch e := ev.(type) {
	case joinReq:
		r.handleJoin(e)
	case resumeReq:
		r.handleResume(e)
	case relayReq:
		r.handleRelay(e)
	case leaveReq:
		r.handleLeave(e)
	case dropReq:
		r.handleDrop(e)
	case graceExpired:
		r.handleGraceExpired(e)
	case lockReq:
		r.handleLock(e)
	case kickReq:
		r.handleKick(e)
	case shutdownReq:
		r.destroy()
	}
}

func (r *Room) snapshot() []protocol.Member {
	out := make([]protocol.Member, 0, len(r.members))
	for _, m := range r.members {
		out = append(out, protocol.Member{Slot: m.slot, Online: m.online, Meta: m.meta})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}

func (r *Room) broadcast(frame []byte, exclude uint16) {
	for slot, m := range r.members {
		if slot == exclude || !m.online || m.peer == nil {
			continue
		}
		m.peer.Send(frame)
	}
}

func (r *Room) handleJoin(ev joinReq) {
	if r.closed {
		ev.reply <- joinResult{code: protocol.ErrRoomNotFound}
		return
	}
	switch {
	case r.locked:
		ev.reply <- joinResult{code: protocol.ErrRoomLocked}
		return
	case len(r.members) >= r.cfg.MaxMembers:
		ev.reply <- joinResult{code: protocol.ErrRoomFull}
		return
	case r.password != "" && string(ev.pwd) != r.password:
		ev.reply <- joinResult{code: protocol.ErrBadPassword}
		return
	case r.nextSlot > 0xFFFF:
		ev.reply <- joinResult{code: protocol.ErrRoomFull}
		return
	}

	slot := uint16(r.nextSlot)
	if slot == 0 {
		slot = 1
	}
	r.nextSlot = uint32(slot) + 1
	m := &member{slot: slot, sid: ev.sid, meta: ev.meta, peer: ev.peer, online: true}
	r.members[slot] = m
	if r.host == 0 {
		r.host = slot
	}
	if r.hooks.Bind != nil {
		r.hooks.Bind(ev.sid, r.Code, slot)
	}

	snap := r.snapshot()
	var frame []byte
	if ev.created {
		frame = protocol.EncodeCreated(r.Code, slot, r.host, r.seq, snap)
	} else {
		frame = protocol.EncodeJoined(r.Code, slot, r.host, r.seq, snap)
	}
	ev.peer.Send(frame)
	ev.reply <- joinResult{slot: slot}
	r.broadcast(protocol.EncodePeerJoin(slot, m.meta), slot)
}

func (r *Room) handleResume(ev resumeReq) {
	if r.closed {
		ev.reply <- resumeResult{code: protocol.ErrRoomNotFound}
		return
	}
	var m *member
	for _, cand := range r.members {
		if cand.sid == ev.sid {
			m = cand
			break
		}
	}
	if m == nil {
		ev.reply <- resumeResult{code: protocol.ErrRoomNotFound}
		return
	}
	if m.grace != nil {
		m.grace.Stop()
		m.grace = nil
	}
	if m.online && m.peer != nil && m.peer != ev.peer {
		// 旧连接半开：踢掉它，新连接接管。旧连接随后的 Drop 会因 peer 不匹配被忽略。
		m.peer.Close(4004, "replaced")
	}
	m.online = true
	m.peer = ev.peer

	frames, gap := r.missed(m.slot, ev.lastSeq)
	snap := r.snapshot()
	ev.peer.Send(protocol.EncodeReconnected(r.Code, m.slot, r.host, r.seq, snap, uint16(len(frames))))
	if gap {
		ev.peer.Send(protocol.EncodeResync(r.seq, protocol.ResyncGap))
	} else {
		for _, f := range frames {
			ev.peer.Send(f)
		}
	}
	ev.reply <- resumeResult{slot: m.slot}
	r.broadcast(protocol.EncodePeerRejoin(m.slot), m.slot)
}

func (r *Room) missed(slot uint16, lastSeq uint32) ([][]byte, bool) {
	if r.seq == 0 || lastSeq >= r.seq {
		return nil, false
	}
	minSeq := r.ring.minSeq()
	if lastSeq == 0 || lastSeq+1 < minSeq {
		return nil, true
	}
	return r.ring.after(slot, lastSeq), false
}

func (r *Room) handleRelay(ev relayReq) {
	m := r.members[ev.slot]
	if m == nil || m.peer != ev.peer {
		ev.reply <- protocol.ErrNotJoined
		return
	}

	var targets []uint16
	if len(ev.targets) == 0 {
		targets = make([]uint16, 0, len(r.members)-1)
		for slot := range r.members {
			if slot != ev.slot {
				targets = append(targets, slot)
			}
		}
		sort.Slice(targets, func(i, j int) bool { return targets[i] < targets[j] })
	} else {
		seen := make(map[uint16]struct{}, len(ev.targets))
		targets = make([]uint16, 0, len(ev.targets))
		for _, t := range ev.targets {
			if _, ok := r.members[t]; !ok {
				ev.reply <- protocol.ErrBadTarget
				return
			}
			if _, dup := seen[t]; dup {
				continue
			}
			seen[t] = struct{}{}
			targets = append(targets, t)
		}
	}

	r.seq++
	frame := protocol.EncodeRelayS2C(ev.slot, r.seq, ev.payload)
	r.ring.add(r.seq, ev.slot, targets, frame)
	for _, t := range targets {
		if dst := r.members[t]; dst != nil && dst.online && dst.peer != nil {
			dst.peer.Send(frame)
		}
	}
	ev.reply <- protocol.ErrNone
}

func (r *Room) handleLeave(ev leaveReq) {
	m := r.members[ev.slot]
	if m == nil || m.peer != ev.peer {
		return
	}
	r.removeMember(ev.slot, protocol.ReasonLeft)
}

func (r *Room) handleDrop(ev dropReq) {
	m := r.members[ev.slot]
	if m == nil || m.peer != ev.peer {
		return
	}
	m.online = false
	m.peer = nil
	r.broadcast(protocol.EncodePeerOffline(ev.slot), ev.slot)
	slot, sid := ev.slot, m.sid
	m.grace = time.AfterFunc(r.cfg.GraceTimeout, func() {
		r.post(graceExpired{slot: slot, sid: sid})
	})
}

func (r *Room) handleGraceExpired(ev graceExpired) {
	m := r.members[ev.slot]
	if m == nil || m.online || m.sid != ev.sid {
		return
	}
	r.removeMember(ev.slot, protocol.ReasonTimeout)
}

func (r *Room) handleLock(ev lockReq) {
	if r.host != ev.by {
		ev.reply <- protocol.ErrNotHost
		return
	}
	r.locked = ev.value
	ev.reply <- protocol.ErrNone
}

func (r *Room) handleKick(ev kickReq) {
	if r.host != ev.by {
		ev.reply <- protocol.ErrNotHost
		return
	}
	m := r.members[ev.target]
	if m == nil || ev.target == ev.by {
		ev.reply <- protocol.ErrBadTarget
		return
	}
	if m.peer != nil {
		m.peer.Send(protocol.EncodeKicked())
		m.peer.Close(4002, "kicked")
	}
	r.removeMember(ev.target, protocol.ReasonKicked)
	ev.reply <- protocol.ErrNone
}

func (r *Room) removeMember(slot uint16, reason uint8) {
	m := r.members[slot]
	if m == nil {
		return
	}
	delete(r.members, slot)
	if m.grace != nil {
		m.grace.Stop()
		m.grace = nil
	}
	if r.hooks.Unbind != nil {
		r.hooks.Unbind(m.sid)
	}
	r.broadcast(protocol.EncodePeerLeave(slot, reason), 0)
	if r.host == slot {
		r.transferHost()
	}
	if len(r.members) == 0 {
		r.destroy()
	}
}

func (r *Room) transferHost() {
	var best uint16
	for slot, m := range r.members {
		if !m.online {
			continue
		}
		if best == 0 || slot < best {
			best = slot
		}
	}
	if best == 0 {
		for slot := range r.members {
			if best == 0 || slot < best {
				best = slot
			}
		}
	}
	r.host = best
	if best != 0 {
		r.broadcast(protocol.EncodeHost(best), 0)
	}
}

func (r *Room) destroy() {
	if r.closed {
		return
	}
	r.closed = true
	r.once.Do(func() { close(r.done) })
	for _, m := range r.members {
		if m.grace != nil {
			m.grace.Stop()
		}
		if r.hooks.Unbind != nil {
			r.hooks.Unbind(m.sid)
		}
		if m.peer != nil {
			m.peer.Close(4004, "room closed")
		}
	}
	r.members = nil
	if r.hooks.Destroy != nil {
		r.hooks.Destroy(r.Code)
	}
}

// ---------------------------------------------------------------- 重放环形缓冲

type ringEntry struct {
	seq     uint32
	from    uint16
	n       uint8
	targets [protocol.MaxTargets]uint16
	frame   []byte
}

type ring struct {
	budget  int
	bytes   int
	entries []ringEntry
}

func (g *ring) add(seq uint32, from uint16, targets []uint16, frame []byte) {
	var e ringEntry
	e.seq = seq
	e.from = from
	e.n = uint8(len(targets))
	copy(e.targets[:], targets)
	e.frame = frame
	g.entries = append(g.entries, e)
	g.bytes += len(frame)
	for g.bytes > g.budget && len(g.entries) > 1 {
		g.bytes -= len(g.entries[0].frame)
		g.entries = g.entries[1:]
	}
}

func (g *ring) minSeq() uint32 {
	if len(g.entries) == 0 {
		return 0
	}
	return g.entries[0].seq
}

func (g *ring) after(slot uint16, lastSeq uint32) [][]byte {
	var out [][]byte
	for i := range g.entries {
		e := &g.entries[i]
		if e.seq <= lastSeq || !e.wants(slot) {
			continue
		}
		out = append(out, e.frame)
	}
	return out
}

func (e *ringEntry) wants(slot uint16) bool {
	for i := 0; i < int(e.n); i++ {
		if e.targets[i] == slot {
			return true
		}
	}
	return false
}
