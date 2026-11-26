package main

import (
	"context"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"relay/internal/server"
	"relay/web"
)

func main() {
	var cfg server.Config
	var logLevel string
	var serveWeb bool
	var staticDir string
	var trustedProxies string

	flag.StringVar(&cfg.Addr, "addr", ":8080", "HTTP 监听地址（同时提供 /ws 与 demo）")
	flag.IntVar(&cfg.MaxMembers, "max-members", 16, "单房间人数上限")
	flag.IntVar(&cfg.MaxRooms, "max-rooms", 10000, "单进程房间数上限")
	flag.DurationVar(&cfg.GraceTimeout, "grace", 60*time.Second, "断线重连宽限期")
	flag.IntVar(&cfg.RingBytes, "ring-bytes", 64<<10, "每房间重放缓冲字节预算")
	flag.Int64Var(&cfg.SendQueueBytes, "send-queue-bytes", 256<<10, "每连接发送队列字节预算")
	flag.DurationVar(&cfg.PingInterval, "ping", 20*time.Second, "服务端心跳间隔")
	flag.DurationVar(&cfg.ReadTimeout, "read-timeout", 60*time.Second, "读空闲超时")
	flag.IntVar(&cfg.RateLimit, "rate-limit", 200, "每连接每秒最大入站帧数")
	flag.IntVar(&cfg.CreatePerMin, "create-per-min", 10, "每 IP 每分钟建房数")
	flag.BoolVar(&serveWeb, "serve-web", true, "是否提供内置静态页面；前后端分离部署时设为 false")
	flag.StringVar(&staticDir, "static-dir", "", "改用磁盘目录提供静态页面（默认用内嵌 web/）")
	flag.StringVar(&trustedProxies, "trusted-proxies", "", "可信反代 CIDR/IP 列表，逗号分隔（如 127.0.0.1/32）")
	flag.StringVar(&logLevel, "log", "info", "日志级别 debug|info|warn|error")
	flag.Parse()

	level := slog.LevelInfo
	if err := level.UnmarshalText([]byte(logLevel)); err != nil {
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	if !serveWeb && staticDir != "" {
		slog.Error("conflicting flags: -serve-web=false 与 -static-dir 不能同时使用")
		os.Exit(2)
	}
	proxies, err := server.ParseTrustedProxies(trustedProxies)
	if err != nil {
		slog.Error("bad -trusted-proxies", "err", err)
		os.Exit(2)
	}
	cfg.TrustedProxies = proxies

	var staticFS fs.FS
	switch {
	case !serveWeb:
		staticFS = nil
	case staticDir != "":
		staticFS = os.DirFS(staticDir)
	default:
		staticFS = web.FS
	}

	srv := server.New(cfg, staticFS)
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		slog.Info("shutting down")
		srv.Shutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()

	if staticFS != nil {
		slog.Info("relay server listening", "addr", cfg.Addr, "demo", "http://localhost"+cfg.Addr+"/")
	} else {
		slog.Info("relay server listening", "addr", cfg.Addr, "ws", "/ws", "static", "disabled")
	}
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("listen failed", "err", err)
		os.Exit(1)
	}
}
