'use strict';
// Shared by the worker and synchronous resize/failure fallback. Layout/density
// are captured by the caller: the painter never reads DOM or device settings.
globalThis.CabinSurface = {
  paint(surface, scratchCanvas, image, mask, accent, world, rect, density) {
    const width = Math.max(1, Math.ceil(rect.width * density));
    const height = Math.max(1, Math.ceil(rect.height * density));
    const cabin = globalThis.ConsoleLayout.cabin(rect);
    const detailScale = Math.min(2, Math.max(1, cabin.scale * density));
    scratchCanvas.width = Math.ceil(1600 * detailScale);
    scratchCanvas.height = Math.ceil(1000 * detailScale);
    const scratch = scratchCanvas.getContext('2d');
    scratch.setTransform(scratchCanvas.width / 1600, 0, 0, scratchCanvas.height / 1000, 0, 0);
    scratch.imageSmoothingQuality = 'high';
    scratch.drawImage(image, 0, 0, 1600, 1000);
    globalThis.CabinDetail.paint(scratch, image);
    globalThis.Worldlight.paint(scratch, 1600, 1000, world);
    scratch.globalAlpha = 0.08;
    scratch.drawImage(accent, 0, 0, 1600, 1000);
    scratch.globalAlpha = 1;
    scratch.globalCompositeOperation = 'destination-in';
    scratch.drawImage(mask, 0, 0, 1600, 1000);
    scratch.globalCompositeOperation = 'source-over';
    surface.width = width;
    surface.height = height;
    const context = surface.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0);
    cabin.paint(context, scratchCanvas);
  },
};
