package main

import (
	"os"
	"path/filepath"
	"strings"
)

// The only folders /api/save may write into, all under <drive>/saves/.
// Everything the app produces lands on the drive the launcher started from —
// never in the host computer's Downloads folder.
var saveKinds = map[string]bool{
	"session": true, // session files, including the rolling autosave
	"report":  true, // flag reports
	"text":    true, // draft text, labels, settings strings
	"audio":   true, // WAV and MP3 narration
}

// Each kind may only write file types it plausibly produces — path traversal
// is blocked elsewhere; this stops attacker-chosen executables landing on the
// stick (P2-2).
var saveExtensions = map[string][]string{
	"session": {".raSession", ".json"},
	"report":  {".txt", ".csv"},
	"text":    {".txt"},
	"audio":   {".wav", ".mp3"},
}

func allowedExtension(kind, name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range saveExtensions[kind] {
		if strings.HasSuffix(lower, strings.ToLower(ext)) {
			return true
		}
	}
	return false
}

const autosaveName = "autosave.raSession"

// writeSave validates and writes one file under <root>/saves/<kind>/<name>.
// It returns the drive-relative path on success, a plain-language user error
// for bad requests, or a system error for disk failures.
func writeSave(root, kind, name string, data []byte) (rel string, userErr string, sysErr error) {
	if !saveKinds[kind] {
		return "", "unknown save kind", nil
	}
	// Same rule as voice assets: a plain file name, nothing that could step
	// outside its folder.
	if !safeAssetName(name) {
		return "", "unsafe file name", nil
	}
	if !allowedExtension(kind, name) {
		return "", "that file type cannot be saved as " + kind, nil
	}
	dir := filepath.Join(root, "saves", kind)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return "", "", err
	}
	return "saves/" + kind + "/" + name, "", nil
}

// friendlySaveError turns a disk failure into a sentence a non-technical
// person can act on, mirroring the drive-lost language used elsewhere.
func friendlySaveError(err error) string {
	if os.IsPermission(err) {
		return "the drive is write-protected, so the file could not be saved"
	}
	if os.IsNotExist(err) {
		return "the drive seems to have been removed — plug it back in and try again"
	}
	return "the file could not be written — the drive may be full, write-protected, or removed"
}

// readAutosave returns the rolling autosave session if one exists.
func readAutosave(root string) ([]byte, bool) {
	b, err := os.ReadFile(filepath.Join(root, "saves", "session", autosaveName))
	if err != nil {
		return nil, false
	}
	return b, true
}
