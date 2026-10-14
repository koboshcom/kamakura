package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func initFixtureSession(c *connector) {
	c.sessionKey = strings.Repeat("ab", 32)
	c.sessionID = "fresh-session"
	c.owner = "owner"
	c.deviceID = "d"
}
func signFixture(c *connector, r *Request, human bool) {
	a := scopedAuthorization{Version: 2, Session: c.sessionID, Owner: c.owner, DeviceID: c.deviceID, ID: r.ID, Action: r.Action, Args: r.Args, Deadline: r.Deadline, Human: human}
	a.DM.Owner = c.owner
	a.DM.Transport = "discord"
	a.DM.Chat = "private-owner"
	if human {
		a.Nonce = "single-human-nonce"
	}
	raw, _ := json.Marshal(a)
	r.Authorization = base64.StdEncoding.EncodeToString(raw)
	key, _ := hex.DecodeString(c.sessionKey)
	m := hmac.New(sha256.New, key)
	m.Write([]byte(r.Authorization))
	r.Signature = hex.EncodeToString(m.Sum(nil))
}
func TestScopedAuthorization(t *testing.T) {
	c := &connector{}
	initFixtureSession(c)
	r := Request{ID: "one", Action: "shell", Args: json.RawMessage(`{"command":"rm -r fixture","purpose":"delete fixture","risk":"normal"}`), Deadline: time.Now().Add(time.Minute).UnixMilli(), Confirmed: true}
	if c.verifyAuthorization(&r) == nil {
		t.Fatal("boolean bypass")
	}
	signFixture(c, &r, false)
	if c.verifyAuthorization(&r) != nil {
		t.Fatal("valid session refused")
	}
	if checkActionSafety(r) == nil {
		t.Fatal("risk lowering bypass")
	}
	signFixture(c, &r, true)
	if c.verifyAuthorization(&r) != nil || checkActionSafety(r) != nil {
		t.Fatal("human confirmation refused")
	}
	for _, field := range []string{"args", "deadline", "device", "session", "id", "signature"} {
		x := r
		other := connector{sessionKey: c.sessionKey, sessionID: c.sessionID, owner: c.owner, deviceID: c.deviceID}
		switch field {
		case "args":
			x.Args = json.RawMessage(`{"command":"rm -r other"}`)
		case "deadline":
			x.Deadline++
		case "device":
			other.deviceID = "other"
		case "session":
			other.sessionID = "old"
		case "id":
			x.ID = "two"
		case "signature":
			x.Signature = "00"
		}
		if other.verifyAuthorization(&x) == nil {
			t.Fatal("mutation accepted", field)
		}
	}
}
