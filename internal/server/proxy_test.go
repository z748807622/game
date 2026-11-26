package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseTrustedProxies(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    int
		wantErr bool
	}{
		{name: "empty", raw: "", want: 0},
		{name: "single ipv4", raw: "127.0.0.1", want: 1},
		{name: "single ipv6", raw: "::1", want: 1},
		{name: "cidr", raw: "10.0.0.0/8", want: 1},
		{name: "mixed with spaces", raw: " 127.0.0.1 , 10.0.0.0/8 , ::1 ", want: 3},
		{name: "invalid", raw: "not-an-ip", wantErr: true},
		{name: "partially invalid", raw: "10.0.0.0/8,nope", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseTrustedProxies(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != tc.want {
				t.Fatalf("got %d proxies, want %d", len(got), tc.want)
			}
		})
	}
}

func TestClientIPTrustedProxy(t *testing.T) {
	trusted, err := ParseTrustedProxies("127.0.0.1/32,::1/128")
	if err != nil {
		t.Fatalf("parse trusted proxies: %v", err)
	}
	srv := New(Config{TrustedProxies: trusted}, nil)

	cases := []struct {
		name   string
		remote string
		realIP string
		xff    string
		want   string
	}{
		{
			name:   "untrusted peer ignores spoofed headers",
			remote: "198.51.100.7:4444",
			realIP: "1.2.3.4",
			xff:    "1.2.3.4",
			want:   "198.51.100.7",
		},
		{
			name:   "trusted peer prefers x-real-ip",
			remote: "127.0.0.1:5555",
			realIP: "203.0.113.9",
			xff:    "6.6.6.6",
			want:   "203.0.113.9",
		},
		{
			name:   "trusted peer uses rightmost valid xff",
			remote: "127.0.0.1:5555",
			xff:    "6.6.6.6, 203.0.113.9",
			want:   "203.0.113.9",
		},
		{
			name:   "trusted peer skips invalid xff entries",
			remote: "127.0.0.1:5555",
			xff:    "2001:db8::1, bogus",
			want:   "2001:db8::1",
		},
		{
			name:   "trusted ipv6 peer without headers",
			remote: "[::1]:5555",
			want:   "::1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/ws", nil)
			req.RemoteAddr = tc.remote
			if tc.realIP != "" {
				req.Header.Set("X-Real-IP", tc.realIP)
			}
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := srv.clientIP(req); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHandlerWithoutStatic(t *testing.T) {
	srv := New(Config{}, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET / status = %d, want 404", resp.StatusCode)
	}

	resp, err = http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, want 200", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read /healthz: %v", err)
	}
	if !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("unexpected /healthz body: %s", body)
	}
}
