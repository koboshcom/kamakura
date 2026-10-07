import test from 'node:test';
import assert from 'node:assert/strict';
import {credentialValues,credentialAllowed,hasCredentials,redactCredentials,preventCredentialStorage,captureCredentials} from '../src/credentials.js';

test('encoded URL credentials are recognized, redacted and authorization-gated',()=>{
 for(const [url,raw,decoded]of [
  ['https://user:dummy%73ecret@example.test/','dummy%73ecret','dummysecret'],
  ['https://example.test/?auth=dummy%71uerysecret','dummy%71uerysecret','dummyquerysecret'],
  ['https://example.test/?%61uth=another%20secret','another%20secret','another secret'],
  ['https://example.test/?api_key=plus+separated+secret','plus+separated+secret','plus separated secret'],
 ] as const){
  assert.ok(credentialValues(url).includes(raw));assert.ok(credentialValues(url).includes(decoded));
  assert.ok(hasCredentials(url));assert.equal(credentialAllowed(url,''),false);
  assert.ok(credentialAllowed(url,`Use this URL for my task ${url}`));
  assert.ok(!redactCredentials(url).includes(raw));assert.ok(!redactCredentials(url).includes(decoded));
  assert.throws(()=>preventCredentialStorage(url),/cannot be stored/);
  captureCredentials(url);assert.ok(!redactCredentials(decoded).includes(decoded));
 }
});
test('short and malformed-escape URL secrets fail closed without exceptions',()=>{
 for(const url of ['https://u:x@example.test/','https://example.test/?auth=%ZZsecret']){
  assert.ok(hasCredentials(url));assert.equal(credentialAllowed(url,''),false);
  assert.ok(credentialAllowed(url,url));assert.notEqual(redactCredentials(url),url);
 }
 assert.equal(hasCredentials('https://example.test/?q=ordinary'),false);
 assert.ok(credentialAllowed('https://example.test/?q=ordinary',''));
});
