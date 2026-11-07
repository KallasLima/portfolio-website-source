// Match the receiver's area-weighted smooth normals and triangle order exactly.
// Float64 accumulation retains JavaScript Number precision until the final GPU
// Float32 conversion. Avoid per-triangle/per-vertex slice/map/flatMap garbage.
export function receiverAttributes(data) {
  const { positions: p, indices, plateUvs, strengths } = data;
  const normals = new Float64Array(p.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const abx = p[b] - p[a],
      aby = p[b + 1] - p[a + 1],
      abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a],
      acy = p[c + 1] - p[a + 1],
      acz = p[c + 2] - p[a + 2];
    const x = aby * acz - abz * acy,
      y = abz * acx - abx * acz,
      z = abx * acy - aby * acx;
    for (let k = 0; k < 3; k++) {
      const v = indices[i + k] * 3;
      normals[v] += x;
      normals[v + 1] += y;
      normals[v + 2] += z;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  const expand = (values, size) => {
    const result = new Float32Array(indices.length * size);
    for (let i = 0; i < indices.length; i++)
      for (let k = 0; k < size; k++) result[i * size + k] = values[indices[i] * size + k];
    return result;
  };
  return {
    position: expand(p, 3),
    normal: expand(normals, 3),
    plateUv: expand(plateUvs, 2),
    strength: expand(strengths, 1),
  };
}
