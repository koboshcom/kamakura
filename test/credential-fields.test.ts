import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialValues, hasCredentials, preventCredentialStorage, redactStoredCredentials, credentialAllowed } from '../src/credentials.js';

test('quoted JSON/config credentials and full escaped whitespace values are detected', () => {
  for (const text of [
    '{"password":"correct horse battery staple","token":"'+'a'.repeat(64)+'"}',
    "password = 'correct horse battery staple'",
    'password = "correct horse battery staple"',
    JSON.stringify({api_key:'fake secret with "escaped" quotes and \\ slash'}),
    '`token` = `opaque fake token value`',
  ]) {
    const values=credentialValues(text);
    assert.ok(values.length);
    assert.ok(hasCredentials(text));
    assert.throws(()=>preventCredentialStorage(text),/cannot be stored/);
    const redacted=redactStoredCredentials(text);
    for (const value of values) assert.ok(!redacted.includes(value));
    assert.ok(!redacted.includes('horse battery staple'));
    assert.ok(!credentialAllowed(text,'unrelated request'));
    assert.ok(credentialAllowed(text,text));
  }
});
test('ordinary profile JSON is not classified as credentials',()=>{
  assert.deepEqual(credentialValues('{"name":"Koharu","username":"yuk1n0w"}'),[]);
});
