import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateImage } from '../../core/models/provider.js';
const python=process.env.SPINDLE_IMAGE_PYTHON;
const skip=python?false:'Trusted Pillow environment required; no downloads.';
const helper=new URL('../../tools/image-worker/worker.py',import.meta.url);
// Use the same built helper asset as production, not a test implementation.
function canonical(bytes:Buffer) {return JSON.parse(execFileSync(python!,['-E',helper.pathname],{input:JSON.stringify({operation:'canonicalize',parameters:{},image:bytes.toString('base64')}),maxBuffer:12*1024*1024}).toString());}
test('all eight EXIF orientations map canonical pixel centers to actual encoded pixels',{skip},()=>{
 for(let orientation=1;orientation<=8;orientation++) {
  const bytes=execFileSync(python!,['-c',`from PIL import Image; import sys; im=Image.new('RGB',(8,4)); im.putdata([(x*30,y*60,90) for y in range(4) for x in range(8)]); e=Image.Exif(); e[274]=${orientation}; im.save(sys.stdout.buffer,format='PNG',exif=e)`]);
  const c=canonical(bytes);validateImage(c.image);assert.equal(c.orientation,orientation);assert.equal(c.originalHash,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(c.canonicalHash,createHash('sha256').update(Buffer.from(c.image,'base64')).digest('hex'));
  const proof=execFileSync(python!,['-c',`from PIL import Image; import sys,json,io,base64; d=json.load(sys.stdin); a=Image.open(io.BytesIO(base64.b64decode(d['original']))); b=Image.open(io.BytesIO(base64.b64decode(d['image']))); t=d['sourceToEncoded']
for y in range(b.height):
 for x in range(b.width):
  u=t[0]*(x+.5)+t[1]*(y+.5)+t[2]; v=t[3]*(x+.5)+t[4]*(y+.5)+t[5]
  assert b.getpixel((x,y))==a.getpixel((int(u),int(v)))
print('actual-pixels-match')`],{input:JSON.stringify({...c,original:bytes.toString('base64')})});
  assert.match(proof.toString(),/actual-pixels-match/);
 }
});
test('actual high-entropy PNG is reduced below provider encoded byte bound with preserved scaling',{skip},()=>{
 const bytes=execFileSync(python!,['-c',"from PIL import Image; import sys,random; im=Image.frombytes('RGB',(1500,1000),random.Random(46).randbytes(4500000)); im.save(sys.stdout.buffer,format='PNG')"],{maxBuffer:8*1024*1024});
 assert.ok(bytes.length>2_000_000);const c=canonical(bytes);validateImage(c.image);
 assert.ok(Buffer.from(c.image,'base64').length<=2_000_000);assert.ok(c.canonicalDimensions[0]<1500);assert.deepEqual(c.orientedDimensions,[1500,1000]);assert.equal(c.canonicalToSource[0],1500/c.canonicalDimensions[0]);assert.equal(c.canonicalToSource[4],1000/c.canonicalDimensions[1]);
});
