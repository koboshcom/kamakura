package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

var buildRevision = "unknown"
var buildTimestamp = "0"

const releaseRepo = "https://api.github.com/repos/koboshcom/kamakura"
const maxArchive = 32 << 20
const maxBinary = 64 << 20

var releaseTag = regexp.MustCompile("^[0-9a-f]{7}$")
var revisionTag = regexp.MustCompile("^[0-9a-f]{40}$")

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}
type cliRelease struct {
	Tag        string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Published  time.Time      `json:"published_at"`
	Assets     []releaseAsset `json:"assets"`
}
type releaseHTTP struct{ client *http.Client }

func newReleaseHTTP() releaseHTTP {
	return releaseHTTP{&http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{
		Proxy: nil, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
	}, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !trustedDownloadURL(r.URL) {
			return errors.New("untrusted release redirect")
		}
		return nil
	}}}
}
func trustedDownloadURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch u.Hostname() {
	case "github.com":
		return strings.HasPrefix(u.Path, "/koboshcom/kamakura/releases/download/")
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}
func (h releaseHTTP) get(ctx context.Context, raw string, limit int64, api bool) ([]byte, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return nil, errors.New("invalid release URL")
	}
	if api {
		if u.Scheme != "https" || u.Host != "api.github.com" || u.User != nil || !strings.HasPrefix(u.Path, "/repos/koboshcom/kamakura/releases") {
			return nil, errors.New("untrusted release API")
		}
	} else if !trustedDownloadURL(u) {
		return nil, errors.New("untrusted release asset")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "kamakura-cli-updater")
	r, e := h.client.Do(req)
	if e != nil {
		return nil, errors.New("release request failed or timed out")
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release unavailable (HTTP %d); retry manually later", r.StatusCode)
	}
	if r.ContentLength > limit {
		return nil, errors.New("release response too large")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if e != nil {
		return nil, errors.New("release download interrupted")
	}
	if int64(len(b)) > limit {
		return nil, errors.New("release response too large")
	}
	return b, nil
}
func platformAsset(tag, goos, arch string) (string, error) {
	platform := goos
	if goos == "darwin" {
		platform = "macos"
	}
	if !((goos == "linux" || goos == "windows") && (arch == "amd64" || arch == "arm64") || goos == "darwin" && arch == "arm64") {
		return "", errors.New("no published CLI asset for this OS/architecture")
	}
	return "kamakura-cli-" + tag + "-" + platform + "-" + arch + ".zip", nil
}
func selectRelease(rows []cliRelease, chosen string, nowRevision string, nowTimestamp int64) (cliRelease, error) {
	var candidates []cliRelease
	for _, r := range rows {
		if !r.Draft && r.Prerelease && releaseTag.MatchString(r.Tag) && !r.Published.IsZero() {
			candidates = append(candidates, r)
		}
	}
	if chosen != "" {
		for _, r := range candidates {
			if r.Tag == chosen {
				return r, nil
			}
		}
		return cliRelease{}, errors.New("requested prerelease not found")
	}
	if len(candidates) == 0 {
		return cliRelease{}, errors.New("no published prerelease")
	}
	newest := candidates[0]
	for _, r := range candidates[1:] {
		if r.Published.After(newest.Published) {
			newest = r
		}
	}
	if strings.HasPrefix(nowRevision, newest.Tag) {
		return newest, nil
	}
	if nowTimestamp <= 0 {
		return cliRelease{}, errors.New("current build version is unknown; select a release tag explicitly")
	}
	if !newest.Published.After(time.Unix(nowTimestamp, 0)) {
		return cliRelease{}, errors.New("latest prerelease is not newer; choose a tag explicitly to downgrade")
	}
	return newest, nil
}
func assetURLs(r cliRelease, name string) (string, string, error) {
	var archive, sums string
	for _, a := range r.Assets {
		if a.Name != name && a.Name != "SHA256SUMS" {
			continue
		}
		u, e := url.Parse(a.URL)
		prefix := "https://github.com/koboshcom/kamakura/releases/download/" + r.Tag + "/"
		if e != nil || u.RawQuery != "" || u.Fragment != "" || a.URL != prefix+a.Name || a.Size <= 0 {
			return "", "", errors.New("invalid same-release asset metadata")
		}
		if a.Name == name {
			if archive != "" || a.Size > maxArchive {
				return "", "", errors.New("invalid archive size or duplicate asset")
			}
			archive = a.URL
		} else {
			if sums != "" || a.Size > 65536 {
				return "", "", errors.New("invalid checksum asset")
			}
			sums = a.URL
		}
	}
	if archive == "" || sums == "" {
		return "", "", errors.New("release lacks archive or SHA256SUMS; no unverified fallback")
	}
	return archive, sums, nil
}
func verifyArchive(archive, sums []byte, name string) error {
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || len(fields[0]) != 64 {
			return errors.New("invalid SHA256SUMS")
		}
		if _, e := hex.DecodeString(fields[0]); e != nil {
			return errors.New("invalid checksum")
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			if want != "" {
				return errors.New("duplicate checksum")
			}
			want = strings.ToLower(fields[0])
		}
	}
	got := sha256.Sum256(archive)
	if want == "" || want != hex.EncodeToString(got[:]) {
		return errors.New("release checksum mismatch")
	}
	return nil
}
func unpackCLI(archive []byte, goos, arch string) ([]byte, error) {
	if len(archive) > maxArchive {
		return nil, errors.New("archive exceeds compressed limit")
	}
	z, e := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if e != nil {
		return nil, errors.New("invalid CLI archive")
	}
	name := "kamakura-cli"
	if goos == "windows" {
		name += ".exe"
	}
	// CI archives contain exactly ONE regular executable, never extra paths.
	if len(z.File) != 1 {
		return nil, errors.New("archive must contain exactly one binary")
	}
	f := z.File[0]
	if f.Name != name || f.Mode()&os.ModeType != 0 || f.UncompressedSize64 == 0 || f.UncompressedSize64 > maxBinary || f.Flags&1 != 0 {
		return nil, errors.New("unsafe archive member")
	}
	r, e := f.Open()
	if e != nil {
		return nil, errors.New("cannot open archive member")
	}
	defer r.Close()
	data, e := io.ReadAll(io.LimitReader(r, maxBinary+1))
	if e != nil || len(data) > maxBinary || uint64(len(data)) != f.UncompressedSize64 {
		return nil, errors.New("invalid or oversized extracted binary")
	}
	if e = validateBinary(data, goos, arch); e != nil {
		return nil, e
	}
	return data, nil
}
func validateBinary(data []byte, goos, arch string) error {
	wrong := errors.New("binary OS/architecture does not match this CLI")
	switch goos {
	case "linux":
		f, e := elf.NewFile(bytes.NewReader(data))
		if e != nil {
			return wrong
		}
		defer f.Close()
		machine := elf.EM_X86_64
		if arch == "arm64" {
			machine = elf.EM_AARCH64
		}
		if f.Machine != machine || f.Class != elf.ELFCLASS64 || f.Type != elf.ET_EXEC && f.Type != elf.ET_DYN {
			return wrong
		}
	case "darwin":
		f, e := macho.NewFile(bytes.NewReader(data))
		if e != nil {
			return wrong
		}
		defer f.Close()
		if arch != "arm64" || f.Cpu != macho.CpuArm64 || f.Type != macho.TypeExec {
			return wrong
		}
	case "windows":
		f, e := pe.NewFile(bytes.NewReader(data))
		if e != nil {
			return wrong
		}
		defer f.Close()
		machine := uint16(pe.IMAGE_FILE_MACHINE_AMD64)
		if arch == "arm64" {
			machine = pe.IMAGE_FILE_MACHINE_ARM64
		}
		if f.Machine != machine || f.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 {
			return wrong
		}
	default:
		return wrong
	}
	return nil
}

// Prepared files and backups stay on the same filesystem as the installed binary.
func installCLI(path string, data []byte, replace func(string, string) error) error {
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0022 != 0 || st.Size() > maxBinary {
		return errors.New("installed binary must be regular and not group/world-writable")
	}
	dir := filepath.Dir(path)
	lock := flock.New(path + ".update-lock")
	ok, e := lock.TryLock()
	if e != nil || !ok {
		return errors.New("another CLI update is running or directory is not writable")
	}
	defer lock.Unlock()
	backup := path + ".previous"
	if _, e = os.Lstat(backup); !os.IsNotExist(e) {
		return errors.New("previous binary already retained; archive it before another update")
	}
	tmp, e := os.CreateTemp(dir, ".kamakura-update-*")
	if e != nil {
		return errors.New("cannot stage update next to installed binary")
	}
	staged := tmp.Name()
	defer os.Remove(staged)
	if e = tmp.Chmod(st.Mode().Perm()); e == nil {
		_, e = tmp.Write(data)
	}
	if e == nil {
		e = tmp.Sync()
	}
	ce := tmp.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return errors.New("update staging failed; old binary untouched")
	}
	// Back up before replacement. Never execute the downloaded file.
	old, e := os.Open(path)
	if e != nil {
		return e
	}
	defer old.Close()
	b, e := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode().Perm())
	if e != nil {
		return errors.New("cannot create previous-binary backup")
	}
	_, e = io.Copy(b, io.LimitReader(old, maxBinary+1))
	if e == nil {
		e = b.Sync()
	}
	ce = b.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		os.Remove(backup)
		return errors.New("backup failed; old binary untouched")
	}
	if e = preserveBinaryPermissions(path, staged, backup); e != nil {
		os.Remove(backup)
		return errors.New("cannot preserve binary permissions; old binary untouched")
	}
	if runtime.GOOS == "windows" {
		// Windows cannot atomically overwrite an executing image. Rename it first,
		// then restore that exact file if the second rename fails.
		running := path + ".running-old"
		if _, e = os.Lstat(running); !os.IsNotExist(e) {
			return errors.New("old Windows executable remains; manual cleanup required")
		}
		if e = os.Rename(path, running); e != nil {
			os.Remove(backup)
			return errors.New("Windows executable busy; stop connector and retry")
		}
		if e = replace(staged, path); e != nil {
			if re := os.Rename(running, path); re != nil {
				return errors.New("Windows replacement and restore failed; recover the .running-old binary manually")
			}
			os.Remove(backup)
			return errors.New("replacement failed; previous binary restored")
		}
	} else if e = replace(staged, path); e != nil {
		os.Remove(backup)
		return errors.New("atomic replacement failed; previous binary untouched")
	}
	if d, e := os.Open(dir); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func cliUpdate(args []string) error {
	if len(args) > 1 {
		return errors.New("usage kamakura-cli update [seven-character-release-tag]")
	}
	chosen := ""
	if len(args) == 1 {
		chosen = args[0]
		if !releaseTag.MatchString(chosen) {
			return errors.New("release tag must be seven lowercase hexadecimal characters")
		}
	}
	var state State
	if readJSON("state.json", &state) == nil && fresh(state) {
		return errors.New("stop the connector before updating")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	h := newReleaseHTTP()
	endpoint := releaseRepo + "/releases?per_page=100"
	if chosen != "" {
		endpoint = releaseRepo + "/releases/tags/" + chosen
	}
	b, e := h.get(ctx, endpoint, 2<<20, true)
	if e != nil {
		return e
	}
	var rows []cliRelease
	if chosen != "" {
		var r cliRelease
		e = json.Unmarshal(b, &r)
		rows = []cliRelease{r}
	} else {
		e = json.Unmarshal(b, &rows)
	}
	if e != nil {
		return errors.New("invalid release metadata")
	}
	timestamp, _ := strconv.ParseInt(buildTimestamp, 10, 64)
	r, e := selectRelease(rows, chosen, buildRevision, timestamp)
	if e != nil {
		return e
	}
	if strings.HasPrefix(buildRevision, r.Tag) {
		fmt.Println("CLI already matches", r.Tag)
		return nil
	}
	name, e := platformAsset(r.Tag, runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return e
	}
	archiveURL, sumURL, e := assetURLs(r, name)
	if e != nil {
		return e
	}
	sums, e := h.get(ctx, sumURL, 65536, false)
	if e != nil {
		return e
	}
	archive, e := h.get(ctx, archiveURL, maxArchive, false)
	if e != nil {
		return e
	}
	if e = verifyArchive(archive, sums, name); e != nil {
		return e
	}
	binary, e := unpackCLI(archive, runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return e
	}
	path, e := os.Executable()
	if e != nil {
		return e
	}
	if e = installCLI(path, binary, os.Rename); e != nil {
		return e
	}
	fmt.Println("Verified CLI", r.Tag, "installed. Config and pairing unchanged. Previous binary is", path+".previous")
	if runtime.GOOS == "windows" {
		fmt.Println("Exit this process and relaunch the CLI manually; remove .running-old only after exit.")
	}
	return nil
}
