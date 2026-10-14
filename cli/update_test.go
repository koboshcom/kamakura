package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureELF(arm bool) []byte {
	b := make([]byte, 64)
	copy(b, []byte{0x7f, 'E', 'L', 'F', 2, 1, 1})
	binary.LittleEndian.PutUint16(b[16:], 2)
	m := uint16(62)
	if arm {
		m = 183
	}
	binary.LittleEndian.PutUint16(b[18:], m)
	binary.LittleEndian.PutUint32(b[20:], 1)
	binary.LittleEndian.PutUint16(b[52:], 64)
	return b
}
func fixtureZIP(t *testing.T, names []string, mode os.FileMode, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, name := range names {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(mode)
		f, e := w.CreateHeader(h)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.Write(data); e != nil {
			t.Fatal(e)
		}
	}
	if e := w.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestCLIUpdateHashBeforeUnpack(t *testing.T) {
	b := fixtureZIP(t, []string{"kamakura-cli"}, 0755, fixtureELF(false))
	name := "kamakura-cli-abcdef0-linux-amd64.zip"
	sum := sha256.Sum256(b)
	s := []byte(fmt.Sprintf("%x  %s\n", sum, name))
	if e := verifyArchive(b, s, name); e != nil {
		t.Fatal(e)
	}
	if e := verifyArchive(append(b, 1), s, name); e == nil {
		t.Fatal("mismatch accepted")
	}
	if e := verifyArchive(b, append(s, s...), name); e == nil {
		t.Fatal("duplicate checksum")
	}
	if e := verifyArchive(b, []byte("bad"), name); e == nil {
		t.Fatal("bad checksum")
	}
}
func TestCLIUpdateUnsafeArchives(t *testing.T) {
	for _, names := range [][]string{{"../kamakura-cli"}, {"/kamakura-cli"}, {"sub/kamakura-cli"}, {"C:\\kamakura-cli"}, {"kamakura-cli", "kamakura-cli"}, {"kamakura-cli.exe"}} {
		b := fixtureZIP(t, names, 0755, fixtureELF(false))
		if _, e := unpackCLI(b, "linux", "amd64"); e == nil {
			t.Fatalf("accepted %v", names)
		}
	}
	b := fixtureZIP(t, []string{"kamakura-cli"}, os.ModeSymlink|0777, []byte("/etc/passwd"))
	if _, e := unpackCLI(b, "linux", "amd64"); e == nil {
		t.Fatal("symlink accepted")
	}
	b = fixtureZIP(t, []string{"kamakura-cli"}, 0755, fixtureELF(true))
	if _, e := unpackCLI(b, "linux", "amd64"); e == nil {
		t.Fatal("wrong arch accepted")
	}
	b = fixtureZIP(t, []string{"kamakura-cli"}, 0755, fixtureELF(false))
	if _, e := unpackCLI(b, "linux", "amd64"); e != nil {
		t.Fatal(e)
	}
	if _, e := unpackCLI(b, "windows", "amd64"); e == nil {
		t.Fatal("wrong OS accepted")
	}
	if _, e := unpackCLI([]byte("broken"), "linux", "amd64"); e == nil {
		t.Fatal("broken zip accepted")
	}
	// Claimed uncompressed size must be checked before reading a zip bomb.
	at := bytes.Index(b, []byte{0x50, 0x4b, 0x01, 0x02})
	binary.LittleEndian.PutUint32(b[at+24:], maxBinary+1)
	if _, e := unpackCLI(b, "linux", "amd64"); e == nil {
		t.Fatal("size limit accepted")
	}
}
func TestCLIUpdateAtomicReplacement(t *testing.T) {
	if os.Getenv("GOOS") == "windows" {
		t.Skip("native Windows replacement needs manual testing")
	}
	d := t.TempDir()
	path := filepath.Join(d, "cli")
	sentinel := filepath.Join(d, "config.json")
	os.WriteFile(path, []byte("old"), 0750)
	os.WriteFile(sentinel, []byte("pairing-sentinel"), 0600)
	fail := func(string, string) error { return os.ErrPermission }
	if e := installCLI(path, []byte("new"), fail); e == nil {
		t.Fatal("failed replace succeeded")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "old" {
		t.Fatal("lost previous binary")
	}
	if _, e := os.Stat(path + ".previous"); !os.IsNotExist(e) {
		t.Fatal("failed backup remains")
	}
	if e := installCLI(path, []byte("new"), os.Rename); e != nil {
		t.Fatal(e)
	}
	b, _ = os.ReadFile(path)
	old, _ := os.ReadFile(path + ".previous")
	cfg, _ := os.ReadFile(sentinel)
	st, _ := os.Stat(path)
	if string(b) != "new" || string(old) != "old" || string(cfg) != "pairing-sentinel" || st.Mode().Perm() != 0750 {
		t.Fatal("binary/config/permissions not preserved")
	}
	if e := installCLI(path, []byte("third"), os.Rename); e == nil {
		t.Fatal("overwrote rollback backup")
	}
}
func TestCLIUpdatePermissionSymlink(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "cli")
	os.WriteFile(p, []byte("old"), 0777)
	os.Chmod(p, 0777)
	if e := installCLI(p, []byte("new"), os.Rename); e == nil {
		t.Fatal("unsafe permissions")
	}
	os.Chmod(p, 0755)
	link := filepath.Join(d, "link")
	os.Symlink(p, link)
	if e := installCLI(link, []byte("new"), os.Rename); e == nil {
		t.Fatal("symlink")
	}
	if e := installCLI(filepath.Join(d, "absent", "cli"), []byte("new"), os.Rename); e == nil {
		t.Fatal("nonexistent path")
	}
}
func TestCLIUpdateReleaseSelection(t *testing.T) {
	now := time.Now()
	rows := []cliRelease{{Tag: "aaaaaaa", Prerelease: true, Published: now.Add(-time.Hour)}, {Tag: "bbbbbbb", Prerelease: true, Published: now}, {Tag: "ccccccc", Prerelease: true, Draft: true, Published: now.Add(time.Hour)}}
	r, e := selectRelease(rows, "", "aaaaaaa", now.Add(-2*time.Hour).Unix())
	if e != nil || r.Tag != "bbbbbbb" {
		t.Fatal(r, e)
	}
	if _, e = selectRelease(rows, "", "unknown", 0); e == nil {
		t.Fatal("unknown implicit downgrade")
	}
	if _, e = selectRelease(rows, "", "ddddddd", now.Add(time.Hour).Unix()); e == nil {
		t.Fatal("implicit downgrade")
	}
	if _, e = selectRelease(rows, "aaaaaaa", "ddddddd", now.Unix()); e != nil {
		t.Fatal("explicit older tag refused", e)
	}
	if _, e = platformAsset("aaaaaaa", "darwin", "amd64"); e == nil {
		t.Fatal("unpublished target")
	}
	if _, e = platformAsset("aaaaaaa", "windows", "arm64"); e != nil {
		t.Fatal(e)
	}
}
func TestCLIUpdateSameReleaseOrigin(t *testing.T) {
	name := "kamakura-cli-aaaaaaa-linux-amd64.zip"
	base := "https://github.com/koboshcom/kamakura/releases/download/aaaaaaa/"
	r := cliRelease{Tag: "aaaaaaa", Assets: []releaseAsset{{name, base + name, 100}, {"SHA256SUMS", base + "SHA256SUMS", 100}}}
	if _, _, e := assetURLs(r, name); e != nil {
		t.Fatal(e)
	}
	r.Assets[1].URL = strings.Replace(r.Assets[1].URL, "aaaaaaa", "bbbbbbb", 1)
	if _, _, e := assetURLs(r, name); e == nil {
		t.Fatal("other release checksums")
	}
	for _, raw := range []string{"http://github.com/koboshcom/kamakura/releases/download/aaaaaaa/x", "https://github.com.evil.test/x", "https://github.com/other/repo/releases/download/x", "https://user@release-assets.githubusercontent.com/x", "https://release-assets.githubusercontent.com:444/x"} {
		u, _ := url.Parse(raw)
		if trustedDownloadURL(u) {
			t.Fatal("trusted", raw)
		}
	}
}

type fixtureRoundTrip func(*http.Request) (*http.Response, error)

func (f fixtureRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCLIUpdateBoundedHTTP(t *testing.T) {
	h := releaseHTTP{&http.Client{Transport: fixtureRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 1025))), ContentLength: -1, Header: make(http.Header)}, nil
	})}}
	if _, e := h.get(context.Background(), releaseRepo+"/releases", 1024, true); e == nil {
		t.Fatal("oversized streaming response")
	}
	if _, e := h.get(context.Background(), "https://evil.test/releases", 1024, true); e == nil {
		t.Fatal("untrusted API")
	}
	h.client.Transport = fixtureRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 429, Body: io.NopCloser(strings.NewReader("secret rate response")), Header: make(http.Header)}, nil
	})
	if _, e := h.get(context.Background(), releaseRepo+"/releases", 1024, true); e == nil || strings.Contains(e.Error(), "secret") {
		t.Fatal("rate response leaked", e)
	}
}
