'use strict';
const { gzipSync } = require('node:zlib');
function deterministicGzip(bytes) {
  const output = gzipSync(bytes, { level: 9 });
  // RFC 1952 byte 9 identifies the compressor's OS, not the payload. Normalize
  // it so Windows/Linux builds have the same content address and Git output.
  output[9] = 255;
  return output;
}
module.exports = { deterministicGzip };
