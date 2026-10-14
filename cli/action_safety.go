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
var dangerStart = regexp.MustCompile(`(?i)^(?:mkfs(?:\.\w+)?|wipefs|shred|truncate|chmod|chown|usermod|userdel|passwd|iptables|ufw|setfacl|Set-ExecutionPolicy|sendmail|shutdown|reboot|poweroff|format|diskpart)\b`)
var dangerRest = regexp.MustCompile(`(?i)^dd\s+[^\n]*\bof\s*=\s*/dev/|^(?:s?fdisk)\b[^\n]*(?:/dev/|--delete)|^mongosh\b[^\n]*(?:dropDatabase\s*\(|deleteMany\s*\(\s*\{\s*\}|drop\s*\()|^(?:apt(?:-get)?|dnf|yum|pacman|brew|winget|choco)\s+[^\n]*(?:install|remove|uninstall|purge)\b`)

var deleteStart = regexp.MustCompile(`(?i)^(?:rm|rmdir|del|erase|rd|Remove-Item)\b`)
var shellToken = regexp.MustCompile(`"[^"]*"|'[^']*'|[^\s]+`)
var recursiveFlag = regexp.MustCompile(`(?i)^--recursive$|^-[^-]*r|^/s$`)
var importantTarget = regexp.MustCompile(`(?i)(?:^|/)(?:\.ssh|\.gnupg|credentials(?:\.[^/]*)?|passwd|shadow)(?:/|$)|^(?:/(?:etc|root|boot|dev|proc|sys|var/lib)(?:/|$)|/(?:home|data|work)/?$|/home/[^/]+/?$|/?$|~/?$|\.\.?/?$)`)

func dangerousDelete(s string) bool {
	tokens := shellToken.FindAllString(s, -1)
	targets := []string{}
	for _, t := range tokens[1:] {
		flag := strings.HasPrefix(t, "-") || strings.EqualFold(t, "/s") || strings.EqualFold(t, "/q")
		if flag {
			if recursiveFlag.MatchString(t) {
				return true
			}
			continue
		}
		targets = append(targets, strings.Trim(t, "'\""))
	}
	return len(targets) != 1 || strings.ContainsAny(targets[0], "*?") || importantTarget.MatchString(targets[0])
}
func dangerousText(text string) bool {
	if len(text) > 16000 {
		text = text[:16000]
	}
	for _, part := range commandSplit.Split(text, -1) {
		s := strings.TrimSpace(part)

		s = sudoPrefix.ReplaceAllString(s, "")
		s = shellPrefix.ReplaceAllString(s, "")
		if strings.HasPrefix(s, "echo ") || strings.HasPrefix(s, "printf ") {
			continue
		}
		if deleteStart.MatchString(s) && dangerousDelete(s) {
			return true
		}
		if criticalKill(s) || dangerStart.MatchString(s) || dangerRest.MatchString(s) {
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

var criticalProcess = regexp.MustCompile(`(?i)^(?:sshd|dockerd|systemd|init|kamakura|kamakura-core|kamakura-agent)(?:\.exe)?$`)
var attachedSignal = regexp.MustCompile(`(?i)^-(?:s|n)(?:HUP|TERM|KILL|INT|QUIT|STOP|CONT|\d+)$|^--signal=`)

func criticalKill(command string) bool {
	tokens := shellToken.FindAllString(command, -1)
	if len(tokens) == 0 {
		return false
	}
	for i := range tokens {
		tokens[i] = strings.Trim(tokens[i], "'\"")
	}
	name := strings.ToLower(tokens[0])
	if name != "kill" && name != "pkill" && name != "killall" && name != "taskkill" && name != "stop-process" {
		return false
	}
	if name == "killall" {
		return true
	}
	literal := false
	for i := 1; i < len(tokens); i++ {
		t := tokens[i]
		if t == "--" {
			literal = true
			continue
		}
		if !literal {
			if name == "kill" && t == "-1" {
				return true
			}
			switch t {
			case "-s", "--signal", "-n", "-u", "-U", "-g", "-G", "-P", "-t", "--ns", "--nslist", "/fi":
				i++
				continue
			}
			if attachedSignal.MatchString(t) {
				continue
			}
			if strings.HasPrefix(t, "-") && t != "-1" {
				continue
			}
			if strings.EqualFold(t, "/pid") || strings.EqualFold(t, "/im") {
				continue
			}
			if strings.HasPrefix(t, "/") {
				continue
			}
		}
		if t == "1" || t == "-1" || criticalProcess.MatchString(t) {
			return true
		}
	}
	return false
}
