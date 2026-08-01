package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// The HTTP server may receive a timer autosave and a Stop-triggered autosave
// at nearly the same time. Serialize all drive writes so two handlers can
// never truncate or replace the same destination concurrently.
var saveWriteMu sync.Mutex

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
	saveWriteMu.Lock()
	defer saveWriteMu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	if err := writeFileAtomically(filepath.Join(dir, name), data, 0o644); err != nil {
		return "", "", err
	}
	return "saves/" + kind + "/" + name, "", nil
}

// writeFileAtomically writes through a temporary file in the destination
// directory, flushes it, and then replaces the destination. os.Rename is an
// atomic replacement on Unix. On platforms where replacing an existing file
// is rejected, the backup fallback preserves the previous complete file until
// the new one has been moved into place.
func writeFileAtomically(path string, data []byte, mode os.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	keepTemp := true
	defer func() {
		if keepTemp {
			_ = os.Remove(tmpName)
		}
	}()

	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}

	if err = os.Rename(tmpName, path); err == nil {
		keepTemp = false
		return nil
	}

	// Windows commonly refuses to rename over an existing destination.
	// Move the old complete file aside, install the new complete file, then
	// discard the backup. If installation fails, restore the prior file.
	backup := path + ".bak"
	_ = os.Remove(backup)
	backupMade := false
	if backupErr := os.Rename(path, backup); backupErr == nil {
		backupMade = true
	} else if !os.IsNotExist(backupErr) {
		return backupErr
	}
	if replaceErr := os.Rename(tmpName, path); replaceErr != nil {
		if backupMade {
			_ = os.Rename(backup, path)
		}
		return replaceErr
	}
	keepTemp = false
	if backupMade {
		_ = os.Remove(backup)
	}
	return nil
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
	dir := filepath.Join(root, "saves", "session")
	for _, name := range []string{autosaveName, autosaveName + ".bak"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err == nil {
			return b, true
		}
	}
	return nil, false
}
