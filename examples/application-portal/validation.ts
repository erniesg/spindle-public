import { inflateSync } from 'node:zlib';

/** Bounded structural checks, not a full document renderer or photo-quality assessment. */
export function inspectUpload(data: Uint8Array, type: string): { width?: number; height?: number; color?: string } {
  const b = Buffer.from(data);
  const invalid = () => { throw new Error('Malformed or unsupported attachment contents'); };
  if (type === 'application/pdf') {
    const text = b.toString('latin1');
    if (!/^%PDF-1\.[0-7]/.test(text) || !/%%EOF\s*$/.test(text) || !/\/Type\s*\/Catalog\b/.test(text) || !/\/Type\s*\/Page\b/.test(text)) return invalid();
    const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
    if (!match || text.slice(Number(match[1]), Number(match[1]) + 4) !== 'xref' || !/trailer\s*<<[\s\S]*\/Root\s+\d+\s+\d+\s+R/.test(text)) return invalid();
    return {};
  }
  if (type === 'image/jpeg') {
    if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8 || b.readUInt16BE(b.length - 2) !== 0xffd9) return invalid();
    let offset = 2; let metadata: { width: number; height: number; color: string } | undefined;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) return invalid();
      const marker = b[offset++]!; const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) return invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || b[offset + 2] !== 8) return invalid();
        const components = b[offset + 7]!;
        if (length !== 8 + components * 3) return invalid();
        metadata = { height: b.readUInt16BE(offset + 3), width: b.readUInt16BE(offset + 5), // Three components often encode YCbCr; component count alone cannot prove RGB.
          color: components === 3 ? 'three-component' : 'other' };
      }
      if (marker === 0xda) {
        if (!metadata?.width || !metadata.height || offset + length >= b.length - 2) return invalid();
        return metadata;
      }
      offset += length;
    }
    return invalid();
  }
  if (type === 'image/png') {
    if (!b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return invalid();
    let offset = 8; let width = 0; let height = 0; let color = ''; const chunks: Buffer[] = [];
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset); const kind = b.toString('ascii', offset + 4, offset + 8);
      if (length > b.length - offset - 12) return invalid();
      const chunk = b.subarray(offset + 4, offset + 8 + length); let crc = 0xffffffff;
      for (const byte of chunk) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      if (((crc ^ 0xffffffff) >>> 0) !== b.readUInt32BE(offset + 8 + length)) return invalid();
      if (offset === 8 && kind !== 'IHDR') return invalid();
      // Only the supported RGB/RGBA subset; never ignore an unknown critical chunk.
      if (!['IHDR', 'IDAT', 'IEND'].includes(kind) && /^[A-Z]/.test(kind)) return invalid();
      if (kind === 'IHDR') {
        if (length !== 13 || width) return invalid();
        width = b.readUInt32BE(offset + 8); height = b.readUInt32BE(offset + 12);
        if (!width || !height || width * height > 16000000 || b[offset + 16] !== 8 || ![2,6].includes(b[offset + 17]!) || b[offset + 18] || b[offset + 19] || b[offset + 20]) return invalid();
        color = b[offset + 17] === 2 ? 'RGB' : 'RGBA';
      }
      if (kind === 'IDAT') chunks.push(b.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
      if (kind === 'IEND') {
        if (length || offset !== b.length || !chunks.length) return invalid();
        const stride = width * (color === 'RGB' ? 3 : 4) + 1;
        const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: stride * height });
        if (raw.length !== stride * height) return invalid();
        for (let row = 0; row < height; row++) if (raw[row * stride]! > 4) return invalid();
        return { width, height, color };
      }
    }
    return invalid();
  }
  throw new Error('Unsupported attachment type');
}
