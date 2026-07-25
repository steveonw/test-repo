package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeVoice(t *testing.T, root, dir, manifest string, files ...string) {
	t.Helper()
	d := filepath.Join(root, dir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if manifest != "" {
		os.WriteFile(filepath.Join(d, "voice.json"), []byte(manifest), 0o644)
	}
	for _, f := range files {
		os.WriteFile(filepath.Join(d, f), []byte("x"), 0o644)
	}
}

const goodManifest = `{"schemaVersion":1,"id":"amy-medium","name":"Amy Medium","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quality":"medium","quantization":"none","sampleRate":22050}`

func TestScanVoices(t *testing.T) {
	root := t.TempDir()
	writeVoice(t, root, "amy-medium", goodManifest, "model.onnx", "tokens.txt")
	writeVoice(t, root, "lessac-high", `{"schemaVersion":1,"id":"lessac-high","name":"Lessac High","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "bad-json", `{nope`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "no-model", goodManifest, "tokens.txt")
	writeVoice(t, root, "traversal", `{"schemaVersion":1,"id":"evil","name":"Evil","engine":"sherpa-vits","architecture":"vits","model":"../../secret","tokens":"tokens.txt","quantization":"none"}`, "tokens.txt")
	writeVoice(t, root, "wrong-arch", `{"schemaVersion":1,"id":"matcha","name":"M","engine":"sherpa-vits","architecture":"matcha","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "quantized", `{"schemaVersion":1,"id":"q","name":"Q","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"int8"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "dup", goodManifest, "model.onnx", "tokens.txt")
	// kitten family: valid, and the ways it can be wrong
	writeVoice(t, root, "kitten-good", `{"schemaVersion":1,"id":"kitten-micro","name":"Kitten Micro","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakerId":3}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "kitten-no-voices", `{"schemaVersion":1,"id":"kno","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "kitten-missing-bin", `{"schemaVersion":1,"id":"kmb","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "kitten-traversal", `{"schemaVersion":1,"id":"ktr","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"../../secret.bin","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "mismatch", `{"schemaVersion":1,"id":"mm","name":"M","engine":"sherpa-kitten","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")
	writeVoice(t, root, "bad-speaker", `{"schemaVersion":1,"id":"bs","name":"B","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakerId":900}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "old-schema", `{"schemaVersion":2,"id":"v2","name":"V2","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")

	valid, invalid := scanVoices(root)
	if len(valid) != 3 {
		t.Fatalf("want 3 valid voices, got %d: %+v", len(valid), valid)
	}
	// sorted by display name: Amy Medium, Kitten Micro, Lessac High
	if valid[0].Name != "Amy Medium" || valid[1].Name != "Kitten Micro" || valid[2].Name != "Lessac High" {
		t.Fatalf("wrong ordering: %+v", valid)
	}
	k := valid[1]
	if k.Architecture != "kitten" || k.VoicesURL != "voices/kitten-good/voices.bin" || k.SpeakerID != 3 {
		t.Fatalf("kitten fields wrong: %+v", k)
	}
	if valid[0].VoicesURL != "" {
		t.Fatalf("vits voice must not carry a voices url: %+v", valid[0])
	}
	if valid[0].ModelURL != "voices/amy-medium/model.onnx" {
		t.Fatalf("bad model url: %s", valid[0].ModelURL)
	}
	reasons := map[string]string{}
	for _, iv := range invalid {
		reasons[iv.Dir] = iv.Reason
	}
	for dir, want := range map[string]string{
		"bad-json": "not valid JSON", "no-model": "missing file", "traversal": "plain filenames",
		"wrong-arch": "architecture", "quantized": "quantized", "dup": "duplicate", "old-schema": "schemaVersion",
		"kitten-no-voices": "voices file", "kitten-missing-bin": "missing file", "kitten-traversal": "plain filename",
		"mismatch": "do not match", "bad-speaker": "speakerId",
	} {
		if r, ok := reasons[dir]; !ok || !contains(r, want) {
			t.Errorf("%s: want reason containing %q, got %q", dir, want, r)
		}
	}
}

func TestEmptyVoicesDir(t *testing.T) {
	valid, invalid := scanVoices(filepath.Join(t.TempDir(), "nope"))
	if len(valid) != 0 || len(invalid) != 0 {
		t.Fatal("missing dir must yield empty results")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
