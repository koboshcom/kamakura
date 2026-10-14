"""Explicit Linux Docker integration audit. Never run against a user's project."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from unittest.mock import patch

repo=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("updater",repo/"deploy/update.py")
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
os.umask(0o077)
project="kama-update-test-"+uuid.uuid4().hex[:10]
root=Path(tempfile.mkdtemp(prefix=project+"-"))
d=u.Docker()
images=[]
backend=os.environ.get("TEST_BACKEND","mongo")
assert backend in ("mongo","sqlite")
def docker(*args):return d.run(list(args),seconds=120)
def compose(*args):return docker("compose","--project-name",project,"--project-directory",str(root),"-f",str(root/"compose.yaml"),*args)
def options(**kw):return argparse.Namespace(target=kw.get("target","latest"),force=kw.get("force",False),auto=False,rollback=kw.get("rollback",False))
class FixtureDocker(u.Docker):
 def __init__(self):super().__init__();self.selected="good";self.fail=False;self.operations=[]
 def run(self,args,seconds=60):
    self.operations.append(args)
    if args[:2]==["image","pull"]:
        if self.fail:raise u.UpdateError("fixture pull failed")
        return "local fixture, no registry request"
    return super().run(args,seconds)
 def inspect(self,kind,name):
    if kind=="image" and name.startswith(u.REGISTRY):
        r=super().inspect("image",images[1 if self.selected=="good" else 2])
        r["RepoDigests"]=[u.REGISTRY+"@sha256:"+r["Id"].split(":")[1]]
        return r
    return super().inspect(kind,name)
f=FixtureDocker()
results={}
baseline=json.loads(d.run(["container","inspect","kamakura-core-1"]))[0]
mongobefore=d.inspect("container","kamakura-mongo-1")
try:
 for mode,revision in [("old","a"*40),("good","b"*40),("bad","c"*40)]:
    build=root/mode;build.mkdir()
    (build/"fixture.js").write_text("const fs=require('fs');fs.writeFileSync('/tmp/fixture-ready','ready');setInterval(()=>{},1000);")
    health="require('fs').accessSync('/tmp/fixture-ready')" if mode!="bad" else "process.exit(1)"
    tag=project+":"+mode
    (build/"Dockerfile").write_text(f"""FROM node:24-bookworm-slim
LABEL io.kamakura.storage-contract="1" io.kamakura.readiness="1" io.kamakura.backends="mongo,sqlite" org.opencontainers.image.revision="{revision}" io.kamakura.fixture="{project}"
COPY fixture.js /app/fixture.js
HEALTHCHECK --interval=1s --timeout=1s --start-period=1s --retries=1 CMD ["node","-e","{health}"]
CMD ["node","/app/fixture.js"]
""")
    docker("build","--pull=false","-t",tag,str(build));images.append(tag)
 # No registry access. Use the image already present on this host.
 mongoimage=mongobefore["Image"]
 s=socket.socket();s.bind(("127.0.0.1",0));port=s.getsockname()[1];s.close()
 (root/".env").write_text("STORAGE="+backend+"\nAUTH=sentinel\nQUOTED=a b ' \"\n")
 (root/".env.advanced").write_text("ADVANCED_SENTINEL=preserve\nSTT_REQUEST_TIMEOUT_SECONDS=60\n")
 (root/"data").mkdir();(root/"data"/"pairings.json").write_text('{"pair":"sentinel"}')
 (root/"compose.yaml").write_text(f"""services:
  core:
    image: {images[0]}
    env_file:
      - path: .env.advanced
        required: false
      - path: .env
        required: true
    labels:
      io.kamakura.fixture: {project}
    ports: ["127.0.0.1:{port}:49123"]
    volumes: ["./data:/app/data", "auth:/app/auth"]
    networks: [default, db]
  mongo:
    image: {mongoimage}
    labels:
      io.kamakura.fixture: {project}
    volumes: ["mongo:/data/db"]
    networks: [db]
    healthcheck:
      test: ["CMD","mongosh","--quiet","--eval","quit(db.adminCommand('ping').ok?0:1)"]
      interval: 1s
      retries: 30
volumes:
  mongo:
  auth:
networks:
  db:
    internal: true
""")
 if backend=="sqlite":
    text=(root/"compose.yaml").read_text();start=text.index("  mongo:");end=text.index("volumes:",start);text=text[:start]+text[end:];text=text.replace("networks: [default, db]","networks: [default]");(root/"compose.yaml").write_text(text)
 compose("up","-d","--no-build","--pull","never")
 core=compose("ps","-q","core").strip();mongo=compose("ps","-q","mongo").strip() if backend=="mongo" else None
 assert u.healthy(d,core,30) and (mongo is None or u.healthy(d,mongo,40))
 docker("exec",core,"node","-e","require('fs').writeFileSync('/app/auth/auth','auth-sentinel')")
 if mongo:docker("exec",mongo,"mongosh","--quiet","--eval","db.getSiblingDB('fixture').sentinel.insertOne({key:'keep'})")
 mongoexact=u.protected(d.inspect("container",mongo)) if mongo else None
 sentinel=(root/"data"/"pairings.json").read_bytes()
 env=u.fingerprint(root/".env");advanced=u.fingerprint(root/".env.advanced")
 u.update(f,root,options())
 current=next(c for c in d.containers() if c["Name"]=="/"+project+"-core-1")
 assert current["Image"]==d.inspect("image",images[1])["Id"]
 if mongo:assert u.protected(d.inspect("container",mongo))==mongoexact
 assert (root/"data"/"pairings.json").read_bytes()==sentinel and u.fingerprint(root/".env")==env
 assert docker("exec",current["Id"],"node","-e","process.stdout.write(require('fs').readFileSync('/app/auth/auth'))")=="auth-sentinel"
 if mongo:assert docker("exec",mongo,"mongosh","--quiet","--eval","db.getSiblingDB('fixture').sentinel.countDocuments({key:'keep'})").strip()=="1"
 results["successProtectedEnvAuthPairingMongo"]=True
 u.update(f,root,options(rollback=True))
 assert d.inspect("container",core)["Image"]==d.inspect("image",images[0])["Id"]
 assert u.healthy(d,core,10)
 results["manualExactRollback"]=True
 f.selected="bad"
 try:u.update(f,root,options())
 except u.UpdateError as e:assert "rolled back" in str(e)
 else:raise AssertionError("unhealthy succeeded")
 assert u.healthy(d,core,10) and d.inspect("container",core)["Image"]==d.inspect("image",images[0])["Id"]
 results["unhealthyExactRollbackNonzero"]=True
 operations=len(f.operations)
 try:u.update(f,root,options())
 except u.UpdateError as e:assert "previously failed" in str(e)
 else:raise AssertionError("bad digest retry")
 assert not any(a[:2]==["container","stop"] for a in f.operations[operations:])
 results["badDigestSuppressed"]=True
 f.selected="good";f.fail=True
 operations=len(f.operations)
 try:u.update(f,root,options())
 except u.UpdateError:pass
 else:raise AssertionError("pull failure")
 assert u.healthy(d,core,10)
 assert not any(a[:2]==["container","stop"] for a in f.operations[operations:])
 results["pullFailureNoStop"]=True
 f.fail=False
 with patch.object(u.shutil,"disk_usage",side_effect=OSError("fixture disk failure")):
    try:u.update(f,root,options())
    except OSError:pass
    else:raise AssertionError("disk error")
 assert u.healthy(d,core,10)
 results["diskErrorNoStop"]=True
 try:u.update(f,root,options(target="d"*40))
 except u.UpdateError as e:assert "revision" in str(e)
 else:raise AssertionError("unknown commit")
 results["unknownCommitRefused"]=True
 import fcntl
 with open(root/".update-state"/"lock","w") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    try:u.update(f,root,options())
    except u.UpdateError as e:assert "Another" in str(e)
    else:raise AssertionError("concurrent lock")
 results["concurrentLock"]=True
 assert u.fingerprint(root/".env")==env and (root/"data"/"pairings.json").read_bytes()==sentinel
 if mongo:assert u.protected(d.inspect("container",mongo))==mongoexact
 assert u.protected(d.inspect("container","kamakura-core-1"))==u.protected(baseline)
 assert u.protected(d.inspect("container","kamakura-mongo-1"))==u.protected(mongobefore)
 assert u.fingerprint(root/".env.advanced")==advanced
 if backend=="sqlite":assert not any(c["Config"].get("Labels",{}).get("com.docker.compose.project")==project and c["Config"].get("Labels",{}).get("com.docker.compose.service")=="mongo" for c in d.containers())
 results["bothEnvFilesUnchangedPrivate"]=True
 results["sqliteNoMongoContainer"]=backend=="sqlite"
 results["liveBetaAndMongoUntouched"]=True
 print(json.dumps(results,indent=2))
finally:
 # Explicit task-owned objects only. No compose down/prune/system cleanup.
 for c in d.containers():
    if c["Config"].get("Labels",{}).get("io.kamakura.fixture")==project:
        docker("container","rm","-f",c["Id"])
 for ident in docker("volume","ls","-q","--filter","label=com.docker.compose.project="+project).split():
    docker("volume","rm",ident)
 for ident in docker("network","ls","-q","--filter","label=com.docker.compose.project="+project).split():
    docker("network","rm",ident)
 for tag in images:docker("image","rm",tag)
 shutil.rmtree(root)
