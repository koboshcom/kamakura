package main

import (
	"reflect"
	"testing"
)

func TestServerSelection(t *testing.T) {
	for _, tc := range []struct {
		name, env string
		args      []string
		want      string
		remaining []string
		bad       bool
	}{
		{name: "default", args: []string{"auth"}, want: "https://kamakura.kobosh.com", remaining: []string{"auth"}},
		{name: "environment", env: "https://custom.example", args: []string{"auth"}, want: "https://custom.example", remaining: []string{"auth"}},
		{name: "flag wins", env: "https://env.example", args: []string{"auth", "--server", "wss://flag.example"}, want: "wss://flag.example", remaining: []string{"auth"}},
		{name: "global equals flag", args: []string{"--server=https://flag.example", "auth"}, want: "https://flag.example", remaining: []string{"auth"}},
		{name: "missing value", args: []string{"auth", "--server"}, bad: true},
		{name: "empty value", args: []string{"auth", "--server="}, bad: true},
		{name: "option as value", args: []string{"auth", "--server", "--foreground"}, bad: true},
		{name: "insecure env", env: "http://kobosh.com", args: []string{"auth"}, bad: true},
		{name: "invalid env overridden", env: "http://bad.example", args: []string{"auth", "--server", "https://good.example"}, want: "https://good.example", remaining: []string{"auth"}},
		{name: "credentials rejected", args: []string{"auth", "--server", "https://user:pass@example.com"}, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KAMAKURA_SERVER", tc.env)
			t.Setenv("KAMA_CORE_URL", "https://legacy.example")
			args, server, err := serverArgs(tc.args)
			if tc.bad {
				if err == nil {
					t.Fatal("accepted invalid server")
				}
				return
			}
			if err != nil || server != tc.want || !reflect.DeepEqual(args, tc.remaining) {
				t.Fatalf("got %v %q %v", args, server, err)
			}
		})
	}
}
