// Package web 内嵌演示页与浏览器端协议库。
package web

import "embed"

//go:embed index.html relay.js bulls.html bulls-core.js bulls.js plane.html plane-core.js plane-net.js plane.js
var FS embed.FS
