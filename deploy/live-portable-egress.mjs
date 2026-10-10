// Run only in a disposable trusted Docker core, mounting current dist read-only.
// No real bot credentials, real owners, existing databases or production probes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import Docker from 'dockerode';
import { config } from '/app/dist/config.js';
import { SandboxManager } from '/app/dist/sandbox.js';
import { guardCommand } from '/app/dist/egress.js';

assert.equal(config.sandbox.instance,'egressprobe');
assert.deepEqual([...config.sandbox.allowed],['42','43']);
const docker = new Docker({socketPath:'/var/run/docker.sock'});
const manager = new SandboxManager(config.sandbox);
const network='kamakura-egressprobe-sandboxes';
const servers=[];
const disposable=[];
const result={platform:'Linux Engine, NOT Docker Desktop', controls:[], denied:[], lifecycle:[], limits:[]};
const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
async function retry(fn) {
  for(let attempt=0;attempt<30;attempt++) {
    try{return await fn();}catch(error){if(attempt===29)throw error;await new Promise(r=>setTimeout(r,250));}
  }
}
async function run(user,command) {
  const r=await manager.run(user,command);
  assert.equal(r.exitCode,0,r.output);
  assert.equal(r.timedOut,false,r.output);
  return r.output;
}
async function listener(name,net,hosts,ports) {
  const js=`const h=require('http'); for(const host of ${JSON.stringify(hosts)})for(const port of ${JSON.stringify(ports)})h.createServer((q,s)=>s.end('disposable-control')).listen({port,host,ipv6Only:true}); console.log('ready');`;
  const c=await docker.createContainer({name,Image:'kamakura-core:latest',User:'0',Cmd:['node','-e',js],HostConfig:{NetworkMode:net,CapDrop:['ALL'],ReadonlyRootfs:true,RestartPolicy:{Name:'no'},Memory:64*1024*1024,PidsLimit:16}});
  disposable.push(c);await c.start();return c;
}
async function control(host,port) {
  const url='http://'+(host.includes(':')?'['+host+']':host)+':'+port;
  const r=await retry(async()=>{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});assert.equal(await response.text(),'disposable-control');return response;});
  result.controls.push({host,port,status:r.status});
}
async function deny(targets) {
  const python=`import socket,json,errno
for host,port in ${JSON.stringify(targets)}:
 s=socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET,socket.SOCK_STREAM)
 s.settimeout(2)
 try:
  code=s.connect_ex((host,port))
  print(json.dumps({'host':host,'port':port,'errno':code}))
  assert code in (errno.EACCES,errno.EPERM,errno.EHOSTUNREACH), (host,port,code,'not an explicit policy rejection')
 finally: s.close()
`;
  const text=await run('42','sudo -n python3 -c '+quote(python));
  result.denied.push(...text.trim().split('\n').map(x=>JSON.parse(x)));
}
async function counters(guard) {
  const exec=await guard.exec({Cmd:['nft','-j','list','table','inet','kamakura_egress'],User:'0',AttachStdout:true,AttachStderr:true});
  const stream=await exec.start({hijack:true,stdin:false});
  const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  // Docker multiplex headers aren't JSON; use demux by querying shell base64? Strip each frame.
  const buffer=Buffer.concat(chunks);let at=0;let text='';
  while(at<buffer.length){const length=buffer.readUInt32BE(at+4);text+=buffer.subarray(at+8,at+8+length).toString();at+=8+length;}
  assert.equal((await exec.inspect()).ExitCode,0);
  const data=JSON.parse(text);
  return data.nftables.flatMap(x=>x.rule?.expr||[]).filter(x=>x.counter).map(x=>x.counter.packets);
}
try {
  for(const port of [49125]) {
    const s=createServer((q,r)=>r.end('disposable-control'));
    await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'::',resolve);});
    servers.push(s);
  }
  await run('42','set -eu; sudo -n id -u; sudo -n sh -c "printf portable >/etc/kamakura-disposable-root-proof"; sudo -n rm /etc/kamakura-disposable-root-proof; test ! -S /var/run/docker.sock; python3 -c "import socket; print(socket.getaddrinfo(\'example.com\',443))"; curl --fail --max-time 20 -s https://example.com >/dev/null; sudo -n apt-get update -qq; sudo -n apt-get install -y -qq --no-install-recommends nftables iproute2 >/dev/null; echo sudo_apt_dns_public_https_ok');
  result.controls.push({proof:'uid0 writable /etc, sudo apt installs, Docker DNS, public HTTPS'});
  let box=await docker.getContainer('kamakura-egressprobe-u42').inspect();
  const core=await docker.getContainer(hostname()).inspect();
  const coreIps=[core.NetworkSettings.Networks[network].IPAddress,core.NetworkSettings.Networks[network].GlobalIPv6Address];
  const ni=await docker.getNetwork(network).inspect();
  const gateways=ni.IPAM.Config.map(x=>x.Gateway);
  const host=await listener('kama-egress-disposable-host','host',gateways,[49124]);
  const peer=await listener('kama-egress-disposable-mongo',network,['0.0.0.0','::'],[27017,49126]).catch(async error=>{
    // Dual listen overlap is avoided by binding individual assigned addresses below.
    throw error;
  });
  const pi=await peer.inspect();
  const peerIps=[pi.NetworkSettings.Networks[network].IPAddress,pi.NetworkSettings.Networks[network].GlobalIPv6Address];
  const targets=[...gateways.map(x=>[x,49124]),...coreIps.map(x=>[x,49125]),...peerIps.map(x=>[x,27017]),...peerIps.map(x=>[x,49126])];
  for(const [ip,port]of targets)await control(ip,port);
  const guard=docker.getContainer(box.HostConfig.NetworkMode.slice('container:'.length));
  const before=await counters(guard);
  await deny(targets);
  const after=await counters(guard);
  result.counterProof={before,after};assert(after[0]>before[0]&&after[1]>before[1]);
  await run('42','set -eu; if sudo -n nft flush ruleset >/work/tamper.log 2>&1; then exit 1; fi; grep -qi "not permitted" /work/tamper.log; if sudo -n ip route add 10.123.0.0/16 via '+gateways[0]+' >/work/route-tamper.log 2>&1; then exit 1; fi; grep -qi "not permitted" /work/route-tamper.log; echo root_cannot_change_firewall_or_route');
  result.controls.push({proof:'root nft flush and route change both EPERM'});
  const desktop=await manager.desktopTarget('42');
  const dr=await retry(()=>fetch(desktop.url,{headers:{authorization:desktop.authorization},signal:AbortSignal.timeout(1000)}).then(r=>{assert.equal(r.status,200);return r;}));
  result.controls.push({proof:'core authenticated desktop returns HTTP '+dr.status});
  // Second owner listener proves sibling isolation, rather than merely testing an empty port.
  await run('43','nohup python3 -m http.server 49127 --bind :: >/work/disposable-listener.log 2>&1 &');
  const sibling=await docker.getContainer('kamakura-egressprobe-u43').inspect();
  const siblingGuard=await docker.getContainer(sibling.HostConfig.NetworkMode.slice('container:'.length)).inspect();
  const siblingIp=siblingGuard.NetworkSettings.Networks[network].IPAddress;
  const siblingProvider=docker.getContainer(siblingGuard.Id);
  const controlExec=await siblingProvider.exec({Cmd:['python3','-c',"import socket; s=socket.create_connection(('127.0.0.1',49127),timeout=2); s.close(); print('sibling_listener_live')"],User:'0',AttachStdout:true,AttachStderr:true});
  const controlStream=await controlExec.start({hijack:true,stdin:false});
  for await(const _ of controlStream){}
  assert.equal((await controlExec.inspect()).ExitCode,0);
  result.controls.push({proof:'sibling 49127 listener confirmed from its trusted namespace',host:siblingIp,port:49127});
  const sibling6=siblingGuard.NetworkSettings.Networks[network].GlobalIPv6Address;
  await deny([[siblingIp,49127],[sibling6,49127]]);
  // Owner restart stays on the same guarded namespace.
  await docker.getContainer(box.Id).stop();
  await run('42','echo owner_restart_ok');
  assert.equal((await docker.getContainer('kamakura-egressprobe-u42').inspect()).Id,box.Id);
  await deny(targets);result.lifecycle.push('owner restart retains nft denial and explicit controls');
  // Provider stop forces owner replacement and reinstalls policy before readmission.
  await guard.stop();
  await run('42','echo guard_recreate_ok');
  const next=await docker.getContainer('kamakura-egressprobe-u42').inspect();
  assert.notEqual(next.Id,box.Id);assert.notEqual(next.HostConfig.NetworkMode,box.HostConfig.NetworkMode);
  box=next;await deny(targets);result.lifecycle.push('guard stop replaces owner and provider, then rechecks policy');
  const current=docker.getContainer(box.HostConfig.NetworkMode.slice('container:'.length));
  await guardCommand(docker,current,'check');
  const ipv6=await manager.run('42', "curl -6 --noproxy '*' --connect-timeout 3 --max-time 5 -sS 'https://[2606:4700:4700::1111]/' >/dev/null");
  result.publicIPv6={target:'2606:4700:4700::1111:443',exitCode:ipv6.exitCode,output:ipv6.output};
  // Corrupting a guard is a TRUSTED fault injection, never owner authority.
  // Existing owner must be removed when the saved reference no longer matches.
  const corrupt=await current.exec({Cmd:['nft','delete','table','inet','kamakura_egress'],User:'0',AttachStdout:true,AttachStderr:true});
  const corruptStream=await corrupt.start({hijack:true,stdin:false});
  for await(const _ of corruptStream){}
  assert.equal((await corrupt.inspect()).ExitCode,0);
  await assert.rejects(manager.run('42','echo must_not_execute'),/enforcement unavailable/);
  await assert.rejects(docker.getContainer('kamakura-egressprobe-u42').inspect(),e=>e.statusCode===404);
  result.lifecycle.push('trusted firewall deletion fails admission and removes owner, without running requested code');
  result.limits.push('Public IPv6 internet connectivity still requires a host IPv6 upstream; this Linux host may lack one. Whole Docker-daemon/host reboot not performed. Desktop not available.');
  console.log(JSON.stringify(result,null,2));
} finally {
  manager.stop();
  for(const user of ['42','43']) {
    await docker.getContainer('kamakura-egressprobe-u'+user).remove({force:true}).catch(()=>{});
    await docker.getContainer('kamakura-egressprobe-egress-u'+user).remove({force:true}).catch(()=>{});
  }
  for(const c of disposable.reverse())await c.remove({force:true}).catch(()=>{});
  for(const server of servers)await new Promise(r=>server.close(r));
}
