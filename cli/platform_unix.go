//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

func secureDir(p string) error      { return os.Chmod(p, 0700) }
func replaceFile(a, b string) error { return os.Rename(a, b) }
func detach(c *exec.Cmd)            { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func shell(ctx context.Context, command string) *exec.Cmd {
	c := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error {
		if c.Process == nil {
			return nil
		}
		return syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
	return c
}
