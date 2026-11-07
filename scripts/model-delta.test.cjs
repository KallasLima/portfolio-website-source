const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const dir = path.join(__dirname, '../assets/displays');
const base = fs.readFileSync(path.join(dir, 'left.glb'));
const right = fs.readFileSync(path.join(dir, 'right.glb'));
const packed = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'right.delta.gz')));
test('side-model delta restores every original byte', async () => {
  const { restoreModelDelta } = await import('../model-delta.mjs');
  assert.deepEqual(Buffer.from(await restoreModelDelta(packed, base)), right);
  assert.ok(
    fs.statSync(path.join(dir, 'right.delta.gz')).size <
      fs.statSync(path.join(dir, 'right.glb.gz')).size / 3,
  );
});
test('corrupt and mixed-release models reject instead of displaying wrong geometry', async () => {
  const { restoreModelDelta } = await import('../model-delta.mjs');
  const stale = Buffer.from(base);
  stale[stale.length - 1] ^= 1;
  await assert.rejects(restoreModelDelta(packed, stale), /Stale/);
  const damaged = Buffer.from(packed);
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(restoreModelDelta(damaged, base), /Damaged/);
  await assert.rejects(restoreModelDelta(packed.subarray(0, 20), base), /Invalid/);
});
