package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestLiveDriverMCP(t *testing.T) {
	if os.Getenv("KAMA_TEST_LIVE_DRIVER") != "1" {
		t.Skip("set KAMA_TEST_LIVE_DRIVER=1 after verified local installation")
	}
	m := &MCP{}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	v, e := m.Call(ctx, "get_screen_size", json.RawMessage(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if v == nil {
		t.Fatal("missing driver response")
	}
}
func TestSnapshotRejectsWrites(t *testing.T) {
	_, e := execute(context.Background(), &MCP{}, Request{Action: "snapshot", Args: json.RawMessage(`{"screenshot_out_file":"/tmp/hidden-write"}`)})
	if e == nil {
		t.Fatal("snapshot accepted file write")
	}
}
