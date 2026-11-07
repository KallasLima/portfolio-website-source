/**
 * Decode one finish bundle in a short-lived worker. Keep the caller's bytes so
 * a CSP denial, unsupported worker, corrupt bundle or timeout can use the
 * original HDR fallback. Every exit terminates the worker and clears its timer.
 */
export function decodeFinishes(buffer, manifest) {
  if (typeof Worker !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker, timer;
    const finish = (result) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(result);
    };
    try {
      worker = new Worker(new URL('finish-worker.js', document.baseURI));
      timer = setTimeout(() => finish(null), 15000);
      worker.onerror = worker.onmessageerror = () => finish(null);
      worker.onmessage = ({ data }) => finish(data.error ? null : new Map(data.files));
      worker.postMessage({ buffer, manifest });
    } catch {
      finish(null);
    }
  });
}
