const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { deterministicGzip } = require('./deterministic-gzip.cjs');
test('portable gzip headers preserve exact binary payload and repeatable output', () => {
  const source = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
  const result = deterministicGzip(source);
  assert.equal(result[9], 255);
  assert.equal(result.readUInt32LE(4), 0);
  assert.deepEqual(gunzipSync(result), source);
  assert.deepEqual(deterministicGzip(source), result);
});
