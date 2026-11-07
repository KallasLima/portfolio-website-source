import fs from 'node:fs';
import path from 'node:path';
import { deterministicGzip } from './deterministic-gzip.cjs';
import { fileURLToPath } from 'node:url';
import { predictPixels, restorePixels } from '../finish-transport.mjs';

// Build-time decoder for the standard scanline RGBE files produced by Blender.
// Fail closed on a new format; the originals remain the source of truth.
export function readRGBE(bytes) {
  const header = bytes.subarray(0, 4096).toString('ascii');
  const match = /\n-Y (\d+) \+X (\d+)\n/.exec(header);
  if (!match || !header.includes('FORMAT=32-bit_rle_rgbe')) throw Error('Unsupported captured HDR');
  const width = Number(match[2]),
    height = Number(match[1]);
  if (width < 8 || width > 1024 || height < 1 || height > 1024)
    throw Error('Unsupported HDR dimensions');
  let at = match.index + match[0].length;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (bytes[at] !== 2 || bytes[at + 1] !== 2 || bytes[at + 2] * 256 + bytes[at + 3] !== width)
      throw Error('Invalid HDR scanline');
    at += 4;
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        const code = bytes[at++],
          count = code > 128 ? code - 128 : code;
        if (!count || x + count > width || at + (code > 128 ? 1 : count) > bytes.length)
          throw Error('Invalid HDR run');
        for (let i = 0; i < count; i++)
          pixels[(y * width + x++) * 4 + channel] = bytes[code > 128 ? at : at++];
        if (code > 128) at++;
      }
    }
  }
  if (at !== bytes.length) throw Error('Unexpected HDR payload');
  return { width, height, pixels };
}
export function packFinishPixels(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const files = [],
    parts = [];
  for (const entry of manifest.finishes) {
    const { width, height, pixels } = readRGBE(fs.readFileSync(path.join(directory, entry.file)));
    const filtered = predictPixels(pixels, width);
    if (!Buffer.from(restorePixels(filtered, width)).equals(Buffer.from(pixels)))
      throw Error('Finish prediction changed pixels');
    files.push({ file: entry.file, width, height, bytes: filtered.length });
    parts.push(filtered);
  }
  const header = Buffer.from(JSON.stringify({ version: 1, format: 'rgbe-paeth', files }));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  fs.writeFileSync(
    path.join(directory, 'finishes.pixels.gz'),
    deterministicGzip(Buffer.concat([length, header, ...parts])),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packFinishPixels(fileURLToPath(new URL('../assets/displays/finishes', import.meta.url)));
}
