// Minimal ICO container writer/reader for PNG-encoded frames (supported by every
// browser and by Windows Vista+). Layout: 6-byte ICONDIR, one 16-byte
// ICONDIRENTRY per frame, then the PNG payloads back to back.

/** @param {{ size: number, png: Buffer }[]} frames */
export function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + 16 * frames.length;
  const entries = frames.map(({ size, png }) => {
    if (size < 1 || size > 256) throw new Error(`ICO frame size out of range: ${size}`);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size === 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

/** @param {Buffer} buf @returns {{ width: number, height: number, png: Buffer }[]} */
export function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    frames.push({
      width: buf.readUInt8(at) || 256,
      height: buf.readUInt8(at + 1) || 256,
      png: buf.subarray(offset, offset + size),
    });
  }
  return frames;
}
