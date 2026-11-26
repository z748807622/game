package main

import (
	"os"
	"path/filepath"
	"testing"

	"relay/web"
)

func TestWriteWebDist(t *testing.T) {
	out := filepath.Join(t.TempDir(), "web")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(out, "stale.js"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}

	if err := writeWebDist(out); err != nil {
		t.Fatalf("writeWebDist: %v", err)
	}

	if _, err := os.Stat(filepath.Join(out, "stale.js")); !os.IsNotExist(err) {
		t.Fatalf("stale file should be removed, stat err = %v", err)
	}
	for _, name := range []string{"index.html", "bulls.html", "plane.html", "relay.js", "config.js"} {
		if _, err := os.Stat(filepath.Join(out, name)); err != nil {
			t.Fatalf("%s missing: %v", name, err)
		}
	}

	entries, err := os.ReadDir(out)
	if err != nil {
		t.Fatalf("read out: %v", err)
	}
	want := countFiles(web.FS)
	if len(entries) != want {
		t.Fatalf("exported %d files, want %d", len(entries), want)
	}
	for _, e := range entries {
		if e.Name() == "embed.go" || e.IsDir() {
			t.Fatalf("unexpected entry %q", e.Name())
		}
	}
}

func TestCleanDirs(t *testing.T) {
	base := t.TempDir()
	var dirs []string
	for _, name := range []string{"bin", "dist", ".tmp"} {
		d := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Join(d, "nested"), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
		dirs = append(dirs, d)
	}

	if err := cleanDirs(dirs...); err != nil {
		t.Fatalf("cleanDirs: %v", err)
	}
	for _, d := range dirs {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Fatalf("%s still exists", d)
		}
	}
}
