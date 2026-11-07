// CPU preparation may run while the visitor reads. Check elapsed time between
// bounded pieces, not just whole models. Returning null avoids a microtask per
// cheap operation; only a real browser task yield renews the budget.
export function preparationBudget(milliseconds = 6) {
  let deadline = performance.now() + milliseconds;
  return () => {
    if (performance.now() < deadline) return null;
    const pause = globalThis.scheduler?.yield
      ? globalThis.scheduler.yield()
      : new Promise((resolve) => setTimeout(resolve, 0));
    return pause.then(() => {
      deadline = performance.now() + milliseconds;
    });
  };
}
