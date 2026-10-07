//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

func secureNewFile(p string) error { return os.Chmod(p, 0600) }
func checkPrivateFile(f *os.File) error {
	s, e := f.Stat()
	if e != nil {
		return e
	}
	if !s.Mode().IsRegular() || s.Mode().Perm()&0077 != 0 {
		return os.ErrPermission
	}
	return nil
}
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
