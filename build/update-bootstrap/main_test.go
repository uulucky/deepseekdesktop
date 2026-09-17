package main

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExtractPayloadPreservesDataAndStagesExecutable(t *testing.T) {
	root := t.TempDir()
	dataFile := filepath.Join(root, "data", "session.json")
	if err := os.MkdirAll(filepath.Dir(dataFile), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dataFile, []byte("keep-me"), 0644); err != nil {
		t.Fatal(err)
	}
	oldExe := filepath.Join(root, defaultExeName)
	if err := os.WriteFile(oldExe, []byte("bootstrap"), 0644); err != nil {
		t.Fatal(err)
	}

	payload := filepath.Join(t.TempDir(), "payload.zip")
	file, err := os.Create(payload)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"DeepSeekDesktop-0.2.9-portable/DeepSeek Desktop.exe":                                           "real-application",
		"DeepSeekDesktop-0.2.9-portable/resources/" + strings.Repeat("long-segment/", 15) + "asset.txt": "payload",
		"DeepSeekDesktop-0.2.9-portable/data/session.json":                                              "must-not-replace",
	}
	for name, contents := range entries {
		item, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := item.Write([]byte(contents)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	nextExe, err := extractPayload(payload, root, defaultExeName, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertFileContents(t, oldExe, "bootstrap")
	assertFileContents(t, nextExe, "real-application")
	assertFileContents(t, dataFile, "keep-me")
	longTarget := filepath.Join(root, "resources", filepath.FromSlash(strings.Repeat("long-segment/", 15)), "asset.txt")
	assertFileContents(t, longTarget, "payload")

	directRoot := t.TempDir()
	directExe := filepath.Join(directRoot, defaultExeName)
	if err := os.WriteFile(directExe, []byte("old-application"), 0644); err != nil {
		t.Fatal(err)
	}
	launched, err := extractPayload(payload, directRoot, defaultExeName, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if launched != directExe {
		t.Fatalf("direct executable = %q, want %q", launched, directExe)
	}
	assertFileContents(t, directExe, "real-application")
	if _, err := os.Stat(filepath.Join(directRoot, "DeepSeek Desktop.next.exe")); !os.IsNotExist(err) {
		t.Fatalf("direct mode unexpectedly staged an executable: %v", err)
	}
}

func TestEnsurePayloadDownloadsAndVerifies(t *testing.T) {
	contents := []byte("portable zip bytes")
	digest := fmt.Sprintf("%x", sha256.Sum256(contents))
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(contents)
	}))
	defer server.Close()

	originalURL, originalHash := payloadURL, payloadSHA256
	payloadURL, payloadSHA256 = server.URL+"/payload.zip", digest
	defer func() { payloadURL, payloadSHA256 = originalURL, originalHash }()

	target := filepath.Join(t.TempDir(), "update-payload.zip")
	if err := ensurePayload(target, nil); err != nil {
		t.Fatal(err)
	}
	assertFileContents(t, target, string(contents))
	valid, err := payloadMatches(target)
	if err != nil || !valid {
		t.Fatalf("payloadMatches() = %v, %v", valid, err)
	}
}

func TestSignalReadyCreatesDurableAcknowledgement(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "nested", "bootstrap.ready")
	if err := signalReady(ready); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(ready)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(contents), "pid=") || !strings.Contains(string(contents), "time=") {
		t.Fatalf("unexpected acknowledgement: %q", contents)
	}
}

func TestWaitForAppReadyTracksVisibleStartupAcknowledgement(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "app-started-123.ready")
	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = os.WriteFile(ready, []byte("visible\n"), 0644)
	}()
	if !waitForAppReady(ready, time.Second) {
		t.Fatal("waitForAppReady timed out before the acknowledgement appeared")
	}
	if waitForAppReady(filepath.Join(t.TempDir(), "missing.ready"), 10*time.Millisecond) {
		t.Fatal("waitForAppReady accepted a missing acknowledgement")
	}
}

func assertFileContents(t *testing.T, path, expected string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != expected {
		t.Fatalf("%s = %q, want %q", path, contents, expected)
	}
}
