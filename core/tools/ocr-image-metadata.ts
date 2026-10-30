/** Bounded metadata inspection only, not JPEG decoding or pixel validation. */
export function jpegDimensions(bytes:Buffer):{width:number;height:number} {
 const invalid=()=>new Error('Invalid or unsupported JPEG metadata');
 if(bytes.length<4 || bytes.readUInt16BE(0)!==0xffd8) throw invalid();
 let pos=2,width=0,height=0,scan=false,markers=0;
 while(pos<bytes.length) {
  if(++markers>65536) throw invalid();
  if(scan) { while(pos<bytes.length && bytes[pos]!==255) pos++; }
  if(bytes[pos++]!==255) throw invalid();
  while(pos<bytes.length && bytes[pos]===255) pos++;
  if(pos>=bytes.length) throw invalid();
  const marker=bytes[pos++];
  if(scan && (marker===0 || (marker>=0xd0 && marker<=0xd7))) continue;
  if(marker===0xd9) {if(!width || !scan || pos!==bytes.length) throw invalid();return {width,height};}
  if(marker===0 || marker===0xd8 || (marker>=0xd0 && marker<=0xd7) || marker===1) throw invalid();
  if(pos+2>bytes.length) throw invalid();
  const length=bytes.readUInt16BE(pos);if(length<2 || length>bytes.length-pos) throw invalid();
  const data=bytes.subarray(pos+2,pos+length);pos+=length;
  if(marker===0xe1) {
   // Unknown APP1 (e.g. XMP) could describe an orientation too; no transform proof yet.
   if(data.length<6 || data.toString('ascii',0,6)!=='Exif\0\0') throw new Error('JPEG APP1 orientation metadata unsupported');
   const t=data.subarray(6);if(t.length<8) throw invalid();
   const order=t.toString('ascii',0,2);if(order!=='II' && order!=='MM') throw invalid();
   const u16=(p:number)=>{if(p<0||p+2>t.length) throw invalid();return order==='II'?t.readUInt16LE(p):t.readUInt16BE(p);};
   const u32=(p:number)=>{if(p<0||p+4>t.length) throw invalid();return order==='II'?t.readUInt32LE(p):t.readUInt32BE(p);};
   if(u16(2)!==42) throw invalid();const offset=u32(4);if(offset<8) throw invalid();
   const count=u16(offset);if(count>1024 || offset+2+12*count+4>t.length) throw invalid();
   let seen=false;
   for(let i=0;i<count;i++){const p=offset+2+i*12;if(u16(p)===0x112){if(seen || u16(p+2)!==3 || u32(p+4)!==1) throw invalid();seen=true;if(u16(p+8)!==1) throw new Error('JPEG nonidentity orientation unsupported; backend/transform proof required');}}
   // Additional IFDs may contain contradictory orientation; refuse rather than guess.
   if(u32(offset+2+12*count)!==0) throw new Error('JPEG additional EXIF directories unsupported');
  }
  if(marker>=0xc0 && marker<=0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
   if(![0xc0,0xc1,0xc2].includes(marker) || width || data.length<6 || data[0]!==8 || !data[5] || data.length!==6+3*data[5]) throw invalid();
   height=data.readUInt16BE(1);width=data.readUInt16BE(3);
   if(!width||!height||width>16384||height>16384||width*height>40000000) throw new Error('JPEG dimensions exceed OCR bound');
  }
  if(marker===0xda) {if(!width || data.length<4 || data.length!==4+2*data[0]) throw invalid();scan=true;}
 }
 throw invalid();
}
