//go:build !windows

package main

import (
	"os"
	"syscall"
)

func preserveBinaryPermissions(old string, paths ...string) error {
	st, e := os.Stat(old)
	if e != nil {
		return e
	}
	info, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return os.ErrPermission
	}
	for _, p := range paths {
		now, e := os.Stat(p)
		if e != nil {
			return e
		}
		own, ok := now.Sys().(*syscall.Stat_t)
		if !ok {
			return os.ErrPermission
		}
		if own.Uid != info.Uid || own.Gid != info.Gid {
			if e = os.Chown(p, int(info.Uid), int(info.Gid)); e != nil {
				return e
			}
		}
		if e = os.Chmod(p, st.Mode().Perm()); e != nil {
			return e
		}
	}
	return nil
}
