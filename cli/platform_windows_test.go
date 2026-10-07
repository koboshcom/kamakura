package main

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
)

func setBroadDACL(t *testing.T, p string) {
	t.Helper()
	sd, e := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if e != nil {
		t.Fatal(e)
	}
	dacl, _, e := sd.DACL()
	if e != nil {
		t.Fatal(e)
	}
	if e = windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); e != nil {
		t.Fatal(e)
	}
}
func TestWindowsPrivateDACL(t *testing.T) {
	p := t.TempDir()
	setBroadDACL(t, p)
	if e := secureDir(p); e != nil {
		t.Fatal(e)
	}
	fpath := filepath.Join(p, "existing.json")
	if e := os.WriteFile(fpath, []byte(`{"token":"synthetic"}`), 0600); e != nil {
		t.Fatal(e)
	}
	setBroadDACL(t, fpath)
	f, e := os.Open(fpath)
	if e != nil {
		t.Fatal(e)
	}
	if e = checkPrivateFile(f); e == nil {
		t.Fatal("accepted broad existing token file")
	}
	f.Close()
	if e = secureNewFile(fpath); e != nil {
		t.Fatal(e)
	}
	f, e = os.Open(fpath)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = checkPrivateFile(f); e != nil {
		t.Fatal(e)
	}
}
