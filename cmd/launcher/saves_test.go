package main

import (
	"os"
	"path/filepath"
	"strings"
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
		{"text", "payload.hta"},   // P2-2: attacker-chosen file types
		{"audio", "setup.exe"},
		{"report", "script.js"},
		{"session", "CON.json"},   // P3-4: Windows reserved device names
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
