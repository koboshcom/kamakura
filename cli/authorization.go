package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

type scopedAuthorization struct {
	DM struct {
		Owner     string `json:"owner"`
		Transport string `json:"transport"`
		Chat      string `json:"chat"`
	} `json:"dm"`
	Version  int             `json:"version"`
	Session  string          `json:"session"`
	Owner    string          `json:"owner"`
	DeviceID string          `json:"deviceId"`
	ID       string          `json:"id"`
	Action   string          `json:"action"`
	Args     json.RawMessage `json:"args"`
	Deadline int64           `json:"deadline"`
	Human    bool            `json:"human"`
	Nonce    string          `json:"nonce"`
}

func (c *connector) verifyAuthorization(r *Request) error {
	deny := errors.New("missing or invalid scoped authorization; update core and CLI, reconnect and resume")
	key, e := hex.DecodeString(c.sessionKey)
	if e != nil || len(key) != 32 || c.sessionID == "" {
		return deny
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(r.Authorization))
	sig, e := hex.DecodeString(r.Signature)
	if e != nil || !hmac.Equal(mac.Sum(nil), sig) {
		return deny
	}
	raw, e := base64.StdEncoding.DecodeString(r.Authorization)
	if e != nil {
		return deny
	}
	var a scopedAuthorization
	if json.Unmarshal(raw, &a) != nil {
		return deny
	}
	var left, right bytes.Buffer
	if json.Compact(&left, a.Args) != nil || json.Compact(&right, r.Args) != nil {
		return deny
	}
	if a.Version != 2 || a.Session != c.sessionID || a.Owner != c.owner || a.DeviceID != c.deviceID || a.ID != r.ID || a.Action != r.Action || a.Deadline != r.Deadline || !bytes.Equal(left.Bytes(), right.Bytes()) || a.Deadline <= time.Now().UnixMilli() || a.Deadline > time.Now().Add(2*time.Minute).UnixMilli() || (a.Human && a.Nonce == "") {
		return deny
	}
	if a.Human && (a.DM.Owner != c.owner || a.DM.Chat == "" || (a.DM.Transport != "telegram" && a.DM.Transport != "discord" && a.DM.Transport != "whatsapp")) {
		return deny
	}
	r.verifiedHuman = a.Human
	return nil
}
