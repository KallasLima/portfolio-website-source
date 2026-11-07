// Lossless spatial prediction of RGBE bytes. Keep exponent data untouched;
// ordinary image decoders would premultiply it as alpha and change the lighting.
export function paeth(a, b, c) {
  const p = a + b - c,
    da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
export function predictPixels(pixels, width) {
  const stride = width * 4,
    result = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const left = i % stride >= 4,
      above = i >= stride;
    result[i] =
      pixels[i] -
      paeth(
        left ? pixels[i - 4] : 0,
        above ? pixels[i - stride] : 0,
        left && above ? pixels[i - stride - 4] : 0,
      );
  }
  return result;
}
export function restorePixels(filtered, width) {
  const stride = width * 4,
    pixels = new Uint8Array(filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const left = i % stride >= 4,
      above = i >= stride;
    pixels[i] =
      filtered[i] +
      paeth(
        left ? pixels[i - 4] : 0,
        above ? pixels[i - stride] : 0,
        left && above ? pixels[i - stride - 4] : 0,
      );
  }
  return pixels;
}
export function finishPixelsToHalfFloat(pixels, toHalfFloat) {
  const half = new Uint16Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const scale = Math.pow(2, pixels[i + 3] - 128) / 255;
    for (let c = 0; c < 3; c++) half[i + c] = toHalfFloat(Math.min(pixels[i + c] * scale, 65504));
    half[i + 3] = 15360;
  }
  return half;
}
export function unpackFinishPixels(buffer, manifest) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw Error('Truncated finish transport');
  const length = view.getUint32(0, true);
  if (length > 65536 || length > bytes.length - 4) throw Error('Invalid finish header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  if (
    header.version !== 1 ||
    header.format !== 'rgbe-paeth' ||
    !Array.isArray(header.files) ||
    header.files.length !== manifest.finishes.length
  )
    throw Error('Invalid finish inventory');
  let at = 4 + length;
  const files = new Map();
  for (const entry of header.files) {
    const { file, width, height } = entry;
    if (
      !manifest.finishes.some((item) => item.file === file) ||
      files.has(file) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024
    )
      throw Error('Invalid finish dimensions');
    const size = width * height * 4;
    if (entry.bytes !== size || at + size > bytes.length) throw Error('Truncated finish pixels');
    files.set(file, { width, height, pixels: restorePixels(bytes.subarray(at, at + size), width) });
    at += size;
  }
  if (at !== bytes.length) throw Error('Unexpected finish bytes');
  return files;
}
