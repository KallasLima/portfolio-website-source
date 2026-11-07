'use strict';

// Optical artwork is prepared once. Travel only moves the resulting immutable
// layers; neither reading nor the instrument idle animation repaints space.
globalThis.ObservatoryArt = (() => {
  const surface = (
    width,
    height,
    canvas = typeof document === 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas'),
  ) => {
    canvas.width = width;
    canvas.height = height;
    return [canvas, canvas.getContext('2d', { alpha: true })];
  };
  const glow = (ctx, x, y, rx, ry, stops) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [position, color] of stops) gradient.addColorStop(position, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  };
  function starfield(photo, target, sourceCrop, inset, insetRect) {
    const [canvas, ctx] = surface(2048, 1280, target);
    ctx.fillStyle = '#01040b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Keep the original photograph's luminous stars and depth. This exposure is
    // baked once; the travel layers and released-canvas lifecycle stay unchanged.
    ctx.globalAlpha = 0.92;
    if (sourceCrop) ctx.drawImage(photo, ...sourceCrop);
    else ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
    if (inset && insetRect) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#01040b';
      ctx.fillRect(...insetRect);
      ctx.globalAlpha = 0.92;
      ctx.drawImage(inset, ...insetRect);
    }
    ctx.globalAlpha = 1;
    glow(ctx, 570, 570, 1020, 660, [
      [0, 'rgba(25,57,84,.17)'],
      [0.6, 'rgba(14,24,47,.10)'],
      [1, 'transparent'],
    ]);
    let seed = 427319;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 1120; i++) {
      const x = random() * 2048,
        y = random() * 1280,
        power = random(),
        radius = 0.48 + power * power * 1.2;
      const warm = random() > 0.8,
        alpha = 0.25 + power * power * 0.75;
      ctx.fillStyle = warm ? `rgba(248,210,170,${alpha})` : `rgba(180,215,245,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (power > 0.989)
        glow(ctx, x, y, 6, 6, [
          [0, 'rgba(223,241,255,.46)'],
          [0.14, 'rgba(168,214,255,.14)'],
          [1, 'transparent'],
        ]);
    }
    return canvas;
  }
  function celestial(name, image) {
    const width = image.naturalWidth || image.width,
      height = image.naturalHeight || image.height;
    const [canvas, ctx] = surface(width, height);
    if (name === 'earth')
      glow(ctx, width * 0.5, height * 0.5, width * 0.5, height * 0.5, [
        [0, 'transparent'],
        [0.84, 'transparent'],
        [0.9, 'rgba(60,150,243,.15)'],
        [0.955, 'rgba(48,130,225,.10)'],
        [1, 'transparent'],
      ]);
    if (name === 'mars')
      glow(ctx, width * 0.5, height * 0.5, width * 0.49, height * 0.49, [
        [0, 'transparent'],
        [0.84, 'transparent'],
        [0.92, 'rgba(236,137,72,.12)'],
        [1, 'transparent'],
      ]);
    if (name === 'turquoise')
      glow(ctx, width * 0.501, height * 0.48, width * 0.275, width * 0.275, [
        [0, 'rgba(34,165,185,.06)'],
        [0.68, 'rgba(29,150,182,.08)'],
        [0.85, 'rgba(43,148,190,.07)'],
        [1, 'transparent'],
      ]);
    if (name === 'galaxy') {
      glow(ctx, width * 0.507, height * 0.475, width * 0.47, height * 0.47, [
        [0, 'rgba(210,180,135,.12)'],
        [0.18, 'rgba(110,138,209,.12)'],
        [0.7, 'rgba(71,92,167,.05)'],
        [1, 'transparent'],
      ]);
    }
    ctx.filter =
      name === 'moon'
        ? 'contrast(1.09) brightness(.92) saturate(.8)'
        : name === 'galaxy'
          ? 'contrast(1.06) saturate(1.12)'
          : 'contrast(1.035) saturate(1.04)';
    ctx.drawImage(image, 0, 0, width, height);
    ctx.filter = 'none';
    // Moon has no atmosphere. A cool shadow grade preserves the crater relief
    // and its unlit hemisphere without adding a fictitious luminous rim.
    if (name === 'moon') {
      ctx.globalCompositeOperation = 'source-atop';
      const shade = ctx.createLinearGradient(0, 0, width, height);
      shade.addColorStop(0, 'rgba(209,221,235,.035)');
      shade.addColorStop(0.42, 'rgba(27,46,67,.015)');
      shade.addColorStop(1, 'rgba(7,20,41,.28)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
    return canvas;
  }
  function foregroundStars(target) {
    const [canvas, ctx] = surface(1024, 1024, target);
    let seed = 12891;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 165; i++) {
      const x = random() * 1024,
        y = random() * 1024,
        power = random();
      const tint = i % 5 === 0 ? '245,210,177' : '185,220,248';
      glow(ctx, x, y, 2.2 + power * 1.5, 2.2 + power * 1.5, [
        [0, `rgba(${tint},${0.36 + power * 0.38})`],
        [0.22, `rgba(${tint},.19)`],
        [1, 'transparent'],
      ]);
    }
    return canvas;
  }
  return {
    foregroundStars,
    prepare: (name, image, target, sourceCrop, inset, insetRect) =>
      name === 'stars'
        ? starfield(image, target, sourceCrop, inset, insetRect)
        : ['moon', 'earth', 'mars', 'turquoise', 'galaxy'].includes(name)
          ? celestial(name, image)
          : image,
  };
})();
