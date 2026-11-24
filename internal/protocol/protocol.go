// Package protocol 定义中继服务器的二进制线格式。
//
// 帧结构（小端序）：
//
//	偏移 0..3  len   u32  后续字节数（不含自身），合法范围 8..65535
//	偏移 4     ver   u8   协议版本
//	偏移 5     op    u8   操作码
//	偏移 6     flags u8   当前必须为 0
//	偏移 7     rsv   u8   必须为 0
//	偏移 8..   body
//
// 业务负载（payload）对服务器完全不透明，服务器只读取头部与路由字段。
package protocol

const (
	Version   = 1
	HeaderLen = 8
	MaxFrame  = 64 * 1024
)

// Op 是操作码。C→S 与 S→C 使用不同的值域，避免回环混乱。
type Op uint8

const (
	OpHello  Op = 0x01
	OpCreate Op = 0x02
	OpJoin   Op = 0x03
	OpLeave  Op = 0x04
	OpRelay  Op = 0x05
	OpLock   Op = 0x06
	OpKick   Op = 0x07
	OpPing   Op = 0x08
	OpPong   Op = 0x09

	OpReady       Op = 0x81
	OpCreated     Op = 0x82
	OpJoined      Op = 0x83
	OpReconnected Op = 0x84
	OpPeerJoin    Op = 0x85
	OpPeerLeave   Op = 0x86
	OpPeerRejoin  Op = 0x87
	OpHost        Op = 0x88
	OpRelayS2C    Op = 0x89
	OpResync      Op = 0x8A
	OpKicked      Op = 0x8B
	OpError       Op = 0x8C
	OpPongS2C     Op = 0x8D
	OpPingS2C     Op = 0x8E
	OpPeerOffline Op = 0x8F
)

func (o Op) String() string {
	switch o {
	case OpHello:
		return "HELLO"
	case OpCreate:
		return "CREATE"
	case OpJoin:
		return "JOIN"
	case OpLeave:
		return "LEAVE"
	case OpRelay:
		return "RELAY"
	case OpLock:
		return "LOCK"
	case OpKick:
		return "KICK"
	case OpPing:
		return "PING"
	case OpPong:
		return "PONG"
	case OpReady:
		return "READY"
	case OpCreated:
		return "CREATED"
	case OpJoined:
		return "JOINED"
	case OpReconnected:
		return "RECONNECTED"
	case OpPeerJoin:
		return "PEER_JOIN"
	case OpPeerLeave:
		return "PEER_LEAVE"
	case OpPeerRejoin:
		return "PEER_REJOIN"
	case OpHost:
		return "HOST"
	case OpRelayS2C:
		return "RELAY_S2C"
	case OpResync:
		return "RESYNC"
	case OpKicked:
		return "KICKED"
	case OpError:
		return "ERROR"
	case OpPongS2C:
		return "PONG_S2C"
	case OpPingS2C:
		return "PING_S2C"
	case OpPeerOffline:
		return "PEER_OFFLINE"
	}
	return "UNKNOWN"
}

// ErrCode 是业务错误码，随 OpError 下发给客户端。
type ErrCode uint16

const (
	ErrNone          ErrCode = 0x00
	ErrUnauthorized  ErrCode = 0x01
	ErrBadFrame      ErrCode = 0x02
	ErrAlreadyJoined ErrCode = 0x03
	ErrNotJoined     ErrCode = 0x04
	ErrRoomNotFound  ErrCode = 0x05
	ErrRoomFull      ErrCode = 0x06
	ErrRoomLocked    ErrCode = 0x07
	ErrBadPassword   ErrCode = 0x08
	ErrBadTarget     ErrCode = 0x09
	ErrNotHost       ErrCode = 0x0A
	ErrRateLimited   ErrCode = 0x0B
	ErrServerFull    ErrCode = 0x0C
	ErrFrameTooLarge ErrCode = 0x0D
	ErrBadVersion    ErrCode = 0x0E
	ErrInternal      ErrCode = 0x0F
)

func (e ErrCode) String() string {
	switch e {
	case ErrNone:
		return "NONE"
	case ErrUnauthorized:
		return "UNAUTHORIZED"
	case ErrBadFrame:
		return "BAD_FRAME"
	case ErrAlreadyJoined:
		return "ALREADY_JOINED"
	case ErrNotJoined:
		return "NOT_JOINED"
	case ErrRoomNotFound:
		return "ROOM_NOT_FOUND"
	case ErrRoomFull:
		return "ROOM_FULL"
	case ErrRoomLocked:
		return "ROOM_LOCKED"
	case ErrBadPassword:
		return "BAD_PASSWORD"
	case ErrBadTarget:
		return "BAD_TARGET"
	case ErrNotHost:
		return "NOT_HOST"
	case ErrRateLimited:
		return "RATE_LIMITED"
	case ErrServerFull:
		return "SERVER_FULL"
	case ErrFrameTooLarge:
		return "FRAME_TOO_LARGE"
	case ErrBadVersion:
		return "BAD_VERSION"
	case ErrInternal:
		return "INTERNAL"
	}
	return "UNKNOWN"
}

// PEER_LEAVE 的 reason。
const (
	ReasonLeft    uint8 = 0
	ReasonTimeout uint8 = 1
	ReasonKicked  uint8 = 2
)

// RESYNC 的 reason。
const (
	ResyncGap       uint8 = 0
	ResyncRoomReset uint8 = 1
)

// Member 是房间成员快照的一项。
type Member struct {
	Slot   uint16
	Online bool
	Meta   []byte
}

// MaxTargets 是单条转发允许的最大目标数，与单房人数上限一致。
const MaxTargets = 16

// codeAlphabet 去掉易混淆的 0/O/1/I。
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// ValidCode 校验房间码格式。
func ValidCode(s string) bool {
	if len(s) != 4 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isCodeChar(s[i]) {
			return false
		}
	}
	return true
}

func isCodeChar(c byte) bool {
	for i := 0; i < len(codeAlphabet); i++ {
		if codeAlphabet[i] == c {
			return true
		}
	}
	return false
}

// CodeAlphabet 暴露字母表，供房间码生成器使用。
func CodeAlphabet() string { return codeAlphabet }
