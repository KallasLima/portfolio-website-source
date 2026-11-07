'use strict';
const $ = (s) => document.querySelector(s),
  chapters = window.CHAPTERS,
  Q = window.JourneyScene;
const stage = $('#stage'),
  cockpit = $('#cockpit'),
  canvas = $('#space'),
  destinations = $('#destinations');
const images = {},
  previewSurfaces = new Map(),
  hardware = [],
  hardwareSurfaces = [],
  names = ['moon', 'earth', 'mars', 'turquoise', 'galaxy', 'localgroup'];
const lastChapter = chapters.length - 1;
const entryChapter = Math.max(
  0,
  Math.min(lastChapter, Number(document.documentElement.dataset.entryChapter) || 0),
);
const weights = [1, 1.2, 1.25, 2.1, 1.65],
  offsets = [0];
for (const weight of weights) offsets.push(offsets[offsets.length - 1] + weight);
const lastLeg = weights.length - 1;
// The final retreat changes the view outside, not the cabin's material finish.
const cabinNames = names.map((name) => (name === 'localgroup' ? 'galaxy' : name));
// Only the entry view is on the cold-start path. All resolutions and finishes
// stay unchanged; subsequent legs are prepared before we animate into them.
const stationArt = [
  ['moon', 'earth'],
  ['earth'],
  ['mars'],
  ['turquoise'],
  ['galaxy'],
  ['galaxy', 'localgroup-neighbors'],
];
const legArt = [
  ['moon', 'earth'],
  ['earth', 'mars'],
  ['mars', 'turquoise'],
  ['turquoise', 'galaxy', 'sun'],
  ['galaxy', 'localgroup-neighbors'],
];
const assetLoads = new Map(),
  stationLoads = new Map(),
  legLoads = new Map(),
  preparedLegs = new Set(),
  preparedCabins = new Map();
let hardwareMask,
  hardwareMaskImage,
  hardwareAccent,
  hardwareScratch,
  preparationTail = Promise.resolve(),
  navigationVersion = 0,
  pendingNavigation = null,
  lastInputAt = 0;
let scene,
  instruments,
  hinges,
  tilt,
  ready = false,
  progress = entryChapter,
  current = -1,
  frame = 0,
  animation = null;
let lastHardware = -1,
  lastFallbackHardware = -1,
  direction = 1,
  displayWidth = 0;
// Preserve the normal journey; reduced motion changes chapters without flight.
const reducedMotion = () => window.CockpitMotion.matches;
stage.dataset.motion = reducedMotion() ? 'reduced' : 'full';
window.CockpitMotion.addEventListener('change', () => {
  stage.dataset.motion = reducedMotion() ? 'reduced' : 'full';
  if (ready && reducedMotion()) {
    const target = navOrigin();
    stopMotion();
    void go(target);
  }
});
for (const type of ['pointerdown', 'pointermove', 'wheel', 'touchmove', 'keydown'])
  cockpit.addEventListener(
    type,
    () => {
      lastInputAt = performance.now();
    },
    { passive: true, capture: true },
  );

function coordinate(p) {
  const i = Math.min(lastLeg, Math.floor(p));
  return offsets[i] + (p - i) * weights[i];
}
function fromCoordinate(v) {
  let i = 0;
  while (i < lastLeg && v > offsets[i + 1]) i++;
  return Q.clamp(i + (v - offsets[i]) / weights[i], 0, lastChapter);
}
const navButtons = [...destinations.querySelectorAll('a[data-destination]')];
const chapterHistory = window.createChapterHistory({
  pages: navButtons.map((link) => ({
    path: link.getAttribute('href'),
    title: link.dataset.pageTitle,
    description: link.dataset.pageDescription,
  })),
  navigate: (index, fromHistory) => go(index, fromHistory),
  readIndex: () => Math.round(progress),
});
[...navButtons, $('.home-link')].filter(Boolean).forEach((link) =>
  link.addEventListener('click', (event) => {
    // Ordinary clicks retain the smooth journey. New tabs and no-JS visits use
    // the real, server-rendered entry URL. Refresh resets to that URL's chapter.
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(Number(link.dataset.destination));
  }),
);
// Keyboard users can reach the current article without traversing the cockpit controls.
$('.skip-reading').addEventListener('click', (event) => {
  const article = activeArticle();
  if (!article) return;
  event.preventDefault();
  article.focus({ preventScroll: true });
});

// A single position drives the scene and every display, including a partial swipe.
// Equal pixel displacement keeps screens synchronized across their separate containers.
const displays = [
  ['#screen-copy', 0],
  ['#side-left', -1],
  ['#side-right', 1],
].map(([selector, offset]) => ({
  element: $(selector),
  offset,
  panels: new Map(),
  cache: new Map(),
  visible: [],
}));
// Adjacent screens preview what can be read next, rather than repeating metadata.
const sideTopics = [
  ['Products & systems', 'Languages & international work'],
  ["Olly Olly's platform", 'CookUnity Smart Fridges'],
  ['Mobile & financial systems', 'Improving existing software'],
  ['Technical direction', 'Hiring & onboarding'],
  ['Working with coding agents', 'Creative AI Workflow Lab'],
  ['Human & AI collaboration', 'From ideas to a working cockpit'],
];
async function preparePreviewSurfaces() {
  for (const name of names.filter((name) => !previewSurfaces.has(name))) {
    const image = images[name === 'localgroup' ? 'localgroup-neighbors' : name];
    if (!image || (name === 'localgroup' && !images.galaxy)) continue;
    const bitmap = await window.ArtworkPreparation?.prepare(
      'preview:' + name,
      image,
      name === 'localgroup' ? images.galaxy : null,
    );
    if (bitmap) {
      previewSurfaces.set(name, bitmap);
      for (const target of document.querySelectorAll(`canvas[data-preview="${name}"]`))
        paintPreview(target, name);
      continue;
    }
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.round(image.naturalWidth * scale));
    surface.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = surface.getContext('2d', { alpha: true });
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, surface.width, surface.height);
    if (name === 'localgroup') {
      // Match the final scene's layer ratio and core anchors. Its two existing
      // alpha plates leave the display visible between galaxies, without sky.
      const galaxy = images.galaxy,
        width = (surface.width * 420) / 1760;
      const height = (width * galaxy.naturalHeight) / galaxy.naturalWidth;
      context.globalAlpha = 0.98;
      context.drawImage(
        galaxy,
        surface.width * 0.473 - width * 0.507,
        surface.height * 0.378 - height * 0.475,
        width,
        height,
      );
      context.globalAlpha = 1;
    }
    previewSurfaces.set(name, surface);
    for (const target of document.querySelectorAll(`canvas[data-preview="${name}"]`))
      paintPreview(target, name);
  }
}
function paintPreview(surface, name) {
  const source = previewSurfaces.get(name);
  if (!source) return;
  surface.width = source.width;
  surface.height = source.height;
  surface.style.aspectRatio = `${source.width} / ${source.height}`;
  surface.getContext('2d', { alpha: true }).drawImage(source, 0, 0);
}
function previewCanvas(name) {
  const surface = document.createElement('canvas');
  surface.dataset.preview = name;
  surface.setAttribute('aria-hidden', 'true');
  paintPreview(surface, name);
  return surface;
}
function displayPanel(index, offset) {
  // Enhance the already delivered manuscript; don't duplicate it after boot.
  const existing =
    offset === 0 ? document.querySelector(`#screen-copy > article[data-index="${index}"]`) : null;
  const c = chapters[index + offset],
    panel = existing || document.createElement(offset === 0 ? 'article' : 'div');
  panel.className = `display-card ${offset === 0 ? 'screen-article' : 'side-card'}`;
  // Retain the first-view visibility marker while 3D is prepared. Removing it
  // would hide the live reader for one frame and drop keyboard focus.
  if (window.HybridBoot && existing && index === entryChapter) panel.classList.add('hybrid-entry');
  panel.dataset.index = index;
  if (!c) {
    panel.classList.add('end-panel');
    panel.innerHTML = `<svg class="end-marker ${offset < 0 ? 'end-start' : ''}" viewBox="0 0 120 160" aria-hidden="true"><path class="end-rails" d="M8 50H70M8 80H70M8 110H70"/><path class="end-stop" d="M78 34V126"/><path class="end-hatch" d="M86 44l17-10M86 62l17-10M86 80l17-10M86 98l17-10M86 116l17-10M86 134l17-10"/></svg>`;
  } else if (offset === 0) {
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', `chapter-title-${index}`);
    if (!existing)
      panel.innerHTML = `<div class="reading-column"><h2 id="chapter-title-${index}">${c.title}</h2>${index === 0 ? '' : `<p class="chapter-subtitle">${c.sub}</p>`}<div class="chapter-body">${c.body}</div></div>`;
    // The manuscript's headings nest below the chapter title in this surface.
    // Their words and the stored source remain unchanged.
    for (const heading of existing
      ? []
      : panel.querySelectorAll('.chapter-body h2,.chapter-body h3')) {
      const section = heading.tagName === 'H2';
      const nested = document.createElement(section ? 'h3' : 'h4');
      nested.className = section ? 'section-title' : 'subsection-title';
      nested.innerHTML = heading.innerHTML;
      heading.replaceWith(nested);
    }
    // Reading cues follow native scroll events. They never repaint the scene,
    // change chapters, or run an animation loop while the reader is idle.
    panel.addEventListener(
      'scroll',
      () => {
        if (Number(panel.dataset.index) === current) updateReadingPosition();
      },
      { passive: true },
    );
  } else {
    const adjacent = index + offset;
    panel.classList.add('chapter-preview');
    panel.dataset.destination = names[adjacent];
    const briefTitle = [
      'About me',
      'Products',
      'More work',
      'Leading teams',
      'AI & projects',
      'The project',
    ][adjacent];
    panel.innerHTML = `<div class="preview-direction"><span>${offset < 0 ? 'Previous chapter' : 'Next chapter'}</span><span aria-hidden="true">${offset < 0 ? '←' : '→'}</span></div><div class="preview-destination" aria-hidden="true"></div><strong class="preview-title"><span class="preview-title-full">${c.title}</span><span class="preview-title-brief">${briefTitle}</span></strong><ul class="preview-topics">${sideTopics[adjacent].map((topic) => `<li>${topic}</li>`).join('')}</ul>`;
    panel.querySelector('.preview-destination').append(previewCanvas(names[adjacent]));
  }
  // The hybrid entry is already being read. Initializing the panel cache must
  // not hide it or make it inert, which also drops native reading focus.
  if (!(window.HybridBoot && existing && index === entryChapter)) {
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    panel.inert = true;
    panel.tabIndex = -1;
    panel.setAttribute('aria-hidden', 'true');
  }
  return panel;
}
function renderDisplays() {
  const p = progress,
    base = Math.floor(p);
  const visible = [base];
  if (base < lastChapter && p - base > 0.00001) visible.push(base + 1);
  const focusedArticle = document.activeElement.closest?.('.screen-article');
  const transferReadingFocus =
    focusedArticle && Number(focusedArticle.dataset.index) !== Math.round(p);
  for (const display of displays) {
    for (const index of display.visible)
      if (!visible.includes(index)) {
        const panel = display.panels.get(index);
        panel.style.opacity = '0';
        panel.style.pointerEvents = 'none';
        panel.inert = true;
        panel.tabIndex = -1;
        panel.setAttribute('aria-hidden', 'true');
      }
    for (const index of visible) {
      const panel = display.panels.get(index);
      const delta = index - p;
      // Fade through the handover so two long passages never overprint each other.
      const opacity = Q.smooth(1 - Math.abs(delta) / 0.54).toFixed(5);
      // Invisible passages do not need a fresh composited transform. Assign
      // their exact position in the same frame they first become visible.
      if (+opacity > 0)
        panel.style.transform = `translateX(${(delta * displayWidth * 0.12).toFixed(5)}px)`;
      if (panel.style.opacity !== opacity) panel.style.opacity = opacity;
      const active = index === Math.round(p);
      if (panel.inert === active || !panel.hasAttribute('aria-hidden')) {
        panel.setAttribute('aria-hidden', String(!active));
        panel.inert = !active;
        if (display.offset === 0) {
          panel.tabIndex = active ? 0 : -1;
          panel.style.pointerEvents = active ? 'auto' : 'none';
        }
      }
    }
    display.visible = visible;
    display.element.dataset.position = p.toFixed(5);
  }
  // Keep keyboard reading in the new chapter without stealing focus from controls.
  if (transferReadingFocus) displays[0].panels.get(Math.round(p))?.focus({ preventScroll: true });
}
function updateChapter(i) {
  if (i === current) return;
  current = i;
  navButtons.forEach((b, j) => b.setAttribute('aria-current', j === i));
  for (const [side, adjacent] of [
    ['left', i - 1],
    ['right', i + 1],
  ]) {
    const adjacentChapter = chapters[adjacent],
      button = $('#side-' + side);
    button.setAttribute(
      'aria-label',
      adjacentChapter
        ? `Preview: ${adjacentChapter.title} at ${adjacentChapter.place}`
        : side === 'left'
          ? 'Beginning of journey'
          : 'End of journey',
    );
    const hit = $('#monitor-hit-' + side);
    hit.setAttribute('aria-disabled', String(!adjacentChapter));
    hit.tabIndex = adjacentChapter ? 0 : -1;
    hit.setAttribute(
      'aria-label',
      adjacentChapter
        ? `${side === 'left' ? 'Previous' : 'Next'} chapter: ${adjacentChapter.title}. Drag to adjust monitor.`
        : `${side === 'left' ? 'Beginning' : 'End'} of journey. Drag to adjust monitor.`,
    );
    if (adjacentChapter) {
      hit.dataset.destination = adjacent;
      hit.setAttribute('href', navButtons[adjacent].getAttribute('href'));
    } else {
      delete hit.dataset.destination;
      hit.removeAttribute('href');
    }
  }
  for (const [id, adjacent] of [
    ['previous', i - 1],
    ['next', i + 1],
  ]) {
    const link = $('#' + id),
      available = adjacent >= 0 && adjacent <= lastChapter;
    link.setAttribute('aria-disabled', String(!available));
    link.tabIndex = available ? 0 : -1;
    if (available) link.setAttribute('href', navButtons[adjacent].getAttribute('href'));
    else link.removeAttribute('href');
  }
  $('#next').setAttribute(
    'aria-label',
    i === lastChapter ? 'End of journey' : `Next chapter: ${chapters[i + 1].title}`,
  );
  $('#previous').setAttribute(
    'aria-label',
    i === 0 ? 'Beginning of journey' : `Previous chapter: ${chapters[i - 1].title}`,
  );
  stage.dataset.chapter = i;
  updateReadingPosition();
}
function updateReadingPosition() {
  const article = displays[0].panels.get(current);
  if (!article) return;
  const extent = Math.max(0, article.scrollHeight - article.clientHeight);
  const atStart = article.scrollTop < 3,
    atEnd = extent - article.scrollTop < 3;
  const fraction = atEnd ? 1 : atStart ? 0 : Q.clamp(article.scrollTop / extent);
  const surface = $('#center-screen');
  surface.style.setProperty('--reading-progress', fraction.toFixed(4));
  surface.dataset.readingStart = String(atStart);
  surface.dataset.readingEnd = String(atEnd);
}
function phaseText(p) {
  if (Math.abs(p - Math.round(p)) < 0.001)
    return [
      'Lunar orbit',
      'Earth daylight',
      'Mars orbit',
      'Turquoise world',
      'The whole galaxy',
      'The Local Group',
    ][Math.round(p)];
  if (direction < 0) {
    if (p > 4) return 'Leaving the Local Group view · Approaching our galaxy';
    if (p < 1) return 'Leaving Earth · Approaching the Moon';
    if (p < 2) return 'Leaving Mars · Approaching Earth';
    if (p < 3)
      return Q.warpTime(p - 2) > 0.78
        ? 'Leaving the turquoise world'
        : p > 2.42
          ? 'Interstellar passage'
          : 'Approaching Mars';
    return p > 3.55 ? 'Into the spiral arm' : 'Approaching the ring planet';
  }
  if (p > 4) return 'Pulling beyond our galaxy · Revealing the Local Group';
  if (p < 1) return 'Leaving the Moon · Approaching Earth';
  if (p < 2) return 'Leaving Earth · Approaching Mars';
  if (p < 3)
    return p < 2.42
      ? 'Passing Mars'
      : Q.warpTime(p - 2) < 0.78
        ? 'Interstellar passage'
        : 'Approaching the turquoise world';
  return p < 3.4
    ? 'Pulling away from the ring planet'
    : p < 3.75
      ? 'Beyond its system · Into the spiral arm'
      : 'Revealing the whole galaxy';
}
async function prepareHardwareSurfaces() {
  hardwareMask ||= loadImage('assets/hardware-without-center.svg?v=17');
  [hardwareMaskImage, hardwareAccent] = await Promise.all([
    hardwareMask,
    loadImage('assets/cabin-luminous.svg'),
  ]);
  // Prepare each cabin plate once per viewport layout. Keeping
  // each distinct plate attached avoids swapping compressed WebP display items while the
  // journey is moving. Their source order always puts the next plate on top.
  for (let index = 0; index < hardware.length; index++) {
    const image = hardware[index];
    if (!image || hardwareSurfaces[index]) continue;
    // Local Group shares the galaxy's already decoded and masked plate.
    if (preparedCabins.has(image)) {
      hardwareSurfaces[index] = preparedCabins.get(image);
      continue;
    }
    await preparationTurn();
    const surface = document.createElement('canvas');
    surface.className = 'hardware hardware-mask-baked';
    surface.id = 'hardware-' + names[index];
    surface.setAttribute('aria-hidden', 'true');
    surface.plateImage = image;
    surface.plateWorld = names[index];
    surface.dataset.artwork = names[index];
    surface.style.opacity = '0';
    await prepareHardwareSurface(surface);
    const nextSurface = hardwareSurfaces.slice(index + 1).find(Boolean);
    stage.insertBefore(surface, nextSurface || $('#hardware-anchor'));
    hardwareSurfaces[index] = surface;
    preparedCabins.set(image, surface);
  }
  lastHardware = -1;
  lastFallbackHardware = -1;
}
async function prepareHardwareSurface(surface) {
  // Build while detached, and publish only pixels for the current viewport.
  // Resize remains synchronous once attached; a stale worker result must never
  // overwrite its newer layout. Continuous resizing uses the existing fallback.
  if (!new URLSearchParams(location.search).has('hybrid-export') && window.ArtworkPreparation)
    for (let attempt = 0; attempt < 2; attempt++) {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) break;
      const density = window.CabinDetail.density(rect.width, rect.height);
      let mask, accent, bitmap;
      try {
        // Chrome can return a fully transparent ImageBitmap for a dimensionless
        // SVG even with resize options. Draw the SVG at an explicit size first,
        // using the same vector rasterization as the original scratch painter.
        const detailScale = Math.min(
          2,
          Math.max(1, window.ConsoleLayout.cabin(rect).scale * density),
        );
        const raster = new OffscreenCanvas(
          Math.ceil(1600 * detailScale),
          Math.ceil(1000 * detailScale),
        );
        const context = raster.getContext('2d');
        context.drawImage(hardwareMaskImage, 0, 0, raster.width, raster.height);
        mask = raster.transferToImageBitmap();
        context.drawImage(hardwareAccent, 0, 0, raster.width, raster.height);
        accent = raster.transferToImageBitmap();
        bitmap = await window.ArtworkPreparation.prepare(
          'cabin-surface',
          surface.plateImage,
          null,
          {
            mask,
            accent,
            world: surface.plateWorld,
            rect: { width: rect.width, height: rect.height },
            density,
          },
        );
        if (!bitmap) break;
        const current = stage.getBoundingClientRect();
        if (
          current.width !== rect.width ||
          current.height !== rect.height ||
          density !== window.CabinDetail.density(current.width, current.height)
        )
          continue;
        surface.width = bitmap.width;
        surface.height = bitmap.height;
        surface.layoutWidth = rect.width;
        surface.layoutHeight = rect.height;
        surface.getContext('2d').drawImage(bitmap, 0, 0);
        surface.dataset.preparation = 'worker';
        return;
      } catch {
        // Worker/bitmap support is optional. Preserve the original full painter.
        break;
      } finally {
        mask?.close();
        accent?.close();
        bitmap?.close();
      }
    }
  paintHardwareSurface(surface);
  surface.dataset.preparation = 'fallback';
}
function paintHardwareSurface(surface) {
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const density = window.CabinDetail.density(rect.width, rect.height);
  const width = Math.max(1, Math.ceil(rect.width * density)),
    height = Math.max(1, Math.ceil(rect.height * density));
  if (
    surface.width === width &&
    surface.height === height &&
    surface.layoutWidth === rect.width &&
    surface.layoutHeight === rect.height
  )
    return;
  // One reusable scratch plate prevents retaining a second full-size bitmap for
  // every destination. Repaint only at preparation/resize, never during travel.
  hardwareScratch ||= document.createElement('canvas');
  window.CabinSurface.paint(
    surface,
    hardwareScratch,
    surface.plateImage,
    hardwareMaskImage,
    hardwareAccent,
    surface.plateWorld,
    rect,
    density,
  );
  surface.layoutWidth = rect.width;
  surface.layoutHeight = rect.height;
  // The masked output owns its pixels now; do not retain a second large plate.
  if (new URLSearchParams(location.search).has('hybrid-export'))
    window.HybridCabin = hardwareScratch.toDataURL('image/png');
  hardwareScratch.width = 1;
  hardwareScratch.height = 1;
}
function loadImage(url) {
  if (!assetLoads.has(url)) {
    assetLoads.set(
      url,
      (async () => {
        // Warming and user navigation share this entire retry, not just its first
        // request. A temporary network/5xx failure must not strand the chapter.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
          const image = new Image();
          image.decoding = 'async';
          let objectURL,
            decoding = false;
          try {
            if (/\.(webp|avif)$/.test(url) && window.ArtworkPreparation) {
              // Bypass a cached failed/truncated response on retry while keeping
              // successful artwork and the normal cold-load request count intact.
              const response = await fetch(url, { cache: attempt ? 'reload' : 'default' });
              if (!response.ok) {
                const error = new Error(`Artwork unavailable: ${url} (HTTP ${response.status})`);
                error.status = response.status;
                error.retryable = response.status >= 500 || [408, 429].includes(response.status);
                throw error;
              }
              const blob = await response.blob();
              objectURL = URL.createObjectURL(blob);
              image.src = objectURL;
              window.ArtworkPreparation.remember(image, blob);
            } else image.src = url;
            decoding = true;
            await image.decode();
            // The document owns successful URLs. Cabin SVG fallbacks reuse them.
            return image;
          } catch (cause) {
            if (objectURL) URL.revokeObjectURL(objectURL);
            // Unsupported AVIF should use the existing WebP fallback immediately.
            if (attempt === 2 || cause.retryable === false || (decoding && url.endsWith('.avif')))
              throw new Error(`Could not prepare artwork: ${url}`, { cause });
          }
        }
      })().catch((error) => {
        assetLoads.delete(url);
        throw error;
      }),
    );
  }
  return assetLoads.get(url);
}
function loadArtwork(name) {
  if (images[name]) return Promise.resolve(images[name]);
  // Same full-resolution artwork and alpha, with the original format retained
  // for browsers that cannot decode AVIF or a failed transport request.
  const original = () => loadImage(`assets/${name}.webp`);
  const image = ['moon', 'earth', 'stars'].includes(name)
    ? loadImage(`assets/${name}.avif`).catch(original)
    : original();
  return image.then((image) => {
    images[name] = image;
  });
}
function loadCabin(index) {
  const name = cabinNames[index];
  return loadImage(`assets/cabin/${name}.webp`).then(async (image) => {
    const colors = await window.ArtworkPreparation?.prepare('cabin-colors', image);
    if (colors) {
      window.CabinDetail.sampledColors ||= new WeakMap();
      window.CabinDetail.sampledColors.set(image, colors);
    }
    cabinNames.forEach((cabin, i) => {
      if (cabin === name) hardware[i] = image;
    });
  });
}
// Yield between full-resolution raster/upload jobs. Never do speculative CPU
// preparation in the middle of a flight, head lift or a display drag.
async function preparationTurn() {
  do {
    await new Promise((resolve) => setTimeout(resolve, ready ? 40 : 0));
  } while (
    ready &&
    (document.hidden ||
      window.CockpitEntrance.blocked ||
      animation ||
      drag?.moved ||
      hinges?.drag ||
      tilt?.drag ||
      (pendingNavigation === null && performance.now() - lastInputAt < 350))
  );
}
function prepareArtwork(art) {
  const work = preparationTail.then(async () => {
    for (const name of art)
      if (!scene.photos.has(name) && Q.photoOrder.includes(name)) {
        await preparationTurn();
        await scene.prepareArtworkAsync(name);
      }
    await prepareHardwareSurfaces();
    await preparePreviewSurfaces();
    instruments.prepare(hardware);
    draw();
  });
  preparationTail = work.catch(() => {});
  return work;
}
function stationImages(index) {
  const previews = names
    .slice(Math.max(0, index - 1), Math.min(names.length, index + 2))
    .flatMap((name) => (name === 'localgroup' ? ['galaxy', 'localgroup-neighbors'] : [name]));
  return [...new Set([...stationArt[index], ...previews])];
}
function prepareStation(index) {
  if (!stationLoads.has(index)) {
    const art = stationImages(index);
    const task = Promise.all([loadCabin(index), ...art.map(loadArtwork)]).then(() =>
      prepareArtwork(art),
    );
    stationLoads.set(
      index,
      task.catch((error) => {
        stationLoads.delete(index);
        throw error;
      }),
    );
  }
  return stationLoads.get(index);
}
function prepareLeg(index) {
  if (!legLoads.has(index)) {
    const task = Promise.all([
      prepareStation(index),
      prepareStation(index + 1),
      ...legArt[index].map(loadArtwork),
    ])
      .then(() => prepareArtwork(legArt[index]))
      .then(() => scene.prepareFlight(index))
      .then(
        () =>
          new Promise((resolve) =>
            // Preparation queues a current-pose paint. Let that paint reach the
            // browser before starting the flight clock; otherwise its upload /
            // compositor work is charged to the first animated frame.
            window.CockpitFrame.paint(
              `leg-ready-${index}`,
              () => requestAnimationFrame(resolve),
              1000,
            ),
          ),
      )
      .then(() => {
        preparedLegs.add(index);
      });
    legLoads.set(
      index,
      task.catch((error) => {
        legLoads.delete(index);
        throw error;
      }),
    );
  }
  return legLoads.get(index);
}
function pathLegs(from, to) {
  const result = [];
  for (let i = Math.floor(Math.min(from, to)); i < Math.ceil(Math.max(from, to)); i++)
    if (i >= 0 && i <= lastLeg) result.push(i);
  return result;
}
async function warmJourney() {
  // Prepare the next reachable views, not the complete six-chapter tour while
  // someone is reading the first paragraph. Moving to a new station schedules
  // its neighbours; an explicit jump still prepares every required leg.
  const station = current;
  const legs = [station, station - 1].filter((i) => i >= 0 && i <= lastLeg);
  for (const leg of legs) {
    await preparationTurn();
    if (current !== station) return;
    try {
      await prepareLeg(leg);
    } catch (error) {
      console.warn('Journey preview will retry when requested.', error);
    }
  }
}
function draw() {
  if (ready) window.CockpitFrame.paint('journey', drawNow, 10);
}
function drawNow() {
  if (!ready) return;
  scene.render(progress);
  renderDisplays();
  const leg = Math.min(lastLeg, Math.floor(progress)),
    fraction = progress - leg;
  const baseSurface = hardwareSurfaces[leg] || hardwareSurfaces[current],
    nextSurface = hardwareSurfaces[leg + 1] || baseSurface;
  const baseImage = hardware[leg] || hardware[current],
    nextImage = hardware[leg + 1] || baseImage;
  if (lastHardware !== leg) {
    for (const surface of new Set(hardwareSurfaces.filter(Boolean)))
      surface.style.opacity = surface === baseSurface ? '1' : '0';
    lastHardware = leg;
  }
  const hardwareOpacity = baseSurface === nextSurface ? 0 : Q.smooth(fraction);
  if (nextSurface !== baseSurface) nextSurface.style.opacity = hardwareOpacity;
  // The SVG slices are only a fallback. Do not swap compressed image sources
  // behind the live hardware; entering fallback refreshes its own source state.
  if (!hinges?.physical) {
    if (lastFallbackHardware !== leg) {
      for (const image of document.querySelectorAll('#device-material-base image'))
        image.setAttribute('href', baseImage.src);
      for (const image of document.querySelectorAll('#device-material-next image'))
        image.setAttribute('href', nextImage.src);
      lastFallbackHardware = leg;
    }
    $('#device-material-next').style.opacity = hardwareOpacity;
  }
  instruments.render(progress, false, { base: baseImage, next: nextImage, mix: hardwareOpacity });
  hinges?.setLighting(baseImage, nextImage, hardwareOpacity);
  hinges?.setJourneyProgress(progress);
  hinges?.render();
  stage.dataset.progress = progress.toFixed(5);
  stage.dataset.phase = phaseText(progress);
}
function resize() {
  // ResizeObserver runs after frame paints. Keep the current pixels until the
  // next shared presentation, then resize and repaint before that frame ends.
  window.CockpitFrame.paint('layout', resizeNow, 0);
}
function resizeNow() {
  if (!window.ConsoleLayout.snapshot()) return;
  window.CockpitEntrance.beforeLayout();
  displayWidth = stage.clientWidth;
  cockpit.style.setProperty(
    '--header-height',
    `${$('.site-header').getBoundingClientRect().height}px`,
  );
  window.ConsoleLayout.place();
  for (const surface of new Set(hardwareSurfaces.filter(Boolean))) paintHardwareSurface(surface);
  tilt?.refresh();
  const spaceRect = canvas.getBoundingClientRect(),
    density = Math.min(devicePixelRatio || 1, 1.25);
  // Give high-density displays a modest, stable exterior sharpness increase.
  // Keep the existing floor on large viewports; only the additional pixels are
  // capped. Resolution changes with viewport size, never with journey state.
  const spaceRaster = window.ConsoleLayout.spaceRaster(
    spaceRect.width,
    spaceRect.height,
    devicePixelRatio,
  );
  // The backdrop can cover a tall viewport while the console keeps its geometry.
  const size = (surface, width, height) => {
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;
  };
  size(canvas, spaceRaster.width, spaceRaster.height);
  const monitors = $('#monitors'),
    layout = monitors.parentElement;
  size(
    monitors,
    hinges?.physical ? 1 : Math.round(layout.clientWidth * density),
    hinges?.physical ? 1 : Math.round(layout.clientHeight * density),
  );
  scene?.resize();
  // Instruments own a cropped backing store. Never expand it to the full deck
  // just to communicate density; that clears a still-valid displayed bitmap.
  instruments?.resize(density);
  hinges?.invalidateLayout();
  hinges?.render();
  draw();
}
function motionState() {
  if (animation || drag?.moved) stage.style.cursor = '';
  stage.dataset.playing = String(!!animation);
  stage.dataset.moving = String(!!animation || !!drag?.moved);
}
function stopMotion(settle = false) {
  navigationVersion++;
  pendingNavigation = null;
  stage.dataset.loadingJourney = 'false';
  const notice = $('#journey-loading');
  // A removed retry control must not leave keyboard focus on a detached node.
  if (notice.contains(document.activeElement)) activeArticle()?.focus({ preventScroll: true });
  notice.setAttribute('aria-hidden', 'true');
  notice.replaceChildren('Preparing next view…');
  window.CockpitFrame.cancel(frame);
  frame = 0;
  animation = null;
  if (settle) {
    const capturedPointer = drag?.id;
    drag = null;
    if (capturedPointer !== undefined && cockpit.hasPointerCapture(capturedPointer))
      cockpit.releasePointerCapture(capturedPointer);
    if (ready) {
      setProgress(Math.round(progress));
      announce();
    }
  }
  motionState();
}
function setProgress(p) {
  const nextProgress = Q.clamp(p, 0, lastChapter);
  const missing = pathLegs(progress, nextProgress).filter((leg) => !preparedLegs.has(leg));
  if (missing.length) {
    for (const leg of missing) prepareLeg(leg).catch(() => {});
    return;
  }
  if (Math.abs(nextProgress - progress) > 0.0000001) direction = Math.sign(nextProgress - progress);
  progress = nextProgress;
  updateChapter(Math.round(progress));
  draw();
}
function announce() {
  chapterHistory.settle(current);
  $('#status').textContent = `${phaseText(progress)}. ${chapters[current].title}.`;
  void warmJourney();
}
async function recoverRetiredRelease(target, version, error) {
  // An open tab can outlive its deployed /r/<id>/ assets. Retrying that 404
  // forever cannot help; verify a genuinely newer document before reloading.
  if (error.cause?.status !== 404) return false;
  const base = document.querySelector('base')?.getAttribute('href');
  if (!/^\/r\/[a-f0-9]{20}\/$/.test(base)) return false;
  const path = navButtons[target].getAttribute('href') + location.search;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || new URL(response.url).origin !== location.origin) return false;
    const html = await response.text();
    const freshBase = html.match(/<base\s+href="(\/r\/[a-f0-9]{20}\/)"/i)?.[1];
    if (freshBase && freshBase !== base && version === navigationVersion) {
      // This is the user's requested destination, not a silent return home.
      // Normal and transient-error navigation retain the animated same-document path.
      location.assign(path);
      return true;
    }
  } catch {
    // Offline, unchanged or unrecognized pages keep the current reader and retry UI.
  } finally {
    clearTimeout(timeout);
  }
  return false;
}
async function go(target, fromHistory = false, allowRecovery = true) {
  if (!ready || window.CockpitEntrance.blocked) return false;
  stopMotion();
  chapterHistory.begin(fromHistory);
  target = Q.clamp(target, 0, lastChapter);
  const distance = Math.abs(coordinate(target) - coordinate(progress));
  if (distance < 0.00001) {
    motionState();
    announce();
    return true;
  }
  const missing = pathLegs(progress, target).filter((leg) => !preparedLegs.has(leg));
  if (missing.length) {
    const version = navigationVersion;
    pendingNavigation = target;
    stage.dataset.loadingJourney = 'true';
    $('#journey-loading').textContent = 'Preparing next view…';
    $('#status').textContent = `Preparing ${chapters[target].title}. You can keep reading.`;
    try {
      for (const leg of missing) await prepareLeg(leg);
    } catch (error) {
      if (
        allowRecovery &&
        version === navigationVersion &&
        (await recoverRetiredRelease(target, version, error))
      )
        return;
      if (version === navigationVersion) {
        pendingNavigation = null;
        const notice = $('#journey-loading');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => go(target));
        const direct = document.createElement('a');
        direct.textContent = 'Open chapter directly';
        // This ordinary link intentionally bypasses the broken 3D transition.
        // The destination's lightweight HTML reader does not need this cabin.
        direct.href = navButtons[target].getAttribute('href') + location.search;
        notice.removeAttribute('aria-hidden');
        notice.replaceChildren('Chapter artwork could not load. ', retry, ' ', direct);
        $('#status').textContent =
          `${chapters[target].title} artwork could not load. You can keep reading, try again, or open the chapter directly.`;
        chapterHistory.fail();
      }
      console.warn('Journey could not be prepared.', error);
      return;
    }
    if (version !== navigationVersion) return;
    pendingNavigation = null;
    stage.dataset.loadingJourney = 'false';
  }
  if (reducedMotion()) {
    setProgress(target);
    motionState();
    announce();
    return true;
  }
  const duration = Math.max(220, 950 * Math.abs(target - progress));
  animation = {
    type: 'move',
    from: coordinate(progress),
    to: coordinate(target),
    target,
    start: performance.now(),
    duration,
  };
  stage.dataset.duration = Math.round(duration);
  $('#status').textContent = `Moving to ${chapters[target].title}.`;
  motionState();
  frame = window.CockpitFrame.request(tick);
  return true;
}
// Optional agent adapter: the same flight and mechanical controllers used by
// visible controls. Only agent calls disable retired-release reload recovery.
window.CockpitActions = window.createCockpitActions({
  ready: () => ready && !window.CockpitEntrance.blocked,
  busy: () => !!(animation || pendingNavigation !== null || drag || tilt?.drag || hinges?.drag),
  navigate: (index) => go(index, false, false),
  version: () => navigationVersion,
  settled: () => !animation && pendingNavigation === null,
  chapter: () => current,
  cancelNavigation: (version) => {
    if (version === navigationVersion) stopMotion(true);
  },
  displays: () => ({ tilt, hinges }),
});
function tick(now) {
  if (!animation) return;
  const a = animation;
  if (a.type === 'wheel') {
    const dt = Math.min(40, now - a.tick);
    a.tick = now;
    const idle = now - wheel.last >= wheel.idleMs;
    if (idle && !a.settling) {
      a.target = wheelDestination(a);
      a.settling = true;
    }
    const difference = a.target - progress;
    const step = Q.clamp(difference * (1 - Math.exp(-dt / 85)), -dt * 0.0009, dt * 0.0009);
    setProgress(progress + step);
    if (idle && Math.abs(difference) < 0.0005) {
      setProgress(a.target);
      animation = null;
      frame = 0;
      motionState();
      announce();
    } else frame = window.CockpitFrame.request(tick);
    return;
  }
  const t = Q.clamp((now - a.start) / a.duration);
  setProgress(fromCoordinate(Q.lerp(a.from, a.to, Q.smooth(t))));
  if (t >= 1) {
    setProgress(a.target);
    announce();
    animation = null;
    frame = 0;
    motionState();
  } else frame = window.CockpitFrame.request(tick);
}
function navOrigin() {
  return pendingNavigation ?? (animation?.type === 'move' ? animation.target : current);
}
function previous() {
  go(Math.max(0, navOrigin() - 1));
}
function next() {
  go(Math.min(lastChapter, navOrigin() + 1));
}
for (const [id, navigate] of [
  ['previous', previous],
  ['next', next],
]) {
  $('#' + id).addEventListener('click', (event) => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (event.currentTarget.getAttribute('aria-disabled') !== 'true') navigate();
  });
}

// Match the inner windshield cutout in cabin-luminous.svg, in plate coordinates.
const windshield = [
  [155, 50],
  [112, 96],
  [172, 720],
  [1428, 720],
  [1488, 96],
  [1445, 50],
];
function windowDestination(clientX, clientY) {
  if (!ready || window.CockpitEntrance.blocked || animation || progress !== current) return null;
  // Physical displays, their drag targets and all website controls own their input.
  if (document.elementFromPoint(clientX, clientY) !== stage) return null;
  const rect = stage.getBoundingClientRect();
  const cabin = window.ConsoleLayout.cabin(rect);
  const x = cabin.sourceAtX(clientX - rect.left),
    y = cabin.sourceAtY(clientY - rect.top);
  let inside = false;
  for (let i = 0, j = windshield.length - 1; i < windshield.length; j = i++) {
    const [ax, ay] = windshield[i],
      [bx, by] = windshield[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  if (!inside) return null;
  if (current === lastChapter) return scene.hitsGalaxy(clientX, clientY) ? current - 1 : null;
  // On the Milky Way chapter, its visible artwork leads back; open space leads on.
  if (current === 4 && scene.hitsGalaxy(clientX, clientY)) return current - 1;
  if (current === 0 && !scene.hitsEarth(clientX, clientY)) return null;
  return current + 1;
}
let drag = null,
  suppressClickUntil = 0;
stage.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && !drag)
    stage.style.cursor = windowDestination(e.clientX, e.clientY) === null ? '' : 'pointer';
});
stage.addEventListener('pointerleave', () => {
  stage.style.cursor = '';
});
window.addEventListener('blur', () => {
  if (drag) drag.tap = null;
});
// Suppress only the click produced by the completed drag, never a fresh gesture.
cockpit.addEventListener(
  'pointerdown',
  (e) => {
    suppressClickUntil = 0;
    // Cancel before a second finger can be claimed by a display/hinge handler.
    if (e.isPrimary === false && drag) drag.tap = null;
  },
  true,
);
cockpit.addEventListener(
  'click',
  (e) => {
    if (e.detail > 0 && performance.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);
cockpit.addEventListener('pointerdown', (e) => {
  if (
    !ready ||
    window.CockpitEntrance.blocked ||
    e.button !== 0 ||
    e.isPrimary === false ||
    e.target.closest('header,footer,nav,a,button,.hinge-grip,.monitor-hit') ||
    (e.pointerType !== 'touch' && e.target.closest('.reading-device,.main-tilt-hit'))
  )
    return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    p: progress,
    chapter: current,
    moved: false,
    id: e.pointerId,
    tap: windowDestination(e.clientX, e.clientY),
  };
});
cockpit.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (tilt?.drag?.active) {
    cancelDrag(e);
    return;
  }
  const dx = e.clientX - drag.x,
    dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 6) drag.tap = null;
  if (!drag.moved && Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) {
    drag = null;
    return;
  }
  if (Math.abs(dx) > 6 && (drag.moved || Math.abs(dx) > Math.abs(dy))) {
    if (!drag.moved) {
      tilt?.finish();
      drag.p = progress;
      drag.chapter = current;
      stopMotion();
      cockpit.setPointerCapture(e.pointerId);
    }
    drag.moved = true;
  }
  if (drag.moved && !reducedMotion()) {
    const p = Q.clamp(
      drag.p - dx / (cockpit.clientWidth * 0.38),
      Math.max(0, drag.chapter - 1),
      Math.min(lastChapter, drag.chapter + 1),
    );
    setProgress(p);
    motionState();
  }
});
window.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const completedDrag = drag;
  drag = null;
  if (completedDrag.moved) {
    const dx = e.clientX - completedDrag.x;
    suppressClickUntil = performance.now() + 350;
    go(
      Math.abs(dx) > Math.max(28, cockpit.clientWidth * 0.04)
        ? completedDrag.chapter - Math.sign(dx)
        : completedDrag.chapter,
    );
  } else if (
    completedDrag.tap !== null &&
    Math.hypot(e.clientX - completedDrag.x, e.clientY - completedDrag.y) <= 6 &&
    windowDestination(e.clientX, e.clientY) === completedDrag.tap
  ) {
    go(completedDrag.tap);
  }
  motionState();
});
function cancelDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const shouldSettle = drag.moved;
  drag = null;
  if (shouldSettle) go(Math.round(progress));
  motionState();
}
window.addEventListener('pointercancel', cancelDrag);
// Touch starts with implicit capture on a child. Transferring that capture to
// the cockpit is expected; only losing our own capture cancels the swipe.
cockpit.addEventListener('lostpointercapture', (e) => {
  if (e.target === cockpit) cancelDrag(e);
});

function activeArticle() {
  return displays[0].panels.get(current);
}
// Keep native scrolling/selection inside the article. A vertical touch anywhere
// else operates that same reader, without stealing horizontal travel or hinges.
let readingTouch = null;
// Cancelable movement handlers make the compositor wait for the main thread.
// Native article reading needs no such handler while the 3D controls prepare.
const interactiveMovement = (type, handler, options) => {
  const install = () => cockpit.addEventListener(type, handler, options);
  if (window.HybridBoot) window.HybridBoot.whenReady(install);
  else install();
};
cockpit.addEventListener(
  'touchstart',
  (e) => {
    readingTouch = null;
    if (
      !ready ||
      window.CockpitEntrance.blocked ||
      e.touches.length !== 1 ||
      e.target.closest('.screen-article')
    )
      return;
    const touch = e.touches[0];
    readingTouch = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lastY: touch.clientY,
      axis: null,
    };
  },
  { passive: true },
);
interactiveMovement(
  'touchmove',
  (e) => {
    if (!readingTouch || tilt?.drag?.active) return;
    if (e.touches.length !== 1) {
      readingTouch = null;
      return;
    }
    const touch = e.touches[0],
      gesture = readingTouch;
    if (touch.identifier !== gesture.id) return;
    const dx = touch.clientX - gesture.x,
      dy = touch.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(dx, dy) > 6)
      gesture.axis = Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal';
    if (gesture.axis !== 'vertical') return;
    tilt?.finish();
    if (e.cancelable) e.preventDefault();
    // A monitor's pending tap must not navigate after a reading swipe.
    hinges?.finishDrag();
    if (drag) {
      const id = drag.id;
      drag = null;
      if (cockpit.hasPointerCapture(id)) cockpit.releasePointerCapture(id);
      motionState();
    }
    const article = activeArticle();
    if (article) article.scrollTop += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    suppressClickUntil = performance.now() + 350;
  },
  { passive: false, capture: true },
);
const endReadingTouch = () => {
  readingTouch = null;
};
window.addEventListener('touchend', endReadingTouch);
window.addEventListener('touchcancel', endReadingTouch);
window.addEventListener('blur', endReadingTouch);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endReadingTouch();
});
const wheel = { last: 0, locked: false, axis: null, axisTime: 0, idleMs: 180 };
function wheelDestination(a) {
  if (Math.abs(a.input) < 0.1) return Math.round(a.startProgress);
  return Q.clamp(
    a.input > 0
      ? Math.floor(a.startProgress + 0.0001) + 1
      : Math.ceil(a.startProgress - 0.0001) - 1,
    0,
    lastChapter,
  );
}
interactiveMovement(
  'wheel',
  (e) => {
    if (drag) drag.tap = null;
    if (!ready || window.CockpitEntrance.blocked || e.ctrlKey) return;
    if (!e.deltaX && !e.deltaY) return;
    const now = performance.now();
    const article = activeArticle();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1;
    const x = Math.abs(e.deltaX * unit),
      y = Math.abs(e.deltaY * unit);
    const axis = y >= x ? 'vertical' : 'horizontal';
    const axisChanged =
      axis !== wheel.axis && Math.max(x, y) >= 12 && Math.max(x, y) > Math.min(x, y) * 2;
    // Ignore a small diagonal momentum tail, but accept a deliberate change of
    // axis immediately. Reading must not wait for horizontal travel to finish.
    if (!wheel.axis || now - wheel.axisTime >= wheel.idleMs || axisChanged) {
      wheel.axis = axis;
    }
    wheel.axisTime = now;
    if (wheel.axis === 'vertical') {
      // Vertical means reading everywhere, even over links, the window or controls.
      // Leave the native article event alone to preserve browser scroll momentum.
      if (article && (!article.contains(e.target) || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        e.preventDefault();
        article.scrollTop +=
          e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? article.clientHeight : 1);
      }
      return;
    }
    if (hinges?.drag) {
      e.preventDefault();
      return;
    }
    const delta = e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1);
    if (!delta) return;
    const sign = Math.sign(delta),
      quiet = now - wheel.last;
    if (
      !animation &&
      pendingNavigation === null &&
      ((progress === 0 && sign < 0) || (progress === lastChapter && sign > 0))
    )
      return;
    e.preventDefault();
    wheel.last = now;
    if (reducedMotion()) {
      if (quiet >= wheel.idleMs || axisChanged) void go(navOrigin() + sign);
      return;
    }
    const reversing =
      animation?.type === 'wheel' && Math.sign(animation.input) === -sign && Math.abs(delta) >= 12;
    const freshGesture = quiet >= wheel.idleMs || axisChanged || reversing;
    if (animation?.type !== 'wheel' || freshGesture) {
      if (wheel.locked && !freshGesture) return;
      // Each fresh gesture may continue the journey before the previous one
      // settles. Keep the displayed position continuous; only rebase its target.
      // Reversals start from what is visible, never from an unreached destination.
      const intent =
        animation?.type === 'wheel'
          ? wheelDestination(animation)
          : (pendingNavigation ?? animation?.target);
      const origin =
        Number.isFinite(intent) && Math.sign(intent - progress) === sign ? intent : progress;
      const target = Q.clamp(
        sign > 0 ? Math.floor(origin + 0.0001) + 1 : Math.ceil(origin - 0.0001) - 1,
        0,
        lastChapter,
      );
      if (pathLegs(progress, target).some((leg) => !preparedLegs.has(leg))) {
        wheel.locked = true;
        go(target);
        return;
      }
      stopMotion();
      chapterHistory.begin();
      wheel.locked = true;
      animation = {
        type: 'wheel',
        startProgress: origin,
        input: 0,
        target: progress,
        tick: now,
        settling: false,
      };
      frame = window.CockpitFrame.request(tick);
    }
    const low = Math.max(0, Math.ceil(animation.startProgress - 0.0001) - 1),
      high = Math.min(lastChapter, Math.floor(animation.startProgress + 0.0001) + 1);
    animation.input = Q.clamp(
      animation.input + Q.clamp(delta, -120, 120) / 240,
      low - animation.startProgress,
      high - animation.startProgress,
    );
    animation.target = animation.startProgress + animation.input;
    animation.settling = false;
    motionState();
  },
  { passive: false },
);

document.addEventListener('keydown', (e) => {
  if (drag) drag.tap = null;
  if (window.CockpitEntrance.blocked) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName))
    return;
  // Buttons keep Enter/Space semantics, while arrow navigation works after a click.
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (!e.repeat) next();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (!e.repeat) previous();
  } else if (!e.target.closest('.screen-article,[role="slider"]')) {
    // Reading keys also work after using a chapter arrow or clicking the window.
    // Space/Enter on buttons and links retain their ordinary activation behavior.
    const article = activeArticle();
    if (!article) return;
    const page = article.clientHeight * 0.82;
    const step = {
      ArrowDown: 42,
      ArrowUp: -42,
      PageDown: page,
      PageUp: -page,
      Home: -article.scrollHeight,
      End: article.scrollHeight,
    }[e.key];
    const blankSpace = e.key === ' ' && !e.target.closest('button,a');
    if (step !== undefined || blankSpace) {
      e.preventDefault();
      article.focus({ preventScroll: true });
      article.scrollBy({ top: step ?? (e.shiftKey ? -page : page), behavior: 'auto' });
    }
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (animation || drag)) stopMotion(true);
});
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(stage);
resizeObserver.observe($('.site-header'));
resizeObserver.observe($('#reading-layout'));
if (canvas.parentElement !== stage) resizeObserver.observe(canvas.parentElement);
// The physical display applies its final intrinsic glass dimensions after the
// outer layout. Observe those dimensions so resize cues use the finished reader.
const readingResizeObserver = new ResizeObserver(updateReadingPosition);
readingResizeObserver.observe($('#center-screen'));
async function load() {
  let preparationFailed = false;
  // Fail the veil immediately, but drain every owner before disposing it. A
  // fail-fast Promise.all can otherwise publish a late renderer after cleanup.
  const settlePreparation = async (tasks) => {
    const results = await Promise.allSettled(
      tasks.map((task) =>
        Promise.resolve(task).catch((error) => {
          preparationFailed = true;
          window.CockpitEntrance.fail();
          throw error;
        }),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (window.CockpitEntrance.state === 'failed') throw new Error('Cockpit preparation stopped');
  };
  try {
    performance.mark('cockpit-load-start');
    hardwareMask = loadImage('assets/hardware-without-center.svg?v=17');
    // Fetch only the visible entry artwork/side previews and its cabin. Full
    // journey preparation starts after the entrance, not behind its veil.
    const entryArt = stationImages(entryChapter);
    const artworkReady = settlePreparation([
      ...['cockpit-ceiling.svg', 'cabin-luminous.svg'].map(async (file) => {
        const image = new Image();
        image.src = 'assets/' + file;
        await image.decode();
      }),
      ...[...entryArt, 'stars'].map(loadArtwork),
      loadCabin(entryChapter),
      hardwareMask,
    ]).then(() => performance.mark('cockpit-art-ready'));
    const displaysReady = (async () => {
      hinges = await window.HingedMonitors.load(stage, $('#monitors'), (destination) =>
        go(destination),
      );
      performance.mark('cockpit-hinges-ready');
      if (preparationFailed) return;
      tilt = new window.ConsoleTilt($('#display-assembly'), $('#tilt-grip'), $('#reading-layout'));
      // Keep the same parked pose: the left endpoint stays folded, while the
      // right display unfolds with the main display during the head lift.
      hinges.setJourneyProgress(entryChapter);
      hinges.set('left', window.HybridBoot && entryChapter !== 0 ? 0 : hinges.data.maxAngle);
      hinges.set(
        'right',
        window.HybridBoot && entryChapter !== lastChapter ? 0 : hinges.data.maxAngle,
      );
      tilt.set(window.HybridBoot ? 0 : 45);
      try {
        await window.PhysicalConsole.load(hinges, tilt);
      } catch (error) {
        if (preparationFailed || window.HybridBoot) throw error;
        // The sprite fallback needs decoded cabin plates even if its renderer
        // fails before the independent artwork branch finishes.
        await artworkReady;
        hinges.setLighting(hardware[entryChapter], hardware[entryChapter], 0);
        await hinges.loadSprites();
        stage.dataset.displayRenderer = 'flat';
        console.warn(
          'Live display lighting unavailable; continuing with the readable cockpit.',
          error,
        );
      }
      performance.mark('cockpit-displays-ready');
    })();
    await settlePreparation([
      displaysReady,
      artworkReady.then(async () => {
        if (preparationFailed) return;
        await prepareHardwareSurfaces();
        if (preparationFailed) return;
        await preparePreviewSurfaces();
        performance.mark('cockpit-surfaces-ready');
        scene = await Q.create(canvas, images);
        instruments =
          window.HybridBoot?.instruments || new window.ConsoleInstruments($('#instruments'));
        instruments.prepare(hardware);
        performance.mark('cockpit-scenes-ready');
      }),
    ]);
    stationLoads.set(entryChapter, Promise.resolve());
    hinges.setLighting(hardware[entryChapter], hardware[entryChapter], 0);
    // Keep the fixed chapter set attached. Native scroll positions persist and
    // chapter handovers never insert nodes or synchronously measure scrolling.
    for (const display of displays)
      for (let index = 0; index < chapters.length; index++) {
        const panel = displayPanel(index, display.offset);
        display.cache.set(index, panel);
        display.panels.set(index, panel);
        if (panel.parentElement !== display.element) display.element.append(panel);
      }
    if (!window.HybridBoot)
      for (const article of document.querySelectorAll('.screen-article')) article.scrollTop = 0;
    window.CockpitEntrance.prepared();
    ready = true;
    updateChapter(entryChapter);
    resize();
    motionState();
    // Journey paints enqueue monitor/optics paints. The veil remains opaque
    // through all of them and through the following browser presentation.
    const painted = async () => {
      await window.ConsoleLayout.whenMeasured(() => {
        resizeNow();
        drawNow();
        return !hinges.physical || hinges.physical.render();
      });
      await new Promise((resolve) =>
        window.CockpitFrame.paint('entrance-ready', () => requestAnimationFrame(resolve), 1000),
      );
    };
    await painted();
    await new Promise(requestAnimationFrame);
    await window.ConsoleLayout.whenMeasured();
    await window.CockpitEntrance.reveal((lift) => {
      tilt.set(45 * (1 - lift));
      hinges.set('left', hinges.data.maxAngle * (entryChapter === 0 ? 1 : 1 - lift));
      hinges.set('right', hinges.data.maxAngle * (entryChapter === lastChapter ? 1 : 1 - lift));
    });
    resize();
    await painted();
    if (window.HybridBoot) window.HybridBoot.physical = hinges.physical;
    window.CockpitEntrance.complete();
    if (window.HybridExport) {
      window.hybridExport = window.HybridExport(hinges.physical, scene);
      window.hybridExport.instruments = instruments;
      window.hybridExport.cabin = hardware[entryChapter];
    }
    if (!window.CockpitEntrance.blocked) {
      stage.dataset.ready = 'true';
      void warmJourney();
    }
  } catch (error) {
    ready = false;
    window.CockpitEntrance.fail();
    // Both preparation paths have settled. No sibling can now recreate or
    // publish graphics behind the failed veil; Try again remains a full reset.
    hinges?.physical?.dispose();
    scene?.dispose();
    scene = null;
    instruments?.dispose();
    instruments = null;
    if (window.HybridBoot) cockpit.classList.add('physical-console');
    performance.mark('cockpit-startup-disposed');
    console.error(error);
  }
}
load();
