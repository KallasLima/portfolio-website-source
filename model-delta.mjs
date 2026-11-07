// Lossless transport only: the GLTF parser receives the original right GLB.
export async function restoreModelDelta(packed, base) {
  const bytes = new Uint8Array(packed),
    source = new Uint8Array(base);
  if (bytes.length < 4 || bytes.length > 8 * 1024 * 1024) throw Error('Invalid model delta');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size > 2048 || size + 4 > bytes.length) throw Error('Invalid delta header');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size)));
  const { baseOffset, prefixBytes, binBytes } = meta;
  if (
    meta.version !== 1 ||
    ![baseOffset, prefixBytes, binBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
    baseOffset + binBytes !== source.length ||
    4 + size + prefixBytes + binBytes !== bytes.length
  ) {
    throw Error('Mismatched model delta');
  }
  const hash = async (value) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  if ((await hash(source)) !== meta.baseHash) throw Error('Stale model delta base');
  const result = new Uint8Array(prefixBytes + binBytes);
  result.set(bytes.subarray(4 + size, 4 + size + prefixBytes));
  const delta = bytes.subarray(4 + size + prefixBytes);
  for (let i = 0; i < binBytes; i++) result[prefixBytes + i] = delta[i] ^ source[baseOffset + i];
  if ((await hash(result)) !== meta.resultHash) throw Error('Damaged model delta');
  return result.buffer;
}
