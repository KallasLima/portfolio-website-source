const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const root = path.resolve(__dirname, '..'),
  read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pages = require('./site-pages.cjs');
const entries = JSON.parse(read('assets/hybrid-entries/manifest.json'));
test('each direct page delivers its own manuscript and early artwork without 3D preloads', () => {
  for (const page of pages) {
    const html = read(page.chapter ? page.path.slice(1) + 'index.html' : 'index.html');
    assert(html.includes(`data-entry-chapter="${page.chapter}"`));
    assert(html.includes(`data-index="${page.chapter}"`));
    assert(html.includes('hybrid-firstview.js'));
    assert(!/<link[^>]+preload[^>]+assets\/displays\//.test(html));
    if (page.chapter) {
      assert(!html.includes('moon-gpu-mobile'));
      assert(html.includes(`${page.chapter}-mobile-cabin.avif`));
      for (const files of Object.values(entries[page.chapter].variants))
        for (const file of Object.values(files))
          assert(fs.existsSync(path.join(root, entries[page.chapter].directory, file)), file);
    }
  }
});
test('lightweight resting objects match the native journey at every chapter and aspect ratio', () => {
  const scope = {};
  scope.window = scope;
  vm.createContext(scope);
  for (const file of ['console-layout.js', 'scene.js', 'hybrid-entry-scene.js'])
    vm.runInContext(read(file), scope);
  const dims = {
    earth: [1254, 1254],
    moon: [1254, 1254],
    mars: [1254, 1254],
    turquoise: [1774, 887],
    galaxy: [2098, 749],
    'localgroup-neighbors': [1671, 941],
    stars: [2048, 1280],
    nearStars: [1024, 1024],
  };
  const assets = Object.fromEntries(
    Object.entries(dims).map(([name, [width, height]]) => [name, { name, width, height }]),
  );
  for (const [width, height, top] of [
    [320, 659, 265],
    [412, 915, 394],
    [913, 1181, 493],
    [1440, 900, 311],
    [2560, 1440, 500],
  ])
    for (let chapter = 1; chapter < 6; chapter++) {
      const raster = scope.ConsoleLayout.spaceRaster(width, height, 1.75),
        camera = scope.ConsoleLayout.spaceCamera(raster.width, raster.height),
        actual = [],
        expected = [];
      const ctx = {
        save() {},
        restore() {},
        translate() {},
        scale() {},
        fillRect() {},
        createRadialGradient() {
          return { addColorStop() {} };
        },
        drawImage(image, ...box) {
          actual.push({ name: image.name, box, alpha: this.globalAlpha });
        },
      };
      scope.HybridEntryScene.paint(
        ctx,
        chapter,
        assets,
        { width, height, reader: { top } },
        raster,
      );
      const scene = Object.create(scope.JourneyScene.prototype),
        density = raster.width / width,
        cssScale = camera.scale / density;
      Object.assign(scene, {
        assets,
        visible: camera.visible,
        photos: new Map([['nearStars', {}]]),
        photo(name, ...values) {
          if (values[2] > 0.3 && (values[4] ?? 1) > 0.001)
            expected.push({ name, box: values.slice(0, 4), alpha: values[4] ?? 1 });
        },
        warp() {},
        point() {},
        retreatStars() {},
        systemBodies: [],
        finalGroupFit: Math.max(
          0.45,
          Math.min(
            1,
            (top - camera.offsetY / density - 238 * cssScale - 22) /
              ((((511 / 941 - 0.378) * 1760 * 941) / 1671) * cssScale),
          ),
        ),
      });
      scene.stars(chapter);
      if (chapter <= 2) scene.solar(chapter);
      else if (chapter === 3) scene.interstellar(1);
      else scene.localGroup(chapter - 4);
      for (const native of expected) {
        const first = actual.find((x) => x.name === native.name);
        assert(first, `${chapter} missing ${native.name}`);
        native.box.forEach((n, i) =>
          assert(Math.abs(first.box[i] - n) < 0.001, `${chapter} ${native.name} coordinate ${i}`),
        );
        assert(Math.abs(first.alpha - native.alpha) < 0.001);
      }
    }
});
