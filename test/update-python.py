import importlib.util
import unittest
import tempfile
from pathlib import Path
import copy
from unittest.mock import patch
import argparse
import fcntl
import json
spec=importlib.util.spec_from_file_location("updater",Path(__file__).resolve().parents[1]/"deploy/update.py")
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)

class FakeDocker:
    def __init__(self,root):
        self.ops=[]
        self.target="sha256:"+64*"b"
        hc={"Test":["CMD","true"]}
        self.old={"Id":"a"*64,"Name":"/fixture-core-1","Image":"sha256:"+64*"a",
          "Config":{"Env":["AUTH=sentinel","QUOTED=a b ' \""],"Labels":{
             "com.docker.compose.service":"core","com.docker.compose.project.working_dir":str(root),
             "com.docker.compose.project.config_files":str(root/"compose.yaml")},"Healthcheck":hc},
          "State":{"Running":True,"StartedAt":"old","Health":{"Status":"healthy"}},
          "HostConfig":{"NetworkMode":"fixture_default"},
          "Mounts":[{"Destination":"/app/data","Source":str(root/"data")}],
          "NetworkSettings":{"Networks":{"fixture_default":{"Aliases":["core"]}}}}
        self.mongo=copy.deepcopy(self.old);self.mongo["Id"]="m"*64;self.mongo["Name"]="/fixture-mongo-1";self.mongo["Config"]["Labels"]={}
        self.c={self.old["Id"]:copy.deepcopy(self.old),self.mongo["Id"]:self.mongo}
        self.healthy=True;self.pullFail=False;self.compat="1";self.revision="b"*40;self.backends="mongo,sqlite"
    def run(self,args,seconds=60):
        self.ops.append(args)
        if args[:2]==["image","pull"] and self.pullFail:raise u.UpdateError("fixture pull failure")
        if args[:2]==["container","stop"]:self.c[args[-1]]["State"]["Running"]=False
        if args[:2]==["container","rename"]:self.c[args[2]]["Name"]="/"+args[3]
        if args[:2]==["container","start"]:
            self.c[args[2]]["State"]["Running"]=True
            self.c[args[2]]["State"]["Health"]["Status"]="healthy" if args[2]==self.old["Id"] or self.healthy else "unhealthy"
        if args[:2]==["container","rm"]:del self.c[args[-1]]
        return ""
    def containers(self):return copy.deepcopy(list(self.c.values()))
    def inspect(self,kind,name):
        if kind=="container":return copy.deepcopy(self.c[name])
        return {"Id":self.target if name.startswith(u.REGISTRY) else name,
          "RepoDigests":[u.REGISTRY+"@sha256:"+64*"b"],
          "Config":{"Labels":{u.COMPAT:self.compat,u.HEALTH:"1","io.kamakura.backends":self.backends,"org.opencontainers.image.revision":self.revision},"Healthcheck":{"Test":["CMD","true"]}}}
    def create(self,payload,name):
        new=copy.deepcopy(self.old);new["Id"]="n"*64;new["Name"]="/"+name
        new["Image"]=payload["Image"];new["Config"]=copy.deepcopy(payload)
        new["Config"].pop("HostConfig",None);new["Config"].pop("NetworkingConfig",None)
        self.c[new["Id"]]=new;return new["Id"]

class UpdateTests(unittest.TestCase):
 def setUp(self):
    self.disk=patch.object(u.shutil,"disk_usage",return_value=type("Disk",(),{"free":4*1024**3})())
    self.disk.start();self.addCleanup(self.disk.stop)
    self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    (self.root/".env").write_text("AUTH=sentinel\nQUOTES='a b \"'\n");(self.root/".env").chmod(0o600)
    (self.root/"compose.yaml").write_text("services: {}")
    self.before=u.fingerprint(self.root/".env");self.d=FakeDocker(self.root)
 def tearDown(self):self.tmp.cleanup()
 def a(self,**kwargs):return argparse.Namespace(target=kwargs.get("target","latest"),force=kwargs.get("force",False),auto=kwargs.get("auto",False),rollback=kwargs.get("rollback",False))
 def test_success_and_exact_rollback(self):
    u.update(self.d,self.root,self.a())
    self.assertEqual(self.d.c["n"*64]["Image"],self.d.target)
    self.assertEqual(self.d.c["n"*64]["Config"]["Env"],self.d.old["Config"]["Env"])
    self.assertEqual(u.fingerprint(self.root/".env"),self.before)
    u.update(self.d,self.root,self.a(rollback=True))
    self.assertEqual(self.d.c[self.d.old["Id"]]["Name"],self.d.old["Name"])
    self.assertTrue(self.d.c[self.d.old["Id"]]["State"]["Running"])
    self.assertNotIn("n"*64,self.d.c)
 def test_advanced_file_bytes_and_mode_across_update_rollback(self):
    advanced=self.root/".env.advanced";advanced.write_text("TUNING='precisely unchanged'\n");advanced.chmod(0o600)
    before=u.fingerprint(advanced)
    u.update(self.d,self.root,self.a());self.assertEqual(u.fingerprint(advanced),before)
    u.update(self.d,self.root,self.a(rollback=True));self.assertEqual(u.fingerprint(advanced),before)
 def test_optional_advanced_absence_is_preserved_and_appearance_blocks_rollback(self):
    u.update(self.d,self.root,self.a())
    self.assertFalse((self.root/".env.advanced").exists())
    (self.root/".env.advanced").write_text("NEW=added\n")
    with self.assertRaisesRegex(u.UpdateError,"Configuration changed"):u.update(self.d,self.root,self.a(rollback=True))
 def test_sqlite_compatibility_contract_and_preservation(self):
    self.d.c[self.d.old["Id"]]["Config"]["Env"].append("STORAGE=sqlite")
    self.d.old["Config"]["Env"].append("STORAGE=sqlite")
    u.update(self.d,self.root,self.a());u.update(self.d,self.root,self.a(rollback=True))
    self.d.backends="mongo"
    with self.assertRaisesRegex(u.UpdateError,"SQLite compatibility"):u.update(self.d,self.root,self.a())
    self.assertTrue(self.d.c[self.d.old["Id"]]["State"]["Running"])
 def test_unhealthy_failure_rollback_and_suppression(self):
    self.d.healthy=False
    with self.assertRaisesRegex(u.UpdateError,"rolled back"):u.update(self.d,self.root,self.a())
    self.assertTrue(self.d.c[self.d.old["Id"]]["State"]["Running"])
    self.assertEqual(self.d.c[self.d.old["Id"]]["Image"],self.d.old["Image"])
    with self.assertRaisesRegex(u.UpdateError,"previously failed"):u.update(self.d,self.root,self.a())
    self.d.healthy=True;u.update(self.d,self.root,self.a(force=True))
 def test_pull_failure_never_stops(self):
    self.d.pullFail=True
    with self.assertRaises(u.UpdateError):u.update(self.d,self.root,self.a())
    self.assertFalse(any(x[:2]==["container","stop"] for x in self.d.ops))
 def test_disk_error_never_stops(self):
    with patch.object(u.shutil,"disk_usage",side_effect=OSError("disk")):
      with self.assertRaises(OSError):u.update(self.d,self.root,self.a())
    with patch.object(u.shutil,"disk_usage",return_value=type("Disk",(),{"free":1})()):
      with self.assertRaisesRegex(u.UpdateError,"headroom"):u.update(self.d,self.root,self.a())
    self.assertFalse(any(x[:2]==["container","stop"] for x in self.d.ops))
 def test_commit_and_schema_refusal(self):
    with self.assertRaisesRegex(u.UpdateError,"revision"):u.update(self.d,self.root,self.a(target="c"*40))
    self.d.compat="2"
    with self.assertRaisesRegex(u.UpdateError,"storage"):u.update(self.d,self.root,self.a())
    self.assertFalse(any(x[:2]==["container","stop"] for x in self.d.ops))
 def test_lock_auto_off_and_args(self):
    folder=self.root/".update-state";folder.mkdir(mode=0o700)
    with open(folder/"lock","w") as f:
      fcntl.flock(f,fcntl.LOCK_EX)
      with self.assertRaisesRegex(u.UpdateError,"Another"):u.update(self.d,self.root,self.a())
    with self.assertRaisesRegex(u.UpdateError,"disabled"):u.update(self.d,self.root,self.a(auto=True))
    for value in ["latest;touch /tmp/pwn","a b","--unknown","../latest","$(echo hi)","LATEST"]:
      with self.assertRaises(SystemExit):u.args([value])
 def test_interrupted_create_recovery(self):
    old=self.d.old
    self.d.run(["container","stop","--time","30",old["Id"]])
    self.d.run(["container","rename",old["Id"],"saved"])
    payload=copy.deepcopy(old["Config"]);payload["Image"]=self.d.target
    payload["Labels"]["io.kamakura.update-transaction"]=old["Id"]
    self.d.create(payload,old["Name"].lstrip("/"))
    folder=self.root/".update-state";folder.mkdir(mode=0o700)
    u.save(folder/"transaction.json",{"old":old,"new":None,"digest":self.d.target})
    with self.assertRaisesRegex(u.UpdateError,"Interrupted"):u.update(self.d,self.root,self.a())
    self.assertNotIn("n"*64,self.d.c)
    self.assertTrue(self.d.c[old["Id"]]["State"]["Running"])
 def test_interrupted_rollback_after_new_removed(self):
    u.update(self.d,self.root,self.a())
    folder=self.root/".update-state"
    state=json.loads((folder/"previous.json").read_text())
    self.d.run(["container","rm","-f",state["new"]])
    u.save(folder/"transaction.json",state)
    with self.assertRaisesRegex(u.UpdateError,"Interrupted"):u.update(self.d,self.root,self.a())
    self.assertTrue(self.d.c[state["old"]["Id"]]["State"]["Running"])
    self.assertFalse((folder/"transaction.json").exists())
 def test_beta_refused(self):
    self.d.c[self.d.old["Id"]]["Config"]["Labels"]["kat.beta.scope"]="sentinel"
    with self.assertRaisesRegex(u.UpdateError,"Beta"):u.update(self.d,self.root,self.a())
if __name__=="__main__":unittest.main()
