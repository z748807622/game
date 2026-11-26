// Command devtool 提供跨平台的构建辅助命令，避免 Makefile 依赖 rm/cp/mkdir
// 等 POSIX 工具（Windows 的 make 会用 CreateProcess 直接执行，找不到这些命令）。
//
//	go run ./cmd/devtool webdist [-out dist/web]
//	go run ./cmd/devtool clean
package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"relay/web"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "webdist":
		fs := flag.NewFlagSet("webdist", flag.ExitOnError)
		out := fs.String("out", filepath.Join("dist", "web"), "输出目录")
		if err := fs.Parse(os.Args[2:]); err != nil {
			os.Exit(2)
		}
		if err := writeWebDist(*out); err != nil {
			fail(err)
		}
	case "clean":
		if err := clean(); err != nil {
			fail(err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: devtool <webdist|clean> [flags]")
	fmt.Fprintln(os.Stderr, "  webdist [-out dist/web]  导出内嵌前端静态文件")
	fmt.Fprintln(os.Stderr, "  clean                    删除 bin/ dist/ .tmp/")
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "devtool:", err)
	os.Exit(1)
}

// writeWebDist 把 web.FS（go:embed 的静态文件）导出到 out 目录。
// 文件清单以内嵌列表为唯一来源，不手写第二份。
func writeWebDist(out string) error {
	if out == "" {
		return errors.New("webdist: empty output dir")
	}
	if err := os.RemoveAll(out); err != nil {
		return err
	}
	if err := os.CopyFS(out, web.FS); err != nil {
		return err
	}
	n := countFiles(web.FS)
	fmt.Printf("devtool: %d 个前端静态文件 -> %s\n", n, out)
	return nil
}

func countFiles(fsys fs.FS) int {
	n := 0
	_ = fs.WalkDir(fsys, ".", func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func clean() error {
	return cleanDirs("bin", "dist", ".tmp")
}

func cleanDirs(dirs ...string) error {
	for _, dir := range dirs {
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	fmt.Printf("devtool: 已清理 %v\n", dirs)
	return nil
}
