import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTimeContext, messageTimestamp, ownerTimeZone, parseOwnerTimeZones, validateTimeZone } from '../src/time-context.js';
test('owner timezone overrides remain scoped and validate startup input', () => {
 const settings={defaultTimeZone:'UTC',ownerTimeZones:parseOwnerTimeZones('{"12":"America/Vancouver","34":"Africa/Lagos"}')};
 assert.equal(ownerTimeZone('12',settings),'America/Vancouver');
 assert.equal(ownerTimeZone('34',settings),'Africa/Lagos');
 assert.equal(ownerTimeZone('56',settings),'UTC');
 for(const raw of ['bad','[]','null','{"x":"UTC"}','{"12":1}','{"12":"not/a-zone"}'])assert.throws(()=>parseOwnerTimeZones(raw));
 assert.throws(()=>validateTimeZone('bad'));
});
test('trusted clock handles local rollover, historical DST and permanent BC Pacific time', () => {
 const settings={defaultTimeZone:'UTC',ownerTimeZones:{'12':'America/Vancouver','34':'Africa/Lagos'}};
 const now=Date.parse('2026-10-07T00:30:00Z');
 assert.match(currentTimeContext('12',settings,now),/Tuesday, October 6, 2026/);
 assert.match(currentTimeContext('34',settings,now),/Wednesday, October 7, 2026/);
 assert.match(messageTimestamp(now,'America/Vancouver'),/GMT-07:00/);
 // BC ended seasonal clock changes after March 8, 2026. Node must have current tzdata.
 // https://news.gov.bc.ca/releases/2026AG0013-000209
 assert.match(messageTimestamp(Date.parse('2026-12-07T00:30:00Z'),'America/Vancouver'),/GMT-07:00/);
 assert.match(messageTimestamp(Date.parse('2025-12-07T00:30:00Z'),'America/Vancouver'),/GMT-08:00/);
 assert.match(messageTimestamp(Date.parse('2026-03-08T09:59:59Z'),'America/Vancouver'),/01:59:59 GMT-08:00/);
 assert.match(messageTimestamp(Date.parse('2026-03-08T10:00:00Z'),'America/Vancouver'),/03:00:00 GMT-07:00/);
 assert.equal(messageTimestamp(NaN,'UTC'),'timestamp unavailable');
 assert.notEqual(currentTimeContext('12',settings,now),currentTimeContext('12',settings,now+1000));
});
