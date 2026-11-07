'use strict';
// Pure resting geometry shared by lightweight presentation and live models.
window.HybridLayout = {
  solve(
    { reader: r, width: w, height: h, stage },
    metadata,
    sideDisplays,
    folds = { left: 74, right: 0 },
  ) {
    const dims = (name) => metadata.models[name],
      d = dims('center'),
      distance = Math.max(3200, w * 4);
    const assembly = [r.left + r.width / 2 - w / 2, h / 2 - r.bottom, 0],
      hingeX = r.width / 2 + 7;
    const near = Math.max(100, distance - 1800),
      fov = (180 / Math.PI) * (2 * Math.atan(h / 2 / distance)),
      top = near * Math.tan((Math.PI / 180) * 0.5 * fov),
      cameraY = (2 * near) / (2 * top),
      cameraX = (2 * near) / ((w / h) * (2 * top));
    // Keep native multiplication order: tiny perspective terms select the same
    // browser glyph-compositing path even for a visually upright reader.
    const project = ([x, y, z]) => {
      const reciprocal = 1 / (distance - z);
      return [
        (cameraX * x * reciprocal * 0.5 + 0.5) * w,
        (-cameraY * y * reciprocal * 0.5 + 0.5) * h,
      ];
    };
    const rotateY = ([x, y, z], a) => [
      Math.cos(a) * x + Math.sin(a) * z,
      y,
      -Math.sin(a) * x + Math.cos(a) * z,
    ];
    const portrait = Math.max(0, Math.min(1, (h / w - 0.85) / 0.3));
    const sideHeight = Math.min(r.height * 0.55, 280, h * 0.28);
    const heightScale = (s) =>
      s * (1 - portrait) +
      (Math.min(sideHeight, r.height * 0.33, 210) / dims('left').nominalHeight) * portrait;
    const cabin = window.ConsoleLayout.cabin(stage),
      inset =
        window.ConsoleLayout.windshieldInset(stage) * (1 - portrait) +
        (cabin.mapX(104) + 12) * portrait;
    const world = (name, p, scale, angle = 0, pitch = 0) => {
      const m = dims(name),
        sign = name === 'left' ? -1 : 1;
      let q =
        name === 'center'
          ? [
              p[0] * (r.width / d.nominalWidth),
              p[1] * (r.height / d.nominalHeight),
              p[2] * ((r.width / d.nominalWidth) * 0.45),
            ]
          : rotateY(
              [
                (p[0] + (sign * m.nominalWidth) / 2) * scale,
                p[1] * heightScale(scale),
                p[2] * scale * 0.45,
              ],
              (-sign * (16 + angle) * Math.PI) / 180,
            );
      if (name !== 'center') {
        q[0] += sign * hingeX;
        q[1] += 5;
      }
      q = [
        q[0],
        q[1] * Math.cos(pitch) - q[2] * Math.sin(pitch),
        q[1] * Math.sin(pitch) + q[2] * Math.cos(pitch),
      ];
      return q.map((v, i) => v + assembly[i]);
    };
    const point = (...args) => project(world(...args));
    const fits = (s) => {
      for (const name of ['left', 'right'])
        for (const angle of [0, 20, 45, 74])
          for (const pitch of [0, 15, 30, 37.5, 45]) {
            const b = dims(name).bounds;
            for (const x of [b.min[0], b.max[0]])
              for (const y of [b.min[1], b.max[1]])
                for (const z of [b.min[2], b.max[2]]) {
                  const [sx] = point(name, [x, y, z], s, angle, (pitch * Math.PI) / 180);
                  if (sx < stage.left + inset || sx > stage.left + stage.width - inset)
                    return false;
                }
          }
      return true;
    };
    let scale = sideHeight / dims('left').nominalHeight;
    if (sideDisplays && !fits(scale)) {
      let low = 0,
        high = scale;
      for (let i = 0; i < 20; i++) {
        const mid = (low + high) / 2;
        if (fits(mid)) low = mid;
        else high = mid;
      }
      scale = low;
    }
    const body = (name) => {
      const m = dims(name);
      return [
        [-m.nominalWidth / 2, m.nominalHeight, 0],
        [m.nominalWidth / 2, m.nominalHeight, 0],
        [m.nominalWidth / 2, 0, 0],
        [-m.nominalWidth / 2, 0, 0],
      ];
    };
    const sides = {};
    for (const name of ['left', 'right']) {
      const m = dims(name),
        angle = folds[name];
      sides[name] = {
        body: body(name).map((p) => point(name, p, scale, angle)),
        glass: m.contentQuad.map((p) => point(name, p, scale, angle)),
        width: (m.contentQuad[1][0] - m.contentQuad[0][0]) * scale,
        height: (m.contentQuad[0][1] - m.contentQuad[3][1]) * heightScale(scale),
      };
    }
    const g = d.contentQuad;
    return {
      folds,
      scale,
      scaleY: heightScale(scale),
      portrait,
      sides,
      point,
      world,
      project,
      assembly,
      distance,
      center: { left: r.left, top: r.top, width: r.width, height: r.height },
      glass: {
        left: ((g[0][0] + d.nominalWidth / 2) / d.nominalWidth) * r.width,
        top: ((d.nominalHeight - g[0][1]) / d.nominalHeight) * r.height,
        width: ((g[1][0] - g[0][0]) / d.nominalWidth) * r.width,
        height: ((g[0][1] - g[3][1]) / d.nominalHeight) * r.height,
      },
    };
  },
  matrix(points, width, height, origin = { left: 0, top: 0 }) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points.map(([x, y]) => [
      x - origin.left,
      y - origin.top,
    ]);
    const dx1 = x1 - x2,
      dx2 = x3 - x2,
      dx3 = x0 - x1 + x2 - x3,
      dy1 = y1 - y2,
      dy2 = y3 - y2,
      dy3 = y0 - y1 + y2 - y3,
      den = dx1 * dy2 - dx2 * dy1;
    const g = Math.abs(den) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / den,
      h = Math.abs(den) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / den;
    return `matrix3d(${(x1 - x0 + g * x1) / width},${(y1 - y0 + g * y1) / width},0,${g / width},${(x3 - x0 + h * x3) / height},${(y3 - y0 + h * y3) / height},0,${h / height},0,0,1,0,${x0},${y0},0,1)`;
  },
};
