// Package registry 维护房间索引与会话索引。
//
// 转发热路径不经过这里，只在建房/加入/重连/销毁时访问。
package registry

import (
	"crypto/rand"
	"errors"
	"sync"

	"relay/internal/protocol"
	"relay/internal/room"
)

var ErrFull = errors.New("registry: too many rooms")

// SessionRef 把 sid 映射回房间与槽位，用于断线重连。
type SessionRef struct {
	Code string
	Slot uint16
}

type Registry struct {
	mu       sync.RWMutex
	rooms    map[string]*room.Room
	sessions map[[16]byte]SessionRef
	maxRooms int
	cfg      room.Config
}

func New(maxRooms int, cfg room.Config) *Registry {
	if maxRooms <= 0 {
		maxRooms = 10000
	}
	return &Registry{
		rooms:    make(map[string]*room.Room),
		sessions: make(map[[16]byte]SessionRef),
		maxRooms: maxRooms,
		cfg:      cfg,
	}
}

// Create 生成一个 4 位房间码并启动房间 actor。
func (r *Registry) Create(password string) (*room.Room, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.rooms) >= r.maxRooms {
		return nil, ErrFull
	}
	for i := 0; i < 16; i++ {
		code := generateCode()
		if _, exists := r.rooms[code]; exists {
			continue
		}
		rm := room.New(code, password, r.cfg, r.hooks())
		r.rooms[code] = rm
		return rm, nil
	}
	return nil, ErrFull
}

func (r *Registry) Get(code string) (*room.Room, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rm, ok := r.rooms[code]
	return rm, ok
}

func (r *Registry) LookupSession(sid [16]byte) (SessionRef, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ref, ok := r.sessions[sid]
	return ref, ok
}

func (r *Registry) RoomCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.rooms)
}

func (r *Registry) hooks() room.Hooks {
	return room.Hooks{
		Bind: func(sid [16]byte, code string, slot uint16) {
			r.mu.Lock()
			r.sessions[sid] = SessionRef{Code: code, Slot: slot}
			r.mu.Unlock()
		},
		Unbind: func(sid [16]byte) {
			r.mu.Lock()
			delete(r.sessions, sid)
			r.mu.Unlock()
		},
		Destroy: func(code string) {
			r.mu.Lock()
			delete(r.rooms, code)
			r.mu.Unlock()
		},
	}
}

func generateCode() string {
	alpha := protocol.CodeAlphabet()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败在实践中不会发生；退化为固定码会导致碰撞重试。
		copy(b[:], "AAAA")
	}
	for i := range b {
		b[i] = alpha[int(b[i])%len(alpha)]
	}
	return string(b[:])
}
