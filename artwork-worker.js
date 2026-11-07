'use strict';
// This is the same deterministic painter used by the retained canvas fallback.
// Only the location of the work changes; source pixels and dimensions do not.
importScripts(
  'observatory-art.js',
  'console-layout.js',
  'cabin-detail.js',
  'worldlight.js',
  'cabin-surface.js',
);
self.onmessage = async ({ data: { id, name, image, blob, overlay, cabin } }) => {
  let canvas, galaxy, scratch;
  try {
    if (blob) image = await createImageBitmap(blob);
    if (name === 'cabin-colors') {
      canvas = new OffscreenCanvas(4, 1);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      [
        [190, 921],
        [360, 838],
        [1370, 930],
        [1400, 842],
      ].forEach(([x, y], i) => context.drawImage(image, x - 3, y - 3, 6, 6, i, 0, 1, 1));
      const pixels = context.getImageData(0, 0, 4, 1).data;
      self.postMessage({
        id,
        colors: Array.from({ length: 4 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 3))),
      });
      return;
    }
    if (name === 'cabin-surface') {
      canvas = new OffscreenCanvas(1, 1);
      scratch = new OffscreenCanvas(1, 1);
      self.CabinSurface.paint(
        canvas,
        scratch,
        image,
        cabin.mask,
        cabin.accent,
        cabin.world,
        cabin.rect,
        cabin.density,
      );
    } else if (name.startsWith('preview:')) {
      const scale = Math.min(1, 512 / Math.max(image.width, image.height));
      canvas = new OffscreenCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const context = canvas.getContext('2d', { alpha: true });
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (overlay) {
        galaxy = await createImageBitmap(overlay);
        const width = (canvas.width * 420) / 1760,
          height = (width * galaxy.height) / galaxy.width;
        context.globalAlpha = 0.98;
        context.drawImage(
          galaxy,
          canvas.width * 0.473 - width * 0.507,
          canvas.height * 0.378 - height * 0.475,
          width,
          height,
        );
      }
    } else
      canvas =
        name === 'nearStars'
          ? ObservatoryArt.foregroundStars()
          : ObservatoryArt.prepare(name, image);
    const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' });
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({ id, error: String(error.message || error) });
  } finally {
    image?.close();
    galaxy?.close();
    cabin?.mask.close();
    cabin?.accent.close();
    if (scratch) scratch.width = scratch.height = 1;
    if (canvas instanceof OffscreenCanvas) {
      canvas.width = canvas.height = 1;
    }
  }
};
