package main

import "golang.org/x/sys/windows"

func preserveBinaryPermissions(old string, paths ...string) error {
	sd, e := windows.GetNamedSecurityInfo(old, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	acl, _, e := sd.DACL()
	if e != nil {
		return e
	}
	control, _, e := sd.Control()
	if e != nil {
		return e
	}
	flags := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION)
	if control&windows.SE_DACL_PROTECTED != 0 {
		flags |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		flags |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	for _, p := range paths {
		if e = windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, flags, nil, nil, acl, nil); e != nil {
			return e
		}
	}
	return nil
}
