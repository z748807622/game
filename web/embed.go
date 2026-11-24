// Package web 内嵌演示页与浏览器端协议库。
package web

import "embed"

//go:embed index.html relay.js
var FS embed.FS
