package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var commandSplit = regexp.MustCompile(`(?:;|&&|\|\||\n|\|)`)
var sudoPrefix = regexp.MustCompile(`^sudo\s+(?:-[\w]+\s+)*`)
var shellPrefix = regexp.MustCompile(`^(?:ba)?sh\s+-c\s+['"]?`)
var dangerStart = regexp.MustCompile(`(?i)^(?:rm|rmdir|del|erase|rd|Remove-Item|mkfs(?:\.\w+)?|wipefs|shred|truncate|kill|killall|pkill|taskkill|Stop-Process|chmod|chown|usermod|userdel|passwd|iptables|ufw|setfacl|Set-ExecutionPolicy|sendmail|shutdown|reboot|poweroff|format|diskpart)\b`)
var dangerRest = regexp.MustCompile(`(?i)^dd\s+[^\n]*\bof\s*=\s*/dev/|^(?:s?fdisk)\b[^\n]*(?:/dev/|--delete)|^mongosh\b[^\n]*(?:dropDatabase\s*\(|deleteMany\s*\(\s*\{\s*\}|drop\s*\()|^(?:apt(?:-get)?|dnf|yum|pacman|brew|winget|choco)\s+[^\n]*(?:install|remove|uninstall|purge)\b`)

func dangerousText(text string) bool {
	if len(text) > 16000 {
		text = text[:16000]
	}
	for _, part := range commandSplit.Split(text, -1) {
		s := strings.TrimSpace(part)
		s = strings.TrimRight(s, "'\"")
		s = sudoPrefix.ReplaceAllString(s, "")
		s = shellPrefix.ReplaceAllString(s, "")
		if strings.HasPrefix(s, "echo ") || strings.HasPrefix(s, "printf ") {
			continue
		}
		if dangerStart.MatchString(s) || dangerRest.MatchString(s) {
			return true
		}
	}
	return false
}
func checkActionSafety(r Request) error {
	if r.Action == "snapshot" {
		return nil
	}
	var a struct {
		Command string         `json:"command"`
		Tool    string         `json:"tool"`
		Risk    string         `json:"risk"`
		Args    map[string]any `json:"args"`
	}
	if json.Unmarshal(r.Args, &a) != nil {
		return errors.New("invalid action")
	}
	danger := a.Risk == "destructive"
	if a.Risk != "" && a.Risk != "normal" && a.Risk != "destructive" {
		return errors.New("invalid risk")
	}
	if r.Action == "shell" {
		danger = danger || dangerousText(a.Command)
	} else {
		if a.Risk != "normal" && a.Tool != "list_windows" && a.Tool != "screenshot" && a.Tool != "get_screen_size" {
			danger = true
		}
		for _, v := range a.Args {
			if s, ok := v.(string); ok && dangerousText(s) {
				danger = true
			}
		}
	}
	if danger && !r.verifiedHuman {
		return errors.New("dangerous action requires verified scoped owner DM confirmation")
	}
	return nil
}
