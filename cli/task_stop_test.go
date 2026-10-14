package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestOutOfBandRegisteredTaskStop(t *testing.T) {
	started := make(chan struct{})
	stops := 0
	c := &connector{seen: map[string]bool{}, cancelled: map[string]bool{}}
	initFixtureSession(c)
	c.executeFn = func(ctx context.Context, _ *MCP, r Request) (any, error) {
		close(started)
		<-ctx.Done()
		stops++
		return nil, ctx.Err()
	}
	r := Request{Deadline: time.Now().Add(time.Minute).UnixMilli(), ID: "owned-active", Action: "shell", Args: json.RawMessage(`{"command":"fixture-only"}`)}
	signFixture(c, &r, false)
	done := make(chan Result, 1)
	go func() { done <- c.execute(r) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("not started")
	}
	c.cancelRequest("foreign")
	select {
	case <-done:
		t.Fatal("foreign stopped task")
	default:
	}
	c.cancelRequest(r.ID)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel queued behind synchronous task")
	}
	if stops != 1 {
		t.Fatal(stops)
	}
	c.cancelRequest(r.ID)
	if stops != 1 {
		t.Fatal("reused stop")
	}
}
