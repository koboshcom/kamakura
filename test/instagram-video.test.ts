import test from 'node:test';
import assert from 'node:assert/strict';
import {instagramPostURI,normalizeVideoURL,newVideoURLs} from '../src/video-url.js';
test('strict Instagram canonical identity drops share tracking only on supported exact hosts',()=>{
 for(const kind of ['p','reel'])for(const host of ['instagram.com','www.instagram.com']){
  const canonical='https://www.instagram.com/'+kind+'/Ab_c-D123/';
  for(const query of ['', '?rpxt=private&vrfl=private&igsh=private&si=private','#fragment'])
   assert.equal(normalizeVideoURL('https://'+host+'/'+kind+'/Ab_c-D123'+query),canonical);
 }
 for(const input of ['https://name:pass@instagram.com/p/abc/','https://instagram.com:444/p/abc/','https://instagram.com/redirect?url=x','https://instagram.com/p/a/extra','https://instagram.com/reels/abc','https://instagram.com/p/%61bc/','https://instagram.com/p/x/../abc/','https://instagram.com\\evil/p/abc/'])assert.throws(()=>instagramPostURI(input),input);
 for(const host of ['instagram.com.evil','evilinstagram.com','instagram.com.'])assert.equal(instagramPostURI('https://'+host+'/p/abc/'),undefined);
 assert.equal(normalizeVideoURL('https://cdn.example/a.mp4?si=signed&vrfl=needed'),'https://cdn.example/a.mp4?si=signed&vrfl=needed');
 assert.deepEqual(newVideoURLs('see https://www.instagram.com/reel/abc/?vrfl=x'),['https://www.instagram.com/reel/abc/']);
});
test('precise nonvideo/rate/auth diagnostics never invent a login requirement or expose raw remote fields',async()=>{
 const {instagramHelperError}=await import('../src/sandbox.js');
 instagramHelperError('{"ok":true}');
 assert.throws(()=>instagramHelperError(JSON.stringify({ok:false,error:'instagram_nonvideo_post_unsupported',stage:'extract_metadata',transferBytes:123,safeMessage:'https://private.example?sessionid=secret @private-name Cookie: secret'})),/Image or image-only carousel.*did not inspect/);
 assert.throws(()=>instagramHelperError('{"ok":false,"error":"instagram_rate_limited"}'),/No automatic retry/);
 assert.throws(()=>instagramHelperError('{"ok":false,"error":"instagram_http_forbidden"}'),/does not establish a login/);
 assert.throws(()=>instagramHelperError('{"ok":false,"error":"instagram_auth_required"}'),/No owner-scoped private cookie/);
 assert.throws(()=>instagramHelperError('{"ok":false,"error":"private-secret","stage":"secret"}'),e=>e instanceof Error&&!e.message.includes('private-secret'));
});
