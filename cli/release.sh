#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export GOTOOLCHAIN=go1.26.8 CGO_ENABLED=0
[[ $(go version) == 'go version go1.26.8 linux/amd64' ]] || { echo 'Release builder requires pinned Go 1.26.8 on linux/amd64' >&2; exit 1; }
out=${1:-/home/kit/kama-cli-build}
archive=${2:-/home/kit/kama-cli-binaries.zip}
mkdir -p "$out"
for os in linux darwin windows; do
 for arch in amd64 arm64; do
  suffix=''; [[ $os != windows ]] || suffix='.exe'
  GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false -ldflags='-buildid=' -o "$out/kama-$os-$arch$suffix" .
 done
done
python3 - "$out" "$archive" <<'PY'
import hashlib, json, pathlib, subprocess, sys, zipfile
out, archive = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
files = sorted(p for p in out.glob('kama-*') if p.is_file())
manifest = {'compiler': 'go1.26.8', 'cgo': False, 'trimpath': True, 'buildvcs': False, 'buildid': '', 'binaries': []}
for p in files:
 version = subprocess.check_output(['go','version','-m',str(p)], text=True)
 if 'go1.26.8' not in version.splitlines()[0]: raise RuntimeError('unexpected compiler')
 manifest['binaries'].append({'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'buildInfo': version})
data = (json.dumps(manifest, indent=2) + '\n').encode()
(out / 'BUILD-VERSIONS.json').write_bytes(data)
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
 for name, content in [(p.name,p.read_bytes()) for p in files] + [('BUILD-VERSIONS.json',data)]:
  info = zipfile.ZipInfo(name, (1980,1,1,0,0,0))
  info.compress_type = zipfile.ZIP_DEFLATED
  info.external_attr = (0o100755 if name.startswith('kama-') else 0o100644) << 16
  z.writestr(info, content)
print(archive)
PY
