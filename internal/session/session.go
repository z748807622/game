// Package session 封装一条 WebSocket 连接：发送队列、背压、关闭语义。
package session

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type message struct {
	frame   []byte
	closing bool
	code    int
	reason  string
}

// Conn 是服务器持有的连接句柄。Send 永不阻塞，队列满即判定为慢客户端并关闭。
type Conn struct {
	ws           *websocket.Conn
	out          chan message
	done         chan struct{}
	once         sync.Once
	queued       atomic.Int64
	maxQueue     int64
	writeTimeout time.Duration
}

func New(ws *websocket.Conn, maxQueue int64) *Conn {
	if maxQueue <= 0 {
		maxQueue = 256 << 10
	}
	return &Conn{
		ws:           ws,
		out:          make(chan message, 256),
		done:         make(chan struct{}),
		maxQueue:     maxQueue,
		writeTimeout: 10 * time.Second,
	}
}

func (c *Conn) WS() *websocket.Conn { return c.ws }

func (c *Conn) Done() <-chan struct{} { return c.done }

func (c *Conn) closed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// Send 入队一帧。返回 false 表示连接已不可用。
func (c *Conn) Send(frame []byte) bool {
	if c.closed() {
		return false
	}
	if c.queued.Add(int64(len(frame))) > c.maxQueue {
		c.Close(1013, "slow consumer")
		return false
	}
	select {
	case c.out <- message{frame: frame}:
		return true
	default:
		c.queued.Add(-int64(len(frame)))
		c.Close(1013, "send queue full")
		return false
	}
}

// Close 先排队一个关闭帧（尽力送达），由写协程写完前面的帧后执行。
func (c *Conn) Close(code int, reason string) {
	if code == 0 {
		code = 1000
	}
	select {
	case c.out <- message{closing: true, code: code, reason: reason}:
	case <-c.done:
	default:
		c.forceClose()
	}
}

func (c *Conn) forceClose() {
	c.once.Do(func() {
		close(c.done)
		_ = c.ws.Close()
	})
}

// WriteLoop 独占写端，直到连接关闭。
func (c *Conn) WriteLoop() {
	for {
		select {
		case <-c.done:
			return
		case m := <-c.out:
			if m.closing {
				_ = c.ws.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(m.code, m.reason),
					time.Now().Add(time.Second),
				)
				c.forceClose()
				return
			}
			c.queued.Add(-int64(len(m.frame)))
			_ = c.ws.SetWriteDeadline(time.Now().Add(c.writeTimeout))
			if err := c.ws.WriteMessage(websocket.BinaryMessage, m.frame); err != nil {
				c.forceClose()
				return
			}
		}
	}
}
