// Disposable Linux GUI fixture. No manager admission or network proof is claimed.
// Run as an operator with Docker access after npm run build. No production services touched.
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxOptions } from '../dist/sandbox.js';
import { config } from '../dist/config.js';
const docker = new Docker();
const work = await mkdtemp(join(tmpdir(), 'kamakura-root-desktop-'));
let box;
try {
  await mkdir(join(work, '.config/autostart'), {recursive:true});
  await writeFile(join(work, 'proof.sh'), `#!/bin/bash
set -euo pipefail
exec > /work/terminal-proof.log 2>&1
id
[ "$(id -u)" = 0 ]
sudo -n sh -c 'umask 077; printf root-desktop > /etc/kamakura-terminal-fixture; chmod 0600 /etc/kamakura-terminal-fixture; chown 0:0 /etc/kamakura-terminal-fixture; test "$(cat /etc/kamakura-terminal-fixture)" = root-desktop; rm /etc/kamakura-terminal-fixture'
python3 - <<'PY'
import os,json
s=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
bound=int(s['CapBnd'].strip(),16)
assert os.geteuid()==0 and s['NoNewPrivs'].strip()=='1'
for bit in (12,13,21,19,16): assert not bound & (1<<bit)
print(json.dumps({'euid':os.geteuid(),'CapBnd':s['CapBnd'].strip(),'NoNewPrivs':s['NoNewPrivs'].strip()}))
PY
printf 'terminal-root-sudo-file-operation-PASS\\n'
`);
  // XFCE itself starts this real graphical terminal, not Docker exec(User=0).
  await writeFile(join(work, '.config/autostart/root-proof.desktop'), '[Desktop Entry]\nType=Application\nName=Disposable root terminal proof\nExec=xterm -e /bin/bash /work/proof.sh\nTerminal=false\n');
  const options = sandboxOptions('42', config.sandbox, work, 'a'.repeat(64));
  assert.equal(options.User, '0:0');
  assert.deepEqual(options.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  // Deliberately offline fixture, never shares a production or unguarded bridge.
  options.HostConfig.NetworkMode = 'none';
  options.HostConfig.StorageOpt = undefined;
  options.Env.push('KAMAKURA_DESKTOP_PASSWORD='+'a'.repeat(64));
  options.name = 'kamakura-root-desktop-fixture-'+process.pid;
  options.Labels = {'kamakura.disposable':'root-desktop-fixture'};
  box = await docker.createContainer(options);
  await box.start();
  let proof = '';
  for (let attempt=0; attempt<120; attempt++) {
    proof = await readFile(join(work, 'terminal-proof.log'), 'utf8').catch(()=> '');
    if(proof.includes('terminal-root-sudo-file-operation-PASS')) break;
    if(!(await box.inspect()).State.Running) throw new Error('Disposable desktop stopped before terminal proof');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.match(proof,/uid=0\(root\)/);
  assert.match(proof,/terminal-root-sudo-file-operation-PASS/);
  console.log('Linux Engine XFCE-autostarted xterm, not Docker Desktop\n'+proof);
} finally {
  if (box) await box.remove({force:true});
  await rm(work, {recursive:true,force:true});
}
