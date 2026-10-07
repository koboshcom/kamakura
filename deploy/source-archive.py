#!/usr/bin/env python3
"""Package only committed source, excluding key/config runtime artifacts."""
import argparse
import hashlib
import subprocess
import zipfile
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('output')
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
entries = subprocess.check_output(['git', 'ls-tree', '-r', revision], cwd=root, text=True).splitlines()
files = [(line.split('\t',1)[1], line.split(' ',1)[0]) for line in entries]
excluded = {'.env', '.env.local'}
with zipfile.ZipFile(a.output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, mode in files:
        path = Path(name)
        if name in excluded or any(part in {'data','keys','sandboxes','node_modules','.git'} for part in path.parts):
            continue
        if path.suffix.lower() in {'.pem','.key'}:
            raise ValueError('Refusing potential private key ' + name)
        data = subprocess.check_output(['git','show',revision+':'+name],cwd=root)
        info = zipfile.ZipInfo('kamakura/'+name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o755 if mode == '100755' else 0o644) << 16
        archive.writestr(info,data)
    archive.writestr('kamakura/SOURCE-REVISION.txt',revision+'\n')
print(revision)
print(hashlib.sha256(Path(a.output).read_bytes()).hexdigest())
