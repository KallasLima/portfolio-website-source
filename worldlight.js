'use strict';

// A small, art-directed approximation of light returning from the windshield.
// Paint into the five EXISTING cabin plates once, not into an extra full-screen
// overlay. Their existing journey crossfade carries this light in both directions.
globalThis.Worldlight = {
  preparationMs: 0,
  // Preserve LED-to-metal contrast: planet bounce is local, not an exposure lift.
  bounceGain: 0.38,
  worlds: {
    moon: { color: [172, 197, 219], power: 0.085, left: 1, right: 0.55, x: 540 },
    earth: { color: [111, 179, 241], power: 0.46, left: 0.48, right: 1, x: 1190 },
    mars: { color: [244, 172, 116], power: 0.48, left: 1, right: 0.42, x: 350 },
    turquoise: { color: [110, 224, 219], power: 0.4, left: 0.82, right: 0.82, x: 800 },
    galaxy: { color: [167, 158, 227], power: 0.17, left: 0.68, right: 0.68, x: 800 },
  },
  paint(context, width, height, world) {
    const start = performance.now(),
      light = this.worlds[world];
    if (!light) return;
    context.save();
    context.scale(width / 1600, height / 1000);
    context.globalCompositeOperation = 'screen';
    const wash = (path, x, y, rx, ry, power, exclude = '') => {
      context.save();
      context.clip(new Path2D(path), 'evenodd');
      if (exclude) context.clip(new Path2D('M0 0H1600V1000H0Z ' + exclude), 'evenodd');
      context.translate(x, y);
      context.scale(rx, ry);
      const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [at, alpha] of [
        [0, 1],
        [0.4, 0.74],
        [0.78, 0.22],
        [1, 0],
      ])
        gradient.addColorStop(
          at,
          `rgba(${light.color.join(',')},${power * alpha * this.bounceGain})`,
        );
      context.fillStyle = gradient;
      context.fillRect(-1, -1, 2, 2);
      context.restore();
    };
    // Broad metal facets only. Holes protect the existing warm/cyan fixtures;
    // neither the window, display faces nor the lower instrument glass is lit.
    const wall = 'M0 173 52 195 111 684 44 706 0 552Z M62 206 103 182 159 698 130 736Z';
    const fixtures =
      'M85 280 111 284 131 496 104 499Z M109 516 139 514 148 591 118 593Z ' +
      'M61 599 118 597 151 699 90 724Z';
    wash(wall, 125, 432, 160, 360, light.power * light.left, fixtures);
    context.save();
    context.translate(1600, 0);
    context.scale(-1, 1);
    wash(wall, 125, 432, 160, 360, light.power * light.right, fixtures);
    context.restore();
    // The rear shelf catches a soft elliptical pool. It ends before the cyan
    // lip and instrument deck, so the raised metal still reads as a surface.
    wash(
      'M178 725H1422L1479 788H1200L1164 810H436L400 788H121Z',
      light.x,
      721,
      690,
      124,
      light.power * 0.68,
    );
    // A faint return on the upper inward-facing lintel, below the cabin ceiling.
    wash('M163 4H1437L1463 38H137Z', light.x, 47, 760, 62, light.power * 0.26);
    context.restore();
    this.preparationMs += performance.now() - start;
  },
};
