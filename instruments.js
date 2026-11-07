'use strict';

// Journey lights follow its reversible coordinate. Quiet idle lights use small
// prepainted compositor layers, without waking the scene's render clock.
window.ConsoleInstruments = class {
  constructor(canvas, { deferJourney = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.deckPatches = new WeakMap();
    this.centralStrips = new WeakMap();
    this.glows = new Map();
    this.orbitTrails = new Map();
    this.geometry = window.CabinDetail.geometry();
    this.bankBackgrounds = new WeakMap();
    for (const [color, size] of [
      ['#a8fff0', 2.6],
      ['#9de9ff', 3],
      ['#ffc68c', 2.2],
    ])
      this.glow(color, size);
    this.meterGlow = document.createElement('canvas');
    this.meterGlow.width = 40;
    this.meterGlow.height = 40;
    const c = this.meterGlow.getContext('2d');
    c.fillStyle = '#b6fff5';
    c.shadowColor = '#65e9ed';
    c.shadowBlur = 5;
    c.fillRect(17, 17, 5.4, 4.4);
    if (!deferJourney) this.prepareJourney();
    this.makeAmbient();
    this.resize();
  }
  prepareJourney() {
    if (this.journeyPrepared) return;
    this.journeyPrepared = true;
    for (const track of this.geometry.tracks) this.makeOrbitTrail(track);
    this.makeMeters();
  }
  makeAmbient() {
    this.ambientAnimations = [];
    this.ambientProgress = 0;
    const group = (x, y, width, height) => {
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      Object.assign(element.style, {
        position: 'absolute',
        width: `${width}px`,
        height: `${height}px`,
        transformOrigin: '0 0',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: '3',
        opacity: '0',
        mixBlendMode: 'screen',
      });
      this.canvas.parentElement.appendChild(element);
      return { element, x, y, width, height, from: 0, target: 0 };
    };
    const left = group(61, 824, 367, 130),
      right = group(1174, 825, 373, 130);
    this.ambientGroups = [left, right];
    const surface = (parent, x, y, width, height, paint) => {
      const canvas = document.createElement('canvas'),
        density = 1.25;
      canvas.width = Math.ceil(width * density);
      canvas.height = Math.ceil(height * density);
      // Override the stage-wide full-size canvas rule only on these small lights.
      Object.assign(canvas.style, {
        position: 'absolute',
        inset: 'auto',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
        mixBlendMode: 'screen',
      });
      const context = canvas.getContext('2d');
      context.scale(density, density);
      paint(context);
      parent.appendChild(canvas);
      return canvas;
    };
    const animate = (element, keyframes, duration, phase = 0) => {
      if (!element.animate) return;
      const animation = element.animate(keyframes, {
        duration,
        iterations: Infinity,
        easing: 'linear',
      });
      animation.pause();
      animation.currentTime = duration * phase;
      this.ambientAnimations.push(animation);
    };
    for (const track of this.geometry.tracks) {
      const target = this.ambientGroups[track.bank],
        canvas = surface(target.element, 0, 0, 64, 64, (c) => {
          c.globalAlpha = 0.5;
          c.drawImage(this.glow(track.color, track.size), 0, 0);
        });
      // Precomputed transforms follow the very same curves as the crisp plot.
      // WAAPI moves a tiny immutable light; no idle JavaScript drawing occurs.
      const points = track.reverse ? [...track.points].reverse() : track.points;
      const keyframes = [...points, points[0]].map(([x, y]) => ({
        transform: `translate(${x - target.x - 32}px,${y - target.y - 32}px)`,
      }));
      animate(canvas, keyframes, track.duration, track.phase);
    }
    for (let row = 0; row < this.geometry.meters.length; row++) {
      const { x, y, skew } = this.geometry.meters[row];
      const canvas = surface(left.element, x - left.x - 30, y - left.y - 24, 132, 58, (c) => {
        c.translate(30, 24);
        c.transform(1, 0, skew, 1, 0, 0);
        for (let segment = 0; segment < 8; segment++) {
          c.globalAlpha = 0.65 - 0.035 * segment;
          c.drawImage(this.meterGlow, segment * 9.7 - 17, -19.5);
        }
      });
      animate(
        canvas,
        [{ opacity: 0.12 }, { opacity: 0.4, offset: 0.5 }, { opacity: 0.12 }],
        6800 + row * 1300,
        row * 0.27,
      );
    }
    this.ambientObserver = new MutationObserver(() => this.syncAmbient());
    this.ambientObserver.observe(this.canvas.parentElement, {
      attributes: true,
      attributeFilter: ['data-moving', 'data-ready'],
    });
    this.ambientObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-boot'],
    });
    this.visibilityListener = () => this.syncAmbient();
    document.addEventListener('visibilitychange', this.visibilityListener);
    window.CockpitMotion.addEventListener('change', this.visibilityListener);
    this.syncAmbient();
  }
  dispose() {
    this.ambientObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.visibilityListener);
    window.CockpitMotion.removeEventListener('change', this.visibilityListener);
    for (const animation of this.ambientAnimations) animation.cancel();
    for (const group of this.ambientGroups) {
      group.fade?.cancel();
      group.element.remove();
    }
  }
  syncAmbient() {
    const hidden = document.hidden,
      boot = document.documentElement.dataset.boot;
    const enabled =
      !window.CockpitMotion.matches &&
      !hidden &&
      (!boot || boot === 'ready') &&
      !this.ambientReduced &&
      this.canvas.parentElement.dataset.moving !== 'true' &&
      Math.abs(this.ambientProgress - Math.round(this.ambientProgress)) < 0.000001;
    if (this.ambientEnabled === enabled && this.ambientHidden === hidden) return;
    this.ambientEnabled = enabled;
    this.ambientHidden = hidden;
    for (const animation of this.ambientAnimations) enabled ? animation.play() : animation.pause();
    for (const group of this.ambientGroups) {
      const progress = group.fade?.effect.getComputedTiming().progress;
      const from =
        progress == null ? group.target : group.from + (group.target - group.from) * progress;
      group.fade?.cancel();
      group.fade = null;
      group.from = hidden ? 0 : from;
      group.target = enabled ? 1 : 0;
      group.element.style.opacity = String(group.target);
      if (
        !window.CockpitMotion.matches &&
        !hidden &&
        Math.abs(group.from - group.target) > 0.001 &&
        group.element.animate
      )
        group.fade = group.element.animate([{ opacity: group.from }, { opacity: group.target }], {
          duration: enabled ? 650 : 180,
          easing: 'ease-in-out',
        });
    }
  }
  glow(color, size) {
    const key = color + size;
    if (this.glows.has(key)) return this.glows.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const c = canvas.getContext('2d');
    c.fillStyle = color;
    c.shadowColor = color;
    c.shadowBlur = 9;
    c.beginPath();
    c.arc(32, 32, size, 0, Math.PI * 2);
    c.fill();
    this.glows.set(key, canvas);
    return canvas;
  }
  atlas(count, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width * 16;
    canvas.height = height * Math.ceil(count / 16);
    return { canvas, ctx: canvas.getContext('2d'), count, width, height, frames: [] };
  }
  makeOrbitTrail(track) {
    const points = track.points,
      count = 128,
      frames = [];
    let width = 0,
      height = 0;
    for (let i = 0; i < count; i++) {
      const segment = Array.from(
        { length: 25 },
        (_, n) => points[(i * 2 - n + points.length) % points.length],
      );
      const xs = segment.map((p) => p[0]),
        ys = segment.map((p) => p[1]);
      const x = Math.floor(Math.min(...xs)) - 3,
        y = Math.floor(Math.min(...ys)) - 3;
      width = Math.max(width, Math.ceil(Math.max(...xs)) - x + 3);
      height = Math.max(height, Math.ceil(Math.max(...ys)) - y + 3);
      frames.push({ x, y, segment });
    }
    const atlas = this.atlas(count, width, height),
      c = atlas.ctx;
    c.strokeStyle = track.color;
    c.lineWidth = 1.4;
    for (let i = 0; i < count; i++) {
      const { x, y, segment } = frames[i],
        sx = (i % 16) * width,
        sy = Math.floor(i / 16) * height;
      atlas.frames.push({ x, y, sx, sy });
      c.save();
      c.translate(sx - x, sy - y);
      for (let n = 0; n < 24; n++) {
        c.globalAlpha = 0.32 * (1 - n / 24);
        c.beginPath();
        c.moveTo(...segment[n]);
        c.lineTo(...segment[n + 1]);
        c.stroke();
      }
      c.restore();
    }
    this.orbitTrails.set(track, atlas);
  }
  makeMeters() {
    const atlas = this.atlas(64, 166, 128),
      c = atlas.ctx;
    atlas.x = 245;
    atlas.y = 818;
    c.globalCompositeOperation = 'screen';
    for (let i = 0; i < atlas.count; i++) {
      const sx = (i % 16) * atlas.width,
        sy = Math.floor(i / 16) * atlas.height,
        phase = (i / atlas.count) * Math.PI * 2;
      atlas.frames.push({ x: atlas.x, y: atlas.y, sx, sy });
      c.save();
      c.translate(sx - atlas.x, sy - atlas.y);
      for (let row = 0; row < this.geometry.meters.length; row++) {
        const { x, y, skew } = this.geometry.meters[row];
        c.save();
        c.transform(1, 0, skew, 1, x, y);
        for (let segment = 0; segment < 8; segment++) {
          c.globalAlpha = (0.5 + 0.5 * Math.cos(phase - segment * 0.65 - row * 0.75)) * 0.65;
          c.drawImage(this.meterGlow, segment * 9.7 - 17, -19.5);
        }
        c.restore();
      }
      c.restore();
    }
    this.meters = atlas;
  }
  interpolated(atlas, angle, activity) {
    const phase = ((((angle / (Math.PI * 2)) % 1) + 1) % 1) * atlas.count,
      index = Math.floor(phase),
      mix = phase - index;
    const a = atlas.frames[index],
      b = atlas.frames[(index + 1) % atlas.count],
      c = this.ctx;
    // The faint trails crossfade directly from immutable atlas textures.
    // Repainting an intermediate canvas would force another GPU surface upload.
    c.globalAlpha = activity * (1 - mix);
    c.drawImage(
      atlas.canvas,
      a.sx,
      a.sy,
      atlas.width,
      atlas.height,
      a.x,
      a.y,
      atlas.width,
      atlas.height,
    );
    if (mix > 0.000001) {
      c.globalAlpha = activity * mix;
      c.drawImage(
        atlas.canvas,
        b.sx,
        b.sy,
        atlas.width,
        atlas.height,
        b.x,
        b.y,
        atlas.width,
        atlas.height,
      );
    }
  }
  orbit(track, angle, activity) {
    const c = this.ctx,
      phase = ((((angle / (Math.PI * 2)) % 1) + 1) % 1) * track.points.length,
      index = Math.floor(phase),
      mix = phase - index;
    const a = track.points[index],
      b = track.points[(index + 1) % track.points.length];
    this.interpolated(this.orbitTrails.get(track), angle, activity);
    c.globalAlpha = activity * 0.9;
    c.drawImage(
      this.glow(track.color, track.size),
      a[0] + (b[0] - a[0]) * mix - 32,
      a[1] + (b[1] - a[1]) * mix - 32,
    );
  }
  resize() {
    // Read the stationary plate, not this cropped canvas. Its own CSS bounds
    // deliberately cover only the deck pixels that the instruments can paint.
    const stage = this.canvas.parentElement.getBoundingClientRect(),
      reader = document.getElementById('reading-layout').getBoundingClientRect();
    // The cropped instrument surface can afford sharp native/supersampled edges
    // without raising the resolution of the much larger moving space renderer.
    const cabin = (this.cabin = window.ConsoleLayout.cabin(stage));
    const { left, top, width, height, visible } = window.ConsoleLayout.measure(reader).instrument;
    this.centralPanelVisible = visible;
    this.panel = { x: left - stage.left, y: top - stage.top, width, height };
    const panel = this.panel;
    this.region = {
      left: Math.max(0, Math.min(cabin.mapX(59), visible ? panel.x - 2 : Infinity)),
      top: Math.max(0, Math.min(cabin.mapY(719), visible ? panel.y - 2 : Infinity)),
      right: Math.min(
        stage.width,
        Math.max(cabin.mapX(1549), visible ? panel.x + panel.width + 2 : 0),
      ),
      bottom: Math.min(
        stage.height,
        Math.max(cabin.mapY(980), visible ? panel.y + panel.height + 2 : 0),
      ),
    };
    const region = this.region,
      cssWidth = region.right - region.left,
      cssHeight = region.bottom - region.top;
    this.density = Math.min(
      Math.max(window.devicePixelRatio || 1, 1.5),
      2,
      Math.sqrt(3000000 / (cssWidth * cssHeight)),
    );
    const bitmapWidth = Math.max(1, Math.ceil(cssWidth * this.density)),
      bitmapHeight = Math.max(1, Math.ceil(cssHeight * this.density));
    const layoutKey = [
      stage.width,
      stage.height,
      left,
      top,
      width,
      height,
      visible,
      this.density,
      panel.x,
      panel.y,
      panel.width,
      panel.height,
      region.left,
      region.top,
      region.right,
      region.bottom,
    ].join(',');
    if (
      layoutKey === this.layoutKey &&
      this.canvas.width === bitmapWidth &&
      this.canvas.height === bitmapHeight
    )
      return;
    this.layoutKey = layoutKey;
    Object.assign(this.canvas.style, {
      left: `${region.left}px`,
      top: `${region.top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${cssWidth}px`,
      height: `${cssHeight}px`,
    });
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    this.scaleX = this.width / (region.right - region.left);
    this.scaleY = this.height / (region.bottom - region.top);
    this.prepareBankArtwork();
    for (const group of this.ambientGroups)
      Object.assign(group.element.style, {
        left: `${cabin.mapX(group.x)}px`,
        top: `${cabin.mapY(group.y)}px`,
        transform: `scale(${cabin.scale})`,
      });
    Object.assign(this.canvas.dataset, {
      panelVisible: String(visible),
      panelX: left.toFixed(2),
      panelY: top.toFixed(2),
      panelWidth: width.toFixed(2),
      panelHeight: height.toFixed(2),
    });
    this.canvas.dataset.region = [region.left, region.top, region.right, region.bottom]
      .map((n) => n.toFixed(2))
      .join(',');
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.last = null;
  }
  prepare(images) {
    for (const image of images)
      if (image?.complete && image.naturalWidth) {
        this.deckPatch(image);
        this.centralStrip(image);
        this.bankBackground(image);
      }
    return this;
  }
  render(progress, reduced, lighting) {
    this.ambientProgress = progress;
    this.ambientReduced = !!reduced;
    this.syncAmbient();
    if (this.width !== this.canvas.width || this.height !== this.canvas.height) this.resize();
    const effectsReduced = !!window.CockpitFrame?.effectsReduced,
      now = window.CockpitFrame?.time || performance.now(),
      last = this.last;
    if (
      last?.progress === progress &&
      last.reduced === reduced &&
      last.base === lighting?.base &&
      last.next === lighting?.next &&
      last.mix === lighting?.mix &&
      last.effectsReduced === effectsReduced
    )
      return;
    // Only the decorative console overlay uses the adaptive paint budget.
    // Exact stops and lighting/layout changes are always painted immediately.
    const force =
      !last ||
      Number.isInteger(progress) ||
      last.base !== lighting?.base ||
      last.next !== lighting?.next ||
      last.reduced !== reduced ||
      last.effectsReduced !== effectsReduced;
    if (effectsReduced && !force && now - this.lastPaintTime < 1000 / 30) return;
    this.lastPaintTime = now;
    this.last = {
      progress,
      reduced,
      base: lighting?.base,
      next: lighting?.next,
      mix: lighting?.mix,
      effectsReduced,
    };
    const c = this.ctx,
      tau = Math.PI * 2;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
    c.setTransform(
      this.scaleX,
      0,
      0,
      this.scaleY,
      -this.region.left * this.scaleX,
      -this.region.top * this.scaleY,
    );
    // Only these small deck areas have pixels. Avoid invalidating a full-screen
    // transparent canvas for a few moving lights and the relocated center strip.
    const activity = reduced ? 0 : Math.pow(Math.max(0, Math.sin((progress % 1) * Math.PI)), 0.7);
    this.canvas.dataset.activity = activity.toFixed(4);
    this.canvas.dataset.phase = progress.toFixed(5);
    if (lighting) {
      this.renderCentralPanel(lighting);
      this.renderBanks(lighting);
    }
    if (activity < 0.002) return;
    this.prepareJourney();
    c.save();
    c.globalCompositeOperation = 'screen';
    const phase = progress * tau;
    this.setPlateTransform(173, 881);
    // A short sweep inside the left gauge, without drawing a second full ring.
    this.orbit(this.geometry.tracks[0], phase - 1.2, activity);
    // Broad, quiet brightness changes across the three existing meter rows.
    this.interpolated(this.meters, phase * 1.3, activity);
    this.setPlateTransform(1363, 882);
    c.save();
    c.clip(this.geometry.banks[1].path);
    this.orbit(this.geometry.tracks[1], phase * 0.8 + 0.8, activity);
    this.orbit(this.geometry.tracks[2], -phase * 0.65 - 1.3, activity);
    c.restore();
    c.restore();
  }
  setPlateTransform(x, y) {
    const { scale } = this.cabin;
    this.ctx.setTransform(
      this.scaleX * scale,
      0,
      0,
      this.scaleY * scale,
      (this.cabin.mapX(x) - x * scale - this.region.left) * this.scaleX,
      (this.cabin.mapY(y) - y * scale - this.region.top) * this.scaleY,
    );
  }
  prepareBankArtwork() {
    const density = Math.min(4, Math.max(1, this.cabin.scale * Math.max(this.scaleX, this.scaleY)));
    if (this.bankArtworkDensity === density) return;
    this.bankArtworkDensity = density;
    this.bankArtwork = this.geometry.banks.map((bank, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(bank.width * density);
      canvas.height = Math.ceil(bank.height * density);
      const c = canvas.getContext('2d');
      c.setTransform(
        canvas.width / bank.width,
        0,
        0,
        canvas.height / bank.height,
        (-bank.x * canvas.width) / bank.width,
        (-bank.y * canvas.height) / bank.height,
      );
      c.clip(bank.path);
      window.CabinDetail.bankArtwork(c, index);
      return canvas;
    });
  }
  bankBackground(image) {
    if (!this.bankBackgrounds.has(image))
      this.bankBackgrounds.set(
        image,
        this.geometry.banks.map((bank, index) => window.CabinDetail.background(image, bank, index)),
      );
    return this.bankBackgrounds.get(image);
  }
  renderBanks({ base, next, mix }) {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'source-over';
    for (let index = 0; index < this.geometry.banks.length; index++) {
      const bank = this.geometry.banks[index];
      c.save();
      this.setPlateTransform(bank.x, bank.y);
      c.clip(bank.path);
      for (const [image, alpha] of [
        [base, 1],
        [next, mix],
      ]) {
        if (!image || alpha <= 0) continue;
        c.globalAlpha = alpha;
        c.drawImage(this.bankBackground(image)[index], bank.x, bank.y, bank.width, bank.height);
      }
      c.globalAlpha = 1;
      c.drawImage(this.bankArtwork[index], bank.x, bank.y, bank.width, bank.height);
      c.restore();
    }
    c.restore();
  }
  renderCentralPanel({ base, next, mix }) {
    const c = this.ctx,
      { x, y, width, height } = this.panel;
    c.save();
    c.globalCompositeOperation = 'source-over';
    for (const [image, alpha] of [
      [base, 1],
      [next, mix],
    ]) {
      if (!image || alpha <= 0) continue;
      c.globalAlpha = alpha;
      // Move the actual Saturn / pyramid / target instrument housing forward.
      // Reuse a matching piece of the grey deck where that housing used to sit.
      this.cabin.paint(c, this.deckPatch(image), [416, 720, 1184, 868]);
      if (this.centralPanelVisible)
        for (const part of window.ConsoleLayout.strip(width, height)) {
          if (part.width > 0)
            c.drawImage(
              this.centralStrip(image),
              part.source * 2,
              0,
              part.span * 2,
              120,
              x + part.left,
              y,
              part.width,
              height,
            );
        }
    }
    c.restore();
  }
  centralStrip(image) {
    if (this.centralStrips.has(image)) return this.centralStrips.get(image);
    // Keep the decoded source crop resident, just like the matching deck patch.
    // Sampling the compressed plate during every frame can trigger image-cache
    // redecodes after an idle pause or a compositor raster-scale change.
    const strip = document.createElement('canvas');
    strip.width = 1236;
    strip.height = 120;
    const c = strip.getContext('2d');
    c.scale(2, 2);
    c.imageSmoothingQuality = 'high';
    c.drawImage(image, 491, 775, 618, 60, 0, 0, 618, 60);
    window.CabinDetail.strip(c);
    this.centralStrips.set(image, strip);
    return strip;
  }
  deckPatch(image) {
    if (this.deckPatches.has(image)) return this.deckPatches.get(image);
    const patch = document.createElement('canvas');
    patch.width = 768;
    patch.height = 148;
    const c = patch.getContext('2d');
    c.drawImage(image, 185, 739, 213, 40, 0, 0, 768, 148);
    // Keep a brushed finish in exposed areas, instead of magnifying the grain
    // of a tiny source crop by 3.6x. This texture is prepared once per cabin;
    // display-dependent reflections and shadows belong to the 3D receiver.
    c.save();
    c.globalCompositeOperation = 'soft-light';
    let seed = 1831;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let y = 0; y < 148; y++) {
      const tone = 118 + Math.floor(random() * 20);
      c.fillStyle = `rgba(${tone},${tone},${tone},.22)`;
      c.fillRect(0, y, 768, 1);
      for (let j = 0; j < 3; j++) {
        c.fillStyle = random() > 0.5 ? 'rgba(210,225,232,.055)' : 'rgba(28,44,53,.055)';
        c.fillRect(random() * 768, y, 18 + random() * 130, 1);
      }
    }
    c.restore();
    c.globalCompositeOperation = 'destination-in';
    const across = c.createLinearGradient(0, 0, 768, 0);
    across.addColorStop(0, 'transparent');
    across.addColorStop(0.035, 'white');
    across.addColorStop(0.965, 'white');
    across.addColorStop(1, 'transparent');
    c.fillStyle = across;
    c.fillRect(0, 0, 768, 148);
    const down = c.createLinearGradient(0, 0, 0, 148);
    down.addColorStop(0, 'white');
    down.addColorStop(0.8, 'white');
    down.addColorStop(1, 'transparent');
    c.fillStyle = down;
    c.fillRect(0, 0, 768, 148);
    this.deckPatches.set(image, patch);
    return patch;
  }
};
