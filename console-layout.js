'use strict';
// One measured layout feeds the physical displays, painted instruments and
// shadow receiver. CSS owns breakpoints and the native reading dimensions.
globalThis.ConsoleLayout = {
  // Initial Canvas layers and the live renderer use the same pixel grid and
  // resting exterior projection, including rounded backing-store dimensions.
  spaceRaster(width, height, dpr) {
    const density = Math.min(dpr || 1, 1.25),
      area = Math.max(1, width * height);
    const ratio = Math.max(density, Math.min(dpr || 1, 1.5, Math.sqrt(1600000 / area)));
    return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
  },
  hardwareRaster(width, height, reader, dpr) {
    const top = Math.max(0, Math.min(height - 1, Math.floor(reader.top - 32))),
      cropHeight = height - top;
    const ratio = Math.min(
      Math.max(dpr || 1, 1.25),
      1.5,
      Math.max(1, Math.sqrt(1250000 / (width * cropHeight))),
    );
    return {
      top,
      height: cropHeight,
      ratio,
      width: Math.floor(width * ratio),
      pixelsHeight: Math.floor(cropHeight * ratio),
    };
  },
  spaceCamera(width, height) {
    const portrait = width < height,
      scale = Math.min(width / 1600, height / 1000) * (portrait ? 0.88 : 0.76);
    const offsetX = width / 2 - 800 * scale,
      offsetY = height * (portrait ? 0.26 : 0.27) - 238 * scale;
    return {
      scale,
      offsetX,
      offsetY,
      visible: {
        left: -offsetX / scale,
        top: -offsetY / scale,
        right: (width - offsetX) / scale,
        bottom: (height - offsetY) / scale,
      },
    };
  },
  cabinDensity(width, height, dpr, memory) {
    const budget = memory && memory <= 4 ? 4000000 : 6000000;
    return Math.min(Math.max(dpr || 1, 1.5), 2, Math.sqrt(budget / (width * height)));
  },
  // Detailed corners, wall fixtures and the lower side consoles share one
  // uniform scale. Only the empty window and plain connecting metal flex.
  cabin({ width, height }) {
    const scale = Math.min(width / 1600, height / 1000);
    const sourceX = [0, 480, 1120, 1600],
      sourceY = [0, 110, 175, 1000];
    // Keep the windshield rim and both lower console housings in view. Only
    // trim the outermost wall margin; detailed surfaces retain one scale.
    const crop = Math.min(24 * scale, Math.max(0, 172 * scale - Math.max(12, width * 0.1 - 52)));
    const x = [-crop, 480 * scale - crop, width - 480 * scale + crop, width + crop];
    const y = [0, 110 * scale, height - 825 * scale, height];
    const map = (value, from, to) => {
      const i = value < from[1] ? 0 : value < from[2] ? 1 : 2;
      return to[i] + ((value - from[i]) * (to[i + 1] - to[i])) / (from[i + 1] - from[i]);
    };
    return {
      scale,
      crop,
      sourceX,
      sourceY,
      x,
      y,
      mapX: (value) => map(value, sourceX, x),
      mapY: (value) => map(value, sourceY, y),
      sourceAtX: (value) => map(value, x, sourceX),
      sourceAtY: (value) => map(value, y, sourceY),
      paint(context, image, rect = [0, 0, 1600, 1000]) {
        const iw = image.naturalWidth || image.width,
          ih = image.naturalHeight || image.height;
        for (let row = 0; row < 3; row++)
          for (let col = 0; col < 3; col++) {
            const left = Math.max(rect[0], sourceX[col]),
              right = Math.min(rect[2], sourceX[col + 1]);
            const top = Math.max(rect[1], sourceY[row]),
              bottom = Math.min(rect[3], sourceY[row + 1]);
            if (right <= left || bottom <= top) continue;
            const dx = map(left, sourceX, x),
              dy = map(top, sourceY, y);
            context.drawImage(
              image,
              ((left - rect[0]) * iw) / (rect[2] - rect[0]),
              ((top - rect[1]) * ih) / (rect[3] - rect[1]),
              ((right - left) * iw) / (rect[2] - rect[0]),
              ((bottom - top) * ih) / (rect[3] - rect[1]),
              dx,
              dy,
              map(right, sourceX, x) - dx,
              map(bottom, sourceY, y) - dy,
            );
          }
      },
    };
  },
  // The upright display rests on the rear tabletop, behind the two lower
  // instrument banks. Use the artwork's coordinates, not a viewport offset.
  dock(stage, readerWidth) {
    const cabin = this.cabin(stage);
    const inset = Math.max(6, 12 * cabin.scale);
    const lane = cabin.mapX(1160) - cabin.mapX(440) - 2 * inset;
    const top = stage.top + cabin.mapY(788);
    const height = Math.max(40, Math.min(60, readerWidth * 0.075));
    const width = Math.max(0, Math.min(readerWidth * 0.96, lane));
    const visible =
      width >= (424 * height) / 60 + 24 && top + height <= stage.top + cabin.mapY(900);
    // On larger screens the whole hinged assembly rests against the fixed
    // light bar. Phones keep their existing tabletop position.
    const bottom = stage.width > 700 && visible ? top : stage.top + cabin.mapY(750);
    return {
      bottom,
      instrument: {
        visible,
        left: stage.left + (stage.width - width) / 2,
        top,
        width,
        height,
      },
    };
  },
  // Keep lamp and icon proportions. Only the empty separators shorten.
  stripCuts: [0, 122, 128, 188, 280, 340, 430, 490, 496, 618],
  strip(width, height) {
    const fixed = height / 60,
      flex = Math.max(0, (width - 424 * fixed) / 194);
    let left = 0;
    return this.stripCuts.slice(1).map((right, i) => {
      const start = this.stripCuts[i],
        span = right - start,
        size = span * (i % 2 ? flex : fixed);
      const segment = { source: start, span, left, width: size };
      left += size;
      return segment;
    });
  },
  windshieldInset(stage) {
    const cabin = this.cabin(stage);
    return cabin.mapX(184) + Math.max(12, 16 * cabin.scale);
  },
  place() {
    const stage = document.getElementById('stage').getBoundingClientRect();
    if (stage.width <= 0 || stage.height <= 0) return;
    const reader = document.getElementById('reading-layout').getBoundingClientRect();
    const bottom = this.dock(stage, reader.width).bottom;
    document
      .getElementById('cockpit')
      .style.setProperty('--display-dock-bottom', `${innerHeight - bottom}px`);
  },
  snapshot() {
    const width = innerWidth,
      height = innerHeight;
    const reader = document.getElementById('reading-layout').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    const displayStage = document.getElementById('display-stage').getBoundingClientRect();
    const measured = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      ['left', 'top', 'right', 'bottom', 'width', 'height'].every((key) =>
        Number.isFinite(rect[key]),
      );
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      !measured(reader) ||
      !measured(stage) ||
      !measured(displayStage)
    )
      return null;
    return { width, height, reader, stage, displayStage };
  },
  // A collapsed/hidden first layout is a wait for browser measurements, not an
  // animation. Retry only on relevant events; keep the loading veil in place.
  whenMeasured(commit = () => true) {
    if (window.CockpitEntrance?.state === 'failed')
      return Promise.reject(new Error('Cockpit preparation stopped'));
    if (!document.hidden && this.snapshot()) {
      try {
        if (commit() !== false) return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const key = {};
      const cleanup = () => {
        settled = true;
        observer.disconnect();
        failureObserver.disconnect();
        window.removeEventListener('resize', wake);
        document.removeEventListener('visibilitychange', wake);
        document.removeEventListener('webglcontextrestored', wake, true);
      };
      const failed = () => {
        if (window.CockpitEntrance?.state !== 'failed') return false;
        cleanup();
        reject(new Error('Cockpit preparation stopped'));
        return true;
      };
      const attempt = () => {
        if (settled || failed() || document.hidden || !this.snapshot()) return;
        try {
          if (commit() !== false) {
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const wake = () => {
        if (settled || failed()) return;
        window.CockpitFrame.paint(key, attempt, 0);
      };
      const observer = new ResizeObserver(wake);
      for (const id of ['stage', 'reading-layout', 'display-stage'])
        observer.observe(document.getElementById(id));
      const failureObserver = new MutationObserver(() => {
        if (!settled) failed();
      });
      failureObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-boot'],
      });
      window.addEventListener('resize', wake);
      document.addEventListener('visibilitychange', wake);
      document.addEventListener('webglcontextrestored', wake, true);
      wake();
    });
  },
  measure(reader) {
    const style = getComputedStyle(document.getElementById('reading-layout'));
    const sideDisplays = style.getPropertyValue('--side-displays').trim() !== 'none';
    const stage = document.getElementById('stage').getBoundingClientRect();
    return { sideDisplays, instrument: this.dock(stage, reader.width).instrument };
  },
};
