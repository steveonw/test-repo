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
	writeVoice(t, root, "bad-speaker", `{"schemaVersion":1,"id":"bs","name":"B","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakerId":90000}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "old-schema", `{"schemaVersion":3,"id":"v3","name":"V3","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"none"}`, "model.onnx", "tokens.txt")
	// schema v2 multi-speaker kitten: valid, and the ways it can be wrong
	writeVoice(t, root, "kitten-multi", `{"schemaVersion":2,"id":"kitten-multi","name":"Kitten Multi","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakers":[{"id":0,"name":"Bella"},{"id":1,"name":"Jasper"}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "spk-conflict", `{"schemaVersion":2,"id":"kc","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakerId":1,"speakers":[{"id":0,"name":"A"}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "spk-on-v1", `{"schemaVersion":1,"id":"kv1","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakers":[{"id":0,"name":"A"}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "spk-dup", `{"schemaVersion":2,"id":"kd","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakers":[{"id":2,"name":"A"},{"id":2,"name":"B"}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "spk-range", `{"schemaVersion":2,"id":"kr","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakers":[{"id":90000,"name":"A"}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "spk-noname", `{"schemaVersion":2,"id":"kn","name":"K","engine":"sherpa-kitten","architecture":"kitten","model":"model.onnx","tokens":"tokens.txt","voices":"voices.bin","quantization":"none","speakers":[{"id":0,"name":"  "}]}`, "model.onnx", "tokens.txt", "voices.bin")
	writeVoice(t, root, "libri-mini", `{"schemaVersion":2,"id":"libri-mini","name":"Libri Two","engine":"sherpa-vits","architecture":"vits","model":"model.onnx","tokens":"tokens.txt","quantization":"none","speakers":[{"id":12,"name":"Warm Reader"},{"id":903,"name":"Last Row"}]}`, "model.onnx", "tokens.txt")

	valid, invalid := scanVoices(root)
	if len(valid) != 5 {
		t.Fatalf("want 5 valid voices, got %d: %+v", len(valid), valid)
	}
	// sorted by display name
	if valid[0].Name != "Amy Medium" || valid[1].Name != "Kitten Micro" || valid[2].Name != "Kitten Multi" || valid[3].Name != "Lessac High" || valid[4].Name != "Libri Two" {
		t.Fatalf("wrong ordering: %+v", valid)
	}
	lb := valid[4]
	if lb.Architecture != "vits" || lb.LockedSpeaker || len(lb.Speakers) != 2 || lb.Speakers[1].ID != 903 || lb.VoicesURL != "" {
		t.Fatalf("multi-speaker vits fields wrong: %+v", lb)
	}
	k := valid[1]
	if k.Architecture != "kitten" || k.VoicesURL != "voices/kitten-good/voices.bin" || k.SpeakerID != 3 || !k.LockedSpeaker {
		t.Fatalf("kitten fields wrong: %+v", k)
	}
	km := valid[2]
	if km.LockedSpeaker || len(km.Speakers) != 2 || km.Speakers[0].Name != "Bella" || km.Speakers[1].ID != 1 {
		t.Fatalf("multi-speaker fields wrong: %+v", km)
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
		"spk-conflict": "not both", "spk-on-v1": "schemaVersion 2", "spk-dup": "duplicate speaker",
		"spk-range": "out of range", "spk-noname": "name",
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

func TestScanAddons(t *testing.T) {
	if got := scanAddons(filepath.Join(t.TempDir(), "missing")); len(got) != 0 {
		t.Fatalf("missing dir must report no addons, got %v", got)
	}
	root := t.TempDir()
	for _, d := range []string{"docx", "some-addon", "BadName", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "loosefile.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := scanAddons(root)
	if len(got) != 2 || got[0] != "docx" || got[1] != "some-addon" {
		t.Fatalf("want [docx some-addon], got %v", got)
	}
}
