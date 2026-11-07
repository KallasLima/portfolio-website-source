const slicedSources = new WeakMap();
function slicedSurfaces(source) {
  if (slicedSources.has(source)) return slicedSources.get(source);
  // Split only where the responsive plate changes scale. Reciprocal depth is
  // linear on these camera-projected triangles, including the inserted edges.
  const cut = (polygon, axis, edge, sign) => {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length],
        da = (a[axis] - edge) * sign,
        db = (b[axis] - edge) * sign;
      if (da >= 0) result.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        result.push(a.map((v, k) => v + (b[k] - v) * t));
      }
    }
    return result;
  };
  const surfaces = source.surfaces.map((surface) => {
    const vertices = [],
      indices = [];
    for (let i = 0; i < surface.indices.length; i += 3) {
      let polygons = [
        surface.indices.slice(i, i + 3).map((index) => {
          const [u, v, d] = surface.vertices[index];
          return [u, v, 1 / d];
        }),
      ];
      for (const [axis, edge] of [
        [0, 0.3],
        [0, 0.7],
        [1, 0.11],
        [1, 0.175],
      ])
        polygons = polygons.flatMap((polygon) => {
          const values = polygon.map((p) => p[axis]);
          return Math.min(...values) < edge && Math.max(...values) > edge
            ? [cut(polygon, axis, edge, 1), cut(polygon, axis, edge, -1)]
            : [polygon];
        });
      for (const polygon of polygons) {
        const offset = vertices.length;
        vertices.push(...polygon.map(([u, v, r]) => [u, v, 1 / r]));
        for (let j = 1; j < polygon.length - 1; j++)
          indices.push(offset, offset + j, offset + j + 1);
      }
    }
    return { ...surface, vertices, indices };
  });
  slicedSources.set(source, surfaces);
  return surfaces;
}

// Closest source surface inside an image rectangle. Clip triangles in projected
// space with reciprocal depth, which stays linear under perspective projection.
function nearestDepth(source, [u0, v0, u1, v1], fallback) {
  let nearest = fallback;
  for (const surface of source.surfaces)
    for (let i = 0; i < surface.indices.length; i += 3) {
      let polygon = surface.indices.slice(i, i + 3).map((index) => {
        const [u, v, d] = surface.vertices[index];
        return [u, v, 1 / d];
      });
      for (const [axis, edge, sign] of [
        [0, u0, 1],
        [0, u1, -1],
        [1, v0, 1],
        [1, v1, -1],
      ]) {
        const clipped = [];
        for (let j = 0; j < polygon.length; j++) {
          const a = polygon[j],
            b = polygon[(j + 1) % polygon.length];
          const da = (a[axis] - edge) * sign,
            db = (b[axis] - edge) * sign;
          if (da >= 0) clipped.push(a);
          if (da >= 0 !== db >= 0) {
            const t = da / (da - db);
            clipped.push(a.map((value, k) => value + (b[k] - value) * t));
          }
        }
        polygon = clipped;
        if (!polygon.length) break;
      }
      for (const point of polygon) nearest = Math.min(nearest, 1 / point[2]);
    }
  return nearest;
}

// The cockpit plate and the moving displays have independent responsive layouts.
// Preserve the Blender surfaces' image coordinates, then reconstruct their
// depth along the live camera rays. This is stationary 3D shadow geometry, not
// a screen-space shadow decal. Only layout changes rebuild it.
export function buildConsoleReceiverData(
  source,
  stage,
  reader,
  width,
  height,
  distance,
  layout,
  clearance = reader,
) {
  const positions = [],
    indices = [],
    strengths = [],
    plateUvs = [];
  const cabin = window.ConsoleLayout.cabin(stage);
  const scale = (cabin.scale * 1600) / (2 * (18 / 52.3) * source.referenceDepth);
  // The reader has a different responsive layout from the photographic shell.
  // Keep the structural surface behind its lower housing even on tall desktops.
  const underReader = nearestDepth(
    source,
    [
      cabin.sourceAtX(clearance.left - stage.left) / 1600,
      cabin.sourceAtY(clearance.top - stage.top) / 1000,
      cabin.sourceAtX(clearance.right - stage.left) / 1600,
      cabin.sourceAtY(clearance.bottom + 2 - stage.top) / 1000,
    ],
    Infinity,
  );
  const referenceDepth =
    Math.min(source.referenceDepth, underReader - 0.35) - (clearance.depth || 0) / scale;
  const append = (vertices, triangles, strength = 1, mapped = true) => {
    const offset = positions.length / 3;
    for (const [u, v, depth] of vertices) {
      const z = (referenceDepth - depth) * scale;
      const rayScale = (distance - z) / distance;
      const x = mapped ? cabin.mapX(u * 1600) : u * stage.width,
        y = mapped ? cabin.mapY(v * 1000) : v * stage.height;
      positions.push(
        (stage.left + x - width / 2) * rayScale,
        (height / 2 - stage.top - y) * rayScale,
        z,
      );
      strengths.push(strength);
      plateUvs.push(x / stage.width, y / stage.height);
    }
    for (const index of triangles) indices.push(offset + index);
  };
  // Dark instrument glass receives a shadow too. The surface shader preserves
  // individual luminous markings; do not exempt the entire instrument bed.
  for (const surface of slicedSurfaces(source))
    append(
      surface.vertices,
      surface.indices,
      /recessed dark display bed/.test(surface.name) ? 0.7 : 1,
    );

  // The original small instrument housing is repositioned below the reader.
  // Match that same measured rectangle instead of catching shadows at its old
  // location in the plate. Its top bevel, face and lower lip have real depth.
  const { width: panelWidth, height: panelHeight, left, top, visible } = layout.instrument;
  const instrumentVertexStart = positions.length / 3;
  if (visible !== false) {
    const u0 = cabin.sourceAtX(left - stage.left) / 1600,
      u1 = cabin.sourceAtX(left + panelWidth - stage.left) / 1600;
    const v0 = cabin.sourceAtY(top - stage.top) / 1000,
      v1 = cabin.sourceAtY(top + panelHeight - stage.top) / 1000;
    let frontDepth = referenceDepth - 0.95;
    // Responsive placement can move this housing over a different part of the
    // source deck. Keep its entire bevel in front of every intersecting surface,
    // rather than letting the depth prepass bury it at taller desktop sizes.
    for (const surface of source.surfaces)
      for (let i = 0; i < surface.indices.length; i += 3) {
        const a = surface.vertices[surface.indices[i]],
          b = surface.vertices[surface.indices[i + 1]],
          c = surface.vertices[surface.indices[i + 2]];
        if (
          Math.max(a[0], b[0], c[0]) < u0 ||
          Math.min(a[0], b[0], c[0]) > u1 ||
          Math.max(a[1], b[1], c[1]) < v0 ||
          Math.min(a[1], b[1], c[1]) > v1
        )
          continue;
        frontDepth = Math.min(frontDepth, a[2], b[2], c[2]);
      }
    const panelDepth = frontDepth - 0.19;
    const rows = [
      [top, panelDepth + 0.14],
      [top + panelHeight * 0.12, panelDepth],
      [top + panelHeight * 0.87, panelDepth],
      [top + panelHeight, panelDepth + 0.08],
    ];
    const vertices = rows.flatMap(([y, depth]) =>
      [left, left + panelWidth].map((x) => [
        (x - stage.left) / stage.width,
        (y - stage.top) / stage.height,
        depth,
      ]),
    );
    append(vertices, [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5, 5, 6, 7], 1, false);
  }

  return {
    positions,
    indices,
    strengths,
    plateUvs,
    instrumentRect:
      visible === false
        ? [-2, -2, 1, 1]
        : [
            (left - stage.left) / stage.width,
            (top - stage.top) / stage.height,
            panelWidth / stage.width,
            panelHeight / stage.height,
          ],
    instrumentVertexStart,
  };
}
