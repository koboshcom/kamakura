// Run in core after recreation and the remapped network hook. No credentials printed.
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import {config} from './dist/config.js';
import {sandboxes} from './dist/sandbox.js';
const docker=new Docker({socketPath:process.env.CORE_DOCKER_SOCKET_PATH||'/var/run/docker.sock'});
try {
 const candidates=await docker.listContainers({filters:JSON.stringify({label:['com.docker.compose.service=mongo']})});
 assert.equal(candidates.length,1,'one running Mongo service expected');
 const mongo=await docker.getContainer(candidates[0].Id).inspect();
 assert.equal(Object.keys(mongo.HostConfig.PortBindings||{}).length,0,'Mongo has no published ports');
 // Official image EXPOSE metadata is not a published port. Require no host binding.
 assert.equal((mongo.HostConfig.PublishAllPorts||false),false,'image ports are not auto-published');
 const mounts=mongo.Mounts.filter(m=>m.Destination==='/data/db');
 assert.equal(mounts.length,1);assert.equal(mounts[0].Type,'bind');assert.ok(mounts[0].RW);
 const networks=Object.values(mongo.NetworkSettings.Networks);
 assert.equal(networks.length,1,'Mongo only joins its internal network');
 const network=await docker.getNetwork(networks[0].NetworkID).inspect();
 assert.equal(network.Internal,true,'Mongo network is internal');
 const peers=await docker.listContainers({filters:JSON.stringify({network:[networks[0].NetworkID]})});
 assert.deepEqual(peers.map(c=>c.Labels['com.docker.compose.service']).sort(),['core','mongo']);
 const target=networks[0].IPAddress;assert.match(target,/^\d+\.\d+\.\d+\.\d+$/);
 for(const owner of config.sandbox.allowed){
  const command=`python3 -c 'import socket; s=socket.socket(); s.settimeout(3); result=s.connect_ex(("${target}",27017)); s.close(); print("mongo-isolated" if result else "mongo-reachable"); raise SystemExit(0 if result else 1)'`;
  const result=await sandboxes.run(owner,command);assert.equal(result.exitCode,0);assert.match(result.output,/mongo-isolated/);
  console.log('PASS owner sandbox cannot open Mongo TCP',owner);
 }
 console.log('PASS Mongo internal network, core-only peer, bind persistence and no host port publication');
}finally{sandboxes.stop();}
