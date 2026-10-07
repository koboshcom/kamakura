import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localModelOutput} from '../src/local-device-output.js';
test('local device output redacts credentials and attaches screenshot rather than flooding text with base64',()=>{
 const png=Buffer.from('fake png').toString('base64');const output=localModelOutput({content:[{type:'image',mimeType:'image/png',data:png},{type:'text',text:'password=supersecret123'}]});
 assert.equal(output.images[0],png);assert(!output.text.includes(png));assert(!output.text.includes('supersecret123'));
 assert.equal(localModelOutput({screenshot_png_b64:png}).images.length,1);
});
