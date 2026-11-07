'use strict';

// Small pre-rendered 3D assemblies over a clean cockpit plate. Text remains HTML.
// Manual hinge positions are independent. At an endpoint the unavailable panel
// acts like a door closer: hold it open, then let go and it folds forward again.
window.HingedMonitors = class {
  constructor(stage, canvas, metadata, frames, navigate) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // The shell can fit the windshield independently of the display assembly.
    // Keep state on the journey stage, but project into the displays' own box.
    this.displayStage = canvas.parentElement;
    this.data = metadata;
    this.frames = frames;
    this.navigate = navigate;
    this.angles = { left: 0, right: 0 };
    this.drag = null;
    this.spriteLayers = new Map();
    this.lighting = null;
    this.sideDisplays = true;
    this.sideVisibilityDirty = true;
    this.progress = null;
    this.lastChapter = window.CHAPTERS.length - 1;
    this.doors = { left: null, right: null };
    this.reopening = { left: null, right: null };
    this.doorFrame = 0;
    this.poseBounds = Object.fromEntries(
      ['left', 'right'].map((side) => {
        const rects = metadata[side].map((frame) => frame.rect);
        return [
          side,
          {
            left: Math.min(...rects.map((rect) => rect[0])),
            top: Math.min(...rects.map((rect) => rect[1])),
            right: Math.max(...rects.map((rect) => rect[0] + rect[2])),
            bottom: Math.max(...rects.map((rect) => rect[1] + rect[3])),
          },
        ];
      }),
    );
    for (const side of ['left', 'right']) {
      for (const element of [
        document.getElementById('monitor-hit-' + side),
        document.getElementById('hinge-' + side),
      ])
        this.bind(element, side);
    }
    window.addEventListener('blur', () => this.finishDrag());
    this.placements = new Map();
    window.CockpitMotion.addEventListener('change', (event) => {
      if (event.matches) this.settleDoors();
    });
  }
  static async load(stage, canvas, navigate) {
    const response = await fetch('hinges.json');
    if (!response.ok) throw new Error('Monitor geometry could not load');
    return new this(stage, canvas, await response.json(), new Map(), navigate);
  }
  async loadSprites() {
    await Promise.all(
      [...this.data.left, ...this.data.right].map(async (frame) => {
        const image = new Image();
        image.src = frame.src;
        await image.decode();
        this.frames.set(frame.src, image);
      }),
    );
    this.render();
  }
  clamp(angle) {
    return Math.min(this.data.maxAngle, Math.max(0, angle));
  }
  smooth(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }
  setJourneyProgress(progress) {
    const first = this.progress === null;
    const previousChapter = first ? null : Math.round(this.progress);
    this.progress = Math.max(0, Math.min(this.lastChapter, progress));
    // An endpoint closes its unavailable display completely. Its next usable
    // position must be open, not an old manual fold restored after navigation.
    // Reset here, while the automatic fold masks it (or before the first paint),
    // so departure keeps the existing continuous opening animation.
    const unavailable =
      this.progress === 0 ? 'left' : this.progress === this.lastChapter ? 'right' : null;
    if (unavailable && this.angles[unavailable] !== 0) {
      this.angles[unavailable] = 0;
    }
    for (const side of ['left', 'right']) {
      const available =
        side === 'left'
          ? Math.round(this.progress) > 0
          : Math.round(this.progress) < this.lastChapter;
      const wasAvailable =
        previousChapter === null ||
        (side === 'left' ? previousChapter > 0 : previousChapter < this.lastChapter);
      if (!available && this.reopening[side]) {
        this.reopening[side] = null;
        this.stopIdleDoorFrame();
      } else if (
        available &&
        !wasAvailable &&
        this.angles[side] > 0 &&
        !(this.drag?.side === side && !this.drag.temporary)
      ) {
        if (!this.sideDisplays || window.CockpitMotion.matches) {
          this.angles[side] = 0;
          continue;
        }
        // A swipe can reverse before reaching the fully closed endpoint. The
        // button still changes from unavailable to available, so open smoothly
        // from the current manual pose instead of exposing a folded target.
        this.reopening[side] = { start: performance.now(), angle: this.angles[side] };
        if (!this.doorFrame)
          this.doorFrame = window.CockpitFrame.request((now) => this.animateDoors(now));
      }
    }
    // The opening view starts with the unavailable left display already folded.
  }
  endpointFold(side) {
    if (this.progress === null) return 0;
    return side === 'left'
      ? 1 - this.smooth(this.progress / 0.42)
      : this.smooth((this.progress - (this.lastChapter - 0.42)) / 0.42);
  }
  foldAmount(side) {
    return this.endpointFold(side);
  }
  baseAngle(side) {
    return this.angles[side] + (this.data.maxAngle - this.angles[side]) * this.foldAmount(side);
  }
  doorWeight(side) {
    return this.doors[side] ? Math.min(1, this.foldAmount(side) / this.doors[side].fold) : 0;
  }
  angle(side) {
    return this.clamp(
      this.baseAngle(side) + (this.doors[side]?.offset || 0) * this.doorWeight(side),
    );
  }
  holdDoor(side, visibleAngle) {
    // The hand owns this temporary pose, including a return interrupted mid-close.
    this.doors[side] = {
      fold: Math.max(0.0001, this.foldAmount(side)),
      offset: visibleAngle - this.baseAngle(side),
    };
    this.stopIdleDoorFrame();
  }
  closeDoor(side) {
    const door = this.doors[side];
    if (!door) return;
    if (window.CockpitMotion.matches) {
      this.doors[side] = null;
      this.stopIdleDoorFrame();
      this.render();
      return;
    }
    if (this.foldAmount(side) < 0.0001 || Math.abs(door.offset) < 0.02) {
      this.doors[side] = null;
      this.stopIdleDoorFrame();
      return;
    }
    door.start = performance.now();
    door.releaseOffset = door.offset;
    if (!this.doorFrame)
      this.doorFrame = window.CockpitFrame.request((now) => this.animateDoors(now));
  }
  stopIdleDoorFrame() {
    if (
      Object.values(this.doors).some((door) => door?.start !== undefined) ||
      Object.values(this.reopening).some(Boolean)
    )
      return;
    window.CockpitFrame.cancel(this.doorFrame);
    this.doorFrame = 0;
  }
  settleDoors() {
    window.CockpitFrame.cancel(this.doorFrame);
    this.doorFrame = 0;
    for (const side of ['left', 'right']) {
      if (this.reopening[side]) this.angles[side] = 0;
      this.reopening[side] = null;
      // Direct dragging still follows the visitor's hand; only auto-return stops.
      if (this.doors[side]?.start !== undefined) this.doors[side] = null;
    }
    this.render();
  }
  animateDoors(now) {
    if (window.CockpitMotion.matches) {
      this.settleDoors();
      return;
    }
    this.doorFrame = 0;
    for (const side of ['left', 'right']) {
      const opening = this.reopening[side];
      if (opening) {
        const elapsed = (now - opening.start) / 260;
        this.angles[side] = opening.angle * (1 - this.smooth(elapsed));
        if (elapsed >= 1) {
          this.reopening[side] = null;
        }
      }
      const door = this.doors[side];
      if (door?.start === undefined) continue;
      // Critically damped return: no bounce through the hard hinge stop. The
      // elapsed clock also settles immediately after a background-tab pause.
      const elapsed = Math.max(0, (now - door.start) / 1000),
        phase = elapsed * 12;
      door.offset = door.releaseOffset * (1 + phase) * Math.exp(-phase);
      if (Math.abs(door.offset * this.doorWeight(side)) < 0.02 || elapsed > 1.2)
        this.doors[side] = null;
    }
    this.render();
    if (
      Object.values(this.doors).some((door) => door?.start !== undefined) ||
      Object.values(this.reopening).some(Boolean)
    )
      this.doorFrame = window.CockpitFrame.request((time) => this.animateDoors(time));
  }
  set(side, angle) {
    this.angles[side] = this.clamp(angle);
    this.render();
  }
  activate(element) {
    if (
      !this.sideDisplays ||
      element.getAttribute('aria-disabled') === 'true' ||
      !element.hasAttribute('data-destination')
    )
      return;
    const destination = Number(element.dataset.destination);
    if (Number.isInteger(destination)) this.navigate(destination);
  }
  finishDrag(event, allowTap = false) {
    const drag = this.drag;
    if (!drag || (event && drag.id !== event.pointerId)) return;
    const tapped =
      allowTap && !drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 6;
    this.drag = null;
    delete this.stage.dataset.adjusting;
    if (drag.temporary) this.closeDoor(drag.side);
    if (drag.element.hasPointerCapture(drag.id)) drag.element.releasePointerCapture(drag.id);
    this.render();
    const rect = drag.element.getBoundingClientRect();
    if (
      tapped &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    )
      this.activate(drag.element);
  }
  bind(element, side) {
    element.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        !this.sideDisplays
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (this.drag || event.isPrimary === false) return;
      if (this.reopening[side]) {
        this.reopening[side] = null;
        this.stopIdleDoorFrame();
      }
      const visibleAngle = this.angle(side),
        temporary = this.endpointFold(side) > 0.0001;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      if (temporary) this.holdDoor(side, visibleAngle);
      this.drag = {
        side,
        element,
        temporary,
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        angle: visibleAngle,
        base: this.baseAngle(side),
        distance: Math.max(1, this.displayStage.clientWidth * 0.14),
        moved: false,
        horizontal: false,
      };
      this.stage.dataset.adjusting = side;
      this.render();
    });
    element.addEventListener('pointermove', (event) => {
      if (!this.drag || this.drag.id !== event.pointerId || this.drag.side !== side) return;
      const dx = event.clientX - this.drag.x,
        dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 6) this.drag.moved = true;
      if (!this.drag.moved) return;
      event.preventDefault();
      event.stopPropagation();
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) this.drag.horizontal = true;
      if (this.drag.horizontal) {
        const angle = this.clamp(
          this.drag.angle +
            ((dx * (side === 'left' ? 1 : -1)) / this.drag.distance) * this.data.maxAngle,
        );
        if (this.drag.temporary) {
          // Weight the entire temporary opening by the journey fold. Navigating
          // away restores the saved normal pose even if the pointer stays down.
          this.doors[side].offset = angle - this.drag.base;
          this.render();
        } else this.set(side, angle);
      }
    });
    element.addEventListener('pointerup', (event) => {
      if (!this.drag || this.drag.id !== event.pointerId || this.drag.side !== side) return;
      event.preventDefault();
      event.stopPropagation();
      this.finishDrag(event, true);
    });
    const cancel = (event) => {
      if (this.drag?.side === side) this.finishDrag(event);
    };
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('lostpointercapture', cancel);
    // Pointer activation was handled above. Its subsequent click must never
    // navigate after a drag or fire twice. Keyboard/assistive clicks still work.
    element.addEventListener('click', (event) => {
      if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.detail === 0 && !this.drag) this.activate(element);
    });
  }
  sample(side) {
    const frames = this.data[side],
      angle = this.angle(side);
    let index = 0;
    while (index < frames.length - 2 && frames[index + 1].angle < angle) index++;
    const a = frames[index],
      b = frames[Math.min(index + 1, frames.length - 1)],
      t = b.angle === a.angle ? 0 : (angle - a.angle) / (b.angle - a.angle);
    const interpolate = (key) => a[key].map((p, i) => p.map((v, j) => v + (b[key][i][j] - v) * t));
    return {
      a,
      b,
      t,
      angle,
      quad: interpolate('quad'),
      bodyQuad: interpolate(a.bodyQuad && b.bodyQuad ? 'bodyQuad' : 'shellQuad'),
      visible: a.frontFacing !== false && b.frontFacing !== false,
    };
  }
  // The main bezel is responsive HTML. Keep the original rigid side assemblies
  // attached to its actual edges, rather than the old baked-in screen position.
  displayRect() {
    // The parent applies the shared tilt after this projection. Measure only
    // the display container's own layout and centering translation, so its
    // already-tilted bounding box cannot apply that perspective a second time.
    const element = this.displayStage,
      transform = getComputedStyle(element).transform;
    const matrix = transform === 'none' ? { m41: 0, m42: 0 } : new DOMMatrixReadOnly(transform);
    return {
      left: element.offsetLeft + matrix.m41,
      top: element.offsetTop + matrix.m42,
      width: element.clientWidth,
      height: element.clientHeight,
    };
  }
  invalidateLayout() {
    this.placements.clear();
    this.sideVisibilityDirty = true;
  }
  setSideDisplays(visible) {
    this.stage.dataset.sideDisplays = String(visible);
    if (this.sideDisplays === visible) return;
    this.sideDisplays = visible;
    this.placements.clear();
    if (!visible) {
      // Preserve deliberate desktop folds, but finish temporary door gestures
      // and invisible animations before a phone layout replaces the controls.
      const drag = this.drag;
      this.drag = null;
      delete this.stage.dataset.adjusting;
      if (drag) {
        if (drag.element.hasPointerCapture(drag.id)) drag.element.releasePointerCapture(drag.id);
      }
      window.CockpitFrame.cancel(this.doorFrame);
      this.doorFrame = 0;
      for (const side of ['left', 'right']) {
        this.doors[side] = null;
        if (this.reopening[side]) {
          this.angles[side] = 0;
          this.reopening[side] = null;
        }
      }
    }
    for (const side of ['left', 'right'])
      for (const id of ['side-', 'monitor-hit-', 'hinge-']) {
        const element = document.getElementById(id + side);
        if (!visible && element.contains(document.activeElement)) document.activeElement?.blur();
        element.inert = !visible;
        if (!visible) element.setAttribute('aria-hidden', 'true');
        else if (id !== 'hinge-') element.removeAttribute('aria-hidden');
      }
  }
  placement(side) {
    if (this.placements.has(side)) return this.placements.get(side);
    const stage = this.displayRect();
    const reader = (
      document.getElementById('reading-layout') || document.querySelector('.reading-device')
    )?.getBoundingClientRect();
    const hinge = this.data.hinges?.[side];
    if (!reader || !hinge || !stage.width || !stage.height)
      return { x: 0, y: 0, scale: 1, stage, reader };
    const x = (hinge.top[0] + hinge.bottom[0]) / 2;
    const y = (hinge.top[1] + hinge.bottom[1]) / 2;
    const open = this.data[side][0];
    const body = open.bodyQuad || open.shellQuad;
    const bodyBottom = Math.max(...body.map((point) => point[1]));
    const edge = side === 'left' ? reader.left : reader.right;
    const sign = side === 'left' ? -1 : 1,
      gap = 7;
    const bounds = this.poseBounds[side],
      pivotX = (reader.left + reader.right) / 2;
    const perspective = Math.max(3200, window.innerWidth * 4);
    const sourceHeight = (bodyBottom - Math.min(...body.map((point) => point[1]))) * stage.height;
    const desiredHeight = Math.min(reader.height * 0.55, 280, window.innerHeight * 0.28);
    const anchor = (scale) => ({
      x: edge + sign * gap,
      y: reader.bottom - 5 - (bodyBottom - y) * stage.height * scale,
    });
    // Fit every sprite frame's envelope at the shared assembly's full tilt
    // range using neutral measurements, so devices never resize during a drag.
    const fits = (scale) => {
      const target = anchor(scale);
      for (const sourceX of [bounds.left, bounds.right])
        for (const sourceY of [bounds.top, bounds.bottom]) {
          const px = target.x + (sourceX / this.data.width - x) * stage.width * scale;
          const py = target.y + (sourceY / this.data.height - y) * stage.height * scale;
          for (const angle of [0, Math.PI / 8, Math.PI / 4]) {
            const denominator = 1 + ((py - reader.bottom) * Math.sin(angle)) / perspective;
            const tiltedX = pivotX + (px - pivotX) / denominator;
            const tiltedY = reader.bottom + ((py - reader.bottom) * Math.cos(angle)) / denominator;
            if (
              denominator <= 0 ||
              tiltedX < 14 ||
              tiltedX > window.innerWidth - 14 ||
              tiltedY < 14 ||
              tiltedY > window.innerHeight - 14
            )
              return false;
          }
        }
      return true;
    };
    let scale = desiredHeight / sourceHeight;
    if (!fits(scale)) {
      let low = 0,
        high = scale;
      for (let step = 0; step < 22; step++) {
        const middle = (low + high) / 2;
        if (fits(middle)) low = middle;
        else high = middle;
      }
      scale = low;
    }
    const { x: targetX, y: targetY } = anchor(scale);
    this.stage.dataset[side + 'HingeX'] = targetX.toFixed(2);
    this.stage.dataset[side + 'HingeY'] = targetY.toFixed(2);
    this.stage.dataset[side + 'HingeGap'] = gap.toFixed(2);
    this.stage.dataset[side + 'AssemblyScale'] = scale.toFixed(4);
    const placement = {
      x: (targetX - stage.left) / stage.width - x * scale,
      y: (targetY - stage.top) / stage.height - y * scale,
      scale,
      stage,
      reader,
      gap,
    };
    this.placements.set(side, placement);
    return placement;
  }
  translate(points, placement) {
    return points.map(([x, y]) => [
      x * placement.scale + placement.x,
      y * placement.scale + placement.y,
    ]);
  }
  setLighting(base, next, mix) {
    this.lighting = { base, next, mix: Math.max(0, Math.min(1, mix)) };
  }
  spriteLayer(side, sample) {
    let layer = this.spriteLayers.get(side);
    if (!layer) {
      const rects = this.data[side].map((frame) => frame.rect);
      const x = Math.min(...rects.map((rect) => rect[0])),
        y = Math.min(...rects.map((rect) => rect[1]));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(...rects.map((rect) => rect[0] + rect[2])) - x;
      canvas.height = Math.max(...rects.map((rect) => rect[1] + rect[3])) - y;
      layer = { canvas, ctx: canvas.getContext('2d'), x, y, angle: null };
      this.spriteLayers.set(side, layer);
    }
    if (layer.angle !== sample.angle) {
      const c = layer.ctx;
      c.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      // Add only the two weighted poses. The finished opaque device is then
      // composited normally over its hinge, never added to the hinge's light.
      c.globalCompositeOperation = 'lighter';
      for (const [frame, opacity] of [
        [sample.a, 1 - sample.t],
        [sample.b, sample.t],
      ]) {
        if (opacity < 0.00001) continue;
        const [x, y, width, height] = frame.rect;
        c.globalAlpha = opacity;
        c.drawImage(this.frames.get(frame.src), x - layer.x, y - layer.y, width, height);
      }
      c.globalAlpha = 1;
      layer.angle = sample.angle;
    }
    return layer;
  }
  drawMount(side, placement) {
    // These are the original fixed hinge barrels, cropped directly from the
    // accepted Blender plates. The moving WebP sprites do not include them.
    const source = side === 'left' ? [416, 598, 38, 126] : [1146, 598, 38, 126];
    const x = source[0] * placement.scale + placement.x * this.data.width;
    const y = source[1] * placement.scale + placement.y * this.data.height;
    const base = this.lighting?.base || document.getElementById('hardware-base');
    const next = this.lighting?.next || document.getElementById('hardware-next');
    const mix = this.lighting
      ? this.lighting.mix
      : Math.max(0, Math.min(1, Number(next?.style.opacity) || 0));
    // Match the hardware plates: a complete base with the next light over it.
    // setLighting supplies decoded images, independent of pending DOM src swaps.
    for (const [image, alpha] of [
      [base, 1],
      [next, mix],
    ]) {
      if (!image?.complete || !image.naturalWidth || alpha <= 0) continue;
      this.ctx.globalAlpha = alpha;
      this.ctx.drawImage(
        image,
        ...source,
        x,
        y,
        source[2] * placement.scale,
        source[3] * placement.scale,
      );
    }
  }
  // Unit-square projective transform, normalized to each HTML plane's dimensions.
  project(element, points) {
    const width = this.displayStage.clientWidth,
      height = this.displayStage.clientHeight;
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points.map(([x, y]) => [
      x * width,
      y * height,
    ]);
    const dx1 = x1 - x2,
      dx2 = x3 - x2,
      dx3 = x0 - x1 + x2 - x3,
      dy1 = y1 - y2,
      dy2 = y3 - y2,
      dy3 = y0 - y1 + y2 - y3;
    const denominator = dx1 * dy2 - dx2 * dy1;
    const g = Math.abs(denominator) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / denominator,
      h = Math.abs(denominator) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / denominator;
    const w = element.offsetWidth,
      hh = element.offsetHeight;
    element.style.transform = `matrix3d(${(x1 - x0 + g * x1) / w},${(y1 - y0 + g * y1) / w},0,${g / w},${(x3 - x0 + h * x3) / hh},${(y3 - y0 + h * y3) / hh},0,${h / hh},0,0,1,0,${x0},${y0},0,1)`;
  }
  // A small margin around the whole device is easier to grab than the glass.
  // Keep the inner boundary clear of the main reader, even on narrow screens.
  positionHit(element, points, side, placement) {
    const width = this.displayStage.clientWidth,
      height = this.displayStage.clientHeight;
    const padding = Math.max(8, Math.min(18, width * 0.012));
    const xs = points.map((p) => p[0] * width),
      ys = points.map((p) => p[1] * height);
    let left = Math.min(...xs) - padding,
      right = Math.max(...xs) + padding;
    const readerLeft = placement.reader
      ? placement.reader.left - placement.stage.left
      : width * 0.286;
    const readerRight = placement.reader
      ? placement.reader.right - placement.stage.left
      : width * 0.714;
    if (side === 'left') {
      right = Math.min(right, readerLeft - 2);
      left = Math.min(left, right - 44);
    } else {
      left = Math.max(left, readerRight + 2);
      right = Math.max(right, left + 44);
    }
    left = Math.max(0, 14 - placement.stage.left, left);
    right = Math.max(left, Math.min(width, window.innerWidth - 14 - placement.stage.left, right));
    const top = Math.max(0, -placement.stage.top, Math.min(...ys) - padding);
    const bottom = Math.max(
      top,
      Math.min(height, window.innerHeight - placement.stage.top, Math.max(...ys) + padding),
    );
    Object.assign(element.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      visibility: placement.scale > 0 && right > left && bottom > top ? 'visible' : 'hidden',
    });
  }
  render() {
    window.CockpitFrame.paint('monitors', () => this.renderNow(), 20);
  }
  renderNow() {
    if (this.sideVisibilityDirty) {
      const reader = document.getElementById('reading-layout').getBoundingClientRect();
      this.setSideDisplays(window.ConsoleLayout.measure(reader).sideDisplays);
      this.sideVisibilityDirty = false;
    }
    for (const side of ['left', 'right']) {
      const door = this.doors[side];
      this.stage.dataset[side + 'DoorState'] =
        this.drag?.side === side && this.drag.temporary
          ? 'held'
          : door?.start !== undefined
            ? 'returning'
            : this.reopening[side]
              ? 'opening'
              : this.foldAmount(side) > 0.0001
                ? 'closed'
                : 'manual';
      this.stage.dataset[side + 'DoorOffset'] = (
        (door?.offset || 0) * this.doorWeight(side)
      ).toFixed(3);
    }
    if (this.physical) {
      this.physical.render();
      return;
    }
    const c = this.ctx;
    c.setTransform(
      this.canvas.width / this.data.width,
      0,
      0,
      this.canvas.height / this.data.height,
      0,
      0,
    );
    c.clearRect(0, 0, this.data.width, this.data.height);
    c.globalCompositeOperation = 'source-over';
    if (!this.sideDisplays) {
      for (const side of ['left', 'right'])
        for (const id of ['side-', 'monitor-hit-', 'hinge-'])
          Object.assign(document.getElementById(id + side).style, {
            visibility: 'hidden',
            pointerEvents: 'none',
          });
      return;
    }
    if (!this.frames.size) return;
    for (const side of ['left', 'right']) {
      const sample = this.sample(side),
        placement = this.placement(side);
      this.drawMount(side, placement);
      const layer = this.spriteLayer(side, sample);
      c.globalAlpha = 1;
      c.drawImage(
        layer.canvas,
        layer.x * placement.scale + placement.x * this.data.width,
        layer.y * placement.scale + placement.y * this.data.height,
        layer.canvas.width * placement.scale,
        layer.canvas.height * placement.scale,
      );
      const screen = document.getElementById('side-' + side),
        hit = document.getElementById('monitor-hit-' + side),
        grip = document.getElementById('hinge-' + side);
      this.project(screen, this.translate(sample.quad, placement));
      this.positionHit(hit, this.translate(sample.bodyQuad, placement), side, placement);
      screen.style.visibility = sample.visible && placement.scale > 0 ? 'visible' : 'hidden';
      screen.style.pointerEvents = '';
      const hinge = this.data.hinges?.[side];
      if (hinge) {
        grip.style.left = `${(((hinge.top[0] + hinge.bottom[0]) / 2) * placement.scale + placement.x) * 100}%`;
        grip.style.top = `${(((hinge.top[1] + hinge.bottom[1]) / 2) * placement.scale + placement.y) * 100}%`;
        grip.style.width = `${Math.max(0, (placement.gap ?? 10) * 2 - 2)}px`;
        grip.style.height = `${17 * placement.scale}%`;
        grip.style.visibility = placement.scale > 0 ? 'visible' : 'hidden';
      }
      const automaticFold = this.foldAmount(side);
      hit.style.pointerEvents = '';
      grip.style.pointerEvents = '';
      hit.dataset.angle = sample.angle.toFixed(2);
      screen.dataset.angle = hit.dataset.angle;
      this.stage.dataset[side + 'Angle'] = hit.dataset.angle;
      this.stage.dataset[side + 'ManualAngle'] = this.angles[side].toFixed(2);
      this.stage.dataset[side + 'AutomaticFold'] = automaticFold.toFixed(4);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
};
