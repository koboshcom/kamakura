package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Config struct {
	CoreURL  string `json:"coreUrl"`
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	OwnerID  string `json:"ownerId"`
}
type Control struct {
	RunID  string `json:"runId"`
	Paused bool   `json:"paused"`
	Stop   bool   `json:"stop"`
}
type State struct {
	RunID     string `json:"runId"`
	PID       int    `json:"pid"`
	Connected bool   `json:"connected"`
	Paused    bool   `json:"paused"`
	Updated   int64  `json:"updated"`
}

func configDir() (string, error) {
	p, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	p = filepath.Join(p, "kama")
	if err = os.MkdirAll(p, 0700); err != nil {
		return "", err
	}
	if err = secureDir(p); err != nil {
		return "", err
	}
	return p, nil
}
func path(name string) (string, error) { p, e := configDir(); return filepath.Join(p, name), e }
func writeJSON(name string, v any) error {
	p, e := path(name)
	if e != nil {
		return e
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".kama-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return e
	}
	return replaceFile(tmp, p)
}
func readJSON(name string, v any) error {
	p, e := path(name)
	if e != nil {
		return e
	}
	s, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if !s.Mode().IsRegular() {
		return errors.New("configuration must be a regular file")
	}
	if runtime.GOOS != "windows" && s.Mode().Perm()&0077 != 0 {
		return errors.New("configuration permissions must be private")
	}
	f, e := os.Open(p)
	if e != nil {
		return e
	}
	defer f.Close()
	return json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(v)
}
func coreEndpoint(raw, endpoint string, ws bool) (string, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return "", errors.New("invalid core URL")
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "wss") {
		return "", errors.New("KAMA_CORE_URL must be an HTTPS or WSS origin without credentials or query")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("core URL must not include a path")
	}
	u.Scheme = "https"
	if ws {
		u.Scheme = "wss"
	}
	u.Path = endpoint
	return u.String(), nil
}
func pair(client *http.Client, core, code, name string) (Config, error) {
	var c Config
	endpoint, e := coreEndpoint(core, "/local-devices/pair", false)
	if e != nil {
		return c, e
	}
	b, _ := json.Marshal(map[string]string{"code": code, "name": name, "platform": runtime.GOOS + "/" + runtime.GOARCH})
	req, e := http.NewRequest("POST", endpoint, bytes.NewReader(b))
	if e != nil {
		return c, e
	}
	req.Header.Set("Content-Type", "application/json")
	res, e := client.Do(req)
	if e != nil {
		return c, errors.New("pairing connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return c, errors.New("pairing rejected; request a fresh owner DM code")
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&c); e != nil {
		return c, errors.New("invalid pairing response")
	}
	if c.DeviceID == "" || c.Token == "" || c.OwnerID == "" || strings.ContainsAny(c.Token, "\r\n") {
		return c, errors.New("incomplete pairing response")
	}
	c.CoreURL = core
	return c, nil
}
func fresh(s State) bool { return s.RunID != "" && time.Now().UnixMilli()-s.Updated < 5000 }
