package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/gofrs/flock"
	"github.com/gorilla/websocket"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"time"
)

type Request struct {
	Confirmed     bool   `json:"confirmed"`
	Authorization string `json:"authorization"`
	Signature     string `json:"signature"`
	Session       string `json:"session"`
	Key           string `json:"key"`
	Owner         string `json:"owner"`
	DeviceID      string `json:"deviceId"`
	onStarted     func()
	verifiedHuman bool
	queuedEpoch   uint64
	Type          string          `json:"type"`
	ID            string          `json:"id"`
	Action        string          `json:"action"`
	Args          json.RawMessage `json:"args"`
	Deadline      int64           `json:"deadline"`
}
type Result struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type connector struct {
	executeFn  func(context.Context, *MCP, Request) (any, error)
	mu         sync.Mutex
	write      sync.Mutex
	epoch      uint64
	sessionKey string
	sessionID  string
	owner      string
	deviceID   string
	paused     bool
	cancel     context.CancelFunc
	activeID   string
	ws         *websocket.Conn
	driver     *MCP
	seen       map[string]bool
	cancelled  map[string]bool
}

func (c *connector) send(v any) error {
	c.write.Lock()
	defer c.write.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.ws.WriteJSON(v)
}
func (c *connector) pause(p bool) {
	c.mu.Lock()
	changed := c.paused != p
	c.paused = p
	if p {
		c.epoch++
	}
	if p && c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	if changed {
		_ = c.send(map[string]any{"type": "pause", "paused": p})
	}
}
func (c *connector) execute(r Request) Result {
	out := Result{Type: "result", ID: r.ID}
	c.mu.Lock()
	if c.paused || c.cancelled[r.ID] || r.queuedEpoch != c.epoch {
		c.mu.Unlock()
		out.Error = "local device paused"
		return out
	}
	if r.ID == "" || len(r.ID) > 256 || c.seen[r.ID] || len(c.seen) >= 10000 {
		c.mu.Unlock()
		out.Error = "invalid or repeated request id; reconnect required after 10000 requests"
		return out
	}
	if err := c.verifyAuthorization(&r); err != nil {
		c.mu.Unlock()
		out.Error = err.Error()
		return out
	}
	c.seen[r.ID] = true
	deadline := time.UnixMilli(r.Deadline)
	if r.Deadline == 0 || !deadline.After(time.Now()) {
		c.mu.Unlock()
		out.Error = "expired or missing deadline"
		return out
	}
	if deadline.After(time.Now().Add(5 * time.Minute)) {
		deadline = time.Now().Add(5 * time.Minute)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	c.cancel = cancel
	c.activeID = r.ID
	c.mu.Unlock()
	defer func() { cancel(); c.mu.Lock(); c.cancel = nil; c.mu.Unlock() }()
	r.onStarted = func() {
		if c.ws != nil {
			_ = c.send(map[string]any{"type": "task_started", "id": r.ID})
		}
	}
	fn := c.executeFn
	if fn == nil {
		fn = execute
	}
	result, e := fn(ctx, c.driver, r)
	if e != nil {
		out.Error = e.Error()
	} else {
		out.OK = true
		out.Result = result
	}
	return out
}
func run(cfg Config, runID string) error {
	return runWithDialer(cfg, runID, &websocket.Dialer{HandshakeTimeout: 10 * time.Second})
}
func runWithDialer(cfg Config, runID string, dial *websocket.Dialer) error {
	lp, e := path("connector.lock")
	if e != nil {
		return e
	}
	lock := flock.New(lp, flock.SetPermissions(0600))
	locked, e := lock.TryLock()
	if e != nil || !locked {
		return errors.New("another connector holds the device lock")
	}
	defer lock.Unlock()
	var ctl Control
	if e := readJSON("control.json", &ctl); e != nil || ctl.RunID != runID || ctl.Stop {
		return errors.New("no valid local start control")
	}
	endpoint, e := coreEndpoint(cfg.CoreURL, "/local-devices/connect", true)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	state := State{RunID: runID, PID: os.Getpid(), Paused: true}
	defer func() { state.Connected = false; state.Updated = 0; _ = writeJSON("state.json", state) }()
	for ctx.Err() == nil {
		state.Updated = time.Now().UnixMilli()
		state.Connected = false
		state.Paused = true
		_ = writeJSON("state.json", state)
		ws, res, e := dial.DialContext(ctx, endpoint, http.Header{"Authorization": []string{"Bearer " + cfg.Token}})
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		if e != nil {
			if !waitLocal(ctx, runID, 2*time.Second) {
				return nil
			}
			continue
		}
		ws.SetReadLimit(1 << 20)
		_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(60 * time.Second)) })
		driver := &MCP{}
		c := &connector{paused: true, ws: ws, driver: driver, seen: map[string]bool{}, cancelled: map[string]bool{}}
		_ = c.send(map[string]any{"type": "hello", "version": 2})
		_ = c.send(map[string]any{"type": "pause", "paused": true})
		_ = writeJSON("control.json", Control{RunID: runID, Paused: true})
		session, stop := context.WithCancel(ctx)
		jobs := make(chan Request, 1)
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-session.Done():
					return
				case r := <-jobs:
					if e := c.send(c.execute(r)); e != nil {
						stop()
						_ = ws.Close()
						return
					}
				}
			}
		}()
		monitorDone := make(chan struct{})
		go func() {
			defer close(monitorDone)
			tick := time.NewTicker(200 * time.Millisecond)
			defer tick.Stop()
			lastPing := time.Now()
			for {
				select {
				case <-session.Done():
					return
				case <-tick.C:
					var v Control
					if e := readJSON("control.json", &v); e != nil || v.RunID != runID || v.Stop {
						c.pause(true)
						cancel()
						stop()
						_ = ws.Close()
						return
					}
					c.pause(v.Paused)
					c.mu.Lock()
					p := c.paused
					c.mu.Unlock()
					state.Connected = true
					state.Paused = p
					state.Updated = time.Now().UnixMilli()
					_ = writeJSON("state.json", state)
					if time.Since(lastPing) > 20*time.Second {
						e := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
						if e != nil {
							stop()
							_ = ws.Close()
							return
						}
						lastPing = time.Now()
					}
				}
			}
		}()
		for {
			var r Request
			if e = ws.ReadJSON(&r); e != nil {
				break
			}
			_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
			if r.Type == "session" {
				c.mu.Lock()
				if c.sessionID != "" || len(r.Key) != 64 || r.Session == "" || r.Owner == "" || r.DeviceID != cfg.DeviceID {
					c.mu.Unlock()
					break
				}
				c.sessionKey = r.Key
				c.sessionID = r.Session
				c.owner = r.Owner
				c.deviceID = r.DeviceID
				c.mu.Unlock()
				continue
			}
			if r.Type == "cancel" {
				c.cancelRequest(r.ID)
				continue
			}

			if r.Type != "request" {
				continue
			}
			c.mu.Lock()
			r.queuedEpoch = c.epoch
			c.mu.Unlock()
			select {
			case jobs <- r:
			default:
				_ = c.send(Result{Type: "result", ID: r.ID, Error: "device busy; do not retry mutations without verifying state"})
			}
		}
		stop()
		c.pause(true)
		_ = ws.Close()
		<-done
		<-monitorDone
		driver.Close()
		if !waitLocal(ctx, runID, time.Second) {
			return nil
		}
	}
	return nil
}
func waitLocal(ctx context.Context, runID string, d time.Duration) bool {
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	end := time.Now().Add(d)
	for {
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
			var c Control
			if e := readJSON("control.json", &c); e != nil || c.RunID != runID || c.Stop {
				return false
			}
			_ = writeJSON("state.json", State{RunID: runID, PID: os.Getpid(), Paused: true, Updated: time.Now().UnixMilli()})
			if time.Now().After(end) {
				return true
			}
		}
	}
}

// Called by the authenticated websocket reader, not the serial execution queue.
func (c *connector) cancelRequest(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cancelled) < 10000 && id != "" {
		c.cancelled[id] = true
	}
	if c.activeID == id && c.cancel != nil {
		c.cancel()
	}
}
