package main

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"syscall"
)

// Replace the DACL, rather than merging grants from a reused directory.
// Only the current user is allowlisted. Administrators retain normal OS takeover powers.
func privateDACL(dir bool) (*windows.ACL, error) {
	u, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		return nil, e
	}
	flags := ""
	if dir {
		flags = "OICI"
	}
	sd, e := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")")
	if e != nil {
		return nil, e
	}
	dacl, _, e := sd.DACL()
	return dacl, e
}
func canonicalDACL(acl *windows.ACL) string {
	sd, e := windows.NewSecurityDescriptor()
	if e != nil {
		return ""
	}
	if e = sd.SetDACL(acl, true, false); e != nil {
		return ""
	}
	relative, e := sd.ToSelfRelative()
	if e != nil {
		return ""
	}
	return relative.String()
}
func verifyPrivateHandle(h windows.Handle, dir bool) error {
	sd, e := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	control, _, e := sd.Control()
	if e != nil {
		return e
	}
	actual, _, e := sd.DACL()
	if e != nil {
		return e
	}
	expected, e := privateDACL(dir)
	if e != nil {
		return e
	}
	if control&windows.SE_DACL_PROTECTED == 0 || actual == nil || actual.AceCount != 1 || canonicalDACL(expected) == "" || canonicalDACL(actual) != canonicalDACL(expected) {
		return errors.New("configuration DACL must be protected and current-user-only")
	}
	return nil
}
func securePath(p string, dir bool) error {
	s, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if s.Mode()&os.ModeSymlink != 0 || (dir && !s.IsDir()) || (!dir && !s.Mode().IsRegular()) {
		return errors.New("configuration must not be a link")
	}
	name, e := windows.UTF16PtrFromString(p)
	if e != nil {
		return e
	}
	h, e := windows.CreateFile(name, windows.READ_CONTROL|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return e
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(h, &info); e != nil {
		return e
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("configuration must not be a reparse point")
	}
	dacl, e := privateDACL(dir)
	if e != nil {
		return e
	}
	if e = windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); e != nil {
		return e
	}
	return verifyPrivateHandle(h, dir)
}
func secureDir(p string) error     { return securePath(p, true) }
func secureNewFile(p string) error { return securePath(p, false) }
func checkPrivateFile(f *os.File) error {
	h := windows.Handle(f.Fd())
	var info windows.ByHandleFileInformation
	if e := windows.GetFileInformationByHandle(h, &info); e != nil {
		return e
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return errors.New("configuration must be a regular non-reparse file")
	}
	return verifyPrivateHandle(h, false)
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
