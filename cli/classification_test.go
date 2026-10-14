package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedClassification(t *testing.T) {
	raw, e := os.ReadFile("../test/action-safety-fixtures.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Command   string `json:"command"`
		Dangerous bool   `json:"dangerous"`
	}
	if json.Unmarshal(raw, &cases) != nil {
		t.Fatal("fixtures")
	}
	for _, v := range cases {
		if dangerousText(v.Command) != v.Dangerous {
			t.Error(v.Command, v.Dangerous)
		}
	}
}
func TestQueuedEpochInvalidation(t *testing.T) {
	c := &connector{epoch: 2, seen: map[string]bool{}, cancelled: map[string]bool{}}
	initFixtureSession(c)
	r := Request{ID: "old", Action: "shell", queuedEpoch: 1}
	signFixture(c, &r, false)
	if c.execute(r).OK {
		t.Fatal("old queue resumed")
	}
}
