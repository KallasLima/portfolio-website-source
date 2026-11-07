'use strict';
// Resting chapter views use the same world coordinates and camera as the
// journey. Small decoded photographs replace only the initial upload, not text.
window.HybridEntryScene = {
  paint(ctx, chapter, assets, measured, raster) {
    const camera = window.ConsoleLayout.spaceCamera(raster.width, raster.height),
      { scale, offsetX: x, offsetY: y, visible: v } = camera;
    const cover = Math.max(1, (v.right - v.left) / 1600, (v.bottom - v.top) / 1000),
      sw = 1880 * cover,
      sh = 1175 * cover;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = chapter >= 4 ? 0.66 : 0.8;
    ctx.drawImage(assets.stars, (v.left + v.right - sw) / 2, (v.top + v.bottom - sh) / 2, sw, sh);
    if (chapter <= 3) {
      const size = 2400 * cover * Math.exp(chapter * 0.11);
      ctx.globalAlpha = 0.72;
      ctx.drawImage(assets.nearStars, 800 - size / 2, 238 - size / 2, size, size);
    }
    const sprite = (name, x, y, w, alpha = 1, u = 0.5, v = 0.5) => {
      const image = assets[name],
        h = (w * image.height) / image.width;
      ctx.globalAlpha = alpha;
      ctx.drawImage(image, x - w * u, y - h * v, w, h);
    };
    if (chapter === 1) {
      sprite('earth', 1510, 1080, 2300);
      const g = ctx.createRadialGradient(570, 255, 0, 570, 255, 3.125);
      g.addColorStop(0, '#ffd5b3');
      g.addColorStop(0.2, '#ffd5b3');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(566.875, 251.875, 6.25, 6.25);
    } else if (chapter === 2) sprite('mars', 70, 1080, 2280);
    else if (chapter === 3) sprite('turquoise', 800, 238, 1800, 1, 0.501, 0.48);
    else if (chapter === 4) sprite('galaxy', 800, 238, 1380, 0.98, 0.507, 0.475);
    else if (chapter === 5) {
      const density = raster.width / measured.width,
        cssScale = scale / density;
      const axisY = y / density + 238 * cssScale,
        offset = (((511 / 941 - 0.378) * 1760 * 941) / 1671) * cssScale;
      const fit = Math.max(0.45, Math.min(1, (measured.reader.top - axisY - 22) / offset));
      sprite('localgroup-neighbors', 800, 238, 1760 * fit, 1, 0.473, 0.378);
      sprite('galaxy', 800, 238, 420 * fit, 0.98, 0.507, 0.475);
    }
    ctx.restore();
  },
};
