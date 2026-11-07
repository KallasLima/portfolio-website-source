'use strict';
// Every canonical chapter starts with live HTML and lightweight artwork.
// The full 3D runtime is requested only after the readable view is presented.
(() => {
  const params = new URLSearchParams(location.search),
    mode = params.get('hybrid') || 'auto';
  const root = document.documentElement,
    host = document.getElementById('cockpit');
  // The same live reader changes composited surfaces during 3D handover.
  // Chromium can retain DOM focus but lose the native page-scroll target during
  // that switch. Route unmodified paging keys to the focused reader directly;
  // this also works before enhancement and leaves selection/shortcut keys alone.
  document.getElementById('screen-copy').addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
    const reader = event.target.closest('.screen-article');
    if (!reader || event.target !== reader) return;
    event.preventDefault();
    reader.scrollBy({
      top: reader.clientHeight * 0.875 * (event.key === 'PageDown' ? 1 : -1),
      behavior: 'instant',
    });
  });
  let readable = false;
  async function publishReadable() {
    if (readable) return;
    // A revealed DOM is not yet a presented view. Keep optional work behind
    // the same paint boundary on successful startup and the readable fallback.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (readable) return;
    readable = true;
    performance.mark('hybrid-first-readable');
    root.dataset.cockpitReadable = 'true';
    window.dispatchEvent(new Event('cockpit-readable'));
  }
  const entryChapter = Number(root.dataset.entryChapter) || 0;
  if (mode === 'original') {
    for (const card of document.querySelectorAll('.hybrid-side-card')) card.remove();
    root.dataset.hybrid = 'interactive';
    loadScript('hybrid-original.js');
    return;
  }
  const dom = (id) => document.getElementById(id),
    art = window.HybridArtwork,
    entryArt = art.entries[entryChapter],
    folds = { left: entryChapter === 0 ? 74 : 0, right: entryChapter === 5 ? 74 : 0 };
  const geometrySet = entryArt?.geometry || art.speed.geometry;
  let state = 'preparing',
    revision = 0,
    layout,
    assets = {},
    currentVariant,
    pendingVariant,
    artworkRevision = 0,
    lastLayoutKey;
  const variantFor = () =>
    innerWidth <= 700 ? 'mobile' : innerWidth < 1100 ? 'tablet' : 'desktop';
  const centerVariantFor = () => {
    const r = window.ConsoleLayout.snapshot()?.reader;
    if (!r) return variantFor();
    return Object.keys(geometrySet).sort(
      (a, b) =>
        Math.abs(
          Math.log(
            r.width / r.height / (geometrySet[a].reader.width / geometrySet[a].reader.height),
          ),
        ) -
        Math.abs(
          Math.log(
            r.width / r.height / (geometrySet[b].reader.width / geometrySet[b].reader.height),
          ),
        ),
    )[0];
  };
  const spriteVariantFor = () => {
    if (entryArt) return variantFor();
    const raster = window.ConsoleLayout.spaceRaster(innerWidth, innerHeight, devicePixelRatio),
      target = window.ConsoleLayout.spaceCamera(raster.width, raster.height).scale,
      density = devicePixelRatio > 1.25 ? 'high' : 'normal';
    return Object.keys(art.speed.planetSprites).sort((a, b) => {
      const scale = (v) => {
        const m = art.speed.planetSprites[v].moon[density];
        return window.ConsoleLayout.spaceCamera(...m.raster).scale;
      };
      return Math.abs(Math.log(scale(a) / target)) - Math.abs(Math.log(scale(b) / target));
    })[0];
  };
  const readyCallbacks = [];
  let instruments, instrumentSeed, deskShadow;
  const layer = document.createElement('div');
  layer.id = 'hybrid-layers';
  layer.setAttribute('aria-hidden', 'true');
  host.append(layer);
  const cabin = document.createElement('canvas');
  cabin.className = 'hybrid-cabin';
  dom('stage').append(cabin);
  const shadow = document.createElement('canvas');
  shadow.className = 'hybrid-shadow';
  layer.append(shadow);
  const exterior = document.createElement('canvas');
  exterior.className = 'hybrid-exterior';
  dom('space').parentElement.append(exterior);
  const surfaces = {};
  for (const name of ['center', 'glass', 'left', 'right', 'mounts']) {
    const el = document.createElement('img');
    el.className = 'hybrid-' + name;
    surfaces[name] = el;
    layer.append(el);
  }
  const mountComposite = document.createElement('canvas');
  mountComposite.style.position = 'absolute';
  layer.insertBefore(mountComposite, surfaces.left);
  const centerComposite = document.createElement('canvas');
  centerComposite.style.position = 'absolute';
  centerComposite.style.pointerEvents = 'none';
  layer.append(centerComposite);
  surfaces.center.hidden = true;
  surfaces.glass.hidden = true;
  host.classList.add('physical-console');
  host.inert = false;
  for (const control of [
    dom('previous'),
    dom('next'),
    dom('tilt-grip'),
    dom('monitor-hit-left'),
    dom('monitor-hit-right'),
  ])
    control.inert = true;
  dom('destinations').inert = true;
  const article = document.querySelector(`#screen-copy > article[data-index="${entryChapter}"]`);
  article.classList.add('hybrid-entry');
  article.tabIndex = 0;
  article.inert = false;
  document.querySelector('.skip-reading').addEventListener('click', (e) => {
    if (state === 'ready') return;
    e.preventDefault();
    article.focus({ preventScroll: true });
  });
  const earlyRead = () => {
    const extent = Math.max(0, article.scrollHeight - article.clientHeight),
      atStart = article.scrollTop < 3,
      atEnd = extent - article.scrollTop < 3,
      fraction = atEnd ? 1 : atStart ? 0 : article.scrollTop / extent;
    dom('center-screen').style.setProperty('--reading-progress', fraction.toFixed(4));
    dom('center-screen').dataset.readingStart = String(atStart);
    dom('center-screen').dataset.readingEnd = String(atEnd);
  };
  article.addEventListener('scroll', earlyRead, { passive: true });
  const mapRect = (el, box) =>
    Object.assign(el.style, {
      left: box.left + 'px',
      top: box.top + 'px',
      width: box.width + 'px',
      height: box.height + 'px',
    });
  function measure() {
    host.style.setProperty(
      '--header-height',
      document.querySelector('.site-header').getBoundingClientRect().height + 'px',
    );
    window.ConsoleLayout.place();
    const measured = window.ConsoleLayout.snapshot();
    if (!measured) return false;
    const layoutKey = [
      artworkRevision,
      measured.width,
      measured.height,
      ...[measured.reader, measured.stage, measured.displayStage].flatMap((r) => [
        r.left,
        r.top,
        r.width,
        r.height,
      ]),
    ].join(',');
    if (layoutKey === lastLayoutKey) return true;
    lastLayoutKey = layoutKey;
    performance.mark('hybrid-layout-start-' + revision);
    const sideDisplays = window.ConsoleLayout.measure(measured.reader).sideDisplays;
    layout = window.HybridLayout.solve(measured, art, sideDisplays, folds);
    revision++;
    const r = layout.center,
      g = layout.glass;
    Object.assign(document.querySelector('.reading-device').style, {
      left: '0px',
      top: '0px',
      bottom: 'auto',
      width: r.width + 'px',
      height: r.height + 'px',
      transformOrigin: '0 0',
      transform: window.HybridLayout.matrix(
        [
          [-art.models.center.nominalWidth / 2, art.models.center.nominalHeight, 0],
          [art.models.center.nominalWidth / 2, art.models.center.nominalHeight, 0],
          [art.models.center.nominalWidth / 2, 0, 0],
          [-art.models.center.nominalWidth / 2, 0, 0],
        ].map((p) => layout.point('center', p, layout.scale)),
        r.width,
        r.height,
      ),
    });
    Object.assign(dom('center-screen').style, {
      inset: 'auto',
      left: g.left + 'px',
      top: g.top + 'px',
      width: g.width + 'px',
      height: g.height + 'px',
    });
    dom('center-screen').dataset.projectedCorners = JSON.stringify([
      [r.left + g.left, r.top + g.top],
      [r.left + g.left + g.width, r.top + g.top],
      [r.left + g.left + g.width, r.top + g.top + g.height],
      [r.left + g.left, r.top + g.top + g.height],
    ]);
    for (const name of ['center', 'glass'])
      mapRect(surfaces[name], {
        left: r.left - 2,
        top: r.top - 2,
        width: r.width + 4,
        height: r.height + 4,
      });
    for (const name of ['left', 'right']) {
      surfaces[name].hidden = !sideDisplays;
      const m = art.models[name],
        b = m.bounds,
        points = [];
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
          for (const z of [b.min[2], b.max[2]])
            points.push(layout.point(name, [x, y, z], layout.scale, folds[name]));
      if (folds[name]) {
        const bounds = (points) => {
            const xs = points.map((p) => p[0]),
              ys = points.map((p) => p[1]);
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          },
          dest = bounds(points),
          geometry = assets.geometry?.boxes[name] ? assets.geometry : assets.sideGeometry;
        let box = dest;
        if (geometry?.stage) {
          const [width, height] = geometry.sourceViewport,
            source = window.HybridLayout.solve(
              { reader: geometry.reader, width, height, stage: geometry.stage },
              art,
              true,
              folds,
            ),
            sourcePoints = [];
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]])
                sourcePoints.push(source.point(name, [x, y, z], source.scale, folds[name]));
          const reference = bounds(sourcePoints),
            crop = geometry.boxes[name],
            sx = (dest[2] - dest[0]) / (reference[2] - reference[0]),
            sy = (dest[3] - dest[1]) / (reference[3] - reference[1]);
          box = [
            dest[0] + (crop[0] - reference[0]) * sx,
            dest[1] + (crop[1] - reference[1]) * sy,
            dest[0] + (crop[2] - reference[0]) * sx,
            dest[1] + (crop[3] - reference[1]) * sy,
          ];
        }
        mapRect(surfaces[name], {
          left: box[0],
          top: box[1],
          width: box[2] - box[0],
          height: box[3] - box[1],
        });
      } else {
        // The export's homography is normalized to the optical aperture, not
        // the larger nominal housing. Use the same coordinates in both paths.
        const pad = art.layers.right.pad,
          g = m.contentQuad,
          gw = g[1][0] - g[0][0],
          gh = g[0][1] - g[3][1],
          body = [
            [g[0][0] - gw * pad, g[0][1] + gh * pad, g[0][2]],
            [g[1][0] + gw * pad, g[1][1] + gh * pad, g[1][2]],
            [g[2][0] + gw * pad, g[2][1] - gh * pad, g[2][2]],
            [g[3][0] - gw * pad, g[3][1] - gh * pad, g[3][2]],
          ].map((p) => layout.point(name, p, layout.scale, folds[name]));
        Object.assign(surfaces[name].style, {
          left: '0px',
          top: '0px',
          width: '800px',
          height: '800px',
          transform: window.HybridLayout.matrix(body, 800, 800),
        });
      }
      const el = dom('side-' + name),
        side = layout.sides[name],
        responsive = layout.portrait > 0;
      el.toggleAttribute('data-responsive', responsive);
      el.toggleAttribute('data-brief', responsive && side.width < 116);
      el.style.width = responsive ? side.width + 'px' : '';
      el.style.height = responsive ? side.height + 'px' : '';
      el.style.transform = window.HybridLayout.matrix(
        side.glass,
        el.offsetWidth,
        el.offsetHeight,
        measured.displayStage,
      );
      el.style.visibility = 'visible';
    }
    surfaces.mounts.hidden = true;
    mountComposite.hidden = !sideDisplays;
    if (assets.cabin) paint(measured);
    if (assets.center && assets.glass) {
      const raster = window.ConsoleLayout.hardwareRaster(
          measured.width,
          measured.height,
          r,
          devicePixelRatio,
        ),
        cropTop = raster.top,
        height = raster.height;
      centerComposite.width = raster.width;
      centerComposite.height = raster.pixelsHeight;
      Object.assign(centerComposite.style, {
        left: '0px',
        top: cropTop + 'px',
        width: measured.width + 'px',
        height: height + 'px',
      });
      // WebGL floors its backing-store dimensions. Match those actual pixel
      // scales rather than the nominal DPR, especially on tall tablet layouts.
      const pixelX = raster.width / measured.width,
        pixelY = raster.pixelsHeight / height;
      const ctx = centerComposite.getContext('2d');
      ctx.setTransform(pixelX, 0, 0, pixelY, 0, -cropTop * pixelY);
      if (art.speed.rawShadow) {
        shadow.width = raster.width;
        shadow.height = raster.pixelsHeight;
        Object.assign(shadow.style, {
          inset: 'auto',
          left: '0px',
          top: cropTop + 'px',
          width: measured.width + 'px',
          height: height + 'px',
        });
        const ctx = shadow.getContext('2d');
        ctx.setTransform(pixelX, 0, 0, pixelY, 0, -cropTop * pixelY);
        if (assets.receiver && deskShadow) {
          try {
            // Composite WebGL directly. A copy through 2D forces synchronous
            // GPU readback, especially costly on software renderers.
            const canvas = deskShadow.render(assets.receiver, assets.cabin, measured, layout, art);
            if (!canvas.isConnected) layer.insertBefore(canvas, shadow);
            Object.assign(canvas.style, {
              position: 'absolute',
              left: '0px',
              top: cropTop + 'px',
              width: measured.width + 'px',
              height: height + 'px',
              pointerEvents: 'none',
            });
            const holes = [
              art.models.center.contentQuad.map((p) => layout.point('center', p, layout.scale)),
              ...(sideDisplays ? ['left', 'right'].map((name) => layout.sides[name].glass) : []),
            ];
            const outline = `M0 0H${measured.width}V${height}H0Z`;
            canvas.style.clipPath = `path(evenodd, "${outline}${holes
              .map(
                (quad) =>
                  quad.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y - cropTop}`).join('') + 'Z',
              )
              .join('')}")`;
          } catch (error) {
            console.warn('Initial desk projection unavailable', error);
            assets.receiver = null;
            deskShadow?.dispose();
            deskShadow = null;
          }
        }
        if (!assets.receiver || !deskShadow) {
          const ref = art.speed.shadowGeometry?.[currentVariant] || assets.geometry,
            from = window.ConsoleLayout.cabin(ref.stage),
            to = window.ConsoleLayout.cabin(measured.stage),
            ratio = ref.captureRatio;
          const sourceX = Math.floor(ref.sourceViewport[0] * ratio) / ref.sourceViewport[0],
            sourceHeight = ref.sourceViewport[1] - ref.cropTop,
            sourceY = Math.floor(sourceHeight * ratio) / sourceHeight;
          for (let row = 0; row < 3; row++)
            for (let col = 0; col < 3; col++) {
              const sx = from.x[col] * sourceX,
                sy = (ref.stage.top + from.y[row] - ref.cropTop) * sourceY,
                sw = (from.x[col + 1] - from.x[col]) * sourceX,
                sh = (from.y[row + 1] - from.y[row]) * sourceY;
              ctx.drawImage(
                assets.shadow,
                sx,
                sy,
                sw,
                sh,
                measured.stage.left + to.x[col],
                measured.stage.top + to.y[row],
                to.x[col + 1] - to.x[col],
                to.y[row + 1] - to.y[row],
              );
            }
        }
        // Housings occlude this lower layer with their real alpha silhouettes.
        // Only the transparent HTML apertures need an explicit cutout.
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        const quads = [
          art.models.center.contentQuad.map((p) => layout.point('center', p, layout.scale)),
          ...(sideDisplays ? ['left', 'right'].map((name) => layout.sides[name].glass) : []),
        ];
        for (const quad of quads) {
          ctx.beginPath();
          quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      const geometry = assets.centerGeometry || assets.geometry,
        source = geometry.reader,
        ratio = geometry.captureRatio,
        cut = geometry.cropTop;
      const sourcePixelX =
          Math.floor(geometry.sourceViewport[0] * ratio) / geometry.sourceViewport[0],
        sourceHeight = geometry.sourceViewport[1] - cut,
        sourcePixelY = Math.floor(sourceHeight * ratio) / sourceHeight;
      const box = geometry.boxes.center || [
          Math.round((source.left - 2) * ratio) / sourcePixelX,
          Math.round((source.top - 2 - cut) * ratio) / sourcePixelY + cut,
          Math.round((source.right + 2) * ratio) / sourcePixelX,
          Math.round((source.bottom + 2 - cut) * ratio) / sourcePixelY + cut,
        ],
        sx = r.width / source.width,
        sy = r.height / source.height;
      for (const name of ['center', 'glass'])
        ctx.drawImage(
          assets[name],
          r.left + (box[0] - source.left) * sx,
          r.top + (box[1] - source.top) * sy,
          (box[2] - box[0]) * sx,
          (box[3] - box[1]) * sy,
        );
      if (sideDisplays && assets.mounts) {
        mountComposite.width = raster.width;
        mountComposite.height = raster.pixelsHeight;
        Object.assign(mountComposite.style, {
          left: '0px',
          top: cropTop + 'px',
          width: measured.width + 'px',
          height: height + 'px',
        });
        const mountCtx = mountComposite.getContext('2d');
        mountCtx.setTransform(pixelX, 0, 0, pixelY, 0, -cropTop * pixelY);
        const mg = assets.geometry?.boxes.mounts ? assets.geometry : assets.sideGeometry,
          box = mg.boxes.mounts,
          source = mg.reader;
        const sourceScale = window.HybridLayout.solve(
          {
            reader: source,
            width: mg.sourceViewport[0],
            height: mg.sourceViewport[1],
            stage: mg.stage,
          },
          art,
          true,
        ).scaleY;
        const sourceH = art.models.left.nominalHeight * sourceScale,
          targetH = art.models.left.nominalHeight * layout.scaleY;
        const image = assets.mounts,
          kx = image.width / (box[2] - box[0]),
          ky = image.height / (box[3] - box[1]);
        // Four fixed-diameter barrels. Their spacing follows the display height;
        // the hardware itself must not stretch with the whole assembly rectangle.
        for (const side of [-1, 1])
          for (const fraction of [0.25, 0.72]) {
            const sy = source.bottom - 5 - sourceH * fraction,
              dy = r.top + r.height - 5 - targetH * fraction;
            const sx = source.left + source.width / 2 + side * (source.width / 2 + 7),
              dx = r.left + r.width / 2 + side * (r.width / 2 + 7);
            const sh = Math.max(10, sourceH * 0.1) * 1.6 + 2,
              dh = Math.max(10, targetH * 0.1) * 1.6 + 2;
            const left = Math.max(box[0], sx - 6),
              right = Math.min(box[2], sx + 6),
              top = Math.max(box[1], sy - sh / 2),
              bottom = Math.min(box[3], sy + sh / 2);
            if (right > left && bottom > top)
              ((folds.left && side < 0) || (folds.right && side > 0) ? mountCtx : ctx).drawImage(
                image,
                (left - box[0]) * kx,
                (top - box[1]) * ky,
                (right - left) * kx,
                (bottom - top) * ky,
                dx + left - sx,
                dy + ((top - sy) * dh) / sh,
                right - left,
                ((bottom - top) * dh) / sh,
              );
          }
        mountCtx.save();
        mountCtx.globalCompositeOperation = 'destination-out';
        for (const side of ['left', 'right']) {
          const quad = layout.sides[side].glass;
          mountCtx.beginPath();
          quad.forEach(([x, y], i) => (i ? mountCtx.lineTo(x, y) : mountCtx.moveTo(x, y)));
          mountCtx.closePath();
          mountCtx.fill();
        }
        mountCtx.restore();
      }
    }
    earlyRead();
    performance.mark('hybrid-layout-end-' + (revision - 1));
    if (
      currentVariant &&
      (currentVariant !== variantFor() ||
        assets.centerVariant !== centerVariantFor() ||
        assets.spriteVariant !== spriteVariantFor())
    )
      refreshVariant();
    return true;
  }
  function occludeShadow(ctx, offset) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const name of [
      'center',
      ...(window.ConsoleLayout.measure(window.ConsoleLayout.snapshot().reader).sideDisplays
        ? ['left', 'right']
        : []),
    ]) {
      const b = art.models[name].bounds,
        points = [];
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
          for (const z of [b.min[2], b.max[2]])
            points.push(layout.point(name, [x, y, z], layout.scale, folds[name]));
      points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const half = (list) => {
        const out = [];
        for (const p of list) {
          while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
          out.push(p);
        }
        out.pop();
        return out;
      };
      const hull = [...half(points), ...half([...points].reverse())];
      ctx.beginPath();
      hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y - offset) : ctx.moveTo(x, y - offset)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  function paint(m) {
    const s = m.stage,
      density = window.ConsoleLayout.cabinDensity(
        s.width,
        s.height,
        devicePixelRatio,
        navigator.deviceMemory,
      ),
      c = window.ConsoleLayout.cabin(s);
    cabin.width = Math.ceil(s.width * density);
    cabin.height = Math.ceil(s.height * density);
    const ctx = cabin.getContext('2d');
    ctx.setTransform(cabin.width / s.width, 0, 0, cabin.height / s.height, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    c.paint(ctx, assets.cabin);
    if (assets.deckSeed) {
      if (!instruments) {
        performance.mark('hybrid-instruments-start');
        instruments = new window.ConsoleInstruments(dom('instruments'), { deferJourney: true });
        for (const group of instruments.ambientGroups)
          group.element.classList.add('hybrid-native-instruments');
        performance.mark('hybrid-instruments-ready');
      }
      if (instrumentSeed?.source !== assets.deckSeed) {
        instrumentSeed = document.createElement('canvas');
        instrumentSeed.width = 1600;
        instrumentSeed.height = 1000;
        instrumentSeed.source = assets.deckSeed;
        instrumentSeed.getContext('2d').drawImage(assets.deckSeed, 185, 739, 213, 40);
        window.CabinDetail.sampledColors ||= new WeakMap();
        window.CabinDetail.sampledColors.set(instrumentSeed, art.speed.instrumentColors);
      }
      if (assets.strip && !instruments.centralStrips.has(instrumentSeed)) {
        const strip = document.createElement('canvas');
        strip.width = 1236;
        strip.height = 120;
        strip.getContext('2d').drawImage(assets.strip, 0, 0, 1236, 120);
        instruments.centralStrips.set(instrumentSeed, strip);
      }
      instruments.resize();
      instruments.render(0, false, { base: instrumentSeed, next: instrumentSeed, mix: 0 });
    } else c.paint(ctx, assets.deck, [416, 720, 1184, 868]);
    const panel = window.ConsoleLayout.measure(m.reader).instrument;
    if (!instruments && panel.visible && assets.strip)
      for (const part of window.ConsoleLayout.strip(panel.width, panel.height))
        if (part.width > 0)
          ctx.drawImage(
            assets.strip,
            part.source * (assets.strip.naturalWidth / 618),
            0,
            part.span * (assets.strip.naturalWidth / 618),
            assets.strip.naturalHeight,
            panel.left - s.left + part.left,
            panel.top - s.top,
            part.width,
            panel.height,
          );
    shadow.width = Math.ceil(m.width * density);
    shadow.height = Math.ceil(m.height * density);
    const sc = shadow.getContext('2d');
    sc.setTransform(density, 0, 0, density, 0, s.top * density);
    sc.imageSmoothingQuality = 'high';
    if (!art.speed.rawShadow) c.paint(sc, assets.shadow);
    // The live renderer depth-tests the receiver behind opaque housings. Match
    // that occlusion in the isolated shadow layer, including the HTML aperture.
    if (!art.speed.rawShadow) occludeShadow(sc, s.top);
    const raster = window.ConsoleLayout.spaceRaster(m.width, m.height, devicePixelRatio);
    exterior.width = raster.width;
    exterior.height = raster.height;
    const ec = exterior.getContext('2d');
    ec.fillStyle = '#020610';
    ec.fillRect(0, 0, raster.width, raster.height);
    if (entryArt) {
      window.HybridEntryScene.paint(ec, entryChapter, assets, m, raster);
      return;
    }
    const {
      scale,
      offsetX: x,
      offsetY: y,
      visible: v,
    } = window.ConsoleLayout.spaceCamera(raster.width, raster.height);
    const cover = Math.max(1, (v.right - v.left) / 1600, (v.bottom - v.top) / 1000),
      sw = 1880 * cover,
      sh = 1175 * cover;
    ec.save();
    ec.translate(x, y);
    ec.scale(scale, scale);
    ec.globalAlpha = 0.8;
    ec.drawImage(assets.stars, (v.left + v.right - sw) / 2, (v.top + v.bottom - sh) / 2, sw, sh);
    ec.globalAlpha = 0.72;
    const size = 2400 * cover;
    ec.drawImage(assets.nearStars, 800 - size / 2, 238 - size / 2, size, size);
    ec.globalAlpha = 1;
    const earthHeight = (210 * assets.earth.height) / assets.earth.width;
    ec.drawImage(
      assets.earth,
      ...(assets.earthWorld || [1160 - 105, 260 - earthHeight / 2, 210, earthHeight]),
    );
    // passSprite's approved entry projection, shared camera and scalar position.
    const moonHeight = (2080 * assets.moon.height) / assets.moon.width;
    ec.drawImage(
      assets.moon,
      ...(assets.moonWorld || [310 - 1040, 1180 - moonHeight / 2, 2080, moonHeight]),
    );
    if (assets.moonInset) ec.drawImage(assets.moonInset, ...assets.moonInsetWorld);
    ec.restore();
  }
  const entrance = {
    get state() {
      return state === 'enhancement-failed' ? 'failed' : state;
    },
    get blocked() {
      return state !== 'ready';
    },
    beforeLayout() {},
    prepared() {},
    async reveal() {
      performance.mark('cockpit-first-frame');
    },
    complete() {
      if (state === 'enhancement-failed') return;
      const physical = window.HybridBoot.physical,
        live = window.ConsoleLayout.snapshot();
      if (
        !physical ||
        !live ||
        physical.width !== innerWidth ||
        physical.height !== innerHeight ||
        ['left', 'top', 'width', 'height'].some(
          (k) => Math.abs(physical.rect[k] - live.reader[k]) > 0.01,
        )
      ) {
        this.fail();
        return;
      }
      physical.publishDOM();
      state = 'ready';
      root.dataset.boot = 'ready';
      root.dataset.hybrid = 'interactive';
      dom('destinations').inert = false;
      for (const control of [
        dom('previous'),
        dom('next'),
        dom('tilt-grip'),
        dom('monitor-hit-left'),
        dom('monitor-hit-right'),
      ])
        control.inert = false;
      for (const card of document.querySelectorAll('.hybrid-side-card')) card.remove();
      deskShadow?.dispose();
      layer.remove();
      cabin.remove();
      exterior.remove();
      article.removeEventListener('scroll', earlyRead);
      viewportObserver.disconnect();
      for (const callback of readyCallbacks.splice(0)) callback();
      performance.mark('hybrid-3d-ready');
      performance.mark('cockpit-ready');
    },
    fail() {
      state = 'enhancement-failed';
      root.dataset.hybrid = state;
      root.dataset.boot = 'ready';
      dom('entrance').hidden = true;
      host.classList.add('physical-console');
      performance.mark('hybrid-enhancement-failed');
      void publishReadable();
    },
  };
  window.HybridBoot = {
    entrance,
    get instruments() {
      return instruments;
    },
    get deskShadow() {
      return deskShadow;
    },
    whenReady(callback) {
      if (state === 'ready') callback();
      else readyCallbacks.push(callback);
    },
    get revision() {
      return revision;
    },
    get layout() {
      return layout;
    },
  };
  window.CockpitEntrance = entrance;
  if (!entryArt)
    dom('side-right').innerHTML =
      '<div class="display-card side-card chapter-preview hybrid-side-card"><div class="preview-direction"><span>Next chapter</span><span>→</span></div><div class="preview-destination"><img class="hybrid-preview-image" alt="" /></div><strong class="preview-title"><span class="preview-title-full">Building products</span><span class="preview-title-brief">Products</span></strong><ul class="preview-topics"><li>Olly Olly\'s platform</li><li>CookUnity Smart Fridges</li></ul></div>';
  measure();
  const viewportObserver = new ResizeObserver(() => {
    if (state !== 'ready') measure();
  });
  for (const id of ['reading-layout', 'stage']) viewportObserver.observe(dom(id));
  window.addEventListener('resize', () => {
    if (state !== 'ready') measure();
  });
  async function loadVariant(variant, priority = 'high') {
    const centerVariant = centerVariantFor(),
      spriteVariant = spriteVariantFor();
    if (entryArt) return loadEntryVariant(variant, centerVariant, priority);
    const result = {
        geometry: art.speed.geometry?.[variant],
        centerGeometry: art.speed.geometry[centerVariant],
        centerVariant,
        spriteVariant,
        sideGeometry: variant === 'mobile' ? art.speed.geometry?.tablet : undefined,
      },
      files = {
        ...art.speed.variants[variant],
        center: art.speed.variants[centerVariant].center,
        glass: art.speed.variants[centerVariant].glass,
      };
    const initialLayout = window.ConsoleLayout.measure(window.ConsoleLayout.snapshot().reader);
    if (!initialLayout.sideDisplays)
      for (const name of ['left', 'right', 'mounts', 'preview']) delete files[name];
    if (initialLayout.instrument.visible === false) delete files.strip;
    for (const name of ['earth', 'moon']) {
      const sprite =
        art.speed.planetSprites?.[spriteVariant]?.[name]?.[
          devicePixelRatio > 1.25 ? 'high' : 'normal'
        ];
      if (sprite) {
        files[name] = sprite.file;
        result[name + 'World'] = sprite.world;
        if (sprite.inset) {
          files[name + 'Inset'] = sprite.inset.file;
          result[name + 'InsetWorld'] = sprite.inset.world;
        }
      }
    }
    const receiver = initialLayout.sideDisplays
      ? fetch('assets/displays/console-receiver.json')
          .then((r) => r.json())
          .then((data) => {
            result.receiver = data;
          })
          .catch(() => {})
      : Promise.resolve();
    await Promise.all(
      Object.entries(files).map(async ([name, file]) => {
        performance.mark('hybrid-image-' + name + '-start');
        const image = new Image();
        image.decoding = 'async';
        image.fetchPriority = priority;
        image.src = (art.speed.directory || 'assets/hybrid-speed/') + file;
        await image.decode();
        result[name] = image;
        performance.mark('hybrid-image-' + name + '-decoded');
      }),
    );
    await receiver;
    if (art.speed.proceduralStars) {
      performance.mark('hybrid-stars-start');
      result.stars = window.ObservatoryArt.prepare(
        'stars',
        result.stars,
        undefined,
        art.speed.starsCrop?.[variant],
        result.starInset,
        art.speed.starsInset?.[variant],
      );
      result.nearStars = assets.nearStars || window.ObservatoryArt.foregroundStars();
      performance.mark('hybrid-stars-ready');
    }
    return result;
  }
  async function loadEntryVariant(variant, centerVariant, priority) {
    const sideDisplays = window.ConsoleLayout.measure(
      window.ConsoleLayout.snapshot().reader,
    ).sideDisplays;
    const sideVariant = variant === 'mobile' ? 'tablet' : variant;
    const common = art.speed.variants[variant],
      own = entryArt.variants[variant];
    const result = {
      geometry: entryArt.geometry[variant],
      centerGeometry: entryArt.geometry[centerVariant],
      centerVariant,
      spriteVariant: variant,
      sideGeometry: entryArt.geometry[sideVariant],
    };
    const files = {
      ...own,
      center: entryArt.variants[centerVariant].center,
      glass: entryArt.variants[centerVariant].glass,
    };
    if (sideDisplays)
      for (const name of ['left', 'right', 'mounts'])
        files[name] = entryArt.variants[sideVariant][name];
    else
      for (const name of ['left', 'right', 'mounts', 'previewleft', 'previewright'])
        delete files[name];
    if (!window.ConsoleLayout.measure(window.ConsoleLayout.snapshot().reader).instrument.visible)
      delete files.strip;
    const jobs = Object.entries(files).map(([name, file]) => [name, entryArt.directory + file]);
    for (const name of ['stars', 'starInset'])
      if (common[name]) jobs.push([name, art.speed.directory + common[name]]);
    if (sideDisplays) jobs.push(['receiver', 'assets/displays/console-receiver.json']);
    await Promise.all(
      jobs.map(async ([name, url]) => {
        if (name === 'receiver') {
          try {
            result.receiver = await fetch(url).then((r) => {
              if (!r.ok) throw Error('Receiver unavailable');
              return r.json();
            });
          } catch {
            /* A missing receiver uses the captured shadow fallback. */
          }
          return;
        }
        const image = new Image();
        image.decoding = 'async';
        image.fetchPriority = priority;
        image.src = url;
        await image.decode();
        result[name] = image;
      }),
    );
    result.stars = window.ObservatoryArt.prepare(
      'stars',
      result.stars,
      undefined,
      art.speed.starsCrop?.[variant],
      result.starInset,
      art.speed.starsInset?.[variant],
    );
    result.nearStars = assets.nearStars || window.ObservatoryArt.foregroundStars();
    return result;
  }
  function applyAssets(result) {
    assets = result;
    artworkRevision++;
    for (const name in surfaces) if (assets[name]) surfaces[name].src = assets[name].src;
    for (const side of ['left', 'right']) {
      const preview = dom('side-' + side).querySelector('.hybrid-preview-image'),
        image = assets['preview' + side] || (side === 'right' ? assets.preview : null);
      if (preview && image) preview.src = image.src;
    }
  }
  async function refreshVariant() {
    const next = variantFor(),
      key = [next, centerVariantFor(), spriteVariantFor()].join(':');
    if (pendingVariant === key) return;
    pendingVariant = key;
    try {
      const result = await loadVariant(next, 'low');
      if (state === 'ready' || next !== variantFor()) return;
      await deskShadow?.preparePlate(result.cabin);
      if (state === 'ready' || next !== variantFor()) return;
      currentVariant = next;
      applyAssets(result);
      measure();
    } catch (error) {
      console.warn('Responsive first-view variant unavailable', error);
    } finally {
      if (pendingVariant === key) pendingVariant = null;
    }
  }
  async function warmSideLayers() {
    if (entryArt) return;
    if (assets.left) return;
    try {
      const files = art.speed.variants.tablet;
      const entries = await Promise.all(
        ['left', 'right', 'mounts', 'strip'].map(async (name) => {
          const image = new Image();
          image.decoding = 'async';
          image.fetchPriority = 'low';
          image.src = (art.speed.directory || 'assets/hybrid-speed/') + files[name];
          await image.decode();
          return [name, image];
        }),
      );
      if (state === 'ready' || assets.left) return;
      assets.sideGeometry = art.speed.geometry?.tablet;
      for (const [name, image] of entries) {
        assets[name] = image;
        if (surfaces[name]) surfaces[name].src = image.src;
      }
      artworkRevision++;
      measure();
    } catch (error) {
      console.warn('Deferred side artwork unavailable', error);
    }
  }
  async function warmPreview() {
    if (entryArt) return;
    if (assets.preview) return;
    try {
      const image = new Image();
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.src =
        (art.speed.directory || 'assets/hybrid-speed/') + art.speed.variants.tablet.preview;
      await image.decode();
      if (state === 'ready') return;
      assets.preview = image;
      const preview = dom('side-right').querySelector('.hybrid-preview-image');
      if (preview) preview.src = image.src;
    } catch (error) {
      console.warn('Deferred preview photograph unavailable', error);
    }
  }
  const initialVariant = variantFor();
  const deskReady = art.speed.rawShadow
    ? window.HybridDeskShadow.create().catch((error) => {
        console.warn('Initial desk shader unavailable; using captured shadows', error);
        return null;
      })
    : Promise.resolve(null);
  loadVariant(initialVariant)
    .then(async (result) => {
      deskShadow = await deskReady;
      await deskShadow?.preparePlate(result.cabin);
      currentVariant = initialVariant;
      applyAssets(result);
      if (!entryArt)
        dom('side-right').querySelector('img').src = (assets.preview || assets.earth).src;
      measure();
      // Avoid carrying the desk's queued GPU work into renderer creation, where
      // synchronous driver queries would otherwise block reading and input.
      await deskShadow?.settled();
      root.dataset.hybrid = 'first-view';
      root.dataset.boot = 'ready';
      dom('entrance').hidden = true;
      await publishReadable();
      // RAF continuations still run before paint. Let the browser present the
      // complete first view before starting optional artwork/3D preparation.
      // A bounded idle task keeps enhancement automatic on busy devices too.
      await new Promise((resolve) => {
        if (window.requestIdleCallback) requestIdleCallback(resolve, { timeout: 1000 });
        else setTimeout(resolve, 0);
      });
      warmSideLayers();
      warmPreview();
      if (mode === 'firstview' || mode === 'failure') {
        if (mode === 'failure') entrance.fail();
        return;
      }
      root.dataset.hybrid = 'preparing';
      performance.mark('hybrid-enhancement-start');
      loadScript('hybrid-enhancement.js').catch(() => entrance.fail());
    })
    .catch((error) => {
      console.error('First-view export unavailable', error);
      entrance.fail();
    });
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }
})();
