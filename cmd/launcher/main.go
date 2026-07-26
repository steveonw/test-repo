package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	appName       = "Read Aloud Portable"
	editionID     = "portable"
	preferredAddr = "127.0.0.1:17391"
	idleTimeout   = 30 * time.Minute
)

var (
	lastRequest  atomic.Int64
	buildVersion = "dev"
)

func main() {
	sharedFlag := flag.String("shared", "", "path to the shared web application")
	noBrowser := flag.Bool("no-browser", false, "do not open the default browser")
	flag.Parse()

	logger, closeLog := newLogger()
	defer closeLog()

	sharedDir, err := locateShared(*sharedFlag)
	if err != nil {
		fatal(logger, err)
	}

	if err := validatePayload(sharedDir); err != nil {
		fatal(logger, err)
	}
	integrityChecked, integrityBad := verifyChecksums(sharedDir, logger)

	if existingURL, ok := findExistingServer(sharedDir); ok {
		if !*noBrowser {
			_ = openBrowser(existingURL)
		}
		return
	}

	listener, err := net.Listen("tcp", preferredAddr)
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal(logger, fmt.Errorf("start local server: %w", err))
		}
	}

	appFingerprint, err := fingerprint(sharedDir)
	if err != nil {
		fatal(logger, fmt.Errorf("fingerprint app: %w", err))
	}

	runToken, err := newRunToken()
	if err != nil {
		fatal(logger, fmt.Errorf("run token: %w", err))
	}
	indexHTML, err := prepareIndex(sharedDir, appFingerprint, runToken)
	if err != nil {
		fatal(logger, fmt.Errorf("prepare index: %w", err))
	}

	quitRequested := make(chan struct{})
	var quitOnce sync.Once

	lastRequest.Store(time.Now().UnixNano())
	mux := http.NewServeMux()
	files := http.FileServer(http.Dir(sharedDir))

	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if !authorizedMutation(r, runToken) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "stopping")
		quitOnce.Do(func() { close(quitRequested) })
	})

	voicesDir := filepath.Join(filepath.Dir(sharedDir), "voices")
	voiceFS := http.StripPrefix("/voices/", http.FileServer(http.Dir(voicesDir)))
	mux.HandleFunc("/voices/", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		lastRequest.Store(time.Now().UnixNano())
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		voiceFS.ServeHTTP(w, r)
	})

	mux.HandleFunc("/api/voices", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		valid, invalid := scanVoices(voicesDir)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"voices": valid, "invalid": invalid, "voicesDir": "voices"})
	})

	driveRoot := filepath.Dir(sharedDir)
	mux.HandleFunc("/api/save", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		if !authorizedMutation(r, runToken) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "this request did not come from the Read Aloud page"})
			return
		}
		lastRequest.Store(time.Now().UnixNano())
		r.Body = http.MaxBytesReader(w, r.Body, 256<<20)
		var req struct {
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			DataBase64 string `json:"dataBase64"`
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "the save request could not be read"})
			return
		}
		data, err := base64.StdEncoding.DecodeString(req.DataBase64)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "the save data was not valid"})
			return
		}
		rel, userErr, sysErr := writeSave(driveRoot, req.Kind, req.Name, data)
		if userErr != "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": userErr})
			return
		}
		if sysErr != nil {
			logger.Printf("save failed: %v", sysErr)
			w.WriteHeader(http.StatusInsufficientStorage)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": friendlySaveError(sysErr)})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"saved": rel})
	})

	mux.HandleFunc("/api/autosave", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		b, ok := readAutosave(driveRoot)
		if !ok {
			// A fresh drive has no autosave — that is the normal case, not an
			// error. Answering 404 here would print a red line in every
			// browser console on every clean boot.
			_, _ = io.WriteString(w, `{"none":true}`)
			return
		}
		_, _ = w.Write(b)
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		integrity := "unverified"
		if integrityChecked > 0 {
			if integrityBad == 0 {
				integrity = fmt.Sprintf("ok:%d", integrityChecked)
			} else {
				integrity = fmt.Sprintf("failed:%d/%d", integrityBad, integrityChecked)
			}
		}
		_, _ = io.WriteString(w, "readaloud:"+appFingerprint+"\nintegrity:"+integrity)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		lastRequest.Store(time.Now().UnixNano())
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			setHeaders(w, "/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(indexHTML)
			return
		}
		setHeaders(w, r.URL.Path)
		files.ServeHTTP(w, r)
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	addr := listener.Addr().String()
	url := "http://" + addr + "/?edition=" + editionID + "&build=" + appFingerprint
	logger.Printf("%s %s serving %s from %s", appName, buildVersion, url, sharedDir)

	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			logger.Printf("could not open browser automatically: %v", err)
			_ = writeOpenMe(sharedDir, url)
		}
	}

	done := make(chan struct{})
	var shutdownOnce sync.Once
	shutdown := func(reason string) {
		shutdownOnce.Do(func() {
			logger.Printf("stopping: %s", reason)
			_ = server.Shutdown(context.Background())
			close(done)
		})
	}
	go func() {
		<-quitRequested
		time.Sleep(300 * time.Millisecond) // let the /quit response flush
		shutdown("quit requested from the page")
	}()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			last := time.Unix(0, lastRequest.Load())
			if time.Since(last) >= idleTimeout {
				shutdown(fmt.Sprintf("%s without file requests", idleTimeout))
				return
			}
		}
	}()

	err = server.Serve(listener)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(logger, fmt.Errorf("local server: %w", err))
	}
	select {
	case <-done:
	default:
	}
}

func locateShared(explicit string) (string, error) {
	if explicit != "" {
		return cleanShared(explicit)
	}

	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find launcher location: %w", err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)

	candidates := []string{
		filepath.Join(dir, "shared"),
		filepath.Join(dir, "Shared"),
	}

	current := dir
	for i := 0; i < 7; i++ {
		candidates = append(candidates,
			filepath.Join(current, "shared"),
			filepath.Join(current, "Shared"),
		)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "shared"),
			filepath.Join(wd, "Shared"),
		)
	}

	seen := map[string]bool{}
	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		if _, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("could not find shared/index.html near the launcher; keep the launcher and shared folder in the USB layout")
}

func cleanShared(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve shared path: %w", err)
	}
	if _, err := os.Stat(filepath.Join(abs, "index.html")); err != nil {
		return "", fmt.Errorf("shared application is incomplete at %s: %w", abs, err)
	}
	return abs, nil
}

func validatePayload(shared string) error {
	required := []string{
		"index.html",
		"app.js",
		"sherpa-onnx-tts.worker.js",
		"sherpa-onnx-tts.js",
	}
	for _, name := range required {
		if _, err := os.Stat(filepath.Join(shared, name)); err != nil {
			return fmt.Errorf("missing %s in shared application; run the builder first", name)
		}
	}

	wasmMatches, _ := filepath.Glob(filepath.Join(shared, "*.wasm"))
	dataMatches, _ := filepath.Glob(filepath.Join(shared, "*.data"))
	if len(wasmMatches) == 0 || len(dataMatches) == 0 {
		return fmt.Errorf("the generated Sherpa WASM payload is missing; run scripts/build_all.sh or the GitHub Actions builder")
	}
	return nil
}

func fingerprint(shared string) (string, error) {
	h := sha256.New()
	for _, name := range []string{"index.html", "app.js"} {
		f, err := os.Open(filepath.Join(shared, name))
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(h, f)
		closeErr := f.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func findExistingServer(shared string) (string, bool) {
	fp, err := fingerprint(shared)
	if err != nil {
		return "", false
	}
	client := http.Client{Timeout: 600 * time.Millisecond}
	resp, err := client.Get("http://" + preferredAddr + "/health")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return "", false
	}
	firstLine, _, _ := strings.Cut(strings.TrimSpace(string(body)), "\n")
	if firstLine == "readaloud:"+fp {
		return "http://" + preferredAddr + "/?edition=" + editionID + "&build=" + fp, true
	}
	return "", false
}

func validHost(host string) bool {
	host = strings.ToLower(host)
	return strings.HasPrefix(host, "127.0.0.1:") ||
		strings.HasPrefix(host, "localhost:") ||
		host == "127.0.0.1" || host == "localhost"
}

func setHeaders(w http.ResponseWriter, path string) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".wasm":
		w.Header().Set("Content-Type", "application/wasm")
	case ".data", ".onnx", ".bin":
		w.Header().Set("Content-Type", "application/octet-stream")
	case ".js", ".mjs":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	default:
		if ext != "" {
			if t := mime.TypeByExtension(ext); t != "" {
				w.Header().Set("Content-Type", t)
			}
		}
	}

	// These permit a future threaded WASM build while remaining harmless for
	// the initial single-threaded version.
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// Network isolation by construction: even compromised page code cannot
	// reach beyond this local origin.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; "+
			"style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "+
			"worker-src 'self' blob:; media-src 'self' blob:; "+
			"base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

	if ext == ".wasm" || ext == ".data" || ext == ".onnx" || ext == ".js" {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
}

func prepareIndex(shared, fp, token string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(shared, "index.html"))
	if err != nil {
		return nil, err
	}
	s := string(raw)
	s = strings.ReplaceAll(s, `href="style.css"`, `href="style.css?v=`+fp+`"`)
	s = strings.ReplaceAll(s, `src="app.js"`, `src="app.js?v=`+fp+`"`)
	// The per-run token authorizes mutating requests (/api/save, /quit).
	// A random website cannot read this page cross-origin, so it can never
	// learn the token; requiring it as a custom header also forces a CORS
	// preflight this server does not answer.
	s = strings.Replace(s, "<head>", "<head>\n  <meta name=\"ra-token\" content=\""+token+"\">", 1)
	return []byte(s), nil
}

// newRunToken returns a fresh random token for this server process.
func newRunToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// authorizedMutation enforces the per-run token and same-origin fetch
// metadata on endpoints that change state (P2-1: CSRF).
func authorizedMutation(r *http.Request, token string) bool {
	if r.Header.Get("X-RA-Token") != token {
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		return false
	}
	return true
}

// verifyChecksums checks the payload against SHA256SUMS.txt when present.
// It returns the number of files checked and the number that failed, so the
// health endpoint can surface payload corruption to the page.
// Warn-only: a proofreading session should not be blocked by one stale hash,
// but tampering or USB corruption deserves a visible log line.
func verifyChecksums(shared string, logger *log.Logger) (checked, bad int) {
	for _, dir := range []string{shared, filepath.Dir(shared)} {
		sumsPath := filepath.Join(dir, "SHA256SUMS.txt")
		raw, err := os.ReadFile(sumsPath)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				continue
			}
			want, name := strings.ToLower(fields[0]), strings.TrimPrefix(fields[1], "*")
			target := filepath.Join(dir, filepath.FromSlash(name))
			f, err := os.Open(target)
			if err != nil {
				continue
			}
			h := sha256.New()
			_, copyErr := io.Copy(h, f)
			_ = f.Close()
			if copyErr != nil {
				continue
			}
			checked++
			if hex.EncodeToString(h.Sum(nil)) != want {
				bad++
				logger.Printf("integrity warning: %s does not match SHA256SUMS.txt", name)
			}
		}
		if checked > 0 {
			if bad == 0 {
				logger.Printf("integrity check: %d files verified against %s", checked, sumsPath)
			} else {
				logger.Printf("integrity check: %d of %d files FAILED verification; the payload may be corrupted or modified", bad, checked)
			}
		}
		return checked, bad
	}
	return 0, 0
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func writeOpenMe(shared, url string) error {
	path := filepath.Join(shared, "OPEN-THIS-ADDRESS.txt")
	return os.WriteFile(path, []byte(url+"\n"), 0o600)
}

func newLogger() (*log.Logger, func()) {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	dir = filepath.Join(dir, "readaloud-"+editionID)
	_ = os.MkdirAll(dir, 0o700)
	f, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return log.New(os.Stderr, "readaloud: ", log.LstdFlags), func() {}
	}
	return log.New(f, "readaloud: ", log.LstdFlags), func() { _ = f.Close() }
}

func fatal(logger *log.Logger, err error) {
	logger.Printf("fatal: %v", err)
	message := appName + " could not start.\n\n" + err.Error()
	switch runtime.GOOS {
	case "windows":
		temp := filepath.Join(os.TempDir(), "ReadAloud-Error.txt")
		_ = os.WriteFile(temp, []byte(message+"\n"), 0o600)
		_ = exec.Command("notepad.exe", temp).Start()
	case "darwin":
		script := fmt.Sprintf(`display alert %q message %q as critical`, appName, err.Error())
		_ = exec.Command("osascript", "-e", script).Run()
	default:
		fmt.Fprintln(os.Stderr, message)
	}
	os.Exit(1)
}
