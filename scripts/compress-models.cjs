'use strict';
// Lossless transport copies. Original GLBs remain the compatibility fallback.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { deterministicGzip } = require('./deterministic-gzip.cjs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
for (const name of ['center', 'left', 'right']) {
  const file = path.join(root, 'assets/displays', `${name}.glb`);
  const bytes = fs.readFileSync(file);
  const packed = deterministicGzip(bytes);
  if (!zlib.gunzipSync(packed).equals(bytes)) throw new Error(`Model compression failed: ${name}`);
  fs.writeFileSync(`${file}.gz`, packed);
}
// Side housings share most vertices. Store the right model's exact JSON and
// XOR its binary payload against the already-needed left model. No quantizing.
const left = fs.readFileSync(path.join(root, 'assets/displays/left.glb'));
const right = fs.readFileSync(path.join(root, 'assets/displays/right.glb'));
const binOffset = (bytes) => {
  if (
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw Error('Invalid GLB');
  const offset = 28 + bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(offset - 4) !== 0x004e4942 ||
    bytes.readUInt32LE(offset - 8) !== bytes.length - offset
  )
    throw Error('Unsupported GLB chunks');
  return offset;
};
const baseOffset = binOffset(left),
  prefixBytes = binOffset(right),
  binBytes = right.length - prefixBytes;
if (left.length - baseOffset !== binBytes) throw Error('Side model binary lengths differ');
const delta = Buffer.alloc(binBytes);
for (let i = 0; i < binBytes; i++) delta[i] = right[prefixBytes + i] ^ left[baseOffset + i];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const deltaHeader = Buffer.from(
  JSON.stringify({
    version: 1,
    baseOffset,
    prefixBytes,
    binBytes,
    baseHash: hash(left),
    resultHash: hash(right),
  }),
);
const deltaLength = Buffer.alloc(4);
deltaLength.writeUInt32LE(deltaHeader.length);
const modelDelta = Buffer.concat([deltaLength, deltaHeader, right.subarray(0, prefixBytes), delta]);
const modelPacked = deterministicGzip(modelDelta);
if (!zlib.gunzipSync(modelPacked).equals(modelDelta)) throw Error('Model delta compression failed');
const restored = Buffer.concat([right.subarray(0, prefixBytes), Buffer.from(delta)]);
for (let i = 0; i < binBytes; i++) restored[prefixBytes + i] ^= left[baseOffset + i];
if (!restored.equals(right)) throw Error('Model delta reconstruction failed');
fs.writeFileSync(path.join(root, 'assets/displays/right.delta.gz'), modelPacked);
// One lossless request for the twelve tiny HDR finishes. The four-byte header
// length precedes a UTF-8 JSON inventory, followed by the original file bytes.
const finishes = path.join(root, 'assets/displays/finishes');
const entries = JSON.parse(fs.readFileSync(path.join(finishes, 'manifest.json'), 'utf8')).finishes;
const parts = entries.map((entry) => fs.readFileSync(path.join(finishes, entry.file)));
const header = Buffer.from(
  JSON.stringify({
    version: 1,
    files: entries.map((entry, i) => ({ file: entry.file, bytes: parts[i].length })),
  }),
);
const length = Buffer.alloc(4);
length.writeUInt32LE(header.length);
const source = Buffer.concat([length, header, ...parts]);
const bundle = deterministicGzip(source);
if (!zlib.gunzipSync(bundle).equals(source)) throw new Error('Finish compression failed');
fs.writeFileSync(path.join(finishes, 'finishes.pack.gz'), bundle);
// Rebuild the spatially predicted RGBE transport automatically on each release.
require('node:child_process').execFileSync(
  process.execPath,
  [path.join(__dirname, 'pack-finish-pixels.mjs')],
  { windowsHide: true },
);
