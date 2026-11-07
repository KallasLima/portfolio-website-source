const test = require('node:test');
const assert = require('node:assert/strict');

function context(statuses) {
  const calls = [];
  return {
    calls,
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    ALREADY_SIGNALED: 2,
    CONDITION_SATISFIED: 3,
    WAIT_FAILED: 4,
    isContextLost: () => false,
    fenceSync: () => ({ fence: true }),
    flush: () => calls.push('flush'),
    clientWaitSync: (_fence, flags, timeout) => {
      assert.equal(flags, 0);
      assert.equal(timeout, 0, 'GPU waits must never block the UI thread');
      calls.push('poll');
      return statuses.shift() ?? 3;
    },
    deleteSync: () => calls.push('delete'),
  };
}
test('startup GPU wait yields, then releases its fence on completion', async () => {
  const { settleGpu } = await import('../gpu-settle.mjs');
  const gl = context([0, 3]);
  let yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  assert.equal(await settleGpu(gl), true);
  assert.equal(yielded, true);
  assert.deepEqual(gl.calls, ['flush', 'poll', 'poll', 'delete']);
});
test('startup GPU failure and deadline clean up without hanging enhancement', async () => {
  const { settleGpu } = await import('../gpu-settle.mjs');
  for (const [statuses, deadline] of [
    [[4], 10000],
    [[0], 0],
  ]) {
    const gl = context(statuses);
    assert.equal(await settleGpu(gl, deadline), false);
    assert.deepEqual(gl.calls, ['flush', 'poll', 'delete']);
  }
  assert.equal(await settleGpu({ isContextLost: () => false }), false);
  assert.equal(await settleGpu({ fenceSync() {}, isContextLost: () => true }), false);
});
