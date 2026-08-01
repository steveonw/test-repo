package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWriteSave(t *testing.T) {
	root := t.TempDir()

	rel, userErr, sysErr := writeSave(root, "session", "read-aloud-session.json", []byte(`{"ok":true}`))
	if userErr != "" || sysErr != nil || rel != "saves/session/read-aloud-session.json" {
		t.Fatalf("valid save failed: rel=%q userErr=%q sysErr=%v", rel, userErr, sysErr)
	}
	b, err := os.ReadFile(filepath.Join(root, "saves", "session", "read-aloud-session.json"))
	if err != nil || string(b) != `{"ok":true}` {
		t.Fatalf("saved bytes wrong: %q %v", b, err)
	}

	// overwrite is allowed (the rolling autosave depends on it)
	if _, userErr, sysErr := writeSave(root, "session", autosaveName, []byte("v1")); userErr != "" || sysErr != nil {
		t.Fatalf("autosave write failed: %q %v", userErr, sysErr)
	}
	if _, userErr, sysErr := writeSave(root, "session", autosaveName, []byte("v2")); userErr != "" || sysErr != nil {
		t.Fatalf("autosave overwrite failed: %q %v", userErr, sysErr)
	}
	got, ok := readAutosave(root)
	if !ok || string(got) != "v2" {
		t.Fatalf("readAutosave wrong: %q %v", got, ok)
	}

	// every kind lands in its own folder, with its own allowed extensions
	for kind, name := range map[string]string{"report": "f.txt", "text": "f.txt", "audio": "f.wav"} {
		if rel, userErr, sysErr := writeSave(root, kind, name, []byte("x")); userErr != "" || sysErr != nil || !strings.HasPrefix(rel, "saves/"+kind+"/") {
			t.Fatalf("kind %s failed: %q %q %v", kind, rel, userErr, sysErr)
		}
	}
	if _, userErr, _ := writeSave(root, "audio", "song.MP3", []byte("x")); userErr != "" {
		t.Fatalf("extension match must be case-insensitive: %q", userErr)
	}

	// rejections: unknown kinds and anything path-shaped
	for _, bad := range [][2]string{
		{"pictures", "f.txt"},
		{"session", "../escape.json"},
		{"session", "a/b.json"},
		{"session", `a\b.json`},
		{"session", ""},
		{"audio", strings.Repeat("n", 200) + ".wav"},
		{"text", "payload.hta"}, // P2-2: attacker-chosen file types
		{"audio", "setup.exe"},
		{"report", "script.js"},
		{"session", "CON.json"}, // P3-4: Windows reserved device names
		{"text", "nul.txt"},
		{"text", ".hidden.txt"},
		{"text", "trailingdot.txt."},
		{"text", "trailingspace.txt "},
	} {
		if _, userErr, _ := writeSave(root, bad[0], bad[1], []byte("x")); userErr == "" {
			t.Fatalf("expected rejection for kind=%q name=%q", bad[0], bad[1])
		}
	}
	if _, err := os.Stat(filepath.Join(root, "escape.json")); !os.IsNotExist(err) {
		t.Fatal("traversal name must never produce a file outside saves/")
	}

	if _, ok := readAutosave(t.TempDir()); ok {
		t.Fatal("readAutosave must report absence on a fresh drive")
	}
}

func TestConcurrentSaveWritesStayComplete(t *testing.T) {
	root := t.TempDir()
	const writers = 24
	const payloadSize = 128 * 1024
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(value byte) {
			defer wg.Done()
			payload := bytes.Repeat([]byte{value}, payloadSize)
			if _, userErr, sysErr := writeSave(root, "session", autosaveName, payload); userErr != "" || sysErr != nil {
				t.Errorf("write failed: %q %v", userErr, sysErr)
			}
		}(byte(i + 1))
	}
	wg.Wait()

	got, err := os.ReadFile(filepath.Join(root, "saves", "session", autosaveName))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != payloadSize {
		t.Fatalf("partial final save: got %d bytes, want %d", len(got), payloadSize)
	}
	if !bytes.Equal(got, bytes.Repeat([]byte{got[0]}, payloadSize)) {
		t.Fatal("final save contains interleaved data from concurrent writers")
	}
}

func TestReadAutosaveFallsBackToBackup(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "saves", "session")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, autosaveName+".bak"), []byte("last complete save"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, ok := readAutosave(root)
	if !ok || string(got) != "last complete save" {
		t.Fatalf("backup autosave not recovered: ok=%v data=%q", ok, got)
	}
}
