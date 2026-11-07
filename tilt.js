'use strict';

// Move the physical monitor assembly as one rigid surface. The reader stays HTML,
// so its blue glass, white text, scrolling, and links survive the perspective.
window.ConsoleTilt = class {
  constructor(assembly, grip, layout) {
    this.assembly = assembly;
    this.grip = grip;
    this.layout = layout;
    this.surface = grip.closest('.reading-device');
    this.housingHit = document.createElement('div');
    this.housingHit.className = 'main-tilt-hit';
    this.housingHit.setAttribute('aria-hidden', 'true');
    assembly.prepend(this.housingHit);
    this.angle = 0;
    this.drag = null;

    grip.setAttribute('role', 'slider');
    grip.setAttribute('aria-label', 'Display tilt');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-valuemin', '0');
    grip.setAttribute('aria-valuemax', '45');
    grip.style.touchAction = 'none';

    const surface = this.surface;
    let suppressClick = false;
    const activate = () => {
      if (!this.drag) return;
      clearTimeout(this.drag.hold);
      try {
        surface.setPointerCapture(this.drag.id);
      } catch {
        this.finish();
        return;
      }
      this.drag.active = true;
      this.assembly.dataset.dragging = 'true';
    };
    const start = (event) => {
      suppressClick = false;
      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        this.drag ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const article = event.target.closest('.screen-article');
      // The native scrollbar keeps its own drag. Shift-drag also remains an
      // explicit text-selection gesture, including selections across lines.
      if (article === event.target && event.offsetX >= article.clientWidth) return;
      // Touch remains undecided until a hold claims tilt or a quick swipe
      // reaches the cockpit's chapter/reading handlers.
      if (event.pointerType !== 'touch') event.stopPropagation();
      const rect = this.layout.getBoundingClientRect();
      // Freeze the input scale for a drag: resizing or tilting must not move its
      // coordinate system underneath the pointer.
      this.drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
        angle: this.angle,
        active: false,
        distance: Math.max(130, Math.min(260, rect.height * 0.55)),
      };
      if (event.pointerType === 'touch') {
        // Apply the same hold to the glass, bezel and projected housing hit
        // area so none of them consumes a horizontal chapter swipe.
        this.drag.hold = setTimeout(activate, 300);
      } else if (!article || grip.contains(event.target)) {
        event.preventDefault();
        activate();
        if (grip.contains(event.target)) grip.focus({ preventScroll: true });
      }
    };
    surface.addEventListener('pointerdown', start);
    this.housingHit.addEventListener('pointerdown', start);
    window.addEventListener(
      'pointermove',
      (event) => {
        if (!this.drag || event.pointerId !== this.drag.id) return;
        const dx = event.clientX - this.drag.x,
          dy = event.clientY - this.drag.y;
        this.drag.dx = dx;
        this.drag.dy = dy;
        if (!this.drag.active) {
          if (Math.hypot(dx, dy) < 6) return;
          if (this.drag.type === 'touch' || Math.abs(dx) > Math.abs(dy)) {
            this.finish();
            return;
          }
          activate();
          if (!this.drag) return;
          const selection = window.getSelection();
          if (selection?.anchorNode && surface.contains(selection.anchorNode))
            selection.removeAllRanges();
        }
        event.preventDefault();
        event.stopPropagation();
        if (Math.hypot(dx, dy) >= 6) this.drag.moved = true;
        this.set(this.drag.angle + (dy / this.drag.distance) * 45);
      },
      { passive: false },
    );
    // Pointer capture alone cannot prevent touch scrolling. Cancel the first
    // touch move only after the hold has claimed it; quick swipes stay native.
    const preventTiltScroll = (event) => {
      if (this.drag?.active && this.drag.type === 'touch' && event.cancelable)
        event.preventDefault();
    };
    surface.addEventListener('touchmove', preventTiltScroll, { passive: false });
    this.housingHit.addEventListener('touchmove', preventTiltScroll, { passive: false });
    window.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length > 1) this.finish();
      },
      { passive: true },
    );
    surface.addEventListener('dragstart', (event) => {
      // Link dragging can start a pixel before our tilt threshold. Keep a
      // pending vertical gesture available, while allowing horizontal selection.
      if (
        this.drag &&
        (this.drag.active || Math.abs(this.drag.dy || 0) > Math.abs(this.drag.dx || 0))
      )
        event.preventDefault();
    });
    surface.addEventListener('contextmenu', (event) => {
      if (this.drag?.active && this.drag.type === 'touch') event.preventDefault();
    });
    const finish = (event) => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      if (this.drag.moved) {
        suppressClick = true;
        event.preventDefault();
        event.stopPropagation();
      }
      this.finish();
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    surface.addEventListener('lostpointercapture', (event) => {
      if (event.target === surface) finish(event);
    });
    window.addEventListener('blur', () => this.finish());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.finish();
    });
    surface.addEventListener(
      'click',
      (event) => {
        if (!suppressClick || event.detail === 0) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );

    grip.addEventListener('keydown', (event) => {
      const changes = {
        ArrowDown: 5,
        ArrowRight: 5,
        ArrowUp: -5,
        ArrowLeft: -5,
        PageDown: 10,
        PageUp: -10,
      };
      const change = changes[event.key];
      if (change === undefined && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      event.stopPropagation();
      // Avoid switching input modes in the middle of a captured pointer drag.
      if (this.drag) return;
      this.set(event.key === 'Home' ? 0 : event.key === 'End' ? 45 : this.angle + change);
    });
    // The handle is a slider, never a chapter control or a toggle.
    grip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.refresh();
  }
  finish() {
    if (!this.drag) return;
    const { id, hold } = this.drag;
    clearTimeout(hold);
    this.drag = null;
    delete this.assembly.dataset.dragging;
    if (this.surface.hasPointerCapture(id)) this.surface.releasePointerCapture(id);
  }
  clamp(angle) {
    return Math.min(45, Math.max(0, angle));
  }
  set(angle) {
    if (!Number.isFinite(angle)) return;
    this.angle = this.clamp(angle);
    const value = this.angle.toFixed(2);
    this.assembly.style.setProperty('--assembly-tilt', `${value}deg`);
    this.assembly.dataset.tiltDegrees = value;
    this.grip.setAttribute('aria-valuenow', value);
    this.grip.setAttribute(
      'aria-valuetext',
      this.angle < 0.01 ? 'Upright' : `${Math.round(this.angle)} degrees forward`,
    );
    this.onChange?.(this.angle);
  }
  refresh() {
    const rect = this.layout.getBoundingClientRect();
    this.assembly.style.transformOrigin = `${rect.left + rect.width / 2}px ${rect.bottom}px`;
    this.assembly.style.setProperty(
      '--assembly-perspective',
      `${Math.max(3200, window.innerWidth * 4)}px`,
    );
    this.set(this.angle);
  }
};
