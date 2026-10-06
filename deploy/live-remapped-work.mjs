// Execute via stdin inside the built core. No user credentials or Telegram sends.
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { config } from './dist/config.js';
import { sandboxes } from './dist/sandbox.js';
const owners=['6612253937','7853500388'];
const docker=new Docker({socketPath:config.sandbox.socketPath});
assert.equal(config.sandbox.usernsRoot,true);
assert.equal(config.sandbox.allowSoftQuota,false);
assert.deepEqual([...config.sandbox.allowed].sort(),owners.toSorted());
for(const owner of owners){
 const result=await sandboxes.run(owner,"set -e; id -u; sudo -n id -u; cat /proc/self/uid_map; printf 'work-retained' > /work/.remapped-live-test; sudo sh -c 'printf ephemeral > /etc/kamakura-live-test'; test -f /work/.kamakura-preserve-novnc; test ! -S /var/run/docker.sock; test ! -S /var/run/kamakura-sandbox.sock; ! command -v tailscale >/dev/null; df -B1 /work");
 assert.equal(result.exitCode,0,result.output);assert.equal(result.workspace,'/work');
 assert.match(result.output,/1000\s+0\s+0\s+200000\s+65536/);
 const name=`kamakura-${config.sandbox.instance}-u${owner}`;
 const before=await docker.getContainer(name).inspect();
 assert.equal(before.HostConfig.ReadonlyRootfs,false);assert.equal(before.HostConfig.Privileged,false);
 assert.equal(before.HostConfig.NanoCpus,2e9);assert.equal(before.HostConfig.Memory,3221225472);
 assert.equal(before.HostConfig.MemorySwap,3221225472);assert.equal(before.HostConfig.PidsLimit,256);
 assert.equal(before.Mounts.length,1);assert.equal(before.Mounts[0].Destination,'/work');
 assert.equal(before.Config.Labels['kamakura.quota'],'loopback-ext4');
 assert(!before.HostConfig.CapAdd.includes('CAP_SYS_ADMIN'));
 const independent=await sandboxes.run(owner,"sudo -n apt-get update -qq && sudo -n apt-get install -y -qq jq && jq -n '42'");
 assert.equal(independent.exitCode,0,independent.output);assert.match(independent.output,/42/);
 await docker.getContainer(name).remove({force:true});
 const after=await sandboxes.run(owner,"set -e; test \"$(cat /work/.remapped-live-test)\" = work-retained; test ! -f /etc/kamakura-live-test; ! command -v jq >/dev/null; sudo -n id -u");
 assert.equal(after.exitCode,0,after.output);
 const current=await docker.getContainer(name).inspect();assert.notEqual(before.Id,current.Id);
 console.log('PASS actual remapped sudo + apt install, no sockets/Tailscale, limits, hard-work mount, persistent work and ephemeral root/package reset',owner);
}
await assert.rejects(sandboxes.run('999','true'),/not authorized/);
const deny=await sandboxes.run(owners[0],`test ! -e /work/../${owners[1]}/.remapped-live-test`);
assert.equal(deny.exitCode,0);
console.log('PASS unauthorized owner denied and sibling filesystem absent');
sandboxes.stop();
