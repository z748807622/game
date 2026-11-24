// Package server 组装 WebSocket 接入、鉴权、分发与限流。
package server

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"relay/internal/protocol"
	"relay/internal/registry"
	"relay/internal/room"
	"relay/internal/session"
)

type Config struct {
	Addr           string
	MaxMembers     int
	MaxRooms       int
	GraceTimeout   time.Duration
	RingBytes      int
	SendQueueBytes int64
	PingInterval   time.Duration
	ReadTimeout    time.Duration
	HelloTimeout   time.Duration
	RateLimit      int // 每连接每秒最大入站帧数，0 表示不限
	CreatePerMin   int // 每 IP 每分钟建房数
}

func (c *Config) normalize() {
	if c.MaxMembers <= 0 {
		c.MaxMembers = 16
	}
	if c.MaxRooms <= 0 {
		c.MaxRooms = 10000
	}
	if c.GraceTimeout <= 0 {
		c.GraceTimeout = 60 * time.Second
	}
	if c.RingBytes <= 0 {
		c.RingBytes = 64 << 10
	}
	if c.SendQueueBytes <= 0 {
		c.SendQueueBytes = 256 << 10
	}
	if c.PingInterval <= 0 {
		c.PingInterval = 20 * time.Second
	}
	if c.ReadTimeout <= 0 {
		c.ReadTimeout = 60 * time.Second
	}
	if c.HelloTimeout <= 0 {
		c.HelloTimeout = 10 * time.Second
	}
	if c.RateLimit <= 0 {
		c.RateLimit = 200
	}
	if c.CreatePerMin <= 0 {
		c.CreatePerMin = 10
	}
}

// TokenVerifier 校验首帧携带的 token。生产环境应换成 HMAC/JWT 校验。
type TokenVerifier interface {
	Verify(token []byte) (string, error)
}

// DevVerifier 接受任何非空 token，仅用于本地开发。
type DevVerifier struct{}

func (DevVerifier) Verify(token []byte) (string, error) {
	if len(token) == 0 {
		return "", errors.New("empty token")
	}
	return string(token), nil
}

type Server struct {
	cfg      Config
	reg      *registry.Registry
	up       websocket.Upgrader
	verifier TokenVerifier
	ipLimit  *ipLimiter
	static   fs.FS

	mu     sync.Mutex
	conns  map[*session.Conn]struct{}
	closed bool
}

func New(cfg Config, static fs.FS) *Server {
	cfg.normalize()
	s := &Server{
		cfg: cfg,
		reg: registry.New(cfg.MaxRooms, room.Config{
			MaxMembers:   cfg.MaxMembers,
			GraceTimeout: cfg.GraceTimeout,
			RingBytes:    cfg.RingBytes,
		}),
		up: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     func(*http.Request) bool { return true },
		},
		verifier: DevVerifier{},
		ipLimit:  newIPLimiter(float64(cfg.CreatePerMin)/60.0, 3),
		static:   static,
		conns:    make(map[*session.Conn]struct{}),
	}
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"rooms":%d}`, s.reg.RoomCount())
	})
	if s.static != nil {
		mux.Handle("/", http.FileServer(http.FS(s.static)))
	}
	return mux
}

// Shutdown 通知所有连接服务端退出。
func (s *Server) Shutdown() {
	s.mu.Lock()
	s.closed = true
	conns := make([]*session.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.Close(4005, "server shutdown")
	}
}

func (s *Server) track(c *session.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.conns[c] = struct{}{}
	return true
}

func (s *Server) untrack(c *session.Conn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("upgrade failed", "err", err, "remote", r.RemoteAddr)
		return
	}
	c := session.New(ws, s.cfg.SendQueueBytes)
	go c.WriteLoop()
	if !s.track(c) {
		c.Close(4005, "server shutdown")
		return
	}
	defer s.untrack(c)
	s.serve(c, clientIP(r))
}

func (s *Server) serve(c *session.Conn, ip string) {
	ws := c.WS()
	ws.SetReadLimit(protocol.MaxFrame + 64)
	defer c.Close(1000, "")

	// ---- 首帧：HELLO
	_ = ws.SetReadDeadline(time.Now().Add(s.cfg.HelloTimeout))
	mt, data, err := ws.ReadMessage()
	if err != nil {
		return
	}
	if mt != websocket.BinaryMessage {
		c.Close(1003, "binary frames only")
		return
	}
	f, err := protocol.ParseFrame(data)
	if err != nil {
		s.sendError(c, protocol.ErrBadFrame)
		c.Close(4003, "bad frame")
		return
	}
	if f.Op != protocol.OpHello {
		s.sendError(c, protocol.ErrUnauthorized)
		c.Close(4001, "hello required")
		return
	}
	hello, err := protocol.DecodeHello(f)
	if err != nil {
		s.sendError(c, protocol.ErrBadFrame)
		c.Close(4003, "bad hello")
		return
	}
	userID, err := s.verifier.Verify(hello.Token)
	if err != nil {
		s.sendError(c, protocol.ErrUnauthorized)
		c.Close(4001, "unauthorized")
		return
	}
	_ = userID

	var sid [16]byte
	var cur *room.Room
	var curSlot uint16

	if hello.Resume() {
		copy(sid[:], hello.SID)
		if ref, ok := s.reg.LookupSession(sid); ok {
			if rm, ok := s.reg.Get(ref.Code); ok {
				slot, code := rm.Resume(c, sid, hello.LastSeq)
				if code == protocol.ErrNone {
					cur, curSlot = rm, slot
					slog.Info("session resumed", "room", ref.Code, "slot", slot, "remote", ip)
				}
			}
		}
		if cur == nil {
			s.sendError(c, protocol.ErrRoomNotFound)
			c.Close(4004, "session expired")
			return
		}
	} else {
		if _, err := rand.Read(sid[:]); err != nil {
			c.Close(1011, "rng failure")
			return
		}
		c.Send(protocol.EncodeReady(sid[:], false))
	}

	if cur != nil {
		defer cur.Drop(c, curSlot)
	}

	go s.heartbeat(c)
	limiter := &connLimiter{limit: s.cfg.RateLimit}

	for {
		_ = ws.SetReadDeadline(time.Now().Add(s.cfg.ReadTimeout))
		mt, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.BinaryMessage {
			c.Close(1003, "binary frames only")
			return
		}
		if !limiter.allow() {
			s.sendError(c, protocol.ErrRateLimited)
			c.Close(4006, "rate limited")
			return
		}
		f, err := protocol.ParseFrame(data)
		if err != nil {
			c.Close(1002, "bad frame")
			return
		}

		switch f.Op {
		case protocol.OpPing:
			r := protocol.NewReader(f.Body)
			ts := r.U64()
			if r.Err() == nil {
				c.Send(protocol.EncodePong(ts))
			}
		case protocol.OpPong:
			// 入站帧已经刷新读超时，无需额外处理

		case protocol.OpCreate:
			if cur != nil {
				s.sendError(c, protocol.ErrAlreadyJoined)
				continue
			}
			ev, err := protocol.DecodeCreate(f)
			if err != nil {
				s.sendError(c, protocol.ErrBadFrame)
				continue
			}
			if !s.ipLimit.allow(ip) {
				s.sendError(c, protocol.ErrRateLimited)
				continue
			}
			rm, err := s.reg.Create(string(ev.Pwd))
			if err != nil {
				s.sendError(c, protocol.ErrServerFull)
				continue
			}
			slot, code := rm.Join(c, sid, ev.Meta, ev.Pwd, true)
			if code != protocol.ErrNone {
				rm.Shutdown()
				s.sendError(c, code)
				continue
			}
			cur, curSlot = rm, slot
			slog.Info("room created", "room", rm.Code, "slot", slot, "remote", ip)

		case protocol.OpJoin:
			if cur != nil {
				s.sendError(c, protocol.ErrAlreadyJoined)
				continue
			}
			ev, err := protocol.DecodeJoin(f)
			if err != nil {
				s.sendError(c, protocol.ErrBadFrame)
				continue
			}
			rm, ok := s.reg.Get(ev.Code)
			if !ok {
				s.sendError(c, protocol.ErrRoomNotFound)
				continue
			}
			slot, code := rm.Join(c, sid, ev.Meta, ev.Pwd, false)
			if code != protocol.ErrNone {
				s.sendError(c, code)
				continue
			}
			cur, curSlot = rm, slot
			slog.Info("room joined", "room", rm.Code, "slot", slot, "remote", ip)

		case protocol.OpRelay:
			if cur == nil {
				s.sendError(c, protocol.ErrNotJoined)
				continue
			}
			ev, err := protocol.DecodeRelay(f)
			if err != nil {
				s.sendError(c, protocol.ErrBadFrame)
				continue
			}
			code := cur.Relay(c, curSlot, ev.Targets, ev.Payload)
			if code == protocol.ErrNotJoined || code == protocol.ErrRoomNotFound {
				cur = nil
			}
			if code != protocol.ErrNone {
				s.sendError(c, code)
			}

		case protocol.OpLeave:
			if cur != nil {
				cur.Leave(c, curSlot)
				cur = nil
			}

		case protocol.OpLock:
			if cur == nil {
				s.sendError(c, protocol.ErrNotJoined)
				continue
			}
			v, err := protocol.DecodeLock(f)
			if err != nil {
				s.sendError(c, protocol.ErrBadFrame)
				continue
			}
			if code := cur.Lock(curSlot, v); code != protocol.ErrNone {
				s.sendError(c, code)
			}

		case protocol.OpKick:
			if cur == nil {
				s.sendError(c, protocol.ErrNotJoined)
				continue
			}
			slot, err := protocol.DecodeKick(f)
			if err != nil {
				s.sendError(c, protocol.ErrBadFrame)
				continue
			}
			if code := cur.Kick(curSlot, slot); code != protocol.ErrNone {
				s.sendError(c, code)
			}

		default:
			slog.Debug("unknown op", "op", f.Op, "remote", ip)
		}
	}
}

func (s *Server) heartbeat(c *session.Conn) {
	t := time.NewTicker(s.cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-c.Done():
			return
		case <-t.C:
			if !c.Send(protocol.EncodePing(uint64(time.Now().UnixMilli()))) {
				return
			}
		}
	}
}

func (s *Server) sendError(c *session.Conn, code protocol.ErrCode) {
	c.Send(protocol.EncodeError(code, code.String()))
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// connLimiter 是每连接每秒帧数的简单窗口限流。
type connLimiter struct {
	limit  int
	window int64
	count  int
}

func (l *connLimiter) allow() bool {
	if l.limit <= 0 {
		return true
	}
	now := time.Now().Unix()
	if now != l.window {
		l.window = now
		l.count = 0
	}
	l.count++
	return l.count <= l.limit
}

// ipLimiter 是每 IP 的令牌桶，用于限制建房频率。
type ipLimiter struct {
	mu    sync.Mutex
	m     map[string]*ipBucket
	rate  float64
	burst float64
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(rate, burst float64) *ipLimiter {
	return &ipLimiter{m: make(map[string]*ipBucket), rate: rate, burst: burst}
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) > 100000 {
		l.m = make(map[string]*ipBucket)
	}
	b := l.m[ip]
	if b == nil {
		b = &ipBucket{tokens: l.burst, last: now}
		l.m[ip] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
