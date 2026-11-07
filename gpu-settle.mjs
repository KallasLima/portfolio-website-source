/**
 * Let queued startup GPU work finish without blocking the browser's main thread.
 * This is used only at initialization boundaries, never in the animation loop.
 * A zero-timeout fence check yields between polls; it does not call gl.finish().
 * Older WebGL contexts retain their normal rendering path. Context loss/timeouts
 * return false so callers can continue through their existing recovery path.
 */
export async function settleGpu(gl, timeoutMs = 10000) {
  if (!gl?.fenceSync || gl.isContextLost()) return false;
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) return false;
  const deadline = performance.now() + timeoutMs;
  try {
    gl.flush();
    while (!gl.isContextLost()) {
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return true;
      if (status === gl.WAIT_FAILED || performance.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return false;
  } finally {
    gl.deleteSync(fence);
  }
}
