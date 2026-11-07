'use strict';
// Full flight is the normal experience, including when the device requests
// less motion. An explicit ?motion=reduced visit retains the accessible path.
// This policy survives the 2D/3D handoff without a toggle or stored override.
window.CockpitMotion ||= (() => {
  const system = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new EventTarget();
  try {
    localStorage.removeItem('kallas-reduced-motion');
  } catch {
    /* Storage is optional; the URL remains the motion-policy source. */
  }
  const matches = new URLSearchParams(location.search).get('motion') === 'reduced';
  function sync() {
    document.documentElement.dataset.motion = matches ? 'reduced' : 'full';
  }
  const preference = {
    get matches() {
      return matches;
    },
    get source() {
      return matches ? 'request' : 'default';
    },
    get systemReduced() {
      return system.matches;
    },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
  };
  sync();
  return preference;
})();

// All state updates run before presentation. Coalescing pointer events, journey
// motion and spring animation avoids drawing the same scene twice per refresh.
window.CockpitFrame = (() => {
  const updates = new Map(),
    paints = new Map();
  let nextId = 0,
    frame = 0,
    flushing = false;
  let previousTime = 0,
    time = 0,
    sampled = 0,
    interval = 0,
    slowFrames = 0,
    effectsReduced = false;
  const wake = () => {
    if (!frame && !flushing) frame = requestAnimationFrame(flush);
  };
  function flush(now) {
    frame = 0;
    flushing = true;
    time = now;
    // Adapt decorative workload, never the cadence of navigation or gestures.
    // Ignore idle gaps. One-way adaptation prevents quality oscillation while
    // reading and keeps later interactions on the measured device budget.
    // Startup combines temporary defocus with moving display geometry. Judge
    // normal journey workload only after that one-time entrance has finished.
    if (previousTime && !document.hidden && !window.CockpitEntrance?.blocked) {
      const elapsed = Math.min(100, now - previousTime);
      if (elapsed > 0) {
        interval = sampled ? interval * 0.9 + elapsed * 0.1 : elapsed;
        sampled++;
        slowFrames = interval > 18 ? slowFrames + 1 : 0;
        if (sampled >= 24 && slowFrames >= 6) effectsReduced = true;
      }
    }
    try {
      const pending = [...updates];
      updates.clear();
      for (const [, callback] of pending) callback(now);
      // Paints can invalidate a later layer (journey -> monitor optics).
      // Drain in order, with at most one paint per layer in this refresh.
      const painted = new Set();
      while (paints.size) {
        const available = [...paints].filter(([key]) => !painted.has(key));
        if (!available.length) break;
        available.sort((a, b) => a[1].priority - b[1].priority);
        const [key, task] = available[0];
        paints.delete(key);
        painted.add(key);
        task.callback(now);
      }
    } finally {
      flushing = false;
      previousTime = updates.size || paints.size ? now : 0;
      if (updates.size || paints.size) wake();
    }
  }
  document.addEventListener('visibilitychange', () => {
    previousTime = 0;
    sampled = 0;
    interval = 0;
    slowFrames = 0;
  });
  return {
    request(callback) {
      const id = ++nextId;
      updates.set(id, callback);
      wake();
      return id;
    },
    cancel(id) {
      updates.delete(id);
    },
    paint(key, callback, priority = 10) {
      paints.set(key, { callback, priority });
      wake();
    },
    get pending() {
      return updates.size + paints.size;
    },
    get time() {
      return time;
    },
    get effectsReduced() {
      return effectsReduced;
    },
  };
})();
