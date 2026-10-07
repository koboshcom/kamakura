// Run via stdin in the built core only AFTER storage migration and network hook.
// Default performs read-only quota/network inspection plus reversible /etc writes.
// PROVE_ROOT_ENOSPC=1 opts into one disposable 256MiB writable layer, never owner /work.
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const owners = ['6612253937', '7853500388'];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function networkCommand(targets) {
  return `python3 -c ${quote(`import socket,json,urllib.request
socket.getaddrinfo('example.com',443)
with urllib.request.urlopen('https://example.com',timeout=15) as r:
 print('public_https',r.status)
for host,port in ${JSON.stringify(targets)}:
 s=socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET,socket.SOCK_STREAM)
 s.settimeout(1)
 try:
  result=s.connect_ex((host,port))
  print(json.dumps({'target':host,'port':port,'connect_ex':result}))
  if result==0: raise RuntimeError('forbidden destination reachable')
 finally: s.close()
`)}`;
}
const quotaPython = `import os,errno,json
path='/kamakura-quota-probe'
v=os.statvfs('/')
assert v.f_blocks*v.f_frsize == 256*1024*1024, 'root statvfs does not reflect requested project quota'
try:
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
 try:
  os.posix_fallocate(fd,0,257*1024*1024)
  raise RuntimeError('allocation above configured 256MiB quota succeeded')
 except OSError as e:
  if e.errno != errno.ENOSPC: raise
  print(json.dumps({'proof':'ENOSPC','errno':e.errno,'requested_bytes':257*1024*1024}))
 finally: os.close(fd)
finally:
 if os.path.exists(path): os.unlink(path)
`;
async function main() {
  const { default: Docker } = await import('dockerode');
  const { config } = await import('./dist/config.js');
  const { sandboxes, sandboxOptions, sandboxNetwork, rootPolicy, assertRootStorage } = await import('./dist/sandbox.js');
  const docker = new Docker({ socketPath: config.sandbox.socketPath });
  const primary = new Docker({ socketPath: config.sandbox.coreSocketPath });
  let probe;
  try {
    assert.deepEqual([...config.sandbox.allowed].sort(), owners.toSorted());
    assert.equal(config.sandbox.usernsRoot, true);
    assert.equal(rootPolicy(true).writable, true);
    const runtime = await docker.info();
    assertRootStorage(runtime, true);
    const network = await docker.getNetwork(sandboxNetwork(config.sandbox.instance).name).inspect();
    const gateway = network.IPAM.Config[0].Gateway;
    const core = await primary.getContainer(hostname()).inspect();
    const coreIPs = Object.values(core.NetworkSettings.Networks).map(n => n.IPAddress).filter(Boolean);
    const mongoCandidates = await primary.listContainers({ filters: JSON.stringify({ label: ['com.docker.compose.service=mongo'] }) });
    assert.equal(mongoCandidates.length, 1);
    const mongo = await primary.getContainer(mongoCandidates[0].Id).inspect();
    const mongoIPs = Object.values(mongo.NetworkSettings.Networks).map(n => n.IPAddress).filter(Boolean);
    const boxes = [];
    for (const owner of owners) {
      const result = await sandboxes.run(owner, `set -eu; sudo -n id -u; sudo -n python3 -c ${quote("import tempfile,os; fd,p=tempfile.mkstemp(prefix='kamakura-boundary-',dir='/etc'); os.write(fd,b'writable'); os.close(fd); os.unlink(p); print('root_write_cleanup_ok')")}; df -B1 / /work; test ! -S /var/run/docker.sock`);
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.timedOut, false);
      assert.match(result.output, /root_write_cleanup_ok/);
      const box = await docker.getContainer(`kamakura-${config.sandbox.instance}-u${owner}`).inspect();
      assert.equal(box.HostConfig.ReadonlyRootfs, false);
      assert.equal(box.HostConfig.StorageOpt.size, rootPolicy(true).size);
      assert.equal(box.HostConfig.NetworkMode, network.Name);
      boxes.push(box);
      console.log('PASS owner sudo and reversible root write; configured root quota and observed df', owner, result.output.trim());
    }
    for (let i = 0; i < owners.length; i++) {
      const siblingIP = boxes[1-i].NetworkSettings.Networks[network.Name].IPAddress;
      const targets = [[gateway,47831], [gateway,6080], ['172.18.0.1',47831], ...coreIPs.map(ip => [ip,3000]), ...mongoIPs.map(ip => [ip,27017]), [siblingIP,6080], ['10.0.0.1',80], ['192.168.0.1',80], ['169.254.169.254',80], ['100.100.100.100',80], ['fd00::1',80], ['fe80::1',80]];
      const result = await sandboxes.run(owners[i], networkCommand(targets));
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.timedOut, false, result.output);
      assert.match(result.output, /public_https 200/);
      console.log('PASS public DNS/HTTPS; forbidden TCP connects unsuccessful', owners[i], result.output.trim());
    }
    console.log('LIMITATION failed connects alone do not prove firewall causality. Capture host INPUT/FORWARD rule counters before/after and separately verify target listeners. Run live-desktop-access.mjs for authorized core HTTP/RFB and live-remapped-work.mjs for apt persistence/reset.');
    if (process.env.PROVE_ROOT_ENOSPC !== '1') {
      console.log('SKIP actual ENOSPC; operator must explicitly set PROVE_ROOT_ENOSPC=1');
      return;
    }
    // Supervisor must measure the aggregate backing filesystem outside the project quota.
    const aggregateFree = Number(process.env.ROOT_QUOTA_AGGREGATE_FREE_BYTES);
    assert(Number.isSafeInteger(aggregateFree) && aggregateFree >= 512 * 1024 * 1024,
      'Set ROOT_QUOTA_AGGREGATE_FREE_BYTES to freshly measured host XFS free bytes (minimum 512MiB) to distinguish project quota from aggregate ENOSPC');
    // Networkless, isolated, no bind mounts, bounded memory and layer. Never fill an owner root.
    const opts = sandboxOptions(owners[0], config.sandbox, '/unused');
    opts.name = `kamakura-quota-probe-${randomUUID()}`;
    opts.Cmd = ['sleep', '120'];
    opts.WorkingDir = '/';
    opts.Labels = { 'kamakura.regression': 'disposable-root-quota' };
    opts.HostConfig.Mounts = [];
    opts.HostConfig.NetworkMode = 'none';
    opts.HostConfig.StorageOpt = { size: '256M' };
    opts.HostConfig.Tmpfs['/work'] = 'rw,nosuid,nodev,size=16m,mode=1777';
    probe = await docker.createContainer(opts);
    await probe.start();
    const inspected = await probe.inspect();
    assert.equal(inspected.Mounts.some(m => m.Type === 'bind'), false);
    assert.equal(inspected.HostConfig.StorageOpt.size, '256M');
    const exec = await probe.exec({ User: '0', Cmd: ['timeout', '30', 'python3', '-c', quotaPython], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    let output = '';
    const sink = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    docker.modem.demuxStream(stream, sink, sink);
    await new Promise((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
    const state = await exec.inspect();
    assert.equal(state.ExitCode, 0, output);
    assert.match(output, /"proof": "ENOSPC"/);
    console.log('PASS actual ENOSPC on isolated 256MiB project-quota layer', output.trim());
    console.log('LIMITATION this proves Docker layer enforcement on the same runtime, not allocating 8GiB in either live owner root. Correlate host xfs_quota report with owner upperdir project IDs for that evidence.');
  } finally {
    if (probe) await probe.remove({ force: true });
    sandboxes.stop();
  }
}
if (process.argv.includes('--self-test')) {
  assert.equal(quote("a'b"), "'a'\\''b'");
  assert.match(networkCommand([['127.0.0.1',80]]), /connect_ex/);
  assert.match(quotaPython, /errno.ENOSPC/);
  assert.doesNotMatch(quotaPython, /\/work/);
  console.log('PASS command escaping and isolated quota probe source invariants');
} else {
  await main();
}
