'use strict';
// Build the readable first view and deferred 3D bundles used by every entry.
const fs = require('node:fs'),
  path = require('node:path'),
  esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
// The full renderer fetches its normal map after readable first paint. The
// ordinary metadata builder's 3D preload must not compete with 2D artwork.
const entry = path.join(root, 'index.html');
fs.writeFileSync(
  entry,
  fs
    .readFileSync(entry, 'utf8')
    .replace(
      /^\s*<link rel="preload" href="assets\/displays\/normal-blue-metal-[^"]+" as="fetch" crossorigin="anonymous">\r?\n/m,
      '',
    ),
);
const data = JSON.parse(fs.readFileSync(path.join(root, 'assets/hybrid/manifest.json')));
const {
  variants,
  directory,
  proceduralStars,
  starsCrop,
  starsInset,
  geometry,
  shadowGeometry,
  planetSprites,
  instrumentColors,
  rawShadow,
} = JSON.parse(fs.readFileSync(path.join(root, 'assets/hybrid-parity/manifest.json')));
data.entries = JSON.parse(fs.readFileSync(path.join(root, 'assets/hybrid-entries/manifest.json')));
data.speed = {
  variants,
  directory,
  proceduralStars,
  starsCrop,
  starsInset,
  geometry,
  shadowGeometry,
  planetSprites,
  instrumentColors,
  rawShadow,
};
fs.writeFileSync(
  path.join(root, 'hybrid-artwork.js'),
  'window.HybridArtwork=' + JSON.stringify(data) + ';\n',
);
const small = [
  'console-layout.js',
  'frame-clock.js',
  'hybrid-layout.js',
  'hybrid-artwork.js',
  'hybrid-desk-shadow.js',
  'observatory-art.js',
  'cabin-detail.js',
  'instruments.js',
  'hybrid-entry-scene.js',
  'hybrid-boot.js',
  'analytics.js',
  'contact.js',
  'header-actions.js',
  'webmcp-loader.js',
];
const original = [
  'hybrid-export.js',
  'entrance.js',
  'console-layout.js',
  'cabin-detail.js',
  'artwork-preparation.js',
  'cabin-surface.js',
  'frame-clock.js',
  'content.js',
  'particle-effects.js',
  'observatory-art.js',
  'scene.js',
  'instruments.js',
  'hinges.js',
  'tilt.js',
  'hybrid-layout.js',
  'display-3d.js',
  'worldlight.js',
  'chapter-history.js',
  'agent-actions.js',
  'app.js',
  'quiet-orbit.js',
];
(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'finish-worker-entry.mjs')],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: path.join(root, 'finish-worker.js'),
    legalComments: 'eof',
  });
  for (const [outfile, files] of [
    ['hybrid-firstview.js', small],
    ['hybrid-original.js', original],
  ])
    await esbuild.build({
      stdin: { contents: files.map((x) => `import './${x}';`).join('\n'), resolveDir: root },
      bundle: true,
      minify: true,
      format: 'iife',
      outfile: path.join(root, outfile),
      legalComments: 'eof',
    });
  await esbuild.build({
    entryPoints: [path.join(root, 'hybrid-enhancement-entry.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: path.join(root, 'hybrid-enhancement.js'),
    legalComments: 'eof',
  });
  await esbuild.build({
    entryPoints: [path.join(root, 'display-3d.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: path.join(root, 'display-engine.js'),
    legalComments: 'eof',
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
