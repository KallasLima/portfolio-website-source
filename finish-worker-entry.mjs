// Import the supported source export so the worker does not carry renderer/shader code.
import { DataUtils } from 'three/src/extras/DataUtils.js';
import { unpackFinishPixels, finishPixelsToHalfFloat } from './finish-transport.mjs';

// Decode off the UI thread. Transfer the exact half-float values the renderer
// already expects; no resolution, color range, or material change is involved.
self.onmessage = ({ data: { buffer, manifest } }) => {
  try {
    const files = [...unpackFinishPixels(buffer, manifest)].map(([name, entry]) => [
      name,
      {
        width: entry.width,
        height: entry.height,
        half: finishPixelsToHalfFloat(entry.pixels, DataUtils.toHalfFloat),
      },
    ]);
    self.postMessage(
      { files },
      files.map(([, entry]) => entry.half.buffer),
    );
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
