'use strict';
// Worker creation is optional. A blocked worker, older browser, or failed job
// uses the original painter without preventing the reader from loading.
window.ArtworkPreparation = (() => {
  let worker = null,
    failed = false,
    sequence = 0;
  const pending = new Map(),
    sources = new WeakMap();
  const shutdown = () => {
    failed = true;
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('Artwork worker unavailable'));
    }
    pending.clear();
  };
  const getWorker = () => {
    if (
      failed ||
      typeof Worker !== 'function' ||
      typeof OffscreenCanvas !== 'function' ||
      typeof createImageBitmap !== 'function'
    )
      return null;
    if (!worker) {
      try {
        worker = new Worker(new URL('artwork-worker.js', document.baseURI));
        worker.onmessage = ({ data }) => {
          const job = pending.get(data.id);
          if (!job) {
            data.bitmap?.close();
            return;
          }
          clearTimeout(job.timer);
          pending.delete(data.id);
          data.error ? job.reject(new Error(data.error)) : job.resolve(data.bitmap || data.colors);
        };
        worker.onerror = shutdown;
        worker.onmessageerror = shutdown;
      } catch {
        shutdown();
      }
    }
    return worker;
  };
  return {
    remember(image, blob) {
      sources.set(image, blob);
    },
    async prepare(name, image, overlay, cabin) {
      const active = getWorker();
      if (!active) {
        cabin?.mask.close();
        cabin?.accent.close();
        return null;
      }
      let input;
      try {
        const blob = image ? sources.get(image) : null;
        input = image && !blob ? await createImageBitmap(image) : null;
        // Worker may have failed while the input was being decoded.
        if (active !== worker) {
          input?.close();
          cabin?.mask.close();
          cabin?.accent.close();
          return null;
        }
        return await new Promise((resolve, reject) => {
          const id = ++sequence,
            timer = setTimeout(shutdown, 15000);
          pending.set(id, { resolve, reject, timer });
          try {
            active.postMessage(
              {
                id,
                name,
                image: input,
                blob,
                overlay: overlay ? sources.get(overlay) : null,
                cabin,
              },
              [...(input ? [input] : []), ...(cabin ? [cabin.mask, cabin.accent] : [])],
            );
            input = null;
          } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      } catch {
        input?.close();
        cabin?.mask.close();
        cabin?.accent.close();
        return null;
      }
    },
  };
})();
