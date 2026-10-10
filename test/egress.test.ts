import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EgressGuards } from '../src/egress.js';
import { SandboxManager } from '../src/sandbox.js';
import { config } from '../src/config.js';

function fixture() {
  const calls: string[] = [];
  let state: any;
  let exit = 0;
  const id = 'a'.repeat(64);
  const guard = {
    inspect: async () => { if (!state) throw Object.assign(new Error('missing'),{statusCode:404}); return state; },
    start: async () => {calls.push('start');state.State={Running:true,StartedAt:'boot1'};},
    remove: async () => {calls.push('guard-remove');state=undefined;},
    exec: async (options: any) => {
      calls.push(options.Cmd.at(-1));
      return {
        start: async () => {
          const stream = new PassThrough();
          setImmediate(() => stream.end(JSON.stringify({policy:'b'.repeat(64),namespace:'net:[123]'})));
          return stream;
        },
        inspect: async () => ({ExitCode:exit}),
      };
    },
  };
  const docker = {
    modem:{demuxStream:(stream:any,out:any) => stream.pipe(out)},
    getContainer: () => guard,
    getImage: () => ({inspect:async()=>({Id:'image1'})}),
    createContainer:async(options:any) => {
      calls.push('create');
      state={Id:id,Image:'image1',Config:{Labels:options.Labels},HostConfig:options.HostConfig,State:{Running:false}};
      return guard;
    },
  };
  return {docker,guard,calls,fail:()=>{exit=1;},stop:()=>{state.State.Running=false;},changeImage:()=>{state.Image='old-image';},missing:()=>{state=undefined;},restart:()=>{state.State={Running:true,StartedAt:'boot2'};},exitOnExec:()=>{guard.exec=async()=>{throw Object.assign(new Error('guard exited'),{statusCode:409});};}};
}
test('guard is initialized and checked before admission; unchanged guard is independently rechecked',async()=>{
  const f=fixture();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  const first=await guards.ready('42',['172.30.0.1'],async()=>{f.calls.push('owner-remove');});
  assert.deepEqual(f.calls,['owner-remove','create','start','install','check']);
  assert.match(first.identity,/boot1/);
  f.calls.length=0;
  assert.equal((await guards.ready('42',['172.30.0.1'],async()=>{})).identity,first.identity);
  assert.deepEqual(f.calls,['check']);
});
test('stopped guard or changed image removes owner BEFORE recreating its namespace',async()=>{
  for(const kind of ['stop','image']){
    const f=fixture();
    const guards=new EgressGuards(f.docker as never,'test','guard-image');
    await guards.ready('42',['172.30.0.1'],async()=>{});
    kind==='stop'?f.stop():f.changeImage();
    f.calls.length=0;
    await guards.ready('42',['172.30.0.1'],async()=>{f.calls.push('owner-remove');});
    assert.deepEqual(f.calls,['owner-remove','guard-remove','create','start','install','check']);
  }
});
test('policy-check failure stops existing owner and does not readmit it',async()=>{
  const f=fixture();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  await guards.ready('42',['172.30.0.1'],async()=>{});
  f.fail();f.calls.length=0;
  await assert.rejects(guards.ready('42',['172.30.0.1'],async()=>{f.calls.push('owner-remove');}),/unavailable/);
  assert.deepEqual(f.calls,['check','owner-remove']);
});
test('failed install never returns a ready guard and cleans the disposable provider',async()=>{
  const f=fixture();f.fail();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  await assert.rejects(guards.ready('42',['172.30.0.1'],async()=>{}),/unavailable/);
  assert.deepEqual(f.calls,['create','start','install','guard-remove']);
});
test('manager never creates an owner when external enforcement is unavailable',async()=>{
  const old=process.env.SANDBOX_ROOTFS_SIZE;delete process.env.SANDBOX_ROOTFS_SIZE;
  let created=false;
  try {
    const docker={info:async()=>({}),getContainer:()=>({}),createContainer:async()=>{created=true;}};
    const manager=new SandboxManager({...config.sandbox,rootView:undefined},docker as never,async()=>({path:'/work/42',hard:true}));
    (manager as unknown as {guards:unknown}).guards={network:async()=>['172.30.0.1'],ready:async()=>{throw new Error('enforcement unavailable');}};
    await assert.rejects((manager as unknown as {container:(id:string)=>Promise<unknown>}).container('42'),/enforcement unavailable/);
    assert.equal(created,false);
  } finally {if(old!==undefined)process.env.SANDBOX_ROOTFS_SIZE=old;}
});

test('restored owner is invalidated before a missing guard is created or installed',async()=>{
  const f=fixture();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  await guards.ready('42',['172.30.0.1'],async()=>{});
  f.missing();f.calls.length=0;
  await guards.ready('42',['172.30.0.1'],async()=>{f.calls.push('owner-remove');});
  assert.deepEqual(f.calls,['owner-remove','create','start','install','check']);
});
test('provider exit during readiness invalidates owner and propagates failure, never admission',async()=>{
  const f=fixture();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  await guards.ready('42',['172.30.0.1'],async()=>{});
  f.exitOnExec();f.calls.length=0;
  await assert.rejects(guards.ready('42',['172.30.0.1'],async()=>{f.calls.push('owner-remove');}),/guard exited/);
  assert.deepEqual(f.calls,['owner-remove']);
});
test('externally restarted provider changes identity even if its live policy check succeeds',async()=>{
  const f=fixture();
  const guards=new EgressGuards(f.docker as never,'test','guard-image');
  const first=await guards.ready('42',['172.30.0.1'],async()=>{});
  f.restart();
  const second=await guards.ready('42',['172.30.0.1'],async()=>{});
  assert.notEqual(first.identity,second.identity);
  assert.match(second.identity,/boot2/);
});
test('ready remains unresolved until the firewall install AND live check complete',async()=>{
  const f=fixture();
  const original=f.guard.exec;
  let release:()=>void=()=>{};
  let entered:()=>void=()=>{};
  const installing=new Promise<void>(r=>{entered=r;});
  const barrier=new Promise<void>(r=>{release=r;});
  f.guard.exec=async(options:any)=>{
    if(options.Cmd.at(-1)==='install'){entered();await barrier;}
    return original(options);
  };
  let admitted=false;
  const pending=new EgressGuards(f.docker as never,'test','guard-image').ready('42',['172.30.0.1'],async()=>{}).then(r=>{admitted=true;return r;});
  await installing;
  assert.equal(admitted,false);
  assert.equal(f.calls.includes('check'),false);
  release();await pending;
  assert.equal(admitted,true);
  assert.deepEqual(f.calls,['create','start','install','check']);
});
