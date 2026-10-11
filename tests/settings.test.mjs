import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePreferences, DEFAULT_PREFERENCES, mapTouch } from '../client.js';
test('preferences whitelist only nonsecret values and reject malformed storage', () => {
  for (const v of [null, [], 'secret', 42, {quality:'constructor', scale:200, zoom:0, audio:'aac', volume:NaN}]) assert.deepEqual(sanitizePreferences(v), DEFAULT_PREFERENCES);
  const saved = sanitizePreferences({quality:'sharp', scale:75, zoom:200, audio:'raw', volume:999, muted:true, key:'SECRET', csrf:'SECRET', phoneId:'SECRET'});
  assert.equal(JSON.stringify(saved).includes('SECRET'), false);
  assert.deepEqual(saved, {quality:'sharp', latency:'balanced', scale:75, zoom:200, audio:'raw', volume:100, muted:true});
  assert.equal(sanitizePreferences({volume:-1}).volume,0);
});
test('touch mapping uses current encoded geometry through fit, zoom, and scroll offsets', () => {
  assert.deepEqual(mapTouch({left:10,top:20,width:240,height:480},130,260,720,1440),{x:360,y:720,width:720,height:1440});
  assert.deepEqual(mapTouch({left:-100,top:-200,width:480,height:960},140,280,360,720),{x:180,y:360,width:360,height:720});
  assert.deepEqual(mapTouch({left:10,top:20,width:480,height:240},900,-1,1440,720),{x:1439,y:0,width:1440,height:720});
});
