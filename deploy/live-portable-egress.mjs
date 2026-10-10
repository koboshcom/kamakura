// Run only in a disposable trusted Docker core, mounting current dist read-only.
// No real bot credentials, real owners, existing databases or production probes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import Docker from 'dockerode';
import { Writable } from 'node:stream';
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
async function direct(container,cmd) {
  const ex=await container.exec({Cmd:cmd,User:'0',AttachStdout:true,AttachStderr:true});
  const stream=await ex.start({hijack:true,stdin:false});
  const chunks=[];
  const sink=new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}});
  docker.modem.demuxStream(stream,sink,sink);
  await new Promise((resolve,reject)=>{stream.once('end',resolve);stream.once('error',reject);});
  return {exitCode:(await ex.inspect()).ExitCode,output:Buffer.concat(chunks).toString()};
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
  for(const port of [49125,6080]) {
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
  const capProof=await run('42','sudo -n python3 -c '+quote(`import ctypes,errno,os,socket,json
status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
bnd=int(status['CapBnd'].strip(),16)
assert os.geteuid()==0
for bit in (12,13,21,19,16):
 assert not (bnd & (1<<bit)), ('unexpected capability',bit)
for family in (socket.AF_INET,socket.AF_INET6):
 try:
  s=socket.socket(family,socket.SOCK_RAW,socket.IPPROTO_TCP)
 except PermissionError as e:
  assert e.errno==errno.EPERM
 else:
  s.close();raise AssertionError('raw socket admitted')
class Header(ctypes.Structure):
 _fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
class Data(ctypes.Structure):
 _fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
libc=ctypes.CDLL(None,use_errno=True)
for bit in (12,13):
 header=Header(0x20080522,0);data=(Data*2)()
 assert libc.capget(ctypes.byref(header),data)==0
 data[0].permitted|=(1<<bit);data[0].effective|=(1<<bit)
 assert libc.capset(ctypes.byref(header),data)==-1 and ctypes.get_errno()==errno.EPERM
fd=os.open('/proc/self/ns/net',os.O_RDONLY)
try:
 assert libc.setns(fd,0x40000000)==-1 and ctypes.get_errno()==errno.EPERM
finally: os.close(fd)
print(json.dumps({'euid':os.geteuid(),'CapBnd':status['CapBnd'].strip(),'capset_NET_ADMIN_NET_RAW':'EPERM','raw_ipv4_ipv6':'EPERM','setns':'EPERM'}))
`));
  result.controls.push({proof:'full sudo cannot reacquire dropped network caps or enter netns',details:JSON.parse(capProof)});
  assert.equal(box.HostConfig.Privileged,false);
  assert.equal(box.HostConfig.PidMode,'');
  assert.equal(box.HostConfig.CapAdd.includes('NET_ADMIN'),false);
  assert.equal(box.HostConfig.CapAdd.includes('NET_RAW'),false);
  assert.equal(box.Mounts.some(m=>m.Destination.includes('docker.sock')),false);
  const host=await listener('kama-egress-disposable-host','host',gateways,[49124]);
  const peer=await listener('kama-egress-disposable-mongo',network,['0.0.0.0','::'],[27017,49126]).catch(async error=>{
    // Dual listen overlap is avoided by binding individual assigned addresses below.
    throw error;
  });
  const pi=await peer.inspect();
  const peerIps=[pi.NetworkSettings.Networks[network].IPAddress,pi.NetworkSettings.Networks[network].GlobalIPv6Address];
  const targets=[...gateways.map(x=>[x,49124]),...coreIps.map(x=>[x,49125]),...coreIps.map(x=>[x,6080]),...peerIps.map(x=>[x,27017]),...peerIps.map(x=>[x,49126])];
  for(const [ip,port]of targets)await control(ip,port);
  const guard=docker.getContainer(box.HostConfig.NetworkMode.slice('container:'.length));
  const gi=await guard.inspect();
  assert.deepEqual(gi.HostConfig.CapDrop,['ALL']);assert.deepEqual(gi.HostConfig.CapAdd,['NET_ADMIN']);
  assert.equal(gi.HostConfig.Privileged,false);assert.equal(gi.HostConfig.ReadonlyRootfs,true);
  assert.equal(gi.HostConfig.PidMode,'');assert.equal(gi.HostConfig.IpcMode==='host',false);
  assert.equal(gi.HostConfig.NetworkMode,network);
  assert.equal(gi.Mounts.some(m=>m.Type==='bind'||m.Type==='volume'),false);
  const guardCaps=await direct(guard,['python3','-c',`import os,json
s=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
assert int(s['CapBnd'].strip(),16)==(1<<12)
assert s['NoNewPrivs'].strip()=='1'
assert s['Seccomp'].strip()=='2'
print(json.dumps({'CapBnd':s['CapBnd'].strip(),'NoNewPrivs':s['NoNewPrivs'].strip(),'Seccomp':s['Seccomp'].strip(),'netns':os.readlink('/proc/self/ns/net'),'pidns':os.readlink('/proc/self/ns/pid')}))
`]);
  assert.equal(guardCaps.exitCode,0,guardCaps.output);
  result.controls.push({proof:'guard has only NET_ADMIN, readonly root, seccomp, no-new-privileges, no host mounts or host network/PID/IPC',details:JSON.parse(guardCaps.output)});
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
  await guard.kill();
  const stoppedProbe=await direct(docker.getContainer(box.Id),['python3','-c',`import socket,json
results=[]
for ip,port in ${JSON.stringify(targets)}:
 s=socket.socket(socket.AF_INET6 if ':' in ip else socket.AF_INET,socket.SOCK_STREAM);s.settimeout(1)
 code=s.connect_ex((ip,port));s.close()
 assert code!=0,(ip,port,'provider exit leaked')
 results.append({'host':ip,'port':port,'errno':code})
print(json.dumps(results))
`]);
  assert.equal(stoppedProbe.exitCode,0,stoppedProbe.output);
  result.lifecycle.push('provider SIGKILL leaves existing owner unable to reach any listening forbidden control');
  result.providerExitProof=JSON.parse(stoppedProbe.output);
  await run('42','echo guard_recreate_ok');
  const next=await docker.getContainer('kamakura-egressprobe-u42').inspect();
  assert.notEqual(next.Id,box.Id);assert.notEqual(next.HostConfig.NetworkMode,box.HostConfig.NetworkMode);
  box=next;await deny(targets);result.lifecycle.push('guard stop replaces owner and provider, then rechecks policy');
  let current=docker.getContainer(box.HostConfig.NetworkMode.slice('container:'.length));
  await guardCommand(docker,current,'check');
  const ipv6=await manager.run('42', "curl -6 --noproxy '*' --connect-timeout 3 --max-time 5 -sS 'https://[2606:4700:4700::1111]/' >/dev/null");
  result.publicIPv6={target:'2606:4700:4700::1111:443',exitCode:ipv6.exitCode,output:ipv6.output};
  // Simulate a provider restored/started independently before policy install.
  await current.restart();
  let restoreFailed=false;
  try { await run('42','echo post_restore_admission'); } catch(error) { restoreFailed=true; }
  if(restoreFailed) {
    await assert.rejects(docker.getContainer('kamakura-egressprobe-u42').inspect(),e=>e.statusCode===404);
    result.lifecycle.push('independently restarted provider lacks readiness and rejects restored owner admission');
    await current.remove({force:true});
    await run('42','echo fresh_policy_before_owner');
  } else {
    const restored=await docker.getContainer('kamakura-egressprobe-u42').inspect();
    assert.notEqual(restored.Id,box.Id);
    result.lifecycle.push('independent provider restart passed live policy check and recreated owner for new namespace identity');
  }
  box=await docker.getContainer('kamakura-egressprobe-u42').inspect();
  current=docker.getContainer(box.HostConfig.NetworkMode.slice('container:'.length));
  await guardCommand(docker,current,'check');
  await deny(targets);
  // Corrupting a guard is a TRUSTED fault injection, never owner authority.
  // Existing owner must be removed when the saved reference no longer matches.
  const corrupt=await current.exec({Cmd:['nft','delete','table','inet','kamakura_egress'],User:'0',AttachStdout:true,AttachStderr:true});
  const corruptStream=await corrupt.start({hijack:true,stdin:false});
  for await(const _ of corruptStream){}
  assert.equal((await corrupt.inspect()).ExitCode,0);
  await assert.rejects(manager.run('42','echo must_not_execute'),/enforcement unavailable/);
  await assert.rejects(docker.getContainer('kamakura-egressprobe-u42').inspect(),e=>e.statusCode===404);
  result.lifecycle.push('trusted firewall deletion fails admission and removes owner, without running requested code');
  // Actual Docker startup gate, with a TEST-ONLY failure before nft install.
  // No owner is permitted to exist during the deliberately paused unready guard.
  await docker.getContainer('kamakura-egressprobe-u43').remove({force:true});
  await docker.getContainer('kamakura-egressprobe-egress-u43').remove({force:true});
  let enteredInstall,releaseInstall;
  const entered=new Promise(r=>{enteredInstall=r;});
  const release=new Promise(r=>{releaseInstall=r;});
  const delayedDocker=new Proxy(docker,{get(target,key){
    if(key==='createContainer')return async options=>{
      const real=await target.createContainer(options);
      if(!options.Labels?.['kamakura.egress'])return real;
      return new Proxy(real,{get(container,method){
        if(method==='exec')return async opts=>{
          if(opts.Cmd.at(-1)==='install'){
            enteredInstall();await release;throw new Error('TEST injected install failure');
          }
          return container.exec(opts);
        };
        const value=container[method];return typeof value==='function'?value.bind(container):value;
      }});
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const gated=new SandboxManager(config.sandbox,delayedDocker);
  let completed=false;
  const blocked=gated.run('43','touch /work/UNSAFE_BEFORE_POLICY').then(()=>{completed=true;return null;},error=>{completed=true;return error;});
  try{
    await entered;
    assert.equal(completed,false);
    await assert.rejects(docker.getContainer('kamakura-egressprobe-u43').inspect(),e=>e.statusCode===404);
    const unready=docker.getContainer('kamakura-egressprobe-egress-u43');
    assert.equal((await unready.inspect()).State.Running,true);
    const noPolicy=await direct(unready,['nft','list','table','inet','kamakura_egress']);
    assert.notEqual(noPolicy.exitCode,0);
    releaseInstall();
    const failed=await blocked;assert.match(failed.message,/TEST injected install failure/);
    await assert.rejects(docker.getContainer('kamakura-egressprobe-u43').inspect(),e=>e.statusCode===404);
    await assert.rejects(unready.inspect(),e=>e.statusCode===404);
    result.lifecycle.push('actual running unready provider: owner absent while install paused; install failure removes provider and never starts owner');
    await run('43','test ! -e /work/UNSAFE_BEFORE_POLICY; echo admitted_only_after_real_policy_install');
    result.lifecycle.push('fresh admission after startup failure succeeds only after genuine policy install and check');
  }finally{releaseInstall();gated.stop();}

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
