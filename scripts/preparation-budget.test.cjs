const test = require('node:test');
const assert = require('node:assert/strict');

test('exhausted preparation budget lets a queued task run, not only a microtask', async () => {
  const { preparationBudget } = await import('../preparation-budget.mjs');
  const checkpoint = preparationBudget(0);
  let otherTaskRan = false;
  setTimeout(() => {
    otherTaskRan = true;
  }, 0);
  await checkpoint();
  assert.equal(otherTaskRan, true);
  assert.equal(preparationBudget(1000)(), null, 'cheap work must not enqueue a microtask');
});
