package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func fmtPID(p int) string { return strconv.Itoa(p) }
func randomID() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func main() {
	if e := command(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func command(args []string) error {
	if len(args) == 0 {
		return errors.New("usage kama auth | start [--foreground] | pause | resume | stop | status | install-driver")
	}
	switch args[0] {
	case "auth":
		var s State
		_ = readJSON("state.json", &s)
		if fresh(s) {
			return errors.New("stop connector before pairing")
		}
		core := os.Getenv("KAMA_CORE_URL")
		if core == "" {
			return errors.New("set KAMA_CORE_URL to your core HTTPS or WSS origin")
		}
		if _, e := coreEndpoint(core, "/", false); e != nil {
			return e
		}
		name, _ := os.Hostname()
		fmt.Print("Owner DM pairing code (not stored) ")
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			return errors.New("missing code")
		}
		code := strings.TrimSpace(scanner.Text())
		if code == "" {
			return errors.New("missing code")
		}
		client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		c, e := pair(client, core, code, name)
		if e != nil {
			return e
		}
		if e = writeJSON("config.json", c); e == nil {
			fmt.Println("Device paired. Run kama start, then kama resume when ready.")
		}
		return e
	case "install-driver":
		p, e := installDriver()
		if e == nil {
			fmt.Println("Verified driver installed at", p)
		}
		return e
	case "start":
		var c Config
		if e := readJSON("config.json", &c); e != nil {
			return errors.New("run kama auth first")
		}
		var s State
		_ = readJSON("state.json", &s)
		if fresh(s) {
			return errors.New("connector already running")
		}
		runID := randomID()
		if e := writeJSON("control.json", Control{RunID: runID, Paused: true}); e != nil {
			return e
		}
		if len(args) > 1 && args[1] == "--foreground" {
			go terminalControl(runID)
			return run(c, runID)
		}
		if len(args) > 1 {
			return errors.New("unknown start option")
		}
		exe, e := os.Executable()
		if e != nil {
			return e
		}
		child := exec.Command(exe, "_run", runID)
		detach(child)
		child.Stdin = nil
		child.Stdout = nil
		child.Stderr = nil
		if e = child.Start(); e != nil {
			return e
		}
		_ = child.Process.Release()
		for i := 0; i < 50; i++ {
			time.Sleep(100 * time.Millisecond)
			_ = readJSON("state.json", &s)
			if s.RunID == runID && fresh(s) {
				fmt.Println("Connector started paused. Use kama resume to allow approved core requests, kama pause to take over.")
				return nil
			}
		}
		return errors.New("connector did not start; try kama start --foreground")
	case "_run":
		if len(args) != 2 {
			return errors.New("invalid connector invocation")
		}
		var c Config
		if e := readJSON("config.json", &c); e != nil {
			return e
		}
		return run(c, args[1])
	case "pause", "resume", "stop":
		var s State
		if e := readJSON("state.json", &s); e != nil || !fresh(s) {
			return errors.New("connector is not running")
		}
		ctl := Control{RunID: s.RunID, Paused: args[0] != "resume", Stop: args[0] == "stop"}
		if e := writeJSON("control.json", ctl); e != nil {
			return e
		}
		if ctl.Stop {
			for i := 0; i < 50; i++ {
				time.Sleep(100 * time.Millisecond)
				_ = readJSON("state.json", &s)
				if !fresh(s) {
					fmt.Println("Connector stopped.")
					return nil
				}
			}
			return errors.New("stop requested; connector still draining")
		}
		fmt.Println("Local control set to", args[0])
		return nil
	case "status":
		var s State
		_ = readJSON("state.json", &s)
		if !fresh(s) {
			fmt.Println("Stopped")
			return nil
		}
		fmt.Printf("Running, connected=%t, paused=%t\n", s.Connected, s.Paused)
		return nil
	}
	return errors.New("unknown kama command")
}
func terminalControl(runID string) {
	fmt.Println("Starts paused. Type resume, pause, or stop. Closing stdin pauses.")
	s := bufio.NewScanner(os.Stdin)
	for s.Scan() {
		v := strings.TrimSpace(s.Text())
		if v == "pause" || v == "resume" || v == "stop" {
			_ = writeJSON("control.json", Control{RunID: runID, Paused: v != "resume", Stop: v == "stop"})
		}
	}
	_ = writeJSON("control.json", Control{RunID: runID, Paused: true})
}
