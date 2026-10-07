import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { LocalDevices, exactLocalActionPreview, type LocalDeviceStore, type DeviceRecord, type PairRecord } from '../src/local-devices.js';

test('exact approval refuses any concealed bytes, including shell substitutions, quoted secrets and Cua input', () => {
  for (const command of ['password=harmlessliteral', 'password=$(touch${IFS}/tmp/never-run)', 'echo `password=hiddenvalue`', 'echo password="correct horse battery staple"', 'echo \u202ehidden']) {
    assert.throws(() => exactLocalActionPreview('shell', { command }), /concealed|invisible/);
  }
  assert.throws(() => exactLocalActionPreview('cua', { tool: 'type', args: { text: 'password=hiddenvalue' } }), /concealed/);
  const args={command:'printf "one\\ntwo"; echo $(pwd)\n# final line'};
  assert.equal(exactLocalActionPreview('shell',args),JSON.stringify(args));
  assert.deepEqual(JSON.parse(exactLocalActionPreview('shell',args)),args);
});

test('delayed stale token authentication is rejected after durable revocation', async () => {
  let pair:PairRecord|undefined, device:DeviceRecord|undefined;
  let started!:()=>void, release!:()=>void;
  const lookupStarted=new Promise<void>(r=>{started=r;}), gate=new Promise<void>(r=>{release=r;});
  const store:LocalDeviceStore={
    async putPair(row){pair=row;}, async consumePair(){const row=pair;pair=undefined;return row??null;},
    async putDevice(row){device={...row};}, async byToken(tokenHash){assert.equal(tokenHash,device?.tokenHash);const stale={...device!};started();await gate;return stale;},
    async get(owner,id){return device?.ownerId===owner&&device.deviceId===id&&!device.revoked?{...device}:null;},
    async list(owner){return device?.ownerId===owner&&!device.revoked?[{...device}]:[];},
    async revoke(owner,id){if(!device||device.ownerId!==owner||device.deviceId!==id||device.revoked)return false;device.revoked=true;return true;}, async audit(){}
  };
  const service=new LocalDevices({dataDir:'/unused',store,authorized:o=>o==='owner'});
  const server=service.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  const code=await service.issuePairCode('owner'),paired=await service.pair(code.code,'fixture','linux');
  const ws=new WebSocket(`ws://127.0.0.1:${address.port}/local-devices/connect`,{headers:{Authorization:`Bearer ${paired.token}`}});
  let opened=false;ws.on('open',()=>{opened=true;});ws.on('error',()=>{});
  const denied=new Promise<number>(resolve=>{ws.on('unexpected-response',(_req,response)=>{resolve(response.statusCode!);response.resume();ws.terminate();});});
  try {
    await lookupStarted;assert.equal(await service.revoke('owner',paired.deviceId),true);release();
    assert.equal(await denied,403);assert.equal(opened,false);assert.deepEqual(await service.list('owner'),[]);
    await assert.rejects(service.execute('owner',paired.deviceId,'snapshot',{}),/unavailable/);
  } finally {release();ws.terminate();await service.close();}
});
