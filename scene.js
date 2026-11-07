'use strict';
// Every visible position is a function of one reversible journey coordinate.
// No generated video, live 3D, random animation state or time-dependent cuts.
window.JourneyScene = class JourneyScene {
  static async create(canvas, assets) {
    const prepared = new Map();
    if (window.ArtworkPreparation)
      for (const name of JourneyScene.photoOrder)
        if (assets[name]) {
          const bitmap = await window.ArtworkPreparation.prepare(name, assets[name]);
          if (bitmap) prepared.set(name, bitmap);
          if (name === 'stars') {
            const near = await window.ArtworkPreparation.prepare('nearStars');
            if (near) prepared.set('nearStars', near);
          }
        }
    let scene;
    // Upload transferred pixels directly. Reconstruct the deterministic canvas
    // fallback only if the graphics context fails, avoiding an unused full-size
    // bitmap-to-canvas copy for every photograph during ordinary startup.
    try {
      scene = new JourneyScene(canvas, assets, prepared);
      for (const entry of scene.photos.values()) await scene.prepareUpload(entry);
      scene.initializeParticles();
      return scene;
    } catch (error) {
      scene?.dispose();
      throw error;
    } finally {
      for (const bitmap of prepared.values()) bitmap.close();
      if (scene) for (const entry of scene.photos.values()) scene.releaseUpload(entry);
    }
  }
  constructor(canvas, assets, prepared = new Map()) {
    this.preparedArtwork = prepared;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.assets = assets;
    this.points = new Map();
    this.photos = new Map();
    this.visiblePhotos = new Set();
    const parent = canvas.parentElement;
    Object.assign(parent.style, { overflow: 'hidden', background: '#020610' });
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      mixBlendMode: 'screen',
      pointerEvents: 'none',
      opacity: '0',
    });
    this.photoRoots = [1, 4].map((z) => {
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      Object.assign(element.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '1600px',
        height: '1000px',
        transformOrigin: '0 0',
        pointerEvents: 'none',
        zIndex: String(z),
      });
      parent.insertBefore(element, canvas);
      return element;
    });
    for (const name of JourneyScene.photoOrder) if (assets[name]) this.prepareArtwork(name);
    let seed = 31987;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this.streaks = Array.from({ length: 290 }, (_, i) => {
      const a = rand() * Math.PI * 2,
        r = 70 + rand() * 600,
        z = rand(),
        w = 0.45 + rand() * 1.8,
        c = rand(),
        layer = i % 4,
        retreatAngle = a + layer * 0.71;
      return {
        a,
        r,
        z,
        w,
        c,
        dx: Math.cos(a),
        dy: Math.sin(a) * 0.76,
        layer,
        rx: Math.cos(retreatAngle),
        ry: Math.sin(retreatAngle) * 0.72,
        radius: 1200 * Math.exp(z * 6),
      };
    });
    // Keep bright rays; thin only faint particles on a struggling device.
    // Every retained particle still follows the exact continuous travel path.
    this.lightStreaks = this.streaks.filter((star, i) => star.w > 1.7 || i % 3 === 0);
    for (const color of ['#ffd5b3', '#ffe6b1', '#8ee6e5'])
      this.addTexturePhoto('point' + color, this.pointTexture(color));
    this.systemBodies = [
      { x: -2000, y: -220, r: 42, a: '#9997df', b: '#252039' },
      { x: -1200, y: 650, r: 25, a: '#ecce9c', b: '#302439' },
      { x: 3100, y: 360, r: 35, a: '#b2c0df', b: '#29344e' },
    ];
    this.systemBodies.forEach((body, i) =>
      this.addTexturePhoto(
        'body' + i,
        this.makeTexture(64, 64, (c) => {
          const g = c.createRadialGradient(20.8, 20.8, 1.6, 32, 32, 32);
          g.addColorStop(0, body.a);
          g.addColorStop(0.65, body.b);
          g.addColorStop(1, '#080c17');
          c.fillStyle = g;
          c.beginPath();
          c.arc(32, 32, 32, 0, Math.PI * 2);
          c.fill();
        }),
      ),
    );
    this.lastProgress = null;
  }
  prepareFlight(leg) {
    if (leg !== 2 && leg !== 3) return Promise.resolve();
    // Both directions and rapid repeated clicks share one preparation promise.
    // Photos/stars stay live; navigation already waits for this leg's assets.
    this.flightPreparation ||= (async () => {
      // These soft lights never change shape. Rasterize them once rather than
      // rebuilding hundreds of Canvas gradients during a journey frame.
      this.warpTail = this.makeTexture(128, 8, (c) => {
        const g = c.createLinearGradient(0, 0, 128, 0);
        g.addColorStop(0, 'rgba(67,121,250,0)');
        g.addColorStop(0.6, 'rgba(124,179,255,.48)');
        g.addColorStop(1, '#def5ff');
        c.fillStyle = g;
        c.fillRect(0, 0, 128, 8);
      });
      this.retreatTail = this.makeTexture(128, 8, (c) => {
        const g = c.createLinearGradient(0, 0, 128, 0);
        g.addColorStop(0, 'rgba(91,169,215,0)');
        g.addColorStop(1, 'rgba(183,222,249,.7)');
        c.fillStyle = g;
        c.fillRect(0, 0, 128, 8);
      });
      // Complete radial light with a transparent perimeter: the wider camera can
      // expose its edges, so it must not be cropped to the old landscape viewport.
      this.haze = this.makeTexture(880, 880, (c) => {
        const g = c.createRadialGradient(440, 440, 2.5, 440, 440, 440);
        g.addColorStop(0, 'rgba(178,235,255,.28)');
        g.addColorStop(0.16, 'rgba(61,130,224,.22)');
        g.addColorStop(0.57, 'rgba(44,47,136,.16)');
        g.addColorStop(1, 'transparent');
        c.fillStyle = g;
        c.fillRect(0, 0, 880, 880);
      });

      if (this.particles?.available) {
        try {
          await this.particles.prepareFlight(this.streaks, {
            warp: this.warpTail,
            retreat: this.retreatTail,
            haze: this.haze,
          });
        } catch (error) {
          // All Canvas flight sources are ready, so a GPU failure preserves the
          // existing complete fallback rather than losing travel or the reader.
          console.warn('Flight GPU unavailable; using canvas lights.', error);
        }
      }
    })();
    return this.flightPreparation;
  }
  initializeParticles() {
    const canvas = this.canvas;
    if (window.JourneyParticles)
      try {
        this.particles = new window.JourneyParticles(
          canvas,
          () => {
            this.restoreCanvasArtwork();
            for (const root of this.photoRoots) root.style.display = '';
            const progress = this.lastProgress;
            this.lastProgress = null;
            this.effects = null;
            if (progress !== null) this.render(progress);
          },
          this.photos,
        );
        for (const root of this.photoRoots) root.style.display = 'none';
        this.releaseStarArtwork();
      } catch (error) {
        this.restoreCanvasArtwork();
        console.warn(
          'Space GPU unavailable; using the retained photograph and canvas fallback.',
          error,
        );
      }
    if (!this.particles?.available) this.restoreCanvasArtwork();
    this.resize();
  }
  async prepareUpload(entry) {
    if (entry.uploadBitmap || typeof createImageBitmap !== 'function') return;
    try {
      entry.uploadBitmap = await createImageBitmap(entry.element, {
        premultiplyAlpha: 'premultiply',
      });
    } catch {
      /* Retained canvas is the compatible upload source. */
    }
  }
  releaseUpload(entry) {
    entry.uploadBitmap?.close();
    entry.uploadBitmap = null;
  }
  async prepareArtworkAsync(name) {
    if (this.photos.has(name)) return;
    const bitmap = await window.ArtworkPreparation?.prepare(name, this.assets[name]);
    if (bitmap) this.preparedArtwork.set(name, bitmap);
    this.prepareArtwork(name);
    const entry = this.photos.get(name);
    if (!entry) return;
    if (!this.particles?.available) {
      this.restoreCanvasArtwork();
      this.releaseUpload(entry);
      return;
    }
    try {
      await this.prepareUpload(entry);
      this.uploadPhoto(name, entry);
    } finally {
      this.releaseUpload(entry);
    }
  }
  dispose() {
    // Particle disposal detaches its loss callback before releasing the context,
    // so abandoning startup cannot rebuild artwork for an already disposed scene.
    this.particles?.dispose();
    this.particles = null;
    for (const root of this.photoRoots) root.remove();
    for (const entry of this.photos.values()) this.releaseUpload(entry);
    this.photos.clear();
    this.visiblePhotos.clear();
  }

  releaseStarArtwork() {
    if (!this.particles?.available || !window.ObservatoryArt) return;
    // texImage2D has already copied these pixels into full-resolution textures.
    // Keep the DOM nodes and their layout, but release 14 MiB of hidden canvas
    // backing stores. Neither travel nor idle rendering needs these copies.
    for (const name of ['stars', 'nearStars']) {
      const entry = this.photos.get(name);
      if (!entry || entry.artworkReleased) continue;
      entry.element.width = 1;
      entry.element.height = 1;
      entry.artworkReleased = true;
    }
  }
  restoreCanvasArtwork() {
    // Graphics loss switches permanently to the existing canvas fallback.
    // Recreate released deterministic layers once before revealing the roots.
    // Constructor failures can use the still-live worker transfers directly.
    for (const [name, entry] of this.photos) {
      if (!entry.artworkReleased) continue;
      // A still-live transfer is the exact source during constructor failure.
      // Later loss regenerates the same painting from retained source images.
      const source =
        entry.uploadBitmap ||
        (name === 'nearStars'
          ? window.ObservatoryArt.foregroundStars()
          : window.ObservatoryArt.prepare(name, this.assets[name]));
      entry.element.width = entry.width;
      entry.element.height = entry.height;
      entry.element
        .getContext('2d', { alpha: true })
        .drawImage(source, 0, 0, entry.width, entry.height);
      if (
        source !== entry.uploadBitmap &&
        source !== this.assets[name] &&
        source.tagName === 'CANVAS'
      )
        source.width = source.height = 1;
      entry.artworkReleased = false;
    }
  }
  makeTexture(width, height, paint) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    paint(canvas.getContext('2d'));
    return canvas;
  }
  static photoOrder = [
    'stars',
    'nearStars',
    'localgroup-neighbors',
    'galaxy',
    'earth',
    'moon',
    'mars',
    'sun',
    'turquoise',
  ];
  prepareArtwork(name) {
    if (this.photos.has(name) || !JourneyScene.photoOrder.includes(name) || !this.assets[name])
      return;
    this.addPhoto(
      name,
      this.preparedArtwork.get(name) ||
        window.ObservatoryArt?.prepare(name, this.assets[name]) ||
        this.assets[name],
      ['stars', 'galaxy', 'localgroup-neighbors'].includes(name) ? 0 : 1,
    );
    if (name === 'stars' && window.ObservatoryArt)
      this.addPhoto(
        'nearStars',
        this.preparedArtwork.get('nearStars') || window.ObservatoryArt.foregroundStars(),
        0,
      );
    this.lastProgress = null;
  }
  addPhoto(name, image, layer = 1) {
    const width = image.naturalWidth || image.width,
      height = image.naturalHeight || image.height;
    // Retain decoded pixels, rather than a compressed image display item. A
    // scaled <img> can make Chromium decode the WebP repeatedly at new raster
    // scales. This surface is painted once at source resolution, then only its
    // compositor transform and opacity change throughout the journey.
    const transferred = typeof ImageBitmap === 'function' && image instanceof ImageBitmap;
    const element = image.tagName === 'CANVAS' ? image : document.createElement('canvas');
    if (element !== image) {
      element.width = transferred ? 1 : width;
      element.height = transferred ? 1 : height;
      if (!transferred)
        element.getContext('2d', { alpha: true }).drawImage(image, 0, 0, width, height);
    }
    element.setAttribute('aria-hidden', 'true');
    element.dataset.artwork = name;
    Object.assign(element.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${width}px`,
      height: `${height}px`,
      maxWidth: 'none',
      transformOrigin: '0 0',
      willChange: 'transform,opacity',
      opacity: '0',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    const order = JourneyScene.photoOrder.indexOf(name),
      entry = {
        element,
        width,
        height,
        layer,
        bounds: new Float32Array(4),
        alpha: 0,
        transform: '',
        opacity: '0',
        order: order < 0 ? 100 : order,
      };
    if (transferred) {
      entry.uploadBitmap = image;
      entry.artworkReleased = true;
      this.preparedArtwork.delete(name);
    }
    if (name === 'galaxy') {
      // Cache a small alpha mask once. Picking follows the visible spiral arms,
      // not the transparent rectangle around the galaxy, on either renderer.
      const w = 256,
        h = Math.max(1, Math.round((w * height) / width));
      const mask = document.createElement('canvas');
      mask.width = w;
      mask.height = h;
      const maskContext = mask.getContext('2d', { willReadFrequently: true });
      maskContext.drawImage(transferred ? image : element, 0, 0, w, h);
      entry.hitMask = maskContext.getImageData(0, 0, w, h);
      mask.width = mask.height = 1;
    }
    element.style.zIndex = String(entry.order);
    this.photoRoots[layer].appendChild(element);
    this.photos.set(name, entry);
  }
  uploadPhoto(name, entry) {
    if (this.particles?.available)
      try {
        this.particles.addPhoto(name, entry);
      } catch (error) {
        // A later allocation failure must not strand navigation with a partial GPU
        // scene. The complete retained photographs remain a compatible fallback.
        this.particles.dispose();
        this.particles = null;
        this.restoreCanvasArtwork();
        for (const root of this.photoRoots) root.style.display = '';
        this.lastProgress = null;
        this.effects = null;
        console.warn('Space texture unavailable; using the photograph fallback.', error);
      }
  }
  addTexturePhoto(name, texture) {
    this.addPhoto(name, texture);
  }
  photo(name, x, y, width, height, alpha = 1) {
    if (width < 0.3 || height < 0.3 || alpha < 0.001) return;
    const v = this.visible;
    if (x + width < v.left || x > v.right || y + height < v.top || y > v.bottom) return;
    const entry = this.photos.get(name);
    entry.bounds[0] = x;
    entry.bounds[1] = y;
    entry.bounds[2] = width;
    entry.bounds[3] = height;
    entry.alpha = alpha;
    if (this.particles?.available) {
      this.visiblePhotos.add(name);
      return;
    }
    const transform = `translate3d(${x}px,${y}px,0) scale(${width / entry.width},${height / entry.height})`,
      opacity = String(alpha);
    if (entry.transform !== transform) {
      entry.element.style.transform = transform;
      entry.transform = transform;
    }
    if (entry.opacity !== opacity) {
      entry.element.style.opacity = opacity;
      entry.opacity = opacity;
    }
    this.visiblePhotos.add(name);
  }
  finishPhotos() {
    if (this.particles?.available) return;
    for (const [name, entry] of this.photos)
      if (entry.opacity !== '0' && !this.visiblePhotos.has(name)) {
        entry.element.style.opacity = '0';
        entry.opacity = '0';
      }
  }
  pointTexture(color) {
    if (!this.points.has(color))
      this.points.set(
        color,
        this.makeTexture(64, 64, (c) => {
          const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
          g.addColorStop(0, color);
          g.addColorStop(0.2, color);
          g.addColorStop(1, 'transparent');
          c.fillStyle = g;
          c.fillRect(0, 0, 64, 64);
        }),
      );
    return this.points.get(color);
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(),
      layoutKey = [this.canvas.width, this.canvas.height, rect.width, rect.height].join(',');
    if (this.layoutKey === layoutKey) return;
    this.layoutKey = layoutKey;
    // Portrait needs a wider field of view, not a center crop of a landscape
    // planet texture. Keep the optical axis in the open windshield above the
    // reader. Every body and travel particle still shares this single camera.
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    // Fit inside both windshield dimensions. A tall phone must not magnify the
    // planets, and turning it sideways must not crop into them again.
    Object.assign(this, window.ConsoleLayout.spaceCamera(this.width, this.height));
    const density = this.width / rect.width,
      cssScale = this.scale / density,
      x = this.offsetX / density,
      y = this.offsetY / density;
    // Fit the final group's lowest major galaxy above the open reading display.
    // Measure once per layout, and contract the WHOLE composition about its core;
    // a narrow viewport must not rearrange the neighboring galaxies independently.
    const reader = window.ConsoleLayout?.snapshot()?.reader;
    const axisY = rect.top + y + 238 * cssScale,
      triangulumOffset = (((511 / 941 - 0.378) * 1760 * 941) / 1671) * cssScale;
    this.finalGroupFit = reader
      ? JourneyScene.clamp((reader.top - axisY - 22) / triangulumOffset, 0.45, 1)
      : 1;
    for (const root of this.photoRoots)
      root.style.transform = `translate3d(${x}px,${y}px,0) scale(${cssScale})`;
    if (this.particles?.available)
      this.particles.resize(this.width, this.height, this.scale, this.offsetX, this.offsetY);
    this.lastProgress = null;
  }
  hitsEarth(clientX, clientY) {
    if (!this.visiblePhotos.has('earth')) return false;
    // The current canvas rect includes idle exterior drift; backing-store density
    // and camera projection are identical on the GPU and retained-photo paths.
    const rect = this.canvas.getBoundingClientRect(),
      b = this.photos.get('earth').bounds;
    const x = (((clientX - rect.left) * this.width) / rect.width - this.offsetX) / this.scale;
    const y = (((clientY - rect.top) * this.height) / rect.height - this.offsetY) / this.scale;
    // Earth's disc fills 94% of its square artwork, excluding transparent corners.
    return (
      Math.hypot((x - b[0] - b[2] / 2) / (b[2] * 0.47), (y - b[1] - b[3] / 2) / (b[3] * 0.47)) <= 1
    );
  }
  hitsGalaxy(clientX, clientY) {
    const entry = this.photos.get('galaxy');
    if (!this.visiblePhotos.has('galaxy') || !entry?.hitMask) return false;
    const rect = this.canvas.getBoundingClientRect(),
      b = entry.bounds,
      mask = entry.hitMask;
    const x =
      ((((clientX - rect.left) * this.width) / rect.width - this.offsetX) / this.scale - b[0]) /
      b[2];
    const y =
      ((((clientY - rect.top) * this.height) / rect.height - this.offsetY) / this.scale - b[1]) /
      b[3];
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return false;
    return (
      mask.data[(Math.floor(y * mask.height) * mask.width + Math.floor(x * mask.width)) * 4 + 3] >=
      24
    );
  }
  baseTransform() {
    this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
  }
  visibleSegment(x0, y0, x, y, padding = 4) {
    const v = this.visible;
    return (
      Math.max(x0, x) + padding >= v.left &&
      Math.min(x0, x) - padding <= v.right &&
      Math.max(y0, y) + padding >= v.top &&
      Math.min(y0, y) - padding <= v.bottom
    );
  }
  streak(texture, x0, y0, x, y, width, alpha) {
    if (alpha < 0.001 || !this.visibleSegment(x0, y0, x, y, width)) return;
    const dx = x - x0,
      dy = y - y0,
      length = Math.hypot(dx, dy);
    if (length < 0.01) return;
    const ux = dx / length,
      uy = dy / length,
      c = this.ctx,
      s = this.scale;
    c.setTransform(ux * s, uy * s, -uy * s, ux * s, x0 * s + this.offsetX, y0 * s + this.offsetY);
    c.globalAlpha = alpha;
    c.drawImage(texture, 0, -width / 2, length, width);
  }
  static clamp(v, a = 0, b = 1) {
    return Math.min(b, Math.max(a, v));
  }
  static smooth(v) {
    v = this.clamp(v);
    return v * v * (3 - 2 * v);
  }
  static lerp(a, b, t) {
    return a + (b - a) * t;
  }
  static get galaxyReadWidth() {
    return 1380;
  }
  // The local FTL clock begins only after Mars has passed the camera. The
  // particle renderer, Canvas fallback and star exposure use this same clock.
  static warpTime(t) {
    return this.clamp((t - 0.42) / 0.58);
  }
  static curve(keys, t) {
    let j = 0;
    while (j < keys.length - 2 && t > keys[j + 1][0]) j++;
    const a = keys[j],
      b = keys[j + 1],
      h = b[0] - a[0],
      u = this.clamp((t - a[0]) / h);
    return a.slice(1).map((_, n) => {
      const k = n + 1;
      const slope = (i) => {
        if (i === 0) return (keys[1][k] - keys[0][k]) / (keys[1][0] - keys[0][0]);
        if (i === keys.length - 1)
          return (keys[i][k] - keys[i - 1][k]) / (keys[i][0] - keys[i - 1][0]);
        const p = (keys[i][k] - keys[i - 1][k]) / (keys[i][0] - keys[i - 1][0]),
          q = (keys[i + 1][k] - keys[i][k]) / (keys[i + 1][0] - keys[i][0]);
        return p * q <= 0 ? 0 : (2 * p * q) / (p + q);
      };
      return (
        (2 * u * u * u - 3 * u * u + 1) * a[k] +
        (u * u * u - 2 * u * u + u) * h * slope(j) +
        (-2 * u * u * u + 3 * u * u) * b[k] +
        (u * u * u - u * u) * h * slope(j + 1)
      );
    });
  }
  sprite(name, x, y, w, alpha = 1) {
    if (w < 0.3 || alpha < 0.001) return;
    const im = this.assets[name],
      h = (w * im.height) / im.width;
    this.photo(name, x - w / 2, y - h / 2, w, h, alpha);
  }
  // Keep an identifiable point in an image on the same sightline at every scale.
  anchoredSprite(name, x, y, w, alpha = 1, u = 0.5, v = 0.5) {
    if (w < 0.3 || alpha < 0.001) return;
    const im = this.assets[name];
    this.sprite(name, x + (0.5 - u) * w, y + ((0.5 - v) * w * im.height) / im.width, w, alpha);
  }
  passSprite(name, x, y, width, t, end) {
    // A fixed world point projected through a forward-moving camera: both its
    // offset from the optical axis and its diameter grow as 1 / distance. The
    // planet is never translated sideways independently, shrunk, or faded out.
    // Each approved starting view aims just beyond the limb, so the expanding
    // surface passes out of the windshield before crossing the camera plane.
    const distance = 1 - JourneyScene.smooth(t / end);
    if (distance <= 0.00001) return;
    const scale = 1 / distance;
    this.sprite(name, 800 + (x - 800) * scale, 238 + (y - 238) * scale, width * scale);
  }
  point(x, y, size, color, alpha = 1) {
    if (size < 0.15 || alpha < 0.001) return;
    this.photo('point' + color, x - size * 2.5, y - size * 2.5, size * 5, size * 5, alpha);
  }
  stars(p) {
    const s = JourneyScene.smooth.bind(JourneyScene);
    const v = this.visible,
      cover = Math.max(1, (v.right - v.left) / 1600, (v.bottom - v.top) / 1000),
      w = 1880 * cover,
      h = 1175 * cover;
    const left = (v.left + v.right - w) / 2,
      top = (v.top + v.bottom - h) / 2;
    // A sparse nearer stellar layer has its own depth. It expands radially as
    // we approach the worlds and contracts into the same optical axis during
    // the great retreat. No lateral drift, twinkling or independent idle loop.
    const warpTime = JourneyScene.warpTime(p - 2),
      warp = p > 2 && p < 3 ? s((warpTime - 0.12) / 0.2) * (1 - s((warpTime - 0.73) / 0.23)) : 0;
    if (this.photos.has('nearStars')) {
      const retreat = Math.max(0, p - 3),
        scale = Math.exp(Math.min(p, 3) * 0.11 - 4 * retreat),
        size = 2400 * cover * scale;
      this.photo(
        'nearStars',
        800 - size / 2,
        238 - size / 2,
        size,
        size,
        0.72 * (1 - 0.9 * warp) * (1 - s(retreat / 0.28)),
      );
    }
    if (p > 4) {
      // Keep the surrounding sky at the galaxy chapter's full-bleed exposure
      // while the galaxies recede together into the Local Group composition.
      this.photo('stars', left, top, w, h, 0.66);
    } else if (p > 3) {
      const t = p - 3;
      // Keep this photographic backdrop full-bleed. Transparent depth particles
      // provide the moving stars, so no shrinking bitmap edge enters the window.
      this.photo(
        'stars',
        left,
        top,
        w,
        h,
        0.8 * (1 - s((t - 0.015) / 0.25)) + 0.66 * s((t - 0.76) / 0.24),
      );
    } else {
      this.photo('stars', left, top, w, h, 0.8 * (1 - 0.88 * warp));
    }
  }
  solar(p) {
    const Q = JourneyScene,
      cv = Q.curve.bind(Q),
      sm = Q.smooth.bind(Q);
    if (p <= 1) {
      // One direct approach. Position is affine in apparent size, so there is no
      // orbit, sideways correction, or reversal while Earth grows toward us.
      const travel = sm(p),
        earthWidth = 210 * Math.exp(Math.log(2300 / 210) * travel),
        approach = (earthWidth - 210) / (2300 - 210);
      const earth = [Q.lerp(1160, 1510, approach), Q.lerp(260, 1080, approach), earthWidth];
      this.sprite('earth', ...earth);
      this.passSprite('moon', 310, 1180, 2080, p, 0.52);
      this.point(570, 255, 1.25, '#ffd5b3', sm((p - 0.6) / 0.4));
    } else {
      const t = p - 1;
      // Pass Earth on one side and leave it behind the camera. Never shrink it
      // back into the forward view at Mars. The same coordinate retraces this
      // departure when returning, with no rotation, fade or depth-order switch.
      const marsWidth = cv(
          [
            [0, 3],
            [0.27, 60],
            [0.56, 410],
            [0.8, 1300],
            [1, 2280],
          ],
          t,
        )[0],
        approach = (marsWidth - 3) / (2280 - 3);
      // Keep the distant target on one projected sightline as it approaches.
      // There is no separate sideways keyframe or bend in the flight path.
      const mars = [Q.lerp(570, 70, approach), Q.lerp(255, 1080, approach), marsWidth];
      this.passSprite('earth', 1510, 1080, 2300, t, 0.52);
      this.sprite('mars', ...mars);
    }
  }
  warp(t) {
    if (this.particles?.available) return;
    const Q = JourneyScene,
      sm = Q.smooth.bind(Q),
      c = this.ctx;
    const intensity = sm((t - 0.12) / 0.2) * (1 - sm((t - 0.73) / 0.23));
    if (intensity < 0.001) return;
    c.save();
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = intensity;
    c.drawImage(this.haze, -5, -615, 1760, 1760);
    for (const star of window.CockpitFrame.effectsReduced ? this.lightStreaks : this.streaks) {
      const z = (star.z + t * 3.5) % 1,
        dist = star.r * (0.045 + z * z * z * 4.8),
        len = Math.min(460, (26 + dist * 0.28) * intensity * (0.2 + z)),
        x = 875 + star.dx * dist,
        y = 265 + star.dy * dist;
      const x0 = 875 + star.dx * Math.max(10, dist - len),
        y0 = 265 + star.dy * Math.max(10, dist - len);
      const fade = sm(z / 0.15) * (1 - sm((z - 0.88) / 0.12)) * intensity;
      if (fade < 0.001) continue;
      this.streak(this.warpTail, x0, y0, x, y, star.w * (0.5 + z), fade);
      if (star.w > 1.8 && this.visibleSegment(x, y, x, y, 2)) {
        this.baseTransform();
        c.globalAlpha = fade * 0.7;
        c.fillStyle = '#dcf7ff';
        c.beginPath();
        c.arc(x, y, 1.2, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }
  interstellar(t) {
    const Q = JourneyScene,
      cv = Q.curve.bind(Q),
      sm = Q.smooth.bind(Q),
      flight = Q.warpTime(t);
    this.passSprite('mars', 70, 1080, 2280, t, 0.42);
    const turquoiseWidth = Math.exp(
      cv(
        [
          [0, 0],
          [0.6, Math.log(8)],
          [0.78, Math.log(330)],
          [0.9, Math.log(1150)],
          [1, Math.log(1800)],
        ],
        flight,
      )[0],
    );
    this.anchoredSprite(
      'turquoise',
      800,
      238,
      turquoiseWidth,
      sm((flight - 0.55) / 0.12),
      0.501,
      0.48,
    );
    this.warp(flight);
  }
  retreatStars(t) {
    if (this.particles?.available) return;
    const Q = JourneyScene,
      sm = Q.smooth.bind(Q),
      c = this.ctx,
      x = 800,
      y = 238;
    // Four successive depth shells make the distance visible between a planetary
    // system and a galaxy. Each star takes one inward path, without recycling.
    // Trails point back along that path; this is not the outbound FTL effect.
    c.save();
    c.globalCompositeOperation = 'screen';
    const shellFade = 1 - sm((t - 0.8) / 0.17),
      shells = [0, 1, 2, 3].map((layer) => {
        const start = 0.015 + layer * 0.17,
          u = Q.clamp((t - start) / 0.43),
          scale = Math.exp(-12 * sm(u));
        return {
          scale,
          previous: Math.exp(-12 * sm(Q.clamp((t - 0.012 - start) / 0.43))),
          fade: sm(u / 0.1) * (1 - sm((u - 0.64) / 0.36)) * shellFade,
          size: Math.pow(scale, 0.07),
        };
      });
    for (const star of window.CockpitFrame.effectsReduced ? this.lightStreaks : this.streaks) {
      const shell = shells[star.layer],
        radius = star.radius * shell.scale;
      const fade = shell.fade * sm((radius - 8) / 50);
      if (fade < 0.002 || radius < 4) continue;
      const dx = star.rx,
        dy = star.ry,
        px = x + dx * radius,
        py = y + dy * radius;
      const previous = star.radius * shell.previous;
      const tailRadius = radius + Math.min(90, previous - radius),
        tx = x + dx * tailRadius,
        ty = y + dy * tailRadius;
      const opacity = fade * (0.65 + star.c * 0.35),
        size = 0.65 + star.w * 0.75 * shell.size;
      if (tailRadius - radius > 0.6) {
        this.streak(this.retreatTail, tx, ty, px, py, size, opacity);
      }
      if (!this.visibleSegment(px, py, px, py, size)) continue;
      this.baseTransform();
      c.globalAlpha = opacity;
      c.fillStyle = '#cde8fa';
      c.beginPath();
      c.arc(px, py, size, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  system(t) {
    const Q = JourneyScene,
      sm = Q.smooth.bind(Q),
      x = 800,
      y = 238;
    // A fixed optical axis. Every object contracts along a straight radial path;
    // neither the ring planet nor the galaxy changes its point of focus.
    const scale = Math.exp(-18 * sm(t)),
      planetWidth = 1800 * scale;
    const galaxyEndWidth = Q.galaxyReadWidth,
      galaxyZoom = sm((t - 0.18) / 0.82);
    const galaxyWidth =
      galaxyEndWidth * Math.exp(Math.log(80000 / galaxyEndWidth) * (1 - galaxyZoom));
    // The close view and the whole galaxy are the SAME artwork and pattern.
    // Its early crop covers the entire window. There is no separate cloud with
    // an exposed perimeter, no image swap, and no lateral re-centering.
    // Let the star field breathe through the close crop, then restore a little
    // definition as the full spiral comes into view without becoming opaque.
    const galaxyAlpha = Q.lerp(0.32, 0.98, sm((t - 0.52) / 0.48)) * sm((t - 0.36) / 0.28);
    this.anchoredSprite('galaxy', x, y, galaxyWidth, galaxyAlpha, 0.507, 0.475);
    this.retreatStars(t);
    const place = (dx, dy) => [x + dx * scale, y + dy * scale];
    // The small, off-axis star and worlds merely establish an alien system.
    // They share the same shrinking frame instead of becoming camera targets.
    this.systemBodies.forEach((body, i) => {
      const [bx, by] = place(body.x, body.y),
        r = body.r * scale;
      if (r >= 0.3) this.photo('body' + i, bx - r, by - r, r * 2, r * 2);
    });
    const [sx, sy] = place(2350, -200);
    this.point(sx, sy, 22 * scale, '#ffe6b1');
    this.sprite('sun', sx, sy, 140 * scale);
    this.anchoredSprite('turquoise', x, y, planetWidth, 1, 0.501, 0.48);
    // Keep the departing system identifiable after its planet becomes subpixel,
    // then let this tiny point disappear among the much larger stellar field.
    this.point(x, y, 1.4, '#8ee6e5', sm((t - 0.33) / 0.1) * (1 - sm((t - 0.55) / 0.15)));
  }
  localGroup(t) {
    const Q = JourneyScene,
      u = Q.smooth(t),
      x = 800,
      y = 238;
    // The SAME original galaxy remains on the optical axis from AI & projects
    // into the final chapter. Its apparent size falls exponentially with distance.
    // The transparent companion plate contains no central replacement galaxy.
    const finalWidth = 420 * (this.finalGroupFit || 1),
      galaxyWidth = Q.galaxyReadWidth * Math.exp(Math.log(finalWidth / Q.galaxyReadWidth) * u);
    const groupWidth = (1760 * galaxyWidth) / 420;
    // This anchor is the removed core in the approved composition. Every neighbor
    // shares its one scale, so the whole group approaches the same vanishing point.
    this.anchoredSprite(
      'localgroup-neighbors',
      x,
      y,
      groupWidth,
      Q.smooth((t - 0.035) / 0.32),
      0.473,
      0.378,
    );
    this.anchoredSprite('galaxy', x, y, galaxyWidth, 0.98, 0.507, 0.475);
  }
  render(p) {
    if (this.width !== this.canvas.width || this.height !== this.canvas.height) this.resize();
    if (this.lastProgress === p) return;
    this.lastProgress = p;
    const gpu = !!this.particles?.available,
      effects = p > 2 && p < 4 && !gpu,
      layer = p > 3 ? '3' : '5';
    if (this.effects !== effects) {
      this.canvas.style.opacity = effects ? '1' : '0';
      this.effects = effects;
    }
    if (this.effectLayer !== layer) {
      this.canvas.style.zIndex = layer;
      this.effectLayer = layer;
    }
    // Travel emits sprite bounds without DOM style writes on the GPU path.
    // Retained photograph layers and Canvas2D lights remain the fallback.
    if (effects) {
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.width, this.height);
      this.baseTransform();
      c.globalAlpha = 1;
    }
    this.visiblePhotos.clear();
    this.stars(p);
    if (p <= 2) this.solar(p);
    else if (p <= 3) this.interstellar(p - 2);
    else if (p <= 4) this.system(p - 3);
    else this.localGroup(p - 4);
    this.finishPhotos();
    if (gpu) this.particles.render(p, this.visiblePhotos);
  }
};
