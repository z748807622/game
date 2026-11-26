package server

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// ParseTrustedProxies 解析逗号分隔的可信反代列表，每项是 CIDR 或单个 IP。
// 空字符串返回 nil；遇到非法项返回错误，便于启动时快速失败。
func ParseTrustedProxies(raw string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, ipnet, err := net.ParseCIDR(part); err == nil {
			out = append(out, ipnet)
			continue
		}
		ip := net.ParseIP(part)
		if ip == nil {
			return nil, fmt.Errorf("invalid trusted proxy %q: want IP or CIDR", part)
		}
		if v4 := ip.To4(); v4 != nil {
			out = append(out, &net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)})
		} else {
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)})
		}
	}
	return out, nil
}

// clientIP 返回客户端 IP。只有直连方命中可信反代列表时才采信反代头：
// 优先 X-Real-IP（nginx 常用），否则取 X-Forwarded-For 最右侧合法项
// （$proxy_add_x_forwarded_for 会把真实对端追加到最后）。
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = strings.Trim(r.RemoteAddr, "[]")
	}
	ip := net.ParseIP(host)
	if ip == nil || !s.trustedProxy(ip) {
		return host
	}
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(v) != nil {
		return v
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if cand := strings.TrimSpace(parts[i]); net.ParseIP(cand) != nil {
				return cand
			}
		}
	}
	return host
}

func (s *Server) trustedProxy(ip net.IP) bool {
	for _, n := range s.cfg.TrustedProxies {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
