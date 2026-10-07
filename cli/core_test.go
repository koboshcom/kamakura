package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func isolated(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if os.Getenv("HOME") == "" {
		t.Setenv("HOME", t.TempDir())
	}
}
func TestEndpoints(t *testing.T) {
	for _, s := range []string{"http://example.com", "ws://example.com", "wss://u:p@example.com", "https://example.com/path", "https://example.com?x=1", "file:///x"} {
		if _, e := coreEndpoint(s, "/local-devices/pair", false); e == nil {
			t.Fatalf("accepted %s", s)
		}
	}
	v, e := coreEndpoint("wss://example.com", "/local-devices/pair", false)
	if e != nil || v != "https://example.com/local-devices/pair" {
		t.Fatal(v, e)
	}
}
func TestPair(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/local-devices/pair" {
			t.Error("bad route")
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["code"] != "one-time" || body["name"] != "laptop" || body["platform"] == "" {
			t.Error("bad pairing payload")
		}
		_, _ = io.WriteString(w, `{"deviceId":"d1","ownerId":"owner1","token":"secret"}`)
	}))
	defer srv.Close()
	c, e := pair(srv.Client(), srv.URL, "one-time", "laptop")
	if e != nil || c.Token != "secret" || c.CoreURL != srv.URL {
		t.Fatal(c, e)
	}
}
func TestConfigPrivate(t *testing.T) {
	isolated(t)
	if e := writeJSON("config.json", Config{Token: "secret"}); e != nil {
		t.Fatal(e)
	}
	p, _ := path("config.json")
	s, _ := os.Stat(p)
	if s.Mode().Perm() != 0600 {
		t.Fatal(s.Mode())
	}
	var c Config
	if e := readJSON("config.json", &c); e != nil || c.Token != "secret" {
		t.Fatal(e)
	}
}
func TestPauseDeadlineReplayAndAction(t *testing.T) {
	c := &connector{paused: true, driver: &MCP{}, seen: map[string]bool{}}
	r := Request{ID: "1", Action: "shell", Args: json.RawMessage(`{"command":"echo test","timeoutMs":1000}`), Deadline: time.Now().Add(time.Second).UnixMilli()}
	if c.execute(r).OK {
		t.Fatal("executed paused")
	}
	c.paused = false
	r.Deadline = 0
	if c.execute(r).OK {
		t.Fatal("executed without deadline")
	}
	r.ID = "2"
	r.Deadline = time.Now().Add(time.Second).UnixMilli()
	v := c.execute(r)
	if !v.OK {
		t.Fatal(v)
	}
	if c.execute(r).OK {
		t.Fatal("replay executed")
	}
	r.ID = "3"
	r.Action = "install"
	if c.execute(r).OK {
		t.Fatal("unknown action")
	}
}
func TestShellTimeout(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix shell command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	v, e := execute(ctx, &MCP{}, Request{Action: "shell", Args: json.RawMessage(`{"command":"sleep 30 & wait","timeoutMs":30000}`)})
	if e != nil {
		t.Fatal(e)
	}
	if time.Since(start) > 2*time.Second || !v.(map[string]any)["cancelled"].(bool) {
		t.Fatal(v)
	}
}
func tarData(name string, kind byte) []byte {
	var b bytes.Buffer
	g := gzip.NewWriter(&b)
	w := tar.NewWriter(g)
	_ = w.WriteHeader(&tar.Header{Name: name, Typeflag: kind, Mode: 0700, Size: 0, Linkname: "/tmp/escape"})
	w.Close()
	g.Close()
	return b.Bytes()
}
func TestArchivePathsAndLinks(t *testing.T) {
	for _, n := range []string{"../escape", "/absolute", "a\\b", "a:C", "a/../../escape"} {
		if e := extract(tarData(n, tar.TypeReg), t.TempDir(), false); e == nil {
			t.Fatalf("accepted %s", n)
		}
	}
	if e := extract(tarData("link", tar.TypeSymlink), t.TempDir(), false); e == nil {
		t.Fatal("accepted link")
	}
	if e := extract(tarData("cua-driver", tar.TypeReg), t.TempDir(), false); e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	f, _ := z.Create("../escape")
	_, _ = f.Write([]byte("x"))
	z.Close()
	if extract(b.Bytes(), t.TempDir(), true) == nil {
		t.Fatal("zip traversal")
	}
}
func TestBoundedOutput(t *testing.T) {
	var b boundedBuffer
	input := make([]byte, maxOutput+100)
	n, e := b.Write(input)
	if n != len(input) || e != nil || len(b.b) != maxOutput {
		t.Fatal(n, e, len(b.b))
	}
}
func TestFakeCoreIntegration(t *testing.T) {
	isolated(t)
	id := "run-test"
	if e := writeJSON("control.json", Control{RunID: id, Paused: true}); e != nil {
		t.Fatal(e)
	}
	connections := make(chan *websocket.Conn, 1)
	up := websocket.Upgrader{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/local-devices/connect" || r.Header.Get("Authorization") != "Bearer token" {
			w.WriteHeader(401)
			return
		}
		c, e := up.Upgrade(w, r, nil)
		if e == nil {
			connections <- c
		}
	}))
	defer srv.Close()
	tlsConfig := srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	tlsConfig.MinVersion = tls.VersionTLS12
	dial := &websocket.Dialer{TLSClientConfig: tlsConfig, HandshakeTimeout: time.Second}
	done := make(chan error, 1)
	go func() { done <- runWithDialer(Config{CoreURL: srv.URL, Token: "token", DeviceID: "d"}, id, dial) }()
	var ws *websocket.Conn
	select {
	case ws = <-connections:
	case <-time.After(3 * time.Second):
		t.Fatal("no connection")
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var hello map[string]any
	if e := ws.ReadJSON(&hello); e != nil || hello["type"] != "hello" || hello["version"] != float64(1) {
		t.Fatal(hello, e)
	}
	var pause map[string]any
	_ = ws.ReadJSON(&pause)
	if pause["paused"] != true {
		t.Fatal(pause)
	}
	r := Request{Type: "request", ID: "r1", Action: "shell", Args: json.RawMessage(`{"command":"echo connected","timeoutMs":1000}`), Deadline: time.Now().Add(3 * time.Second).UnixMilli()}
	_ = ws.WriteJSON(r)
	var res Result
	_ = ws.ReadJSON(&res)
	if res.OK || !strings.Contains(res.Error, "paused") {
		t.Fatal(res)
	}
	_ = writeJSON("control.json", Control{RunID: id, Paused: false})
	for {
		var p map[string]any
		if e := ws.ReadJSON(&p); e != nil {
			t.Fatal(e)
		}
		if p["type"] == "pause" && p["paused"] == false {
			break
		}
	}
	r.ID = "r2"
	r.Deadline = time.Now().Add(3 * time.Second).UnixMilli()
	_ = ws.WriteJSON(r)
	if e := ws.ReadJSON(&res); e != nil || !res.OK {
		t.Fatal(res, e)
	}
	_ = writeJSON("control.json", Control{RunID: id, Paused: true, Stop: true})
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("failed to stop")
	}
}
func TestPinnedAssets(t *testing.T) {
	if len(assets) != 6 {
		t.Fatal("missing platforms")
	}
	for _, a := range assets {
		if len(a.SHA) != 64 || strings.Contains(a.Name, "/") {
			t.Fatal(a)
		}
	}
}

var _ = filepath.Separator
