package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const driverVersion = "0.34.0"

type asset struct{ Name, SHA string }

var assets = map[string]asset{
	"linux/amd64":   {"linux-x86_64-binary.tar.gz", "629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7"},
	"linux/arm64":   {"linux-arm64-binary.tar.gz", "9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb"},
	"darwin/amd64":  {"darwin-universal-binary.tar.gz", "940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81"},
	"darwin/arm64":  {"darwin-universal-binary.tar.gz", "940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81"},
	"windows/amd64": {"windows-x86_64-binary.zip", "bcc520e50861c7092cf775846fec76ae386d7dcd6b5b408608b0ea4423a8b888"},
	"windows/arm64": {"windows-arm64-binary.zip", "df5786c6e7841d2f0d88f31c627c487181463ed99614b03efc0e907acfc698c3"},
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}
func installDriver() (string, error) {
	var s State
	_ = readJSON("state.json", &s)
	if fresh(s) {
		return "", errors.New("stop connector before installing driver")
	}
	a, ok := assets[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return "", errors.New("unsupported platform")
	}
	url := "https://github.com/trycua/cua/releases/download/cua-driver-rs-v" + driverVersion + "/cua-driver-rs-" + driverVersion + "-" + a.Name
	client := &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" {
			return errors.New("unsafe download redirect")
		}
		return nil
	}}
	r, e := client.Get(url)
	if e != nil {
		return "", errors.New("driver download failed")
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return "", errors.New("driver release unavailable")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, (256<<20)+1))
	if e != nil || len(b) > 256<<20 {
		return "", errors.New("driver archive too large or unreadable")
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != a.SHA {
		return "", errors.New("driver checksum mismatch; refusing installation")
	}
	base, e := configDir()
	if e != nil {
		return "", e
	}
	tmp, e := os.MkdirTemp(base, "driver-staging-")
	if e != nil {
		return "", e
	}
	defer os.RemoveAll(tmp)
	if e = extract(b, tmp, strings.HasSuffix(a.Name, ".zip")); e != nil {
		return "", e
	}
	binary := filepath.Join(tmp, "cua-driver"+exeSuffix())
	info, e := os.Stat(binary)
	if e != nil || !info.Mode().IsRegular() {
		return "", errors.New("release did not contain expected driver")
	}
	dest := filepath.Join(base, "driver")
	if _, e = os.Lstat(dest); e == nil {
		return "", errors.New("verified driver already installed; remove driver directory locally to change version")
	}
	if e = os.Rename(tmp, dest); e != nil {
		return "", e
	}
	return filepath.Join(dest, "cua-driver"+exeSuffix()), nil
}
func safeEntry(base, name string) (string, error) {
	if strings.Contains(name, "\\") || strings.Contains(name, ":") || strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", errors.New("unsafe archive path")
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) || filepath.IsAbs(clean) {
		return "", errors.New("unsafe archive path")
	}
	return filepath.Join(base, clean), nil
}
func extract(data []byte, base string, zipped bool) error {
	count := 0
	total := int64(0)
	seen := map[string]bool{}
	put := func(name string, size int64, mode os.FileMode, r io.Reader, dir bool) error {
		count++
		if count > 4096 || size < 0 || size > 256<<20 || total+size > 512<<20 {
			return errors.New("archive limits exceeded")
		}
		total += size
		p, e := safeEntry(base, name)
		if e != nil {
			return e
		}
		if seen[p] {
			return errors.New("duplicate archive entry")
		}
		seen[p] = true
		if dir {
			return os.MkdirAll(p, 0700)
		}
		if !mode.IsRegular() {
			return errors.New("archive links or special files forbidden")
		}
		if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
			return e
		}
		f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		perm := os.FileMode(0600)
		if mode&0111 != 0 || filepath.Base(p) == "cua-driver"+exeSuffix() {
			perm = 0700
		}
		_, e = io.CopyN(f, r, size)
		if e == nil {
			e = f.Chmod(perm)
		}
		ce := f.Close()
		if e != nil {
			return e
		}
		return ce
	}
	if zipped {
		z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if e != nil {
			return e
		}
		for _, f := range z.File {
			if f.UncompressedSize64 > 256<<20 {
				return errors.New("archive limits exceeded")
			}
			r, e := f.Open()
			if e != nil {
				return e
			}
			e = put(f.Name, int64(f.UncompressedSize64), f.Mode(), r, f.FileInfo().IsDir())
			r.Close()
			if e != nil {
				return e
			}
		}
		return nil
	}
	g, e := gzip.NewReader(bytes.NewReader(data))
	if e != nil {
		return e
	}
	defer g.Close()
	t := tar.NewReader(io.LimitReader(g, 513<<20))
	for {
		h, e := t.Next()
		if e == io.EOF {
			return nil
		}
		if e != nil {
			return e
		}
		if h.Typeflag != tar.TypeDir && h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return fmt.Errorf("archive special entry forbidden")
		}
		if e = put(h.Name, h.Size, h.FileInfo().Mode(), t, h.Typeflag == tar.TypeDir); e != nil {
			return e
		}
	}
}
