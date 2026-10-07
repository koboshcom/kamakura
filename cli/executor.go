package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const maxOutput = 512 << 10
const maxDriverMessage = 16 << 20

type boundedBuffer struct{ b []byte }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.b) < maxOutput {
		limit := maxOutput - len(b.b)
		if len(p) > limit {
			p = p[:limit]
		}
		b.b = append(b.b, p...)
	}
	return n, nil
}
func execute(ctx context.Context, mcp *MCP, r Request) (any, error) {
	switch r.Action {
	case "shell":
		var a struct {
			Command string `json:"command"`
			Timeout int64  `json:"timeoutMs"`
		}
		if e := json.Unmarshal(r.Args, &a); e != nil || a.Command == "" || len(a.Command) > 65536 {
			return nil, errors.New("invalid shell arguments")
		}
		if a.Timeout <= 0 || a.Timeout > 300000 {
			a.Timeout = 300000
		}
		ctx, cancel := context.WithTimeout(ctx, time.Duration(a.Timeout)*time.Millisecond)
		defer cancel()
		c := shell(ctx, a.Command)
		c.WaitDelay = time.Second
		var b boundedBuffer
		c.Stdout = &b
		c.Stderr = &b
		e := c.Run()
		exit := 0
		if e != nil {
			exit = -1
			if v, ok := e.(*exec.ExitError); ok {
				exit = v.ExitCode()
			}
		}
		return map[string]any{"output": string(b.b), "exitCode": exit, "truncated": len(b.b) == maxOutput, "cancelled": ctx.Err() != nil}, nil
	case "cua":
		var a struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		if e := json.Unmarshal(r.Args, &a); e != nil || !regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`).MatchString(a.Tool) {
			return nil, errors.New("invalid cua tool")
		}
		return mcp.Call(ctx, a.Tool, a.Args)
	case "snapshot":
		var a struct {
			MaxImageDimension int    `json:"max_image_dimension,omitempty"`
			Session           string `json:"session,omitempty"`
		}
		raw := r.Args
		if len(raw) == 0 {
			raw = json.RawMessage(`{}`)
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if e := d.Decode(&a); e != nil || a.MaxImageDimension < 0 || a.MaxImageDimension > 8192 {
			return nil, errors.New("invalid read-only snapshot arguments")
		}
		safe, _ := json.Marshal(a)
		return mcp.Call(ctx, "get_desktop_state", safe)
	}
	return nil, errors.New("unsupported local action")
}

type MCP struct {
	mu    sync.Mutex
	cmd   *exec.Cmd
	input io.WriteCloser
	lines chan []byte
	stop  chan struct{}
	seq   int
}

func (m *MCP) Close() { m.mu.Lock(); defer m.mu.Unlock(); m.close() }
func (m *MCP) close() {
	if m.cmd != nil {
		_ = m.cmd.Process.Kill()
		_ = m.cmd.Wait()
		_ = m.input.Close()
		close(m.stop)
		m.cmd = nil
	}
}
func (m *MCP) start() error {
	p, e := path(filepath.Join("driver", "cua-driver"+exeSuffix()))
	if e != nil {
		return e
	}
	if _, e = os.Stat(p); e != nil {
		return errors.New("install verified driver with kama install-driver first")
	}
	c := exec.Command(p, "mcp", "--direct")
	c.Env = cleanDriverEnv()
	input, e := c.StdinPipe()
	if e != nil {
		return e
	}
	output, e := c.StdoutPipe()
	if e != nil {
		return e
	}
	c.Stderr = io.Discard
	if e = c.Start(); e != nil {
		return errors.New("driver could not start; inspect local OS permissions")
	}
	m.cmd = c
	m.input = input
	m.lines = make(chan []byte, 16)
	m.stop = make(chan struct{})
	stop := m.stop
	lines := m.lines
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), maxDriverMessage)
		for scanner.Scan() {
			b := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- b:
			case <-stop:
				return
			}
		}
	}()
	return nil
}
func cleanDriverEnv() []string {
	v := []string{}
	for _, s := range os.Environ() {
		if len(s) >= 11 && s[:11] == "CUA_DRIVER_" {
			continue
		}
		v = append(v, s)
	}
	return v
}
func (m *MCP) Call(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == nil {
		if e := m.start(); e != nil {
			return nil, e
		}
	}
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	var obj map[string]any
	if e := json.Unmarshal(args, &obj); e != nil || obj == nil {
		return nil, errors.New("cua args must be an object")
	}
	m.seq++
	id := m.seq
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": obj, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": map[string]any{}}}}
	b, _ := json.Marshal(req)
	b = append(b, '\n')
	if _, e := m.input.Write(b); e != nil {
		m.close()
		return nil, errors.New("driver connection failed; action state unknown")
	}
	for {
		select {
		case <-ctx.Done():
			m.close()
			return nil, errors.New("driver cancelled; verify state before any retry")
		case b, ok := <-m.lines:
			if !ok {
				m.close()
				return nil, errors.New("driver exited; check local OS permissions")
			}
			var r struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(b, &r) != nil || r.ID != id {
				continue
			}
			if len(r.Error) > 0 {
				return nil, errors.New("driver rejected request; check its schema and local permissions")
			}
			var v any
			if e := json.Unmarshal(r.Result, &v); e != nil {
				return nil, errors.New("invalid driver result")
			}
			return v, nil
		}
	}
}
