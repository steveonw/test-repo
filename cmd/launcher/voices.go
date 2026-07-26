package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// SpeakerEntry names one speaker row inside a multi-speaker (kitten) model.
type SpeakerEntry struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// VoiceManifest is the strict per-package voice.json schema.
type VoiceManifest struct {
	SchemaVersion         int            `json:"schemaVersion"`
	ID                    string         `json:"id"`
	Name                  string         `json:"name"`
	Language              string         `json:"language"`
	Locale                string         `json:"locale"`
	Engine                string         `json:"engine"`
	Architecture          string         `json:"architecture"`
	Model                 string         `json:"model"`
	Tokens                string         `json:"tokens"`
	Voices                string         `json:"voices"`    // kitten only: style/speaker rows
	SpeakerID             *int           `json:"speakerId"` // kitten only: lock package to one speaker (v1 style)
	Speakers              []SpeakerEntry `json:"speakers"`  // kitten only, schema v2: name the speakers
	Quality               string         `json:"quality"`
	Quantization          string         `json:"quantization"`
	SampleRate            int            `json:"sampleRate"`
	MinimumRuntimeVersion string         `json:"minimumRuntimeVersion"`
	Default               bool           `json:"default"`
}

// VoiceInfo is what the browser receives: validated metadata plus safe
// same-origin URLs. Nothing from the manifest reaches the page unchecked.
type VoiceInfo struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Locale        string         `json:"locale"`
	Quality       string         `json:"quality"`
	SampleRate    int            `json:"sampleRate"`
	Architecture  string         `json:"architecture"`
	ModelURL      string         `json:"modelUrl"`
	TokensURL     string         `json:"tokensUrl"`
	VoicesURL     string         `json:"voicesUrl,omitempty"` // kitten only
	SpeakerID     int            `json:"speakerId"`
	LockedSpeaker bool           `json:"lockedSpeaker,omitempty"` // v1-style package pinned to one speaker
	Speakers      []SpeakerEntry `json:"speakers,omitempty"`      // named speakers, when the package declares them
	Default       bool           `json:"default"`
}

type InvalidVoice struct {
	Dir    string `json:"dir"`
	Reason string `json:"reason"`
}

var voiceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// safeAssetName rejects anything that could escape the voice directory.
func safeAssetName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	return name == filepath.Base(name)
}

func validateVoiceDir(dir string) (*VoiceManifest, string) {
	raw, err := os.ReadFile(filepath.Join(dir, "voice.json"))
	if err != nil {
		return nil, "missing voice.json"
	}
	var m VoiceManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "voice.json is not valid JSON"
	}
	if m.SchemaVersion != 1 && m.SchemaVersion != 2 {
		return nil, "unsupported schemaVersion"
	}
	if !voiceIDPattern.MatchString(m.ID) {
		return nil, "invalid voice id"
	}
	// Two model families are supported, both run by the same shared engine:
	// piper-style VITS (model + tokens) and KittenTTS (model + tokens +
	// voices.bin holding the style/speaker rows). Anything else is refused
	// rather than allowed to fail deep inside the engine.
	switch {
	case m.Engine == "sherpa-vits" && m.Architecture == "vits":
	case m.Engine == "sherpa-kitten" && m.Architecture == "kitten":
	case m.Engine == "sherpa-vits" && m.Architecture != "vits",
		m.Engine == "sherpa-kitten" && m.Architecture != "kitten":
		return nil, "engine and architecture do not match"
	case m.Engine != "sherpa-vits" && m.Engine != "sherpa-kitten":
		return nil, "unsupported engine"
	default:
		return nil, "unsupported model architecture"
	}
	if m.Quantization != "" && m.Quantization != "none" {
		return nil, "quantized voices are not supported by this runtime yet"
	}
	if m.Name == "" {
		return nil, "missing display name"
	}
	if !safeAssetName(m.Model) || !safeAssetName(m.Tokens) {
		return nil, "model and tokens must be plain filenames inside the package"
	}
	required := []string{m.Model, m.Tokens}
	// Speaker rules are architecture-neutral: kitten carries several speakers
	// in voices.bin, and multi-speaker VITS models (e.g. LibriTTS-R, 904
	// speakers) carry them in the model itself. Either way the engine selects
	// by sid at generate time.
	if m.SpeakerID != nil && (*m.SpeakerID < 0 || *m.SpeakerID > 4095) {
		return nil, "speakerId out of range"
	}
	if m.Speakers != nil {
		if m.SchemaVersion < 2 {
			return nil, "speakers requires schemaVersion 2"
		}
		if m.SpeakerID != nil {
			return nil, "use speakerId or speakers, not both"
		}
		if len(m.Speakers) == 0 || len(m.Speakers) > 1024 {
			return nil, "speakers must list between 1 and 1024 entries"
		}
		seenSpk := map[int]bool{}
		for _, s := range m.Speakers {
			if s.ID < 0 || s.ID > 4095 {
				return nil, "speaker id out of range"
			}
			if seenSpk[s.ID] {
				return nil, "duplicate speaker id"
			}
			seenSpk[s.ID] = true
			name := strings.TrimSpace(s.Name)
			if name == "" || len(name) > 64 {
				return nil, "every speaker needs a name up to 64 characters"
			}
		}
	}
	if m.Architecture == "kitten" {
		if m.Voices == "" {
			return nil, "kitten packages need a voices file (voices.bin)"
		}
		if !safeAssetName(m.Voices) {
			return nil, "voices must be a plain filename inside the package"
		}
		required = append(required, m.Voices)
	}
	for _, f := range required {
		if st, err := os.Stat(filepath.Join(dir, f)); err != nil || st.IsDir() {
			return nil, "missing file: " + f
		}
	}
	return &m, ""
}

// scanVoices discovers and validates every package under voicesDir.
// One bad package never blocks the good ones.
func scanVoices(voicesDir string) ([]VoiceInfo, []InvalidVoice) {
	// non-nil so the JSON API always emits [] rather than null
	valid := []VoiceInfo{}
	invalid := []InvalidVoice{}
	entries, err := os.ReadDir(voicesDir)
	if err != nil {
		return valid, invalid
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(voicesDir, e.Name())
		m, reason := validateVoiceDir(dir)
		if reason != "" {
			invalid = append(invalid, InvalidVoice{Dir: e.Name(), Reason: reason})
			continue
		}
		if seen[m.ID] {
			invalid = append(invalid, InvalidVoice{Dir: e.Name(), Reason: "duplicate voice id: " + m.ID})
			continue
		}
		seen[m.ID] = true
		sr := m.SampleRate
		if sr <= 0 {
			sr = 22050
		}
		info := VoiceInfo{
			ID: m.ID, Name: m.Name, Locale: m.Locale, Quality: m.Quality,
			SampleRate:   sr,
			Architecture: m.Architecture,
			ModelURL:     "voices/" + e.Name() + "/" + m.Model,
			TokensURL:    "voices/" + e.Name() + "/" + m.Tokens,
			Default:      m.Default,
		}
		if m.Architecture == "kitten" {
			info.VoicesURL = "voices/" + e.Name() + "/" + m.Voices
		}
		if m.SpeakerID != nil {
			info.SpeakerID = *m.SpeakerID
			info.LockedSpeaker = true // package pinned to one speaker
		}
		if len(m.Speakers) > 0 {
			info.Speakers = m.Speakers
		}
		valid = append(valid, info)
	}
	sort.Slice(valid, func(i, j int) bool { return valid[i].Name < valid[j].Name })
	return valid, invalid
}
