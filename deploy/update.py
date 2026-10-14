#!/usr/bin/env python3
"""Linux Compose core-only updater. No DB operations, migrations or pruning."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = "ghcr.io/koboshcom/kamakura"
COMPAT = "io.kamakura.storage-contract"
HEALTH = "io.kamakura.readiness"
MIN_FREE = 2 * 1024**3
TIMEOUT = 120

class UpdateError(Exception):
    pass

class Docker:
    def __init__(self):
        # Do not inherit remote Docker/Compose selection or shell startup settings.
        self.env = {k:v for k,v in os.environ.items() if k in ("PATH", "HOME", "DOCKER_CONFIG")}
        self.env["PATH"] = "/usr/local/bin:/usr/bin:/bin"
    def run(self, args, seconds=60):
        try:
            p = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", *args],
                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=seconds, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise UpdateError("Docker operation failed or timed out") from None
        if p.returncode:
            raise UpdateError("Docker operation failed; current image remains pinned") from None
        if len(p.stdout) > 16*1024**2:
            raise UpdateError("Docker response too large")
        return p.stdout.decode()
    def inspect(self, kind, name):
        return json.loads(self.run([kind, "inspect", name]))[0]
    def containers(self):
        ids=self.run(["container","ls","-aq"]).split()
        return [self.inspect("container",x) for x in ids]
    def create(self, payload, name):
        # Engine API avoids shell strings and faithfully retains HostConfig.
        import http.client
        import socket
        class UnixHTTP(http.client.HTTPConnection):
            def connect(self):
                self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                self.sock.settimeout(60)
                self.sock.connect("/var/run/docker.sock")
        c=UnixHTTP("localhost",timeout=60)
        data=json.dumps(payload).encode()
        try:
            c.request("POST","/v1.47/containers/create?name="+name,body=data,
                      headers={"Content-Type":"application/json"})
            r=c.getresponse();raw=r.read(65537)
            if r.status!=201 or len(raw)>65536:
                raise UpdateError("Core creation failed")
            return json.loads(raw)["Id"]
        finally:
            c.close()

def save(path, value):
    temp=path.with_suffix(".tmp")
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"w") as f:
        json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(temp,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def fingerprint(path):
    if path.is_symlink() or not path.is_file():
        raise UpdateError("Required configuration must be a regular non-symlink file")
    s=path.stat()
    return [hashlib.sha256(path.read_bytes()).hexdigest(),s.st_mode,s.st_uid,s.st_gid]

def protected(container):
    return {"id":container["Id"],"image":container["Image"],
            "mounts":sorted(container["Mounts"],key=lambda x:x["Destination"]),"host":container["HostConfig"],
            "networks":sorted(container["NetworkSettings"]["Networks"]),
            "running":container["State"]["Running"],"started":container["State"]["StartedAt"]}

def inventory(d, core_id):
    # All other containers, not just Mongo or this project's owner boxes.
    return {c["Id"]:protected(c) for c in d.containers() if c["Id"]!=core_id}

def healthy(d, ident, timeout=TIMEOUT):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        c=d.inspect("container",ident)
        if not c["State"]["Running"]:
            return False
        h=c["State"].get("Health",{}).get("Status")
        if h=="healthy":
            return True
        if h=="unhealthy":
            return False
        time.sleep(1)
    return False

def rollback(d, state):
    old=state["old"]
    new=state.get("new")
    if not new:
        # Recover a crash between Engine creation and journal fsync by its
        # transaction label, never by an unrelated container name alone.
        matches=[c for c in d.containers() if c["Config"].get("Labels",{}).get("io.kamakura.update-transaction")==old["Id"]]
        if len(matches)>1:raise UpdateError("Ambiguous transaction recovery")
        if matches:new=matches[0]["Id"]
    if new:
        # Only the container created by this transaction can be removed.
        d.run(["container","rm","-f",new])
    current=d.inspect("container",old["Id"])
    if current["Image"]!=old["Image"] or current["HostConfig"]!=old["HostConfig"] or current["Config"]["Env"]!=old["Config"]["Env"]:
        raise UpdateError("Retained core configuration changed; rollback refused")
    if current["Name"]!=old["Name"]:
        d.run(["container","rename",old["Id"],old["Name"].lstrip("/")])
    d.run(["container","start",old["Id"]])
    # Legacy core may have no healthcheck. Require the existing startup event.
    if old["State"].get("Health"):
        ok=healthy(d,old["Id"])
    else:
        end=time.monotonic()+TIMEOUT;ok=False
        while time.monotonic()<end:
            c=d.inspect("container",old["Id"])
            if not c["State"]["Running"]:break
            text=d.run(["container","logs","--since",c["State"]["StartedAt"],old["Id"]])
            for line in text.splitlines():
                try:r=json.loads(line)
                except ValueError:continue
                if r.get("transports") and str(r.get("msg","")).endswith(" awake"):
                    ok=True
            if ok:break
            time.sleep(1)
    if not ok:
        raise UpdateError("Previous core restored but readiness failed; operator intervention required")

def args(argv):
    p=argparse.ArgumentParser(description="Update only the standard Compose core; never Mongo or owner boxes.")
    p.add_argument("target",nargs="?",default="latest")
    p.add_argument("--force",action="store_true",help="Retry a previously failed digest")
    p.add_argument("--auto",action="store_true",help="Requires the operator-created auto-enabled file")
    p.add_argument("--rollback",action="store_true",help="Restore the exact previous retained core")
    a=p.parse_args(argv)
    if not re.fullmatch(r"latest|[0-9a-f]{7}|[0-9a-f]{40}",a.target):
        p.error("target must be latest, the published seven-character commit tag, or full commit")
    if a.rollback and (a.target!="latest" or a.auto):
        p.error("rollback cannot select a target or run automatically")
    return a

def update(d, root, a):
    root=Path(root).resolve()
    configfiles=[root/".env",root/"compose.yaml"]
    if (root/"compose.whatsapp.yaml").exists():configfiles.append(root/"compose.whatsapp.yaml")
    before={str(p):fingerprint(p) for p in configfiles}
    state_dir=root/".update-state"
    if state_dir.is_symlink():raise UpdateError("Unsafe updater state directory")
    state_dir.mkdir(mode=0o700,exist_ok=True)
    if state_dir.stat().st_mode & 0o077:raise UpdateError("Updater state directory must be private")
    lockfd=os.open(state_dir/"lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(lockfd,"w") as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise UpdateError("Another update is running") from None
        journal=state_dir/"transaction.json"
        previous=state_dir/"previous.json"
        bad=state_dir/"failed-digest"
        if journal.exists():
            state=json.loads(journal.read_text())
            if state.get("committed"):
                if not healthy(d,state["new"]):raise UpdateError("Committed update is no longer healthy; use --rollback")
                journal.unlink()
                print("Completed interrupted success cleanup")
                return
            rollback(d,state);journal.unlink()
            raise UpdateError("Interrupted update rolled back; rerun manually")
        if a.auto and not (state_dir/"auto-enabled").is_file():
            raise UpdateError("Automatic updates are disabled")
        if a.auto:time.sleep(int.from_bytes(os.urandom(2),"big")%31)
        if a.rollback:
            if not previous.exists():raise UpdateError("No retained previous core")
            state=json.loads(previous.read_text())
            if before!=state["files"]:raise UpdateError("Configuration changed; manual rollback review required")
            rollback(d,state);previous.unlink()
            print("Exact previous core restored; no database or owner-box operations")
            return
        allc=d.containers()
        candidates=[c for c in allc if c["State"]["Running"]
                    and c["Config"].get("Labels",{}).get("com.docker.compose.service")=="core"
                    and c["Config"].get("Labels",{}).get("com.docker.compose.project.working_dir")==str(root)]
        if len(candidates)!=1:raise UpdateError("Exactly one running Compose core for this checkout is required")
        old=candidates[0]
        labels=old["Config"].get("Labels",{})
        if any(k.startswith("kat.beta.") for k in labels):
            raise UpdateError("Beta overlays are unsupported; use the protected overlay deployment procedure")
        cfgpaths=labels.get("com.docker.compose.project.config_files","").split(",")
        if sorted(cfgpaths)!=sorted(str(p) for p in configfiles if p.name!=".env"):
            raise UpdateError("Unsupported Compose override set; configuration review required")
        if old["HostConfig"].get("NetworkMode") in ("host","none") or any(v.get("IPAMConfig") for v in old["NetworkSettings"]["Networks"].values()):
            raise UpdateError("Static/host networking requires manual deployment review")
        oi=d.inspect("image",old["Image"])
        contract=oi["Config"].get("Labels",{}).get(COMPAT)
        if contract!="1":
            raise UpdateError("Previous image lacks the supported storage contract; rebuild/install this version manually once")
        if not healthy(d,old["Id"],10):raise UpdateError("Current core is not healthy")
        if shutil.disk_usage(root).free<MIN_FREE or shutil.disk_usage("/var/lib/docker").free<MIN_FREE:
            raise UpdateError("Insufficient disk headroom; nothing stopped or pruned")
        inv=inventory(d,old["Id"])
        tag=a.target
        # The workflow publishes ONLY seven-character tags and latest.
        if len(tag)==40:
            revision=tag;tag=tag[:7]
        else:revision=None
        image=REGISTRY+":"+tag
        d.run(["image","pull",image],seconds=300)
        target=d.inspect("image",image)
        targetlabels=target["Config"].get("Labels",{})
        if targetlabels.get(COMPAT)!=contract or targetlabels.get(HEALTH)!="1":
            raise UpdateError("Missing or incompatible storage/readiness contract; migration refused")
        rev=targetlabels.get("org.opencontainers.image.revision","")
        if not re.fullmatch(r"[0-9a-f]{40}",rev) or (tag!="latest" and not rev.startswith(tag)) or (revision and revision!=rev):
            raise UpdateError("Published image revision does not match requested commit")
        if not target.get("RepoDigests") or not any(x.startswith(REGISTRY+"@sha256:") for x in target["RepoDigests"]):
            raise UpdateError("Trusted registry digest unavailable")
        digest=target["Id"]
        if digest==old["Image"]:
            print("Core already uses this immutable image");return
        if bad.exists() and json.loads(bad.read_text())==digest and not a.force:
            raise UpdateError("This digest previously failed; wait for a new digest or use --force")
        if before!={str(p):fingerprint(p) for p in configfiles} or inventory(d,old["Id"])!=inv:
            raise UpdateError("Protected inventory/configuration changed during precheck")
        if shutil.disk_usage(root).free<MIN_FREE or shutil.disk_usage("/var/lib/docker").free<MIN_FREE:
            raise UpdateError("Insufficient headroom after pull; current core untouched")
        cfg=copy.deepcopy(old["Config"]);cfg.pop("Hostname",None);cfg.pop("Domainname",None)
        cfg.setdefault("Labels",{})["io.kamakura.update-transaction"]=old["Id"]
        cfg["Image"]=digest;cfg["Healthcheck"]=target["Config"].get("Healthcheck")
        if not cfg["Healthcheck"]:raise UpdateError("Target image has no readiness healthcheck")
        # Preserve every environment value, secret, command, mount and network.
        payload=dict(cfg,HostConfig=old["HostConfig"],NetworkingConfig={"EndpointsConfig":{
            n:{"Aliases":v.get("Aliases",[])} for n,v in old["NetworkSettings"]["Networks"].items()}})
        state={"old":old,"new":None,"files":before,"inventory":inv,"digest":digest}
        save(journal,state)
        try:
            d.run(["container","stop","--time","30",old["Id"]])
            d.run(["container","rename",old["Id"],old["Name"].lstrip("/")+"-update-previous-"+old["Id"][:12]])
            state["new"]=d.create(payload,old["Name"].lstrip("/"));save(journal,state)
            d.run(["container","start",state["new"]])
            if not healthy(d,state["new"]):raise UpdateError("New core failed its readiness deadline")
            now=d.inspect("container",state["new"])
            if now["Image"]!=digest or now["HostConfig"]!=old["HostConfig"] or now["Config"]["Env"]!=old["Config"]["Env"] or sorted(now["Mounts"],key=lambda x:x["Destination"])!=sorted(old["Mounts"],key=lambda x:x["Destination"]) or sorted(now["NetworkSettings"]["Networks"])!=sorted(old["NetworkSettings"]["Networks"]):
                raise UpdateError("Protected core configuration mismatch")
            afterinv=inventory(d,state["new"]);afterinv.pop(old["Id"],None)
            if afterinv!=inv or before!={str(p):fingerprint(p) for p in configfiles}:
                raise UpdateError("Protected inventory changed")
            if previous.exists():
                history=state_dir/"history";history.mkdir(mode=0o700,exist_ok=True)
                prior=json.loads(previous.read_text())
                save(history/(prior["old"]["Id"]+".json"),prior)
            save(previous,state);state["committed"]=True;save(journal,state);journal.unlink();bad.unlink(missing_ok=True)
            print("Core updated to "+rev+" ("+digest+"); previous immutable core retained. Mongo and owner boxes untouched.")
        except Exception:
            save(bad,digest)
            rollback(d,state);journal.unlink(missing_ok=True)
            raise UpdateError("Update failed; exact previous core rolled back. No migration, database restart, or pruning performed") from None

def main():
    os.umask(0o077)
    try:update(Docker(),ROOT,args(sys.argv[1:]))
    except (UpdateError,OSError,ValueError) as e:
        # Never emit subprocess output, provider settings, or snapshot contents.
        print(str(e) if isinstance(e,UpdateError) else "Updater state/configuration operation failed",file=sys.stderr)
        return 1
    return 0
if __name__=="__main__":
    sys.exit(main())
