package main

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"syscall"
)

func secureDir(p string) error {
	u, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		return e
	}
	sid := u.User.Sid.String()
	c := exec.Command("icacls.exe", p, "/inheritance:r", "/grant:r", "*"+sid+":(OI)(CI)F")
	if e = c.Run(); e != nil {
		return e
	}
	return nil
}
func replaceFile(a, b string) error {
	ap, e := windows.UTF16PtrFromString(a)
	if e != nil {
		return e
	}
	bp, e := windows.UTF16PtrFromString(b)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(ap, bp, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x08000000}
}
func shell(ctx context.Context, command string) *exec.Cmd {
	c := exec.CommandContext(ctx, "cmd.exe", "/D", "/S", "/C", command)
	c.Cancel = func() error {
		if c.Process == nil {
			return nil
		}
		_ = exec.Command("taskkill.exe", "/PID", fmtPID(c.Process.Pid), "/T", "/F").Run()
		return c.Process.Kill()
	}
	return c
}

var _ = os.ErrNotExist
