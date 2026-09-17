package main

// DeepSeek Desktop update bootstrap.
//
// PowerShell's Expand-Archive fails on the full dependency tree when a path crosses legacy
// MAX_PATH. This small native process is launched directly by current clients (or once through
// the repair CMD for affected old clients). It acknowledges startup, downloads the separately
// published portable ZIP, verifies its build-pinned SHA-256, expands it with Go's long-path-aware
// Windows file APIs, then hands only the final executable swap to PowerShell after it exits.

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const defaultExeName = "DeepSeek Desktop.exe"

// Filled by make-portable.js through -ldflags. Keeping these out of source means each bootstrap
// is cryptographically pinned to the portable payload produced in the same build.
var payloadURL string
var payloadSHA256 string

func main() {
	root, payload, exeName, readyFile, extractOnly, err := arguments()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	logPath := filepath.Join(root, "data", "logs", "update-bootstrap.log")
	logf := openLog(logPath)
	if logf != nil {
		defer logf.Close()
	}
	logLine(logf, "bootstrap starting; payload="+payload)
	var transition updateTransition = noopTransition{}
	if !extractOnly {
		transition = startUpdateTransition()
	}
	defer transition.Close()
	if !extractOnly {
		unlock, lockErr := acquireLock(root)
		if lockErr != nil {
			logLine(logf, "another update bootstrap is already running: "+lockErr.Error())
			return
		}
		defer unlock()
	}
	if readyFile != "" {
		if err := signalReady(readyFile); err != nil {
			logLine(logf, "FAILED writing ready acknowledgement: "+err.Error())
			os.Exit(1)
		}
		logLine(logf, "ready acknowledgement written: "+readyFile)
	}
	transition.SetDetail("正在下载并校验新版本…")
	if err := ensurePayload(payload, logf); err != nil {
		logLine(logf, "FAILED downloading payload: "+err.Error())
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	stageExecutable := runningAsTarget(root, exeName)
	transition.SetDetail("正在安装新版本，请勿关闭电脑…")
	nextExe, err := extractPayload(payload, root, exeName, stageExecutable, logf)
	if err != nil {
		logLine(logf, "FAILED: "+err.Error())
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	logLine(logf, "payload extracted; next executable="+nextExe)
	if extractOnly {
		fmt.Println(nextExe)
		return
	}
	if !stageExecutable {
		_ = os.Remove(payload)
		startupReadyFile := filepath.Join(root, "data", "update", fmt.Sprintf("app-started-%d.ready", os.Getpid()))
		_ = os.Remove(startupReadyFile)
		transition.SetDetail("安装完成，正在重新启动软件…")
		if err := startUpdatedApp(root, exeName, startupReadyFile); err != nil {
			logLine(logf, "FAILED starting updated app: "+err.Error())
			os.Exit(1)
		}
		if waitForAppReady(startupReadyFile, 60*time.Second) {
			logLine(logf, "updated app displayed its startup window")
		} else {
			logLine(logf, "updated app startup acknowledgement timed out; closing transition window")
		}
		_ = os.Remove(startupReadyFile)
		logLine(logf, "update completed successfully; started "+filepath.Join(root, exeName))
		return
	}

	// Compatibility for 0.2.6-0.2.10's legacy outer ZIP, which temporarily installs this
	// bootstrap over DeepSeek Desktop.exe. A running executable cannot replace itself, so only
	// that old path needs the final PowerShell rename.
	script, err := writeFinishScript(root)
	if err != nil {
		logLine(logf, "FAILED writing finish script: "+err.Error())
		os.Exit(1)
	}
	command := exec.Command("powershell.exe",
		"-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
		"-File", script,
		"-AppRoot", root,
		"-ExeName", exeName,
		"-NextExe", nextExe,
		"-Payload", payload,
		"-ParentPid", fmt.Sprint(os.Getpid()),
		"-LogFile", logPath,
	)
	command.Stdin = nil
	command.Stdout = logf
	command.Stderr = logf
	if err := command.Start(); err != nil {
		logLine(logf, "FAILED starting finish script: "+err.Error())
		os.Exit(1)
	}
	logLine(logf, "finish script started")
}

func acquireLock(root string) (func(), error) {
	path := filepath.Join(root, "data", "update", "update-bootstrap.lock")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) > 30*time.Minute {
		_ = os.Remove(path)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	_, _ = fmt.Fprintln(file, os.Getpid())
	return func() {
		_ = file.Close()
		_ = os.Remove(path)
	}, nil
}

func ensurePayload(payload string, logf *os.File) error {
	if _, err := os.Stat(payload); err == nil {
		valid, verifyErr := payloadMatches(payload)
		if verifyErr == nil && valid {
			logLine(logf, "using verified existing payload")
			return nil
		}
		logLine(logf, "discarding invalid existing payload")
		_ = os.Remove(payload)
	}
	if payloadURL == "" {
		return fmt.Errorf("payload is missing and no download URL was embedded")
	}
	if err := os.MkdirAll(filepath.Dir(payload), 0755); err != nil {
		return err
	}
	temporary := payload + ".download"
	_ = os.Remove(temporary)
	logLine(logf, "downloading "+payloadURL)
	client := &http.Client{Timeout: 30 * time.Minute}
	response, err := client.Get(payloadURL)
	if err != nil {
		return fmt.Errorf("download payload: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download payload: HTTP %d", response.StatusCode)
	}
	destination, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("create payload: %w", err)
	}
	hash := sha256.New()
	progress := &downloadProgress{total: response.ContentLength, logf: logf, lastPercent: -1}
	written, copyErr := io.Copy(io.MultiWriter(destination, hash, progress), response.Body)
	closeErr := destination.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("download payload body: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("close payload: %w", closeErr)
	}
	digest := fmt.Sprintf("%x", hash.Sum(nil))
	if payloadSHA256 != "" && !strings.EqualFold(digest, payloadSHA256) {
		_ = os.Remove(temporary)
		return fmt.Errorf("payload SHA-256 mismatch: got %s", digest)
	}
	if err := os.Rename(temporary, payload); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("finish payload: %w", err)
	}
	logLine(logf, fmt.Sprintf("downloaded and verified payload (%d bytes, sha256=%s)", written, digest))
	return nil
}

type downloadProgress struct {
	total       int64
	written     int64
	lastPercent int
	logf        *os.File
}

func (progress *downloadProgress) Write(value []byte) (int, error) {
	progress.written += int64(len(value))
	if progress.total > 0 {
		percent := int(progress.written * 100 / progress.total)
		bucket := percent / 10 * 10
		if bucket > progress.lastPercent && bucket < 100 {
			progress.lastPercent = bucket
			logLine(progress.logf, fmt.Sprintf("download progress %d%%", bucket))
		}
	}
	return len(value), nil
}

func payloadMatches(path string) (bool, error) {
	if payloadSHA256 == "" {
		return true, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false, err
	}
	return strings.EqualFold(fmt.Sprintf("%x", hash.Sum(nil)), payloadSHA256), nil
}

func arguments() (root, payload, exeName, readyFile string, extractOnly bool, err error) {
	executable, executableErr := os.Executable()
	if executableErr != nil {
		err = executableErr
		return
	}
	root = filepath.Dir(executable)
	payload = filepath.Join(root, "update-payload.zip")
	exeName = defaultExeName
	for index := 1; index < len(os.Args); index++ {
		switch os.Args[index] {
		case "--extract-only":
			extractOnly = true
		case "--app-root", "--payload", "--exe-name", "--ready-file":
			if index+1 >= len(os.Args) {
				err = fmt.Errorf("%s requires a value", os.Args[index])
				return
			}
			value := os.Args[index+1]
			index++
			switch os.Args[index-1] {
			case "--app-root":
				root = value
			case "--payload":
				payload = value
			case "--exe-name":
				exeName = value
			case "--ready-file":
				readyFile = value
			}
		}
	}
	root, err = filepath.Abs(root)
	if err == nil {
		payload, err = filepath.Abs(payload)
	}
	return
}

/** Tell the parent app that this process owns the update lock and its durable log is open. */
func signalReady(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0755); err != nil {
		return err
	}
	return os.WriteFile(absolute, []byte(fmt.Sprintf("pid=%d\ntime=%s\n", os.Getpid(), time.Now().Format(time.RFC3339Nano))), 0644)
}

func extractPayload(payload, root, exeName string, stageExecutable bool, logf *os.File) (string, error) {
	reader, err := zip.OpenReader(payload)
	if err != nil {
		return "", fmt.Errorf("open payload: %w", err)
	}
	defer reader.Close()

	prefix := ""
	needle := "/" + exeName
	for _, item := range reader.File {
		name := strings.TrimPrefix(filepath.ToSlash(item.Name), "/")
		if strings.HasSuffix(name, needle) {
			candidate := strings.TrimSuffix(name, exeName)
			if prefix == "" || len(candidate) < len(prefix) {
				prefix = candidate
			}
		}
	}
	if prefix == "" {
		return "", fmt.Errorf("payload does not contain %s", exeName)
	}

	nextExe := filepath.Join(root, strings.TrimSuffix(exeName, filepath.Ext(exeName))+".next"+filepath.Ext(exeName))
	count := 0
	for _, item := range reader.File {
		name := strings.TrimPrefix(filepath.ToSlash(item.Name), "/")
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		relSlash := strings.TrimPrefix(name, prefix)
		if relSlash == "" {
			continue
		}
		rel := filepath.Clean(filepath.FromSlash(relSlash))
		if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return "", fmt.Errorf("unsafe payload path %q", item.Name)
		}
		first := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		if strings.EqualFold(first, "data") {
			continue
		}
		target := filepath.Join(root, rel)
		if stageExecutable && strings.EqualFold(rel, exeName) {
			target = nextExe
		}
		if item.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return "", fmt.Errorf("create directory %s: %w", target, err)
			}
			continue
		}
		if err := writeZipFile(item, target); err != nil {
			return "", err
		}
		count++
		if count%1000 == 0 {
			logLine(logf, fmt.Sprintf("extracted %d files", count))
		}
	}
	launchExe := filepath.Join(root, exeName)
	if stageExecutable {
		launchExe = nextExe
	}
	if _, err := os.Stat(launchExe); err != nil {
		return "", fmt.Errorf("updated executable missing: %w", err)
	}
	logLine(logf, fmt.Sprintf("extracted %d files", count))
	return launchExe, nil
}

func runningAsTarget(root, exeName string) bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	self, selfErr := filepath.Abs(executable)
	target, targetErr := filepath.Abs(filepath.Join(root, exeName))
	return selfErr == nil && targetErr == nil && strings.EqualFold(filepath.Clean(self), filepath.Clean(target))
}

func startUpdatedApp(root, exeName, startupReadyFile string) error {
	command := exec.Command(filepath.Join(root, exeName))
	command.Dir = root
	command.Env = append(os.Environ(), "DEEPSEEK_DESKTOP_UPDATE_READY_FILE="+startupReadyFile)
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	return command.Start()
}

func waitForAppReady(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func writeZipFile(item *zip.File, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return fmt.Errorf("create parent for %s: %w", target, err)
	}
	var last error
	for attempt := 1; attempt <= 30; attempt++ {
		source, err := item.Open()
		if err != nil {
			return fmt.Errorf("open %s: %w", item.Name, err)
		}
		destination, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
		if err == nil {
			_, copyErr := io.Copy(destination, source)
			closeErr := destination.Close()
			source.Close()
			if copyErr == nil && closeErr == nil {
				return nil
			}
			if copyErr != nil {
				last = copyErr
			} else {
				last = closeErr
			}
		} else {
			source.Close()
			last = err
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("write %s after retries: %w", target, last)
}

func openLog(path string) *os.File {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil
	}
	file, _ := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	return file
}

func logLine(file *os.File, message string) {
	fmt.Println(message)
	if file != nil {
		fmt.Fprintf(file, "%s %s\n", time.Now().Format(time.RFC3339Nano), message)
	}
}

func writeFinishScript(root string) (string, error) {
	directory := filepath.Join(root, "data", "update")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "finish-bootstrap-update.ps1")
	const script = `param(
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$NextExe,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$LogFile
)
$ErrorActionPreference = 'Stop'
function Log([string]$Message) { Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8 }
try {
  Log ('waiting for bootstrap ' + $ParentPid)
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  $Target = Join-Path $AppRoot $ExeName
  $Moved = $false
  for ($Attempt = 1; $Attempt -le 30 -and -not $Moved; $Attempt++) {
    try {
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
      Move-Item -LiteralPath $NextExe -Destination $Target -Force
      $Moved = $true
    } catch {
      if ($Attempt -eq 30) { throw }
      Start-Sleep -Seconds 1
    }
  }
  Remove-Item -LiteralPath $Payload -Force -ErrorAction SilentlyContinue
  Log ('starting updated app ' + $Target)
  Start-Process -FilePath $Target -WorkingDirectory $AppRoot
  Log 'update completed successfully'
} catch {
  Log ('FAILED: ' + $_.Exception.ToString())
}
`
	return path, os.WriteFile(path, []byte(script), 0644)
}
